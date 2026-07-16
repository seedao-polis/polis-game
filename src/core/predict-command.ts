import { parseCommand } from './commands.js';
import { hasBadge, grantPt } from './store/gamification.js';
import { log } from './log.js';
import {
  getPredictByNum,
  getPredictBets,
  getUnrefundedBets,
  markBetRefunded,
  cancelPredictProposal,
  type PredictProposal,
} from './store/predict.js';
import { updateMessage } from './lark.js';
import { buildPredictCancelledPost } from './predict-post.js';
import { settlePredict } from './predict-settlement.js';

// Community-prediction command layer — the single authoritative implementation (unlike TC, which grew
// a duplicate cancel path in commands.ts before tc-command.ts was split out; see the research doc's
// "雙軌實作技術債" warning). Every predict-facing in-group command (announce / cancel / query) is
// handled here and nowhere else; feishu-bot.ts calls tryHandlePredictCommand before the bet parser.

/** Badge id gating who may announce a community-prediction result ("社区预测裁判"). */
export const PREDICT_JUDGE_BADGE_ID = 'predict_judge';

const STATUS_ZH: Record<string, string> = { active: '进行中', settled: '已结算', cancelled: '已撤销' };

/**
 * Refund every outstanding bet on a proposal (per-soul markBetRefunded + shared-db grantPt), then mark
 * it cancelled. Shared by the in-group command and the CLI so the refund logic lives in one place.
 */
export function cancelPredictWithRefund(proposal: PredictProposal): { refunded: number; refundedLp: number } {
  const pending = getUnrefundedBets(proposal.id);
  let refunded = 0;
  let refundedLp = 0;
  for (const bet of pending) {
    try {
      markBetRefunded(bet.id);
      grantPt(bet.userOpenId, bet.lpAmount, 'predict_refund_cancel', proposal.topMessageId);
      refunded++;
      refundedLp += bet.lpAmount;
    } catch (e) {
      log.warn(`BET 撤销退款失败（bet.id=${bet.id}）：${(e as Error).message}`);
    }
  }
  cancelPredictProposal(proposal.id);
  return { refunded, refundedLp };
}

/** Parse a proposal number from either a bare integer or a "BET-N" token. */
function parsePredictNum(raw: string | undefined): number {
  if (!raw) return NaN;
  const m = /^bet-(\d+)$/i.exec(raw.trim());
  return m ? parseInt(m[1]!, 10) : (/^\d+$/.test(raw.trim()) ? parseInt(raw.trim(), 10) : NaN);
}

/** Build a plain-text reply describing a proposal's current state and bet distribution. */
export function queryPredictReply(num: number): string {
  if (isNaN(num)) return '请提供有效的编号，例如：BET-1 或 预测 查询 1';
  const proposal = getPredictByNum(num);
  if (!proposal) return `找不到 BET-${num}。`;
  const bets = getPredictBets(proposal.id);
  const activeBets = bets.filter(b => !b.isRefunded);
  const totalLp = activeBets.reduce((s, b) => s + b.lpAmount, 0);
  const participants = new Set(activeBets.map(b => b.userOpenId)).size;

  const statusStr = proposal.status === 'active'
    ? `进行中，投注截止 ${new Date(proposal.endTime * 1000).toLocaleString('sv-SE').slice(0, 16)}`
    : proposal.status === 'settled'
    ? `已结算，裁判宣布结果：【${proposal.settledOption ?? ''}】获胜`
    : '已撤销';

  const lines: string[] = [
    `【BET-${proposal.num}】${proposal.title}`,
    `状态：${statusStr}`,
    `参与：${participants} 人  总投入：${totalLp.toFixed(1)} LP  奖金池：${(totalLp * 1.05).toFixed(1)} LP`,
    '',
  ];
  const lpByOption: Record<string, number> = {};
  for (const b of activeBets) {
    lpByOption[b.optionValue] = (lpByOption[b.optionValue] ?? 0) + b.lpAmount;
  }
  for (const [opt, lp] of Object.entries(lpByOption).sort((a, b) => b[1] - a[1])) {
    lines.push(`  【${opt}】${lp.toFixed(1)} LP`);
  }
  return lines.join('\n');
}

