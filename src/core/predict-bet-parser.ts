import { log } from './log.js';
import { parseLpAmount } from './commands.js';
import {
  getPredictBets,
  getUserTotalBetLp,
  insertPredictBet,
  type PredictProposal,
} from './store/predict.js';
import { getProfile, spendPt, grantPt } from './store/gamification.js';
import { memberName } from './store/members.js';
import { buildPredictResultPost } from './predict-post.js';
import { updateMessage } from './lark.js';

export interface PredictBetParse {
  optionValue: string;
  lpAmount: number;
}

/**
 * Extract { optionValue, lpAmount } from a bet message, or null when the text is not bet syntax.
 * Pure (no db / network), so it is unit-testable and shared by tryParsePredictBet. Community
 * prediction is discrete-only, so this is TC's parseTcBetInput narrowed to just the discrete branch
 * (see tc-bet-parser.ts for the fuller continuous-aware version and its regression history).
 *
 * Two strategies are tried in order:
 *   A. Whitespace-separated: "<option...> <amount>", amount = "5" / "5LP" / "5 LP".
 *      The leading @mention is stripped and standalone "BET-N" disambiguation tokens are dropped.
 *   B. Glued discrete option: "<option><amount>lp" with no separator (e.g. "法国3lp"). Gated on a
 *      trailing lp/LP marker; the known option list is used to split the option prefix off (longest
 *      option first), then the remainder is parsed as the amount.
 *
 * Semantic validation (option membership, limits, balance) is the caller's job; this returns the raw
 * parsed option string even when it is not a member of the option set.
 */
export function parsePredictBetInput(rawText: string, proposal: Pick<PredictProposal, 'options'>): PredictBetParse | null {
  const afterMention = rawText.replace(/^@\S+\s+/, '').trim();
  const tokens = afterMention.split(/\s+/).filter(t => t && !/^BET-\d+$/i.test(t));

  // Strategy A — whitespace-separated option and amount.
  if (tokens.length >= 2) {
    let lp: number | null = null;
    let optionEnd = 0;
    // "5 LP" (last two tokens); requires at least one option token before them.
    if (tokens.length >= 3) {
      lp = parseLpAmount([tokens[tokens.length - 2]!, tokens[tokens.length - 1]!]);
      if (lp !== null) optionEnd = tokens.length - 2;
    }
    // "5LP" (last token glued).
    if (lp === null) {
      lp = parseLpAmount([tokens[tokens.length - 1]!]);
      if (lp !== null) optionEnd = tokens.length - 1;
    }
    if (lp !== null && optionEnd > 0) {
      return { optionValue: tokens.slice(0, optionEnd).join(' ').trim(), lpAmount: lp };
    }
  }

  // Strategy B — glued discrete option, gated on a trailing lp/LP marker.
  const body = tokens.join(' ');
  if (/lp\s*$/i.test(body)) {
    // Longest option first so a longer option wins over a shorter one that also prefixes the body.
    const opts = [...proposal.options].sort((a, b) => b.length - a.length);
    for (const opt of opts) {
      if (opt && body.startsWith(opt)) {
        const lp = parseLpAmount([body.slice(opt.length)]);
        if (lp !== null) return { optionValue: opt, lpAmount: lp };
      }
    }
  }

  return null;
}

/**
 * Attempt to parse a Feishu message as a community-prediction bet and, on success, record it.
 *
 * Supported syntax: @agent <option> <LP-amount>
 *   @城邦土地神 选项A 5LP  |  @城邦土地神 法国3lp (glued, no space)
 *
 * Returns { reply } when the message looks like a bet attempt (success or user error).
 * Returns false when the message doesn't look like a bet (caller should fall through to LLM).
 *
 * LP transaction order (conservative strategy, identical to TC's — see tc-betting-playbook §8):
 *   spendPt() first (shared db) — if insufficient balance, return immediately with no side effect.
 *   insertPredictBet() second (per-soul db) — if this throws, roll back via grantPt().
 */
