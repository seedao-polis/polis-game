import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.js';
import * as store from './store.js';
import {
  subscribeMeetupTag,
  unsubscribeMeetupTag,
  listMeetupSubscriptions,
  getMeetupById,
  cancelMeetup as storeCancelMeetup,
} from './store/meetups.js';
import { loadConfigs, resolveChatTarget, isAdmin } from './configs.js';
import { cancelCalendarEvent } from './lark.js';
import { refreshMeetupWiki } from './meetup-wiki.js';

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
  run(args: string[], ctx: CommandContext): string;
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

function applyRename(rawName: string, ctx: CommandContext): string {
  if (!ctx.senderOpenId) {
    return '无法确认你的身份（缺少 sender open_id），请在飞书群里 @ 我使用改名。';
  }
  const name = trimEdgeSpaces(rawName ?? '');
  if (!name) return RENAME_USAGE;
  if (name.includes('\n') || [...name].length > MAX_NAME_LEN) {
    return `新名字不太合适（不能换行，且最多 ${MAX_NAME_LEN} 个字），请换一个短一点的再试。`;
  }
  // Resolve the current display name (already override-aware) before writing, so we can echo old → new.
  const before = store.memberName(ctx.senderOpenId) || store.getProfile(ctx.senderOpenId)?.name || '';
  const saved = store.setPreferredName(ctx.senderOpenId, name);
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
function subscriberName(openId: string): string {
  return store.memberName(openId) || store.getProfile(openId)?.name || '你';
}

// ── built-in commands ─────────────────────────────────────────
// To add a command later, just append an entry to this array; help will list it automatically.
const COMMANDS: Command[] = [
  {
    name: 'help',
    aliases: ['?', '命令', 'commands', 'menu'],
    summary: '显示命令列表，或某个命令的用法',
    usage: 'help [命令]',
    run(args, ctx) {
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
    run: () => 'pong 🏓',
  },
  {
    name: 'version',
    aliases: ['ver', 'v'],
    summary: '显示我的版本',
    run: (_args, ctx) => `${ctx.agentName} v${readVersion()}`,
  },
  {
    name: 'whoami',
    aliases: ['id'],
    summary: '显示我的身份与运行信息',
    run: (_args, ctx) =>
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
    run(_args, ctx) {
      if (!ctx.senderOpenId) {
        return '无法确认你的身份（缺少 sender open_id），请在飞书群内使用此命令。';
      }
      const p = store.getProfile(ctx.senderOpenId);
      if (!p) {
        return '你还没有档案，和我互动一次就会自动建立！';
      }
      const badges = store.listBadges(ctx.senderOpenId);
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
    name: 'leaderboard',
    aliases: ['榜', '排行'],
    summary: '显示 LP 排行榜前十名',
    usage: 'leaderboard',
    run() {
      const rows = store.leaderboard(10);
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
    run(_args, ctx) {
      if (!ctx.senderOpenId) {
        return '无法确认你的身份（缺少 sender open_id），请在飞书群内使用此命令。';
      }
      const r = store.checkIn(ctx.senderOpenId);
      if (r.firstToday) {
        return '在 SeeDAO 数字城邦签到' + store.buildStatusFooter(ctx.senderOpenId, r.awarded);
      }
      const mmdd = `${r.date.slice(5, 7)}/${r.date.slice(8, 10)}`;
      return `今天 (${mmdd}) 你已在 SeeDAO 数字城邦签到了` + store.buildStatusFooter(ctx.senderOpenId, 0);
    },
  },
  {
    name: 'rename',
    aliases: ['改名'],
    summary: '给自己改名（@我 改名 <新名字>）',
    usage: 'rename <新名字>',
    // "改名…" is normally intercepted by parseRename in dispatchCommand (to support the no-space and
    // spaces-in-name forms); this entry lists it in help and also handles the English "rename <name>".
    run: (args, ctx) => applyRename(args.join(' '), ctx),
  },
  {
    name: 'follow',
    aliases: ['订阅'],
    summary: '订阅活动标签，有新会议时在群里收到 @ 提醒',
    usage: 'follow <标签>',
    run(args, ctx) {
      if (!ctx.senderOpenId) return '无法确认你的身份，请在飞书群内使用此命令。';
      const tag = args[0]?.trim();
      if (!tag) return '请提供标签名，例如：follow 共学';
      const who = subscriberName(ctx.senderOpenId);
      const added = subscribeMeetupTag(ctx.senderOpenId, tag);
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
    run(args, ctx) {
      if (!ctx.senderOpenId) return '无法确认你的身份，请在飞书群内使用此命令。';
      const tag = args[0]?.trim();
      if (!tag) return '请提供标签名，例如：unfollow 共学';
      const who = subscriberName(ctx.senderOpenId);
      const removed = unsubscribeMeetupTag(ctx.senderOpenId, tag);
      return removed ? `${who}，已为你取消订阅【${tag}】。` : `${who}，你本来就没有订阅【${tag}】。`;
    },
  },
  {
    name: 'follows',
    aliases: ['我的订阅'],
    summary: '查看你当前订阅的活动标签',
    usage: 'follows',
    run(_args, ctx) {
      if (!ctx.senderOpenId) return '无法确认你的身份，请在飞书群内使用此命令。';
      const who = subscriberName(ctx.senderOpenId);
      const tags = listMeetupSubscriptions(ctx.senderOpenId);
      if (tags.length === 0) return `${who}，你还没有订阅任何活动标签。发送 follow <标签> 即可订阅。`;
      return `${who}，你当前订阅的标签：${tags.map((t) => `【${t}】`).join('、')}`;
    },
  },
  {
    name: 'meetup',
    summary: '管理活动会议（cancel / edit）',
    usage: 'meetup cancel <id>  |  meetup edit <id> --title <新标题>',
    run(args, ctx) {
      const sub = args[0]?.toLowerCase();

      // meetup cancel <id>: soft-cancel in DB and delete from Feishu calendar
      if (sub === 'cancel' || sub === '取消') {
        const id = Number(args[1]);
        if (!id) return '用法：meetup cancel <会议编号>（整数 id，见 agent meetup 列表）';
        const mtg = getMeetupById(id);
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

        const larkOk = cancelCalendarEvent(calendarId, mtg.larkEventId);
        storeCancelMeetup(id);
        refreshMeetupWiki(); // mirror the cancellation to the "SeeDAO 活动日历" wiki page
        return larkOk
          ? `已取消会议【${mtg.title}】（飞书日历已删除，本地已标记取消）。`
          : `本地已标记取消【${mtg.title}】，但飞书日历删除失败，请手动检查。`;
      }

      // meetup edit: in-group edit is not exposed (directs to the operator CLI). Still gate on
      // ownership so a non-creator is told they cannot edit it, rather than pointed at a command
      // that would not accept them anyway.
      if (sub === 'edit' || sub === '编辑') {
        const id = Number(args[1]);
        const mtg = id ? getMeetupById(id) : null;
        if (mtg && !canManageMeetup(ctx.senderOpenId, mtg.createdBy)) {
          return `只有活动发起人才能编辑【${mtg.title}】。`;
        }
        return '活动编辑请使用管理员 CLI 命令：pnpm agent meetup edit <id> [--title ...] [--start ...] [--end ...]';
      }

      return `未知子命令【${sub}】。支持：meetup cancel <id> / meetup edit <id>`;
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
function handle(command: string, args: string[], run: () => string): DispatchResult {
  try {
    return { handled: true, command, args, reply: run() };
  } catch (e) {
    return { handled: true, command, args, reply: `命令【${command}】执行出错：${(e as Error).message}` };
  }
}

/**
 * Try to handle the message as a command. Hit → { handled:true, reply }; miss → { handled:false }.
 * If the command itself throws, it is still treated as handled and returns an error message (does not fall back to the LLM).
 */
export function dispatchCommand(raw: string, ctx: CommandContext): DispatchResult {
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

  // Fuzzy daily check-in ("每日签到", "8/12 签") — layered on top of the exact 签 / 签到 aliases above.
  if (isFuzzyCheckIn(raw)) {
    const sign = lookup('sign');
    if (sign) return handle(sign.name, [], () => sign.run([], ctx));
  }

  return { handled: false };
}