/**
 * Handle an in-group community-prediction command. Deterministic — never touches the LLM.
 *
 * Supports:
 *   预测 宣布 <编号> <选项>   |  predict announce <num> <option>   — 仅 predict_judge 徽章持有者
 *   预测 撤销/cancel <编号>   |  predict cancel <num>              — 提案人 或 predict_judge 徽章持有者
 *   预测 查询 <编号>          |  predict query <num>
 *
 * Returns { reply } when the message is a predict command (whether it succeeded or was rejected), or
 * false when it is not (the caller then falls through to the bet parser / general dispatcher / LLM).
 *
 * This must run before the bet pre-intercept: "预测 宣布 3 巴西" ends in a discrete option token and
 * could otherwise be misread as a bet on the chat's active proposal (same lesson as TC's "tc cancel 51"
 * regression — see tc.test.ts).
 */
export function tryHandlePredictCommand(
  rawText: string,
  senderOpenId: string,
  larkProfile?: string,
): { reply: string } | false {
  const cmd = parseCommand(rawText);
  if (!cmd) return false;
  if (cmd.name !== '预测' && cmd.name !== 'predict') return false;
  const sub = (cmd.args[0] ?? '').toLowerCase();

  if (sub === '宣布' || sub === 'announce') {
    const num = parsePredictNum(cmd.args[1]);
    const winnerOption = cmd.args.slice(2).join(' ').trim();
    if (isNaN(num) || !winnerOption) {
      return { reply: '用法：预测 宣布 <编号> <获胜选项>，例如「预测 宣布 3 巴西」。' };
    }
    const proposal = getPredictByNum(num);
    if (!proposal) return { reply: `找不到 BET-${num}。` };
    if (proposal.status !== 'active') {
      return { reply: `BET-${num} 当前状态为「${STATUS_ZH[proposal.status] ?? proposal.status}」，无法宣布结果。` };
    }
    if (!hasBadge(senderOpenId, PREDICT_JUDGE_BADGE_ID)) {
      return { reply: '只有社区预测裁判可以宣布结果。' };
    }
    if (!proposal.options.includes(winnerOption)) {
      return {
        reply: `【${winnerOption}】不是 BET-${num} 的有效选项。\n` +
               `有效选项：${proposal.options.map(o => `【${o}】`).join(' / ')}`,
      };
    }
    // settlePredict is async (it performs the in-place message edit / fallback send); the caller here
    // is itself sync, so kick it off and let the post update land shortly after this reply. LP grants
    // and the idempotent status transition are already fully applied by the time settlePredict resolves.
    void settlePredict(proposal, winnerOption, senderOpenId, larkProfile).catch((e) => {
      log.error(`BET-${num} 结算失败：${(e as Error).message}`);
    });
    return { reply: `BET-${num}【${proposal.title}】已宣布【${winnerOption}】获胜，正在结算并更新原帖…` };
  }

  if (sub === '撤销' || sub === '取消' || sub === 'cancel') {
    const num = parsePredictNum(cmd.args[1]);
    if (isNaN(num)) return { reply: '用法：预测 撤销 <编号>，例如「预测 撤销 3」。' };
    const proposal = getPredictByNum(num);
    if (!proposal) return { reply: `找不到 BET-${num}。` };
    if (proposal.status !== 'active') {
      return { reply: `BET-${num} 当前状态为「${STATUS_ZH[proposal.status] ?? proposal.status}」，无法撤销。` };
    }
    if (proposal.createdBy !== senderOpenId && !hasBadge(senderOpenId, PREDICT_JUDGE_BADGE_ID)) {
      return { reply: `只有发起人或社区预测裁判才能撤销 BET-${num}。` };
    }
    const { refunded, refundedLp } = cancelPredictWithRefund(proposal);
    try {
      const post = buildPredictCancelledPost(proposal, refunded);
      updateMessage(proposal.topMessageId, post, { as: 'bot', profile: larkProfile });
    } catch (e) {
      log.warn(`BET 撤销：更新原帖失败（BET-${proposal.num}）：${(e as Error).message}`);
    }
    return {
      reply:
        `BET-${proposal.num}【${proposal.title}】已撤销。` +
        (refunded > 0
          ? `已退还 ${refunded} 笔投注、共 ${refundedLp.toFixed(1)} LP。`
          : '本次没有需要退还的投注。'),
    };
  }

  if (sub === '查询' || sub === 'query') {
    return { reply: queryPredictReply(parsePredictNum(cmd.args[1])) };
  }

  return { reply: '用法：预测 宣布 <编号> <选项> | 预测 撤销 <编号> | 预测 查询 <编号>' };
}
