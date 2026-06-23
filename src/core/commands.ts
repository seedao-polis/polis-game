import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.js';
import * as store from './store.js';

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

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
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

/**
 * Try to handle the message as a command. Hit → { handled:true, reply }; miss → { handled:false }.
 * If the command itself throws, it is still treated as handled and returns an error message (does not fall back to the LLM).
 */
export function dispatchCommand(raw: string, ctx: CommandContext): DispatchResult {
  const parsed = parseCommand(raw);
  if (!parsed) return { handled: false };
  const cmd = lookup(parsed.name);
  if (!cmd) return { handled: false };
  try {
    return { handled: true, command: cmd.name, args: parsed.args, reply: cmd.run(parsed.args, ctx) };
  } catch (e) {
    return { handled: true, command: cmd.name, args: parsed.args, reply: `命令【${cmd.name}】执行出错：${(e as Error).message}` };
  }
}
