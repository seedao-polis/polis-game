import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.js';
import * as store from './store.js';
import { isPgUnavailableError, PG_UNAVAILABLE_REPLY_ZH } from './db.js';
import {
  subscribeMeetupTag,
  unsubscribeMeetupTag,
  listMeetupSubscriptions,
  getMeetupById,
  cancelMeetup as storeCancelMeetup,
} from './store/meetups.js';
import { loadConfigs, resolveChatTarget, isAdmin } from './configs.js';
import { cancelCalendarEvent, updateMessage } from './lark.js';
import { refreshMeetupWiki } from './meetup-wiki.js';
import {
  getTcByNum,
  getTcBets,
  cancelTcProposal,
  getUnrefundedBets,
  markBetRefunded,
  updateTcProposal,
} from './store/tc.js';
import { buildTcResultPost } from './tc-post.js';
import { grantPt } from './store/gamification.js';
import { queryPredictReply } from './predict-command.js';

// ── command mode (pure code, no LLM / kimi) ───────────────────
// After being triggered (@ or prefix), the message is passed here first: strip the leading @mention → split on whitespace,
// the first token is the command name and the rest are the arguments. Only when the command name hits the registry is it handled as a command and replied to directly;
// on a miss it returns { handled:false }, and the caller hands it off to the agent (kimi) to answer as usual.

export interface CommandContext {
  /** agent / soul display name */
  agentName: string;
  /** identity: user / bot / cli */
  identity?: string;
  /** source channel name (feishu-bot / feishu-user / cli) */
  source: string;
  /** chat id of the current group (if any) */
  chatId?: string;
  /** sender open_id, used for profile-related commands */
  senderOpenId?: string;
}

export interface Command {
  /** primary command name (lowercase) */
  name: string;
  /** aliases (lowercase) */
  aliases?: string[];
  /** one-line description used in the help list */
  summary: string;
  /** usage string used by help <command> */
  usage?: string;
  /** execute: returns the plain-text reply to send */
  run(args: string[], ctx: CommandContext): Promise<string>;
}

export interface DispatchResult {
  /** whether it was handled as a command (if true, it should not go through the LLM) */
  handled: boolean;
  /** the text to reply with on a hit */
  reply?: string;
  /** the matched command name (for logging) */
  command?: string;
  /** the parsed arguments passed to the command */
  args?: string[];
}

/** A leading @mention + whitespace (like @tudigong / @_user_1); there may be several in a row. */
const LEADING_MENTION = /^@\S+\s+/;

/**
 * Tolerant LP-amount parser for bet input.
 * Accepts: "5", "5LP", "5lp", "5 LP", "5 lp" — all resolve to the number 5.
 * Returns a positive finite number, or null when the input does not match the expected format.
 */
export function parseLpAmount(tokens: string[]): number | null {
  const s = tokens.join('').trim().toLowerCase().replace(/\s+/g, '');
  const m = /^(\d+(?:\.\d+)?)(?:lp)?$/.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]!);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Parse a message: strip the leading @mention, allow an optional / or ! prefix, then split on whitespace.
 * Returns { name, args }; returns null if there is no parseable command name.
 */
export function parseCommand(raw: string): { name: string; args: string[] } | null {
  let s = (raw ?? '').trim();
  while (LEADING_MENTION.test(s)) s = s.replace(LEADING_MENTION, '');
  if (!s || s.startsWith('@')) return null; // just an @ with no content
  s = s.replace(/^[/!]/, '').trim(); // optional / or ! prefix
  if (!s) return null;
  const parts = s.split(/\s+/);
  return { name: parts[0].toLowerCase(), args: parts.slice(1) };
}

/** Strip the leading @mention(s) and an optional / or ! prefix, returning the trimmed body. */
function stripLead(raw: string): string {
  let s = (raw ?? '').trim();
  while (LEADING_MENTION.test(s)) s = s.replace(LEADING_MENTION, '');
  return s.replace(/^[/!]/, '').trim();
}

/** Strip leading/trailing half-width AND full-width (U+3000) spaces — used for the 改名 argument. */
function trimEdgeSpaces(s: string): string {
  return s.replace(/^[\s　]+/, '').replace(/[\s　]+$/, '');
}

