import { log } from './log.js';
import { grantPt, getProfile } from './store/gamification.js';
import { memberName } from './store/members.js';
import {
  getTcBets,
  settleTcProposal,
  type TcProposal,
  type TcBet,
} from './store/tc.js';
import {
  buildTcSettledPost,
  aggregateWinners,
} from './tc-post.js';
import { updateMessage, sendText } from './lark.js';
import { loadConfigs } from './configs.js';

// ── Pure settlement algorithm (no side effects, fully unit-testable) ──────────

export interface BetRow {
  userOpenId: string;
  optionValue: string;
  lpAmount: number;
}

export interface WinnerPayout {
  userOpenId: string;
  optionValue: string;
  lpAmount: number;    // original bet amount
  payout: number;      // actual reward (floored to 0.1 LP precision)
}

export interface SettlementResult {
  settledValue: number | null;   // continuous: weighted average (4 decimal places); discrete: null
  settledOption: string | null;  // discrete: JSON-encoded winner option array; continuous: null
  totalPool: number;             // effective prize pool (totalLp * 1.05, or totalLp when noBonusWhenNoLoser applies)
  winners: WinnerPayout[];
  dust: number;                  // undistributed remainder (discarded per decision 3)
}

/**
 * Two-tier TC settlement algorithm (pure function, no DB or network side effects).
 *
 * Decision 1 (tie handling): when multiple winner groups tie (equal LP or equal distance),
 *   each group receives an equal share of the pool (pool / G); within each group, payout
 *   is proportional to individual LP stake.
 * Decision 2 (no-loser case): when all bets land on the winning side (no losers), the
 *   5% bonus still applies by default (noBonusWhenNoLoser=false). Set noBonusWhenNoLoser=true
 *   to return only principal in that scenario.
 * Decision 3 (dust): fractional LP below 0.1 precision is discarded (floor, not round).
 * Decision 4 (multi-bet): a user may bet multiple times on multiple options; each bet record
 *   is treated independently for winner-group membership and proportional payout calculation.
 *
 * Continuous settlement: weighted average of all bet values; the winning bets are those
 *   whose optionValue is closest to the average (ties broken by equal minimum distance → all tied).
 * Discrete settlement: the option(s) with the highest total LP win; ties yield multiple groups.
 */
export function computeTcSettlement(
  optionType: 'discrete' | 'continuous',
  options: string[] | [number, number],
  bets: BetRow[],
  noBonusWhenNoLoser = false,
): SettlementResult {
  // No bets: return empty result
  if (bets.length === 0) {
    return { settledValue: null, settledOption: null, totalPool: 0, winners: [], dust: 0 };
  }

  const totalAllLp = bets.reduce((s, b) => s + b.lpAmount, 0);
  const totalPool = totalAllLp * 1.05;

  let settledValue: number | null = null;
  let settledOption: string | null = null;
  let winnerGroups: Map<string, BetRow[]>; // key: optionValue → bet rows in that winner group

  if (optionType === 'continuous') {
    // Weighted average rounded to 4 decimal places is the canonical outcome
    const weightedSum = bets.reduce((s, b) => s + parseFloat(b.optionValue) * b.lpAmount, 0);
    settledValue = Math.round((weightedSum / totalAllLp) * 10000) / 10000;
    settledOption = null;

    // Find bets closest to the average; multiple distinct option values can tie at equal distance
    const dists = bets.map(b => Math.abs(parseFloat(b.optionValue) - settledValue!));
    const minDist = Math.min(...dists);
    const winnerBets = bets.filter(
      (_, i) => Math.abs(parseFloat(bets[i]!.optionValue) - settledValue!) === minDist,
    );

    winnerGroups = new Map();
    for (const wb of winnerBets) {
      const key = wb.optionValue;
      const existing = winnerGroups.get(key) ?? [];
      existing.push(wb);
      winnerGroups.set(key, existing);
    }
  } else {
    // Discrete: option(s) with the highest cumulative LP win
    const lpByOption: Record<string, number> = {};
    for (const b of bets) {
      lpByOption[b.optionValue] = (lpByOption[b.optionValue] ?? 0) + b.lpAmount;
    }
    const maxLp = Math.max(...Object.values(lpByOption));
    const winnerOptions = Object.entries(lpByOption)
      .filter(([, lp]) => lp === maxLp)
      .map(([opt]) => opt);

    settledOption = JSON.stringify(winnerOptions);
    settledValue = null;

    winnerGroups = new Map();
    for (const opt of winnerOptions) {
      winnerGroups.set(opt, bets.filter(b => b.optionValue === opt));
    }
  }

  // Determine whether all bets are on the winning side (no losers)
  const allBetValues = new Set(bets.map(b => b.optionValue));
  const winnerValues = new Set(winnerGroups.keys());
  const hasLosers = [...allBetValues].some(v => !winnerValues.has(v));

  let effectivePool = totalPool;
  if (!hasLosers && noBonusWhenNoLoser) {
    // No-loser mode: return principal only (no 5% bonus from the system)
    effectivePool = totalAllLp;
  }

  // Two-tier distribution:
  //   Tier 1: each winner group receives an equal share (effectivePool / G).
  //   Tier 2: within each group, each bet row receives (groupShare * betLp / groupTotalLp).
  const G = winnerGroups.size;
  const groupShare = effectivePool / G;

  const winners: WinnerPayout[] = [];
  let distributed = 0;

  for (const [, groupBets] of winnerGroups) {
    const groupTotalLp = groupBets.reduce((s, b) => s + b.lpAmount, 0);
    for (const wb of groupBets) {
      const personalShare = groupShare * (wb.lpAmount / groupTotalLp);
      // Floor to 0.1 LP precision per decision 3
      const payout = Math.floor(personalShare * 10) / 10;
      winners.push({ userOpenId: wb.userOpenId, optionValue: wb.optionValue, lpAmount: wb.lpAmount, payout });
      distributed += payout;
    }
  }

  // Floating-point guard. LP arithmetic leaves IEEE754 noise in the remainder (34.65 - 34.5 evaluates
  // to 0.1499999999999986), so round it at a precision far finer than any real LP amount to recover
  // the exact value, then clamp at zero — every payout is floored, so the distributed total can never
  // legitimately exceed the pool, and only noise can push the subtraction negative. Note the rounding
  // step must stay finer than the 0.1 payout-flooring step: the remainder is by construction a
  // fraction of that step, so rounding it at 0.1 would quantise away the very value being reported.
  const dust = Math.max(0, Math.round((effectivePool - distributed) * 1e6) / 1e6);

  return { settledValue, settledOption, totalPool: effectivePool, winners, dust };
}