export function tryParsePredictBet(
  rawText: string,
  proposal: PredictProposal,
  senderOpenId: string,
  messageId: string,
  larkProfile?: string,
): { reply: string } | false {
  const parsed = parsePredictBetInput(rawText, proposal);
  if (!parsed) return false;
  const { optionValue, lpAmount } = parsed;

  // Validate option against proposal constraints.
  if (!proposal.options.includes(optionValue)) {
    // Only report an invalid-option error when the text actually looks like a bet — i.e. it carries an
    // explicit lp/LP amount marker. Otherwise a command or plain chatter that merely ends in a number
    // would be swallowed as a failed bet; let it fall through to the command dispatcher / LLM instead.
    if (!/\d\s*lp/i.test(rawText)) return false;
    return {
      reply: `投注失败：【${optionValue}】不是有效选项。\n` +
             `有效选项：${proposal.options.map(o => `【${o}】`).join(' / ')}`,
    };
  }

  // Validate LP amount lower bound.
  if (lpAmount < proposal.minBetLp) {
    return { reply: `投注失败：最少需要 ${proposal.minBetLp} LP，你输入了 ${lpAmount} LP。` };
  }

  // Validate cumulative upper bound for this user on this proposal.
  const alreadyBet = getUserTotalBetLp(proposal.id, senderOpenId);
  if (alreadyBet + lpAmount > proposal.maxBetLp) {
    const remaining = proposal.maxBetLp - alreadyBet;
    return {
      reply: `投注失败：你对 BET-${proposal.num} 的累计上限为 ${proposal.maxBetLp} LP，` +
             `已投 ${alreadyBet.toFixed(1)} LP，剩余可投 ${remaining.toFixed(1)} LP。`,
    };
  }

  // Pre-check balance (avoids calling spendPt when obviously insufficient).
  const userProfile = getProfile(senderOpenId);
  const balance = userProfile?.ptBalance ?? 0;
  if (balance < lpAmount) {
    return {
      reply: `投注失败：LP 不足。需要 ${lpAmount} LP，你目前只有 ${balance.toFixed(1)} LP。`,
    };
  }

  // Deduct LP from shared db first; insertPredictBet into per-soul db second.
  // If insertPredictBet fails, roll back with grantPt to restore the deducted amount.
  const spent = spendPt(senderOpenId, lpAmount, 'predict_bet', messageId);
  if (!spent) {
    // Race condition: balance dropped between the pre-check and spendPt.
    return { reply: `投注失败：LP 余额不足。` };
  }

  try {
    insertPredictBet({
      proposalId: proposal.id,
      userOpenId: senderOpenId,
      optionValue,
      lpAmount,
      messageId,
    });
  } catch (e) {
    // insertPredictBet failed: roll back the LP deduction.
    grantPt(senderOpenId, lpAmount, 'predict_bet_rollback', messageId);
    return { reply: `投注失败：记录出错，LP 已退还。请重试。` };
  }

  // Update the canonical proposal post in-place (best-effort: failures are logged, not thrown).
  try {
    const allBets = getPredictBets(proposal.id);
    const post = buildPredictResultPost(proposal, allBets);
    const ok = updateMessage(proposal.topMessageId, post, { as: 'bot', profile: larkProfile });
    if (!ok) {
      log.warn(`BET 投注：更新原帖失败（BET-${proposal.num}  topMsgId=${proposal.topMessageId}）`);
    }
  } catch (e) {
    log.warn(`BET 投注：更新原帖异常：${(e as Error).message}`);
  }

  const userName = memberName(senderOpenId) || userProfile?.name || senderOpenId;
  return {
    reply: `${userName} 对 BET-${proposal.num}【${proposal.title}】 投注成功！\n` +
           `本次投注选项【${optionValue}】投注 ${lpAmount} LP\n` +
           `已累计投注：${(alreadyBet + lpAmount).toFixed(1)} / ${proposal.maxBetLp} LP`,
  };
}