// ── fuzzy daily check-in ──────────────────────────────────────
// The bare forms 签 / 签到 are already `sign` command aliases. On top of that, a SHORT message (under
// CHECKIN_MAX_LEN characters) whose text ends in 签到 or 签 also counts as a daily check-in — so
// "每日签到" or "8/12 签" work without being an exact command. The length cap keeps a longer sentence
// that merely happens to end in 签 from being swallowed as a check-in.
const CHECKIN_MAX_LEN = 15;

export function isFuzzyCheckIn(raw: string): boolean {
  const s = stripLead(raw);
  if (!s || s.length >= CHECKIN_MAX_LEN) return false;
  return /(签到|签)$/.test(s);
}

// ── fuzzy LP-balance query ────────────────────────────────────
// The bare form 我的 is already a `profile` alias, but a member usually asks in natural language
// ("看我现在有多少 LP", "我还有多少积分", "查一下我的 LP"). A SHORT message that mentions LP/积分/生命点 AND
// reads as "how much do I have" is answered deterministically by the profile command — so a plain
// balance check never reaches the LLM (fast, free, and immune to a provider content-moderation reject).
// The length cap keeps a longer sentence that merely happens to mention LP from being swallowed.
const LP_QUERY_MAX_LEN = 30;

export function isFuzzyLpQuery(raw: string): boolean {
  const s = stripLead(raw).replace(/\s+/g, '').toLowerCase();
  if (!s || s.length > LP_QUERY_MAX_LEN) return false;
  if (!/(lp|积分|生命点)/.test(s)) return false; // must be about LP at all
  // A bet-status question ("我西班牙的押注 LP 呢", "我投注的 LP 什么时候结算") is self-referential and mentions
  // LP, but there the LP is a wager, not the account balance. Betting keywords disqualify it so it falls
  // through to the LLM instead of being answered with the balance — the "我" modifies the bet, not "我有多少 LP".
  if (/押注|投注|下注|押|赌|结算|中奖|赔|提案|输了|赢/.test(s)) return false;
  // A balance check reads as self-referential, a query verb, or a "how much / remaining" quantity.
  // Mechanism questions ("怎么获得LP", "LP是什么", "LP怎么用") carry none of these — and longer ones are
  // excluded by the length cap — so they still fall through to the LLM.
  return /我|自己|查|多少|几多|余额|还有|剩/.test(s);
}

// Human-readable label for an LP ledger reason code (shown in the `lp` recent-changes list). Unknown
// reasons fall back to their prefix family, then to the raw string, so the list never shows blanks.
function humanizeLpReason(reason: string): string {
  const exact: Record<string, string> = {
    first_contact: '初次建档',
    daily_checkin: '每日签到',
    daily_floor_reset: '每日补底',
    llm_reply: '对话回复',
    manual_reset: '统一重置',
    'welcome:self-intro': '收录自介',
  };
  if (exact[reason]) return exact[reason];
  if (reason.startsWith('event:')) {
    const ev: Record<string, string> = {
      'like-maniac-notify': '点赞狂魔',
      'first-try-notify': '尝新奖励',
      'lurker-discovered': '潜水被发现',
    };
    return ev[reason.slice(6)] ?? '活动奖励';
  }
  if (reason.startsWith('tc_')) return '意向调查';
  if (reason.startsWith('predict_chest_')) return '宝箱';
  if (reason.startsWith('predict_')) return '社区预测';
  if (reason.startsWith('chest_')) return '宝箱';
  if (reason.startsWith('refund')) return '退款';
  if (reason.startsWith('judge_')) return '对话评分';
  if (reason.startsWith('task:')) return '任务奖励';
  if (reason.startsWith('manual:')) return '运营调整';
  return reason || '变动';
}

