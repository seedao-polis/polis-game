import { log } from './log.js';
import { grantPt, getProfile } from './store/gamification.js';
import { memberName } from './store/members.js';
import {
  getPredictBets,
  settlePredictProposal,
  type PredictProposal,
  type PredictBet,
} from './store/predict.js';
import { buildPredictSettledPost, aggregateWinners } from './predict-post.js';
import { updateMessage, sendText } from './lark.js';
import { distributePool, type BetRow, type WinnerPayout } from './tc-settlement.js';
import { PUBLIC_WELFARE_CHEST_ID, ensurePublicWelfareChest } from './treasure-chest.js';

// Community-prediction settlement: unlike TC, the winning option is not computed by an algorithm —
// it is announced by a 社区预测裁判 (predict_judge badge holder). This module re-uses TC's shared
// distributePool() for the payout math (same tie/dust/0.1-flooring rules) but skips winner *detection*
// entirely: the announced option IS the sole winner group.

export type PredictSettleError = 'invalid_option' | 'already_settled';

export interface PredictSettleResult {
  ok: boolean;
  error?: PredictSettleError;
  winners: WinnerPayout[];
  totalPool: number;
  chestContribution: number;
  dust: number;
}

/**
 * Settle a community-prediction proposal on a judge's announced winning option.
 *
 * Flow: validate the option is a real proposal option → idempotent status transition (WHERE
 * status='active', so a duplicate/replayed announcement is a no-op) → every non-refunded bet on the
 * proposal (any option) sums to the total pool (totalAllLp * 1.05, same 5% incentive TC uses) → the
 * announced option's bets form the single winner group → distributePool() pays them out → the public
 * welfare chest receives an EXTRA, separately-minted totalPool*0.10 contribution — not deducted from
 * winners, granted even when nobody bet on the announced option (decision: "无输家亦注资"), skipped
 * only when the proposal drew zero bets at all (there is no pool to speak of) → the canonical post is
 * updated in place (falls back to a plain-text message on API failure, same as TC).
 *
 * Idempotency matters more here than for TC: TC's minute-cron settlement is naturally deduped by its
 * own scheduler loop, while a judge's manual announcement has no scheduler backstop — a resent Feishu
 * event or a judge double-tapping "sure" must not double-grant LP. settlePredictProposal's conditional
 * UPDATE (status='active') is the single gate that guarantees this function's side effects run at most once.
 */
export async function settlePredict(
  proposal: PredictProposal,
  winnerOption: string,
  announcerOpenId: string,
  larkProfile?: string,
): Promise<PredictSettleResult> {
  if (!proposal.options.includes(winnerOption)) {
    return { ok: false, error: 'invalid_option', winners: [], totalPool: 0, chestContribution: 0, dust: 0 };
  }

  const bets: PredictBet[] = (await getPredictBets(proposal.id)).filter(b => !b.isRefunded);
  const totalAllLp = bets.reduce((s, b) => s + b.lpAmount, 0);
  const totalPool = totalAllLp * 1.05;

  // Idempotency gate: only the first successful call transitions active -> settled and grants LP.
  const didSettle = await settlePredictProposal(proposal.id, winnerOption, announcerOpenId);
  if (!didSettle) {
    return { ok: false, error: 'already_settled', winners: [], totalPool: 0, chestContribution: 0, dust: 0 };
  }

  let winners: WinnerPayout[] = [];
  let dust = 0;
  let chestContribution = 0;
  const winnerNames: Array<{ userOpenId: string; userName: string; amount: number }> = [];

  if (bets.length > 0) {
    const winnerBets: BetRow[] = bets
      .filter(b => b.optionValue === winnerOption)
      .map(b => ({ userOpenId: b.userOpenId, optionValue: b.optionValue, lpAmount: b.lpAmount }));
    const winnerGroups = new Map<string, BetRow[]>([[winnerOption, winnerBets]]);

    const result = distributePool(winnerGroups, totalPool);
    winners = result.winners;
    dust = result.dust;

    for (const w of winners) {
      if (w.payout > 0) {
        await grantPt(w.userOpenId, w.payout, 'predict_reward', proposal.topMessageId);
        const name = (await memberName(w.userOpenId)) || (await getProfile(w.userOpenId))?.name || w.userOpenId;
        winnerNames.push({ userOpenId: w.userOpenId, userName: name, amount: w.payout });
      }
    }
    if (dust > 0) {
      log.info(`BET-${proposal.num} dust=${dust} LP（丢弃，不分配）`);
    }

    // Public-welfare chest contribution: extra-minted (never deducted from winner payouts), granted
    // even when nobody bet on the announced winning option (dust would already have absorbed that
    // share) — the only condition is that the proposal drew at least one bet at all. Rounded to 2
    // decimal places purely to keep the ledger free of floating-point noise (e.g. 1.0499999999999998);
    // the 10% factor itself is not part of the 0.1 LP payout-flooring rule.
    await ensurePublicWelfareChest();
    chestContribution = Math.round(totalPool * 0.10 * 100) / 100;
    await grantPt(PUBLIC_WELFARE_CHEST_ID, chestContribution, 'predict_chest_contribute', proposal.topMessageId);
    log.info(`BET-${proposal.num} 公益宝箱注资：+${chestContribution.toFixed(2)} LP`);
  }

  // Update the original proposal post in-place; fall back to a new text message on failure.
  const announcerName = (await memberName(announcerOpenId)) || (await getProfile(announcerOpenId))?.name || announcerOpenId;
  const updatedProposal: PredictProposal = { ...proposal, status: 'settled', settledOption: winnerOption, announcedBy: announcerOpenId };
  const settledPost = buildPredictSettledPost(updatedProposal, bets, winnerNames, announcerName, chestContribution);
  const ok = await updateMessage(proposal.topMessageId, settledPost, { as: 'bot', profile: larkProfile });
  if (!ok) {
    log.warn(`BET-${proposal.num} 结算原帖更新失败（topMsgId=${proposal.topMessageId}），发送新消息补充`);
    try {
      const agg = aggregateWinners(winnerNames);
      const fallbackText = agg.length > 0
        ? `【BET-${proposal.num}】已结算。裁判宣布结果：${winnerOption}\n获奖：${agg.map(w => `${w.userName} +${w.amount.toFixed(1)} LP`).join('  ')}`
        : `【BET-${proposal.num}】已结算。裁判宣布结果：${winnerOption}（无人押中）。`;
      await sendText({ chatId: proposal.chatId }, fallbackText, { as: 'bot', profile: larkProfile });
    } catch (fe) {
      log.error(`BET-${proposal.num} fallback 消息发送也失败：${(fe as Error).message}`);
    }
  }

  return { ok: true, winners, totalPool, chestContribution, dust };
}
