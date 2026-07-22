import { log } from './log.js';
import { parseLpAmount } from './commands.js';
import {
  getTcBets,
  getUserTotalBetLp,
  insertTcBet,
  type TcProposal,
} from './store/tc.js';
import { getProfile, spendPt, grantPt } from './store/gamification.js';
import { memberName } from './store/members.js';
import { buildTcResultPost } from './tc-post.js';
import { updateMessage } from './lark.js';
import { isPgUnavailableError, PG_UNAVAILABLE_REPLY_ZH } from './db.js';

export interface TcBetParse {
  optionValue: string;
  lpAmount: number;
}

/**
 * Extract { optionValue, lpAmount } from a bet message, or null when the text is not bet syntax.
 * Pure (no db / network), so it is unit-testable and shared by tryParseTcBet.
 *
 * Two strategies are tried in order:
 *   A. Whitespace-separated: "<option...> <amount>", amount = "5" / "5LP" / "5 LP".
 *      The leading @mention is stripped and standalone "TC-N" disambiguation tokens are dropped.
 *   B. Glued discrete option: "<option><amount>lp" with no separator (e.g. "法国3lp"). A group chat
 *      frequently sticks a non-numeric option straight onto the amount, which strategy A's whitespace
 *      split cannot separate. This path is gated on a trailing lp/LP marker and is discrete-only:
 *      the known option list is used to split the option prefix off (longest option first), then the
 *      remainder is parsed as the amount. A continuous "675lp" cannot be split unambiguously, so it
 *      is intentionally left to strategy A.
 *
 * Semantic validation (option membership, numeric range, limits, balance) is the caller's job;
 * this returns the raw parsed option string even when it is not a member of the option set.
 */
export function parseTcBetInput(rawText: string, proposal: TcProposal): TcBetParse | null {
  const afterMention = rawText.replace(/^@\S+\s+/, '').trim();
  const tokens = afterMention.split(/\s+/).filter(t => t && !/^TC-\d+$/i.test(t));

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
  if (proposal.optionType === 'discrete') {
    const body = tokens.join(' ');
    if (/lp\s*$/i.test(body)) {
      // Longest option first so "法国" wins over a shorter "法" that also prefixes the body.
      const opts = [...(proposal.options as string[])].sort((a, b) => b.length - a.length);
      for (const opt of opts) {
        if (opt && body.startsWith(opt)) {
          const lp = parseLpAmount([body.slice(opt.length)]);
          if (lp !== null) return { optionValue: opt, lpAmount: lp };
        }
      }
    }
  }

  return null;
}

/**
 * Attempt to parse a Feishu message as a TC bet and, on success, record it.
 *
 * Supported syntax: @agent <option> <LP-amount>
 *   Discrete:   @城邦土地神 选项A 5LP  |  @城邦土地神 法国3lp (glued, no space)
 *   Continuous: @城邦土地神 67 5LP  |  @城邦土地神 67.5 5 lp
 *
 * Returns { reply } when the message looks like a bet attempt (success or user error).
 * Returns false when the message doesn't look like a bet (caller should fall through to LLM).
 *
 * LP transaction order (conservative strategy):
 *   spendPt() first (shared db) — if insufficient balance, return immediately with no side effect.
 *   insertTcBet() second (per-soul db) — if this throws, roll back via grantPt().
 *   This avoids the inverse (recording the bet then failing to deduct LP) which is harder to detect.
 */