/** Compact local timestamp "MM-DD HH:mm" for a unix-second ledger time. */
function fmtLpWhen(createdAtSec: number): string {
  if (!createdAtSec) return '';
  const t = new Date(createdAtSec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

// ── self-service rename (改名) ─────────────────────────────────
// "@我 改名 <名字>" lets a member rename themselves. The name may be glued to 改名 ("改名Vicky") or
// separated by a half/full-width space ("改名 Vicky Huang"), and may itself contain spaces, so this is
// parsed directly rather than through the whitespace-splitting command tokenizer. Only the head/tail
// spaces of the name are trimmed. The new name is stored keyed by open_id (see store.setPreferredName),
// so every display surface resolves it by identity and a future rename stays cheap.
const RENAME_PREFIX = /^改名/;
const MAX_NAME_LEN = 40;
const RENAME_USAGE = '改名用法：@我 改名 <新名字>，例如「改名 Vicky」或「改名 Vicky Huang」。名字会自动去掉首尾空白。';

/**
 * Extract the requested new name from a "改名…" message. Returns the trimmed name, an empty string when
 * the message is a bare "改名" with no name (caller shows usage), or null when it is not a rename at all.
 */
export function parseRename(raw: string): string | null {
  const s = stripLead(raw);
  if (!RENAME_PREFIX.test(s)) return null;
  const rest = trimEdgeSpaces(s.slice(2)); // drop the 2-char 改名 prefix; '' = no name supplied
  // A question ("改名怎么操作？") is not a rename — let the LLM answer it instead of renaming to it.
  if (/[?？]/.test(rest)) return null;
  return rest;
}

async function applyRename(rawName: string, ctx: CommandContext): Promise<string> {
  if (!ctx.senderOpenId) {
    return '无法确认你的身份（缺少 sender open_id），请在飞书群里 @ 我使用改名。';
  }
  const name = trimEdgeSpaces(rawName ?? '');
  if (!name) return RENAME_USAGE;
  if (name.includes('\n') || [...name].length > MAX_NAME_LEN) {
    return `新名字不太合适（不能换行，且最多 ${MAX_NAME_LEN} 个字），请换一个短一点的再试。`;
  }
  // Resolve the current display name (already override-aware) before writing, so we can echo old → new.
  const before = (await store.memberName(ctx.senderOpenId)) || (await store.getProfile(ctx.senderOpenId))?.name || '';
  const saved = await store.setPreferredName(ctx.senderOpenId, name);
  if (!saved) return RENAME_USAGE;
  return before && before !== saved
    ? `好的，已把你的名字从【${before}】改成【${saved}】，之后我在城邦里都会这样称呼你。`
    : `好的，已把你的名字设为【${saved}】，之后我在城邦里都会这样称呼你。`;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Ownership gate for managing (cancel / edit) a meetup: only the original creator may manage it, with
 * the operator (admin) allowed to override. Fail-closed — an empty / unknown sender is refused. This
 * lives in the deterministic command layer, which is the single authoritative path: there is no
 * LLM-callable calendar tool and no natural-language cancel / edit marker, so a serve user cannot
 * reach calendar update / delete except through this gate.
 */
function canManageMeetup(senderOpenId: string | undefined, creatorOpenId: string): boolean {
  const sender = senderOpenId ?? '';
  if (!sender) return false;
  if (sender === creatorOpenId) return true;
  return isAdmin(sender);
}

/** Resolve a display name for a subscriber's open_id (roster → profile → fallback "你"). */
async function subscriberName(openId: string): Promise<string> {
  return (await store.memberName(openId)) || (await store.getProfile(openId))?.name || '你';
}

// ── TC helper functions ──────────────────────────────────────

/** Ownership gate: proposal creator and admins may cancel or edit a TC. */
function canManageTc(senderOpenId: string, proposal: { createdBy: string }): boolean {
  if (!senderOpenId) return false;
  if (isAdmin(senderOpenId)) return true;
  return senderOpenId === proposal.createdBy;
}

/**
 * Build a plain-text reply describing the current state and bet distribution of a proposal.
 * Used by the tc-query command and the @土地神 TC-N shorthand.
 */
async function queryTcReply(num: number): Promise<string> {
  if (isNaN(num)) return '请提供有效的 TC 编号，例如：TC-1 或 tc query 1';
  const proposal = await getTcByNum(num);
  if (!proposal) return `找不到 TC-${num}。`;
  const bets = await getTcBets(proposal.id);
  const activeBets = bets.filter(b => !b.isRefunded);
  const totalLp = activeBets.reduce((s, b) => s + b.lpAmount, 0);
  const participants = new Set(activeBets.map(b => b.userOpenId)).size;

  const statusStr = proposal.status === 'active'
    ? `进行中，截止 ${new Date(proposal.endTime * 1000).toLocaleString('sv-SE').slice(0, 16)}`
    : proposal.status === 'settled'
    ? `已结算，基准值：${proposal.settledOption ?? String(proposal.settledValue)}`
    : '已撤销';

  const lines: string[] = [
    `【TC-${proposal.num}】${proposal.title}`,
    `状态：${statusStr}`,
    `参与：${participants} 人  总投入：${totalLp.toFixed(1)} LP  奖金池：${(totalLp * 1.05).toFixed(1)} LP`,
    '',
  ];

  if (proposal.optionType === 'discrete') {
    const lpByOption: Record<string, number> = {};
    for (const b of activeBets) {
      lpByOption[b.optionValue] = (lpByOption[b.optionValue] ?? 0) + b.lpAmount;
    }
    const sorted = Object.entries(lpByOption).sort((a, b) => b[1] - a[1]);
    for (const [opt, lp] of sorted) {
      lines.push(`  【${opt}】${lp.toFixed(1)} LP`);
    }
  } else {
    if (activeBets.length > 0) {
      const totalLpC = activeBets.reduce((s, b) => s + b.lpAmount, 0);
      const weightedSum = activeBets.reduce((s, b) => s + parseFloat(b.optionValue) * b.lpAmount, 0);
      const avg = Math.round((weightedSum / totalLpC) * 10000) / 10000;
      lines.push(`  当前加权均值：${avg}`);
    }
  }
  lines.push('', '🌱 LP');
  return lines.join('\n');
}

/**
 * Refund all outstanding (non-refunded) bets on a proposal.
 * Strategy: mark is_refunded=1 in per-soul db first, then grantPt in shared db.
 * If grantPt fails after marking, the bet is counted as skipped (conservative "under-refund").
 * The caller should log any discrepancy for manual recovery.
 * Returns the count of successfully refunded bets.
 */
async function refundTcBets(proposal: { id: number; topMessageId: string }): Promise<{ refunded: number }> {
  const pending = await getUnrefundedBets(proposal.id);
  let refunded = 0;
  for (const bet of pending) {
    try {
      await markBetRefunded(bet.id);
      await grantPt(bet.userOpenId, bet.lpAmount, 'tc_refund_cancel', proposal.topMessageId);
      refunded++;
    } catch {
      // grantPt failed after marking refunded — conservative under-refund; log externally
    }
  }
  return { refunded };
}

// ── built-in commands ─────────────────────────────────────────
// To add a command later, just append an entry to this array; help will list it automatically.
const COMMANDS: Command[] = [
  {
    name: 'help',
    aliases: ['?', '命令', 'commands', 'menu'],
    summary: '显示命令列表，或某个命令的用法',
    usage: 'help [命令]',
    async run(args, ctx) {
      if (args[0]) {
        const c = lookup(args[0]);
        if (!c) return `没有这个命令：${args[0]}。发送 help 查看全部命令。`;
        const alias = c.aliases?.length ? `（别名：${c.aliases.join('、')}）` : '';
        return `📖 ${c.name}${alias}\n  ${c.summary}\n  用法：${c.usage ?? c.name}`;
      }
      const width = Math.max(...COMMANDS.map((c) => c.name.length));
      const lines = COMMANDS.map((c) => `  ${c.name.padEnd(width + 2)}${c.summary}`);
      const how = ctx.source.startsWith('feishu') ? '@我 后接命令' : '直接输入命令';
      return [
        `📖 ${ctx.agentName} 支持以下命令（${how}即可）：`,
        ...lines,
        '',
        '其他消息会照常交给我用 AI 回复。',
      ].join('\n');
    },
  },
  {
    name: 'ping',
    summary: '测试我是否在线',
    run: async () => 'pong 🏓',
  },
  {
    name: 'version',
    aliases: ['ver', 'v'],
    summary: '显示我的版本',
    run: async (_args, ctx) => `${ctx.agentName} v${readVersion()}`,
  },
  {
    name: 'whoami',
    aliases: ['id'],
    summary: '显示我的身份与运行信息',
    run: async (_args, ctx) =>
      [
        `名字：${ctx.agentName}`,
        ctx.identity ? `身份：${ctx.identity}` : null,
        `频道：${ctx.source}`,
        ctx.chatId ? `群：${ctx.chatId}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
  },
  {
    name: 'profile',
    aliases: ['我的', 'me'],
    summary: '查看自己的 LP 与已获徽章',
    usage: 'profile',
    async run(_args, ctx) {
      if (!ctx.senderOpenId) {
        return '无法确认你的身份（缺少 sender open_id），请在飞书群内使用此命令。';
      }
      const p = await store.getProfile(ctx.senderOpenId);
      if (!p) {
        return '你还没有档案，和我互动一次就会自动建立！';
      }
      const badges = await store.listBadges(ctx.senderOpenId);
      const badgeStr = badges.length
        ? badges.map((b) => `${b.emoji || ''}${b.name}`).join('、')
        : '（暂无）';
      return [
        `👤 ${p.name || ctx.senderOpenId}`,
        `🌱 LP：${p.ptBalance.toFixed(1)}`,
        `🎖 徽章：${badgeStr}`,
      ].join('\n');
    },
  },
  {
    name: 'lp',
    aliases: ['积分', '生命点'],
    summary: '查看自己的 LP 与最近 3 笔变化',
    usage: 'lp',
    async run(_args, ctx) {
      if (!ctx.senderOpenId) {
        return '无法确认你的身份（缺少 sender open_id），请在飞书群内使用此命令。';
      }
      const p = await store.getProfile(ctx.senderOpenId);
      if (!p) {
        return '你还没有档案，和我互动一次就会自动建立！';
      }
      const recent = await store.recentPtLedger(ctx.senderOpenId, 3);
      const lines = [`🌱 ${p.name || ctx.senderOpenId} 当前 LP：${p.ptBalance.toFixed(1)}`];
      if (recent.length === 0) {
        lines.push('', '（暂无 LP 变化记录）');
      } else {
        lines.push('', `最近 ${recent.length} 笔变化：`);
        for (const e of recent) {
          const sign = e.delta >= 0 ? '+' : '';
          lines.push(`· ${humanizeLpReason(e.reason)} ${sign}${e.delta.toFixed(1)}（${fmtLpWhen(e.createdAt)}）`);
        }
      }
      return lines.join('\n');
    },
  },
  {
    name: 'leaderboard',
    aliases: ['榜', '排行'],
    summary: '显示 LP 排行榜前十名',
    usage: 'leaderboard',
    async run() {
      const rows = await store.leaderboard(10);
      if (rows.length === 0) return '（排行榜暂无数据）';
      const lines = rows.map((r, i) => `${i + 1}. ${r.name || r.openId}  ${r.ptBalance.toFixed(1)} LP`);
      return ['🏆 LP 排行榜', ...lines].join('\n');
    },
  },
  {
    name: 'sign',
    aliases: ['签', '簽', '签到', '簽到', 'checkin'],
    summary: '每日签到，领取 LP',
    usage: 'sign',
    async run(_args, ctx) {
      if (!ctx.senderOpenId) {
        return '无法确认你的身份（缺少 sender open_id），请在飞书群内使用此命令。';
      }
      let r: Awaited<ReturnType<typeof store.checkIn>>;
      try {
        r = await store.checkIn(ctx.senderOpenId);
      } catch (e) {
        if (isPgUnavailableError(e)) return PG_UNAVAILABLE_REPLY_ZH;
        throw e;
      }
      if (r.firstToday) {
        return '在 SeeDAO 数字城邦签到' + (await store.buildStatusFooter(ctx.senderOpenId, r.awarded));
      }
      const mmdd = `${r.date.slice(5, 7)}/${r.date.slice(8, 10)}`;
      return `今天 (${mmdd}) 你已在 SeeDAO 数字城邦签到了` + (await store.buildStatusFooter(ctx.senderOpenId, 0));
    },
  },
  {
    name: 'rename',
    aliases: ['改名'],
    summary: '给自己改名（@我 改名 <新名字>）',
    usage: 'rename <新名字>',
    // "改名…" is normally intercepted by parseRename in dispatchCommand (to support the no-space and
    // spaces-in-name forms); this entry lists it in help and also handles the English "rename <name>".
    run: async (args, ctx) => applyRename(args.join(' '), ctx),
  },
  {
    name: 'follow',
    aliases: ['订阅'],
    summary: '订阅活动标签，有新会议时在群里收到 @ 提醒',
    usage: 'follow <标签>',
    async run(args, ctx) {
      if (!ctx.senderOpenId) return '无法确认你的身份，请在飞书群内使用此命令。';
      const tag = args[0]?.trim();
      if (!tag) return '请提供标签名，例如：follow 共学';
      const who = await subscriberName(ctx.senderOpenId);
      const added = await subscribeMeetupTag(ctx.senderOpenId, tag);
      return added
        ? `${who}，已为你订阅标签【${tag}】，有该标签的活动我会在群里 @ 你。`
        : `${who}，你之前已经订阅过【${tag}】了，无需重复订阅。`;
    },
  },
  {
    name: 'unfollow',
    aliases: ['取消订阅'],
    summary: '取消订阅活动标签',
    usage: 'unfollow <标签>',
    async run(args, ctx) {
      if (!ctx.senderOpenId) return '无法确认你的身份，请在飞书群内使用此命令。';
      const tag = args[0]?.trim();
      if (!tag) return '请提供标签名，例如：unfollow 共学';
      const who = await subscriberName(ctx.senderOpenId);
      const removed = await unsubscribeMeetupTag(ctx.senderOpenId, tag);
      return removed ? `${who}，已为你取消订阅【${tag}】。` : `${who}，你本来就没有订阅【${tag}】。`;
    },
  },
  {
    name: 'follows',
    aliases: ['我的订阅'],
    summary: '查看你当前订阅的活动标签',
    usage: 'follows',
    async run(_args, ctx) {
      if (!ctx.senderOpenId) return '无法确认你的身份，请在飞书群内使用此命令。';
      const who = await subscriberName(ctx.senderOpenId);
      const tags = await listMeetupSubscriptions(ctx.senderOpenId);
      if (tags.length === 0) return `${who}，你还没有订阅任何活动标签。发送 follow <标签> 即可订阅。`;
      return `${who}，你当前订阅的标签：${tags.map((t) => `【${t}】`).join('、')}`;
    },
  },
  {
    name: 'meetup',
    summary: '管理活动会议（cancel / edit）',
    usage: 'meetup cancel <id>  |  meetup edit <id> --title <新标题>',
    async run(args, ctx) {
      const sub = args[0]?.toLowerCase();

      // meetup cancel <id>: soft-cancel in DB and delete from Feishu calendar
      if (sub === 'cancel' || sub === '取消') {
        const id = Number(args[1]);
        if (!id) return '用法：meetup cancel <会议编号>（整数 id，见 agent meetup 列表）';
        const mtg = await getMeetupById(id);
        if (!mtg) return `找不到编号 ${id} 的会议。`;
        if (mtg.status === 'cancelled') return `会议【${mtg.title}】已经是已取消状态。`;
        if (!canManageMeetup(ctx.senderOpenId, mtg.createdBy)) {
          return `只有活动发起人才能取消【${mtg.title}】。请用发起时的同一账号操作。`;
        }

        // Resolve the activity calendar id from lark.json.
        let calendarId = mtg.calendarId;
        try {
          const cfg = loadConfigs();
          calendarId = cfg.lark.activityCalendarId ?? calendarId;
        } catch { /* use the stored calendar_id as fallback */ }

        const larkOk = await cancelCalendarEvent(calendarId, mtg.larkEventId);
        await storeCancelMeetup(id);
        await refreshMeetupWiki(); // mirror the cancellation to the "SeeDAO 活动日历" wiki page
        return larkOk
          ? `已取消会议【${mtg.title}】（飞书日历已删除，本地已标记取消）。`
          : `本地已标记取消【${mtg.title}】，但飞书日历删除失败，请手动检查。`;
      }

      // meetup edit: in-group edit is not exposed (directs to the operator CLI). Still gate on
      // ownership so a non-creator is told they cannot edit it, rather than pointed at a command
      // that would not accept them anyway.
      if (sub === 'edit' || sub === '编辑') {
        const id = Number(args[1]);
        const mtg = id ? await getMeetupById(id) : null;
        if (mtg && !canManageMeetup(ctx.senderOpenId, mtg.createdBy)) {
          return `只有活动发起人才能编辑【${mtg.title}】。`;
        }
        return '活动编辑请使用管理员 CLI 命令：pnpm agent meetup edit <id> [--title ...] [--start ...] [--end ...]';
      }

      return `未知子命令【${sub}】。支持：meetup cancel <id> / meetup edit <id>`;
    },
  },
  {
    name: 'tc',
    summary: '管理投注提案（query / cancel / edit）',
    usage: 'tc query <编号>  |  tc cancel <编号>  |  tc edit <编号> [--max-bet N] [--end "YYYY-MM-DD HH:mm"]',
    async run(args, ctx) {
      const sub = args[0]?.toLowerCase();
      if (!sub) return '用法：tc cancel <编号>  /  tc query <编号>\n或直接 @我 TC-1 查询进展';

      if (sub === 'query' || sub === '查询') {
        const num = parseInt(args[1] ?? '', 10);
        return queryTcReply(num);
      }

      if (sub === 'cancel' || sub === '撤销' || sub === '取消') {
        const num = parseInt(args[1] ?? '', 10);
        if (isNaN(num)) return '用法：tc cancel <编号>，例如：tc cancel 1';
        const proposal = await getTcByNum(num);
        if (!proposal) return `找不到 TC-${num}。`;
        if (proposal.status === 'cancelled') return `TC-${num} 已经是撤销状态。`;
        if (proposal.status === 'settled') return `TC-${num} 已结算，不能撤销。`;
        if (!ctx.senderOpenId) return '无法确认你的身份，请在群内使用此命令。';
        if (!canManageTc(ctx.senderOpenId, proposal)) {
          return `只有提案发起人或管理员才能撤销 TC-${proposal.num}。`;
        }
        const result = await refundTcBets(proposal);
        await cancelTcProposal(proposal.id);
        // Best-effort: update the original post to show cancelled state
        try {
          const bets = await getTcBets(proposal.id);
          const post = buildTcResultPost({ ...proposal, status: 'cancelled' }, bets);
          await updateMessage(proposal.topMessageId, post, { as: 'bot' });
        } catch { /* ignore */ }
        return `TC-${proposal.num}【${proposal.title}】已撤销，已退还 ${result.refunded} 笔投注 LP。\n🌱 LP`;
      }

      if (sub === 'edit' || sub === '编辑') {
        const num = parseInt(args[1] ?? '', 10);
        if (isNaN(num)) return '用法：tc edit <编号> [--max-bet N] [--end "YYYY-MM-DD HH:mm"]';
        const proposal = await getTcByNum(num);
        if (!proposal) return `找不到 TC-${num}。`;
        if (!ctx.senderOpenId || !isAdmin(ctx.senderOpenId)) {
          return 'TC 内容修改仅限管理员操作（提案人只能撤销）。';
        }
        const updates: { maxBetLp?: number; endTime?: number } = {};
        // Parse --max-bet flag
        const maxBetIdx = args.indexOf('--max-bet');
        if (maxBetIdx !== -1 && args[maxBetIdx + 1]) {
          const v = parseFloat(args[maxBetIdx + 1]!);
          if (Number.isFinite(v) && v > 0) updates.maxBetLp = v;
        }
        // Parse --end flag ("YYYY-MM-DD HH:mm" or ISO 8601)
        const endIdx = args.indexOf('--end');
        if (endIdx !== -1 && args[endIdx + 1]) {
          const raw = args[endIdx + 1]!;
          const t = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T'));
          if (Number.isFinite(t)) updates.endTime = Math.floor(t / 1000);
        }
        if (Object.keys(updates).length === 0) {
          return 'tc edit：请提供 --max-bet 或 --end 参数。';
        }
        const ok = await updateTcProposal(proposal.id, updates);
        return ok
          ? `TC-${num} 已更新（${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join('  ')}）。`
          : `TC-${num} 更新失败（无有效变更）。`;
      }

      return `未知子命令【${sub}】。支持：tc query <编号> / tc cancel <编号> / tc edit <编号>`;
    },
  },
];

// Index from name / alias → command.
const INDEX = new Map<string, Command>();
for (const c of COMMANDS) {
  INDEX.set(c.name, c);
  for (const a of c.aliases ?? []) INDEX.set(a.toLowerCase(), c);
}

function lookup(name: string): Command | undefined {
  return INDEX.get(name.toLowerCase());
}

/** List all commands (for external use, e.g. a hint when the CLI starts). */
export function listCommands(): Command[] {
  return [...COMMANDS];
}

/** Run a resolved command body, treating a throw as handled (returns an error reply, never falls to the LLM). */
async function handle(command: string, args: string[], run: () => Promise<string>): Promise<DispatchResult> {
  try {
    return { handled: true, command, args, reply: await run() };
  } catch (e) {
    return { handled: true, command, args, reply: `命令【${command}】执行出错：${(e as Error).message}` };
  }
}

/**
 * Try to handle the message as a command. Hit → { handled:true, reply }; miss → { handled:false }.
 * If the command itself throws, it is still treated as handled and returns an error message (does not fall back to the LLM).
 */
export async function dispatchCommand(raw: string, ctx: CommandContext): Promise<DispatchResult> {
  // Self-service rename ("改名 <名字>") — checked before the tokenizer so the name may be glued to 改名
  // or contain spaces. A bare "改名" (empty name) is still handled, replying with usage.
  const renameName = parseRename(raw);
  if (renameName !== null) {
    return handle('rename', renameName ? [renameName] : [], () => applyRename(renameName, ctx));
  }

  const parsed = parseCommand(raw);
  const cmd = parsed ? lookup(parsed.name) : undefined;
  if (parsed && cmd) {
    return handle(cmd.name, parsed.args, () => cmd.run(parsed.args, ctx));
  }

  // TC quick-query shorthand: "@土地神 TC-1" — parseCommand yields name="tc-1" which is not
  // in the command index, so intercept it here before falling through to the LLM.
  if (parsed) {
    const tcNumMatch = /^tc-(\d+)$/i.exec(parsed.name);
    if (tcNumMatch) {
      const num = parseInt(tcNumMatch[1]!, 10);
      return handle('tc-query', [String(num)], () => queryTcReply(num));
    }
  }

  // Community-prediction quick-query shorthand: "@土地神 BET-1" — same shape as the TC-N shorthand
  // above. queryPredictReply is the single authoritative query implementation (predict-command.ts);
  // this is only a lookup-table entry point, not a second implementation.
  if (parsed) {
    const predictNumMatch = /^bet-(\d+)$/i.exec(parsed.name);
    if (predictNumMatch) {
      const num = parseInt(predictNumMatch[1]!, 10);
      return handle('predict-query', [String(num)], () => queryPredictReply(num));
    }
  }

  // Fuzzy daily check-in ("每日签到", "8/12 签") — layered on top of the exact 签 / 签到 aliases above.
  if (isFuzzyCheckIn(raw)) {
    const sign = lookup('sign');
    if (sign) return handle(sign.name, [], () => sign.run([], ctx));
  }

  // Fuzzy LP-balance query ("看我现在有多少 LP", "我还有多少积分") — answered by the lp command (current
  // balance + last 3 changes) so a plain balance check is deterministic and never reaches the LLM.
  if (isFuzzyLpQuery(raw)) {
    const lp = lookup('lp');
    if (lp) return handle(lp.name, [], () => lp.run([], ctx));
  }

  return { handled: false };
}
