import type { PostElement } from './lark.js';
import type { PredictProposal, PredictBet } from './store/predict.js';
// Reused as-is: aggregateWinners is a generic { userOpenId, userName, amount } collapser with no
// TC-specific coupling, so the community-prediction settled post shares it rather than duplicating it.
import { aggregateWinners } from './tc-post.js';

export { aggregateWinners };

/** Community-prediction wiki explainer URL, linked from the active post's CTA line. */
const PREDICT_WIKI_URL = 'https://seedao2049.feishu.cn/wiki/Z2iXw4hmAiJ4BtkQPHBcWcCynBc';

/** CTA paragraph "了解更多 👉 社区预测", where 社区预测 is a clickable link to the wiki explainer. */
const LEARN_MORE_PARA: PostElement[] = [
  { tag: 'text', text: '了解更多 👉 ' },
  { tag: 'a', text: '社区预测', href: PREDICT_WIKI_URL },
];

// ── Formatting helpers ────────────────────────────────────────

/** Format unix seconds as "YYYY-MM-DD HH:mm" in local time. */
function fmtSec(sec: number): string {
  return new Date(sec * 1000)
    .toLocaleString('sv-SE', { hour12: false })
    .slice(0, 16)
    .replace('T', ' ');
}

/** Option summary line for the active post header. */
function optionLine(proposal: PredictProposal): string {
  return `🔸选项：${proposal.options.map(o => `【${o}】`).join(' / ')}`;
}

/**
 * Summarise the current bet distribution for the active post: sorted list of options with their
 * LP totals. Returns "暂无投注" when nobody has bet yet.
 */
function betSummary(bets: PredictBet[]): string {
  const activeBets = bets.filter(b => !b.isRefunded);
  if (activeBets.length === 0) return '暂无投注';

  const lpByOption: Record<string, number> = {};
  for (const b of activeBets) {
    lpByOption[b.optionValue] = (lpByOption[b.optionValue] ?? 0) + b.lpAmount;
  }
  const dist = Object.entries(lpByOption)
    .sort((a, b) => b[1] - a[1])
    .map(([opt, lp]) => `  【${opt}】${lp.toFixed(1)} LP`)
    .join('\n');
  return `当前投注分布：\n${dist}`;
}

// ── Post builders ─────────────────────────────────────────────

/**
 * Active-state post shown at the group top-level: the canonical proposal message that is edited
 * in-place on every bet. The post title carries the heading, so the body does not repeat it.
 * Unlike TC, the result is decided by a 社区预测裁判 announcement rather than an automatic algorithm
 * at end_time, so the deadline is framed as "投注截止" (stops bet acceptance) rather than "调查结束".
 */
function buildActivePost(
  proposal: PredictProposal,
  bets: PredictBet[],
): { title: string; content: PostElement[][] } {
  const lines: PostElement[][] = [
    [{ tag: 'text', text: optionLine(proposal) }],
    [{ tag: 'text', text: `🔸投注上限：${proposal.minBetLp} – ${proposal.maxBetLp} LP（每人累计上限 ${proposal.maxBetLp} LP）` }],
    [{ tag: 'text', text: `🔸投注截止：${fmtSec(proposal.endTime)}` }],
    [{ tag: 'text', text: `💡投注方式：在本群回复，@城邦土地神 [选项] [LP 数量]` }],
    [{ tag: 'text', text: `例：@城邦土地神 ${proposal.options[0] ?? '选项'} 5LP` }],
    [{ tag: 'text', text: '投注后就不可取消，可重复投注各选项，累计到投注上限为止' }],
    LEARN_MORE_PARA,
    [{ tag: 'text', text: betSummary(bets) }],
  ];
  return { title: `【BET-${proposal.num}】${proposal.title}`, content: lines };
}

/**
 * Initial proposal post sent to the group top-level when a prediction is created (no bets yet).
 */
export function buildPredictProposalPost(
  proposal: PredictProposal,
): { title: string; content: PostElement[][] } {
  return buildActivePost(proposal, []);
}

/**
 * Live result post: the same active layout with the current bet distribution, used to edit the
 * canonical post in-place after each bet.
 */
export function buildPredictResultPost(
  proposal: PredictProposal,
  bets: PredictBet[],
): { title: string; content: PostElement[][] } {
  return buildActivePost(proposal, bets);
}

/**
 * Final post shown once a 社区预测裁判 announces the winning option: displays the announced result,
 * the prize pool, the winner payout list and the public-welfare chest contribution. Replaces the
 * canonical post in-place after settlement.
 *
 * Settlement mints LP at two separate rates and the post states both, because they are easily
 * confused for each other: the pool carries a +5% 参与激励 paid to the winners, while the chest gets
 * a further 10% of that pool, extra-minted and never deducted from anyone's payout. Showing the
 * pool as an absolute LP figure (not just "+5%" against the raw stake) is what lets a reader
 * reconcile the winner list against it — the payouts are floored to 0.1 LP each, so they sum to
 * slightly less than the pool and would otherwise look wrong.
 */
export function buildPredictSettledPost(
  proposal: PredictProposal,
  bets: PredictBet[],
  winners: Array<{ userOpenId: string; userName: string; amount: number }>,
  announcerName: string,
  chestContribution = 0,
): { title: string; content: PostElement[][] } {
  const activeBets = bets.filter(b => !b.isRefunded);
  const totalLp = activeBets.reduce((s, b) => s + b.lpAmount, 0);
  const pool = totalLp * 1.05;

  const resultLine = `🔸裁判宣布结果：【${proposal.settledOption ?? ''}】获胜（由 ${announcerName} 宣布）`;

  const agg = aggregateWinners(winners);
  const winnerLines = agg.length > 0
    ? agg.map(w => `  ${w.userName}  +${w.amount.toFixed(1)} LP`).join('\n')
    : '  （无人押中该选项）';

  const lines: PostElement[][] = [
    [{ tag: 'text', text: '🔸调查进度：已结算' }],
    [{ tag: 'text', text: resultLine }],
    [{ tag: 'text', text: `🔸总投注：${totalLp.toFixed(1)} LP` }],
    [{ tag: 'text', text: `🔸激励：${pool.toFixed(2)} LP （含 +5% 额外奖励）` }],
    [{ tag: 'text', text: '🔸获奖名单：' }],
    [{ tag: 'text', text: winnerLines }],
  ];
  // A zero contribution means the proposal drew no bets at all — there is no chest transfer to report.
  if (chestContribution > 0) {
    lines.push([{ tag: 'text', text: `🔸公益宝箱：+${chestContribution.toFixed(2)} LP （10% 奖励）` }]);
  }
  lines.push([{ tag: 'text', text: '💡投注选项与裁判宣布结果一致即可瓜分总投注 LP' }]);

  return { title: `【BET-${proposal.num}】${proposal.title}`, content: lines };
}

/**
 * Post shown after a proposal is cancelled by its creator or a 社区预测裁判: every bet is refunded and
 * the prediction is closed. Replaces the canonical post in-place.
 */
export function buildPredictCancelledPost(
  proposal: PredictProposal,
  refunded: number,
): { title: string; content: PostElement[][] } {
  const lines: PostElement[][] = [
    [{ tag: 'text', text: '🔸调查进度：已撤销' }],
    [{
      tag: 'text',
      text: refunded > 0
        ? `🔸已退还全部投注（${refunded} 笔），LP 已原路返还`
        : '🔸本次没有投注需要退还',
    }],
  ];
  return { title: `【BET-${proposal.num}】${proposal.title}`, content: lines };
}
