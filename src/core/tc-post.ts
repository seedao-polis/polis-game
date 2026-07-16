import type { PostElement } from './lark.js';
import type { TcProposal, TcBet } from './store/tc.js';

// Canonical knowledge-base entry that explains the intention-survey mechanism to community members.
const WIKI_URL = 'https://seedao2049.feishu.cn/wiki/LGK2wo8dGi2oDQkSsasc2i4Un0g';

// ── Formatting helpers ────────────────────────────────────────

/** Format unix seconds as "YYYY-MM-DD HH:mm" in local time. */
function fmtSec(sec: number): string {
  return new Date(sec * 1000)
    .toLocaleString('sv-SE', { hour12: false })
    .slice(0, 16)
    .replace('T', ' ');
}

/** Human label for how the community intention is derived from bets. */
function intentionMethod(proposal: TcProposal): string {
  return proposal.optionType === 'continuous' ? '加权均值' : '最高票选项';
}

/** First option token, used to build the bet example line. */
function firstOption(proposal: TcProposal): string {
  return proposal.optionType === 'discrete'
    ? String((proposal.options as string[])[0] ?? '选项')
    : String((proposal.options as [number, number])[0] ?? 0);
}

/** Option summary line for the active post header. */
function optionLine(proposal: TcProposal): string {
  if (proposal.optionType === 'discrete') {
    return `🔸选项：${(proposal.options as string[]).map(o => `【${o}】`).join(' / ')}`;
  }
  const [min, max] = proposal.options as [number, number];
  return `🔸选项范围：${min} – ${max}`;
}

/**
 * Summarise the current bet distribution for the active post.
 * Discrete: sorted list of options with their LP totals.
 * Continuous: weighted average (community intention) of all non-refunded bets.
 * Returns "暂无投注" when nobody has bet yet.
 */
function betSummary(proposal: TcProposal, bets: TcBet[]): string {
  const activeBets = bets.filter(b => !b.isRefunded);
  if (activeBets.length === 0) return '暂无投注';

  if (proposal.optionType === 'discrete') {
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
  const totalLp = activeBets.reduce((s, b) => s + b.lpAmount, 0);
  const weightedSum = activeBets.reduce((s, b) => s + parseFloat(b.optionValue) * b.lpAmount, 0);
  const avg = Math.round((weightedSum / totalLp) * 10000) / 10000;
  return `当前社区意向：${avg}（总投注 ${totalLp.toFixed(1)} LP）`;
}

// ── Post builders ─────────────────────────────────────────────

/**
 * Active-state post shown at the group top-level: the canonical proposal message that is edited
 * in-place on every bet. The post title carries the TC heading, so the body does not repeat it.
 */
function buildActivePost(
  proposal: TcProposal,
  bets: TcBet[],
): { title: string; content: PostElement[][] } {
  const lines: PostElement[][] = [
    [{ tag: 'text', text: optionLine(proposal) }],
    [{ tag: 'text', text: `🔸投注上限：${proposal.minBetLp} – ${proposal.maxBetLp} LP（每人累计上限 ${proposal.maxBetLp} LP）` }],
    [{ tag: 'text', text: `🔸结束时间：${fmtSec(proposal.endTime)}` }],
    [{ tag: 'text', text: `💡投注方式：在本群回复，@城邦土地神 [选项] [LP 数量]` }],
    [{ tag: 'text', text: `例：@城邦土地神 ${firstOption(proposal)} 5LP` }],
    [{ tag: 'text', text: '投注后就不可取消，可重复投注各选项，累计到投注上限为止' }],
    [{ tag: 'text', text: `了解更多 👉 ${WIKI_URL}` }],
    [{ tag: 'text', text: betSummary(proposal, bets) }],
  ];
  return { title: `【TC-${proposal.num}】${proposal.title}`, content: lines };
}

/**
 * Initial proposal post sent to the group top-level when a TC is created (no bets yet).
 */
export function buildTcProposalPost(
  proposal: TcProposal,
): { title: string; content: PostElement[][] } {
  return buildActivePost(proposal, []);
}

/**
 * Live result post: the same active layout with the current bet distribution, used to edit the
 * canonical post in-place after each bet.
 */
export function buildTcResultPost(
  proposal: TcProposal,
  bets: TcBet[],
): { title: string; content: PostElement[][] } {
  return buildActivePost(proposal, bets);
}

/**
 * Collapse per-bet winner payouts into one row per person (summed), ordered from highest total to
 * lowest. A winner who placed several winning bets therefore appears once with their combined payout.
 */
export function aggregateWinners(
  winners: Array<{ userOpenId: string; userName: string; amount: number }>,
): Array<{ userName: string; amount: number }> {
  const byUser = new Map<string, { name: string; amount: number }>();
  for (const w of winners) {
    const prev = byUser.get(w.userOpenId);
    if (prev) prev.amount += w.amount;
    else byUser.set(w.userOpenId, { name: w.userName, amount: w.amount });
  }
  return Array.from(byUser.values())
    .sort((a, b) => b.amount - a.amount)
    .map(w => ({ userName: w.name, amount: w.amount }));
}

/**
 * Final post shown when the survey ends: displays the community intention, participation incentive,
 * and the winner payout list. Replaces the canonical post in-place after settlement.
 */
export function buildTcSettledPost(
  proposal: TcProposal,
  bets: TcBet[],
  winners: Array<{ userOpenId: string; userName: string; amount: number }>,
): { title: string; content: PostElement[][] } {
  const activeBets = bets.filter(b => !b.isRefunded);
  const totalLp = activeBets.reduce((s, b) => s + b.lpAmount, 0);
  const method = intentionMethod(proposal);

  const intentionValue = proposal.optionType === 'continuous'
    ? (proposal.settledValue != null ? String(proposal.settledValue) : '')
    : (proposal.settledOption ?? '');
  const intentionLine = activeBets.length > 0
    ? `🔸社区意向：${intentionValue}（${method}）`
    : `🔸社区意向计算方式：${method}`;

  const agg = aggregateWinners(winners);
  const winnerLines = agg.length > 0
    ? agg.map(w => `  ${w.userName}  +${w.amount.toFixed(1)} LP`).join('\n')
    : '  （无参与者）';

  const lines: PostElement[][] = [
    [{ tag: 'text', text: '🔸调查进度：已结束' }],
    [{ tag: 'text', text: intentionLine }],
    [{ tag: 'text', text: `🔸总投注：${totalLp.toFixed(1)} LP （+5% 参与激励）` }],
    [{ tag: 'text', text: '🔸获奖名单：' }],
    [{ tag: 'text', text: winnerLines }],
    [{ tag: 'text', text: '💡投注选项最接近社区意向即可瓜分总投注 LP' }],
    [{ tag: 'text', text: `了解更多 👉 ${WIKI_URL}` }],
  ];
  return { title: `【TC-${proposal.num}】${proposal.title}`, content: lines };
}

/**
 * Post shown after a proposal is cancelled by its creator or an admin: every bet is refunded and the
 * survey is closed. Replaces the canonical post in-place.
 */
export function buildTcCancelledPost(
  proposal: TcProposal,
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
    [{ tag: 'text', text: `了解更多 👉 ${WIKI_URL}` }],
  ];
  return { title: `【TC-${proposal.num}】${proposal.title}`, content: lines };
}