export async function tryParseTcBet(
  rawText: string,
  proposal: TcProposal,
  senderOpenId: string,
  messageId: string,
  larkProfile?: string,
): Promise<{ reply: string } | false> {
  const parsed = parseTcBetInput(rawText, proposal);
  if (!parsed) return false;
  const { optionValue, lpAmount } = parsed;

  // Validate option against proposal constraints
  if (proposal.optionType === 'discrete') {
    const validOptions = proposal.options as string[];
    if (!validOptions.includes(optionValue)) {
      // Only report an invalid-option error when the text actually looks like a bet — i.e. it carries
      // an explicit lp/LP amount marker. Otherwise a command or plain chatter that merely ends in a
      // number (e.g. "tc cancel 51", "我觉得 8") would be swallowed as a failed bet; let it fall
      // through to the command dispatcher / LLM instead.
      if (!/\d\s*lp/i.test(rawText)) return false;
      return {
        reply: `投注失败：【${optionValue}】不是有效选项。\n` +
               `有效选项：${validOptions.map(o => `【${o}】`).join(' / ')}`,
      };
    }
  } else {
    const numVal = parseFloat(optionValue);
    // A non-numeric option in a continuous survey is almost certainly not a bet: let it fall through
    // to the LLM rather than rejecting an ordinary message that merely ends in a number.
    if (isNaN(numVal)) return false;
    const [min, max] = proposal.options as [number, number];
    if (numVal < min || numVal > max) {
      return {
        reply: `投注失败：${optionValue} 不在范围 ${min}–${max} 内。`,
      };
    }
  }

  // Validate LP amount lower bound
  if (lpAmount < proposal.minBetLp) {
    return { reply: `投注失败：最少需要 ${proposal.minBetLp} LP，你输入了 ${lpAmount} LP。` };
  }

  // Validate cumulative upper bound for this user on this proposal
  const alreadyBet = await getUserTotalBetLp(proposal.id, senderOpenId);
  if (alreadyBet + lpAmount > proposal.maxBetLp) {
    const remaining = proposal.maxBetLp - alreadyBet;
    return {
      reply: `投注失败：你对 TC-${proposal.num} 的累计上限为 ${proposal.maxBetLp} LP，` +
             `已投 ${alreadyBet.toFixed(1)} LP，剩余可投 ${remaining.toFixed(1)} LP。`,
    };
  }

  // Pre-check balance (avoids calling spendPt when obviously insufficient), then deduct LP from shared
  // db and insertTcBet into per-soul db. Both getProfile and spendPt touch the shared LP database, so
  // both are inside this one try: the circuit breaker can be open before either call is reached.
  let userProfile: Awaited<ReturnType<typeof getProfile>>;
  let spent: boolean;
  try {
    userProfile = await getProfile(senderOpenId);
    const balance = userProfile?.ptBalance ?? 0;
    if (balance < lpAmount) {
      return {
        reply: `投注失败：LP 不足。需要 ${lpAmount} LP，你目前只有 ${balance.toFixed(1)} LP。`,
      };
    }
    // If insertTcBet (below) fails, roll back with grantPt to restore the deducted amount.
    spent = await spendPt(senderOpenId, lpAmount, 'tc_bet', messageId);
  } catch (e) {
    // Shared LP pool's circuit breaker is open: refuse quietly, no local write of any kind.
    if (isPgUnavailableError(e)) return { reply: PG_UNAVAILABLE_REPLY_ZH };
    throw e;
  }
  if (!spent) {
    // Race condition: balance dropped between the pre-check and spendPt
    return { reply: `投注失败：LP 余额不足。` };
  }

  try {
    await insertTcBet({
      proposalId: proposal.id,
      userOpenId: senderOpenId,
      optionValue,
      lpAmount,
      messageId,
    });
  } catch (e) {
    // insertTcBet failed: roll back the LP deduction
    await grantPt(senderOpenId, lpAmount, 'tc_bet_rollback', messageId);
    return { reply: `投注失败：记录出错，LP 已退还。请重试。` };
  }

  // Update the canonical proposal post in-place (best-effort: failures are logged, not thrown)
  try {
    const allBets = await getTcBets(proposal.id);
    const post = buildTcResultPost(proposal, allBets);
    const ok = await updateMessage(proposal.topMessageId, post, { as: 'bot', profile: larkProfile });
    if (!ok) {
      log.warn(`TC 投注：更新原帖失败（TC-${proposal.num}  topMsgId=${proposal.topMessageId}）`);
    }
  } catch (e) {
    log.warn(`TC 投注：更新原帖异常：${(e as Error).message}`);
  }

  const userName = (await memberName(senderOpenId)) || userProfile?.name || senderOpenId;
  return {
    reply: `${userName} 对 TC-${proposal.num}【${proposal.title}】 投注成功！\n` +
           `本次投注选项【${optionValue}】投注 ${lpAmount} LP\n` +
           `已累计投注：${(alreadyBet + lpAmount).toFixed(1)} / ${proposal.maxBetLp} LP`,
  };
}