// ── Side-effectful settlement (DB writes + LP grants + post update) ───────────

/**
 * Settle one expired TC proposal: compute outcome, mark settled in DB, grant winner LP,
 * and update the original Feishu post in-place.
 *
 * Idempotency: settleTcProposal() uses WHERE status='active', so a second call returns false
 * and the function exits without re-granting LP. Safe to call from a minute-cron scheduler.
 *
 * Fallback: if updateMessage() fails, a plain-text summary is sent to the proposal's chat.
 */
export async function settleTc(proposal: TcProposal, larkProfile: string): Promise<void> {
  const bets: TcBet[] = getTcBets(proposal.id).filter(b => !b.isRefunded);

  let noBonusWhenNoLoser = false;
  try {
    const cfg = loadConfigs();
    noBonusWhenNoLoser = (cfg.lark as any).tc?.noBonusWhenNoLoser === true;
  } catch { /* config unavailable — default false (bonus always applies) */ }

  const result = computeTcSettlement(
    proposal.optionType,
    proposal.options,
    bets.map(b => ({ userOpenId: b.userOpenId, optionValue: b.optionValue, lpAmount: b.lpAmount })),
    noBonusWhenNoLoser,
  );

  // Mark settled first (idempotency gate); abort if already settled by another process
  const didSettle = settleTcProposal(proposal.id, result.settledValue, result.settledOption);
  if (!didSettle) {
    log.info(`TC-${proposal.num} 已结算，跳过重复结算。`);
    return;
  }

  // Grant LP to each winner with positive payout
  const winnerNames: Array<{ userOpenId: string; userName: string; amount: number }> = [];
  for (const w of result.winners) {
    if (w.payout > 0) {
      grantPt(w.userOpenId, w.payout, 'tc_reward', proposal.topMessageId);
      const name = memberName(w.userOpenId) || getProfile(w.userOpenId)?.name || w.userOpenId;
      winnerNames.push({ userOpenId: w.userOpenId, userName: name, amount: w.payout });
    }
  }

  if (result.dust > 0) {
    log.info(`TC-${proposal.num} dust=${result.dust} LP（丢弃，不分配）`);
  }

  // Update the original proposal post in-place; fall back to a new text message on failure
  const updatedProposal: TcProposal = {
    ...proposal,
    status: 'settled',
    settledValue: result.settledValue,
    settledOption: result.settledOption,
  };
  const settledPost = buildTcSettledPost(updatedProposal, bets, winnerNames);
  const ok = updateMessage(proposal.topMessageId, settledPost, { as: 'bot', profile: larkProfile });
  if (!ok) {
    log.warn(`TC-${proposal.num} 结算原帖更新失败（topMsgId=${proposal.topMessageId}），发送新消息补充`);
    try {
      const baseDesc = proposal.optionType === 'continuous'
        ? `加权均值 ${result.settledValue?.toFixed(4) ?? ''}`
        : `最高票选项 ${result.settledOption ?? ''}`;
      const agg = aggregateWinners(winnerNames);
      const fallbackText = agg.length > 0
        ? `【TC-${proposal.num}】已结算。基准值：${baseDesc}\n获奖：${agg.map(w => `${w.userName} +${w.amount.toFixed(1)} LP`).join('  ')}`
        : `【TC-${proposal.num}】已结算（无参与者）。`;
      sendText({ chatId: proposal.chatId }, fallbackText, { as: 'bot', profile: larkProfile });
    } catch (fe) {
      log.error(`TC-${proposal.num} fallback 消息发送也失败：${(fe as Error).message}`);
    }
  }
}
