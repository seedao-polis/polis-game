import { parseCommand } from './commands.js';
import { isAdmin } from './configs.js';
import { log } from './log.js';
import {
  getTcByNum,
  getUnrefundedBets,
  markBetRefunded,
  cancelTcProposal,
  type TcProposal,
} from './store/tc.js';
import { grantPt } from './store/gamification.js';
import { updateMessage } from './lark.js';
import { buildTcCancelledPost } from './tc-post.js';

/**
 * Cancel a TC proposal: refund every outstanding bet (per-soul markBetRefunded + shared-db grantPt),
 * then mark the proposal cancelled. Shared by the in-group command and the CLI so the refund logic
 * lives in one place. Returns how many bets were refunded and the total LP returned.
 */
export function cancelTcWithRefund(proposal: TcProposal): { refunded: number; refundedLp: number } {
  const pending = getUnrefundedBets(proposal.id);
  let refunded = 0;
  let refundedLp = 0;
  for (const bet of pending) {
    try {
      markBetRefunded(bet.id);
      grantPt(bet.userOpenId, bet.lpAmount, 'tc_refund_cancel', proposal.topMessageId);
      refunded++;
      refundedLp += bet.lpAmount;
    } catch (e) {
      log.warn(`TC 撤销退款失败（bet.id=${bet.id}）：${(e as Error).message}`);
    }
  }
  cancelTcProposal(proposal.id);
  return { refunded, refundedLp };
}

const STATUS_ZH: Record<string, string> = { active: '进行中', settled: '已结算', cancelled: '已撤销' };

/**
 * Handle an in-group TC management command. Deterministic — never touches the LLM.
 *
 * Currently supports "@agent tc cancel <num>": only the proposal creator or an admin may cancel;
 * cancelling refunds every outstanding bet and closes the survey. Returns { reply } when the message
 * is a TC command (whether it succeeded or was rejected), or false when it is not a TC command (the
 * caller then falls through to the bet parser / general dispatcher / LLM).
 *
 * This must run before the bet pre-intercept: "tc cancel 51" ends in a number and would otherwise be
 * misread as a bet on the chat's active proposal.
 */
export function tryHandleTcCommand(
  rawText: string,
  senderOpenId: string,
  larkProfile?: string,
): { reply: string } | false {
  const cmd = parseCommand(rawText);
  if (!cmd || cmd.name !== 'tc') return false;
  const sub = (cmd.args[0] ?? '').toLowerCase();
  if (sub !== 'cancel') return false; // only cancel is exposed in-group for now

  const numStr = cmd.args[1] ?? '';
  const num = /^\d+$/.test(numStr) ? parseInt(numStr, 10) : NaN;
  if (isNaN(num)) return { reply: '用法：@我 tc cancel <编号>，例如「tc cancel 51」。' };

  const proposal = getTcByNum(num);
  if (!proposal) return { reply: `找不到 TC-${num}。` };
  if (proposal.status !== 'active') {
    return { reply: `TC-${num} 当前状态为「${STATUS_ZH[proposal.status] ?? proposal.status}」，无法撤销。` };
  }
  if (proposal.createdBy !== senderOpenId && !isAdmin(senderOpenId)) {
    return { reply: `只有发起人或管理员才能撤销 TC-${num}。` };
  }

  const { refunded, refundedLp } = cancelTcWithRefund(proposal);

  // Reflect the cancellation on the original pinned post (best-effort; never blocks the reply).
  try {
    const post = buildTcCancelledPost(proposal, refunded);
    updateMessage(proposal.topMessageId, post, { as: 'bot', profile: larkProfile });
  } catch (e) {
    log.warn(`TC 撤销：更新原帖失败（TC-${proposal.num}）：${(e as Error).message}`);
  }

  return {
    reply:
      `TC-${proposal.num}【${proposal.title}】已撤销。` +
      (refunded > 0
        ? `已退还 ${refunded} 笔投注、共 ${refundedLp.toFixed(1)} LP。`
        : '本次没有需要退还的投注。'),
  };
}
