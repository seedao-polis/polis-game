// Community-ops daily narrative: gather one logical day's collected records into a structured,
// privacy-filtered digest, then have Kimi turn it into an operations report (map-reduce). The
// gatherer here is deterministic and side-effect-free (DB + config reads only) so it is unit-testable
// independently of the LLM. The Kimi pipeline lives in the lower half of this file.

import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { getChatTier, getChatPolicy, loadConfigs, type ChatTier, type KimiProfile } from './configs.js';
import {
  messagesBetween,
  getChatMeta,
  memberName,
  memberSyncRoundsBetween,
  docReaderDigestBetween,
  upcomingTrackedEventIds,
  calendarEventRsvpHistory,
  type MessageRow,
} from './store.js';
import { runKimiAsync } from './kimi.js';
import { log } from './log.js';
import { localDateFromEpochSec, localDateTimeFromEpochSec } from './time.js';

/** Tiers whose chat CONTENT may be summarized. Work-tier chats contribute metrics only (privacy). */
export const DEFAULT_CONTENT_TIERS: ChatTier[] = ['public', 'member'];

export interface ChatDayDigest {
  chatId: string;
  name: string;
  tier: ChatTier;
  external: boolean;
  messageCount: number;
  /** distinct human senders (the bot's own messages are excluded) */
  activeMembers: number;
  /** Per-message content lines, populated ONLY when the chat's tier is in contentTiers. */
  lines: { name: string; text: string; threadId?: string }[];
  /** True when this chat's content was summarized; false = metrics-only (e.g. a work group). */
  contentIncluded: boolean;
}

export interface MemberDayChange {
  joined: { openId: string; name: string }[];
  left: { openId: string; name: string }[];
  renamed: number;
  /** external (社区围观) present count at the window's last sync round */
  presentExternal: number;
  /** change in external present count across the window (last − first round) */
  presentExternalDelta: number;
}

export interface DayData {
  range: { from: number; to: number };
  contentTiers: ChatTier[];
  /** per-chat digests, most active first */
  chats: ChatDayDigest[];
  /** total messages across all chats (incl. metrics-only chats) */
  totalMessages: number;
  members: MemberDayChange;
  /** documents browsed in the window, most-read first (title + reader count, no identities) */
  docs: Array<{ title: string; readers: number }>;
  /** upcoming tracked events with their latest in-window accepted count */
  upcomingEvents: Array<{ title: string; accepted: number; startTime: number }>;
}

/** Bot open_ids across all lark profiles, so the bot's own messages don't count as community activity. */
function botOpenIds(): Set<string> {
  try {
    const cfg = loadConfigs();
    return new Set(
      Object.values(cfg.lark.profiles)
        .map((p) => p.botOpenId)
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/** Parse the ops-detail string "(open_id, name),(open_id, name)" back into refs. Inverse of formatMemberRefs. */
export function parseMemberRefs(detail: string): { openId: string; name: string }[] {
  if (!detail) return [];
  const out: { openId: string; name: string }[] = [];
  const re = /\(([^,]+),\s*([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(detail)) !== null) {
    const openId = (m[1] ?? '').trim();
    const name = (m[2] ?? '').trim();
    if (openId) out.push({ openId, name });
  }
  return out;
}

export interface GatherOptions {
  /** Tiers whose content may be summarized (default public+member). */
  contentTiers?: ChatTier[];
  /** Cap content lines kept per chat (newest kept) to bound prompt size. Default 400. */
  maxLinesPerChat?: number;
  /** Tier resolver (injectable for tests); defaults to the chat-policies classification. */
  tierOf?: (chatId: string) => ChatTier;
  /** Predicate for chats omitted entirely from the report (injectable for tests); defaults to the
   *  chat-policies excludeFromOpsReport flag. */
  excludeChat?: (chatId: string) => boolean;
}

/**
 * Assemble all of a logical day's collected records into a single structured digest. Times are Unix
 * SECONDS; pass the same [from,to) window resolveRange produces. Content for chats outside contentTiers
 * (e.g. work groups) is dropped here — not just hidden later — so it never reaches the prompt.
 */
export function gatherDayData(range: { from: number; to: number }, opts: GatherOptions = {}): DayData {
  const contentTiers = opts.contentTiers ?? DEFAULT_CONTENT_TIERS;
  const maxLines = opts.maxLinesPerChat ?? 400;
  const tierOf = opts.tierOf ?? getChatTier;
  const excludeChat = opts.excludeChat ?? ((id: string) => getChatPolicy(id)?.excludeFromOpsReport === true);
  const bots = botOpenIds();

  // ── chats (from messages) ──
  const byChat = new Map<string, MessageRow[]>();
  for (const m of messagesBetween(range.from, range.to)) {
    if (bots.has(m.senderOpenId)) continue; // the bot's own posts are not community activity
    const arr = byChat.get(m.chatId) ?? [];
    arr.push(m);
    byChat.set(m.chatId, arr);
  }
  const chats: ChatDayDigest[] = [];
  let totalMessages = 0;
  for (const [chatId, rows] of byChat) {
    if (excludeChat(chatId)) continue; // omit configured chats (e.g. agent-collaboration rooms) from the report entirely
    const meta = getChatMeta(chatId);
    const tier = tierOf(chatId);
    const includeContent = contentTiers.includes(tier);
    const active = new Set(rows.map((r) => r.senderOpenId).filter(Boolean));
    const lines = includeContent
      ? rows
          .filter((r) => r.msgType === 'text' && r.text.trim() !== '')
          .slice(-maxLines)
          .map((r) => ({
            name: r.senderName || memberName(r.senderOpenId) || '匿名',
            text: r.text.trim(),
            threadId: r.threadId,
          }))
      : [];
    totalMessages += rows.length;
    chats.push({
      chatId,
      name: meta?.name || chatId,
      tier,
      external: meta?.external ?? false,
      messageCount: rows.length,
      activeMembers: active.size,
      lines,
      contentIncluded: includeContent,
    });
  }
  chats.sort((a, b) => b.messageCount - a.messageCount);

  // ── member changes (dedupe across the window's sync rounds) ──
  const rounds = memberSyncRoundsBetween(range.from, range.to);
  const joinedMap = new Map<string, string>();
  const leftMap = new Map<string, string>();
  let renamed = 0;
  for (const r of rounds) {
    for (const j of parseMemberRefs(r.joinedDetail)) joinedMap.set(j.openId, j.name);
    for (const l of parseMemberRefs(r.leftDetail)) leftMap.set(l.openId, l.name);
    renamed += r.renamedCount;
  }
  const members: MemberDayChange = {
    joined: [...joinedMap].map(([openId, name]) => ({ openId, name })),
    left: [...leftMap].map(([openId, name]) => ({ openId, name })),
    renamed,
    presentExternal: rounds.length ? rounds[rounds.length - 1]!.presentExternal : 0,
    presentExternalDelta: rounds.length
      ? rounds[rounds.length - 1]!.presentExternal - rounds[0]!.presentExternal
      : 0,
  };

  // ── docs (title + reader count, privacy-safe) ──
  const docs = docReaderDigestBetween(range.from, range.to);

  // ── upcoming events with their latest in-window accepted count ──
  const upcomingEvents = upcomingTrackedEventIds(range.to).map((ev) => {
    const hist = calendarEventRsvpHistory(ev.eventId, range.from, range.to);
    return {
      title: ev.title,
      accepted: hist.length ? hist[hist.length - 1]!.accepted : 0,
      startTime: ev.startTime,
    };
  });

  return { range, contentTiers, chats, totalMessages, members, docs, upcomingEvents };
}

// ── Kimi map-reduce narrative pipeline ─────────────────────────────────────────────────────────
// "一次或多次执行": when the day's content is small it goes to Kimi in one pass; when it is large each
// public/member group is first summarized on its own (map), then the digests + metrics are synthesized
// into the final ops report (reduce). Every Kimi call is isolated (throwaway workDir, no session) and
// failures degrade gracefully — a failed group is dropped, a failed reduce returns null so the image
// report still ships without the narrative.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

/** Per-group raw block byte budget, so one chatty group can't blow up a prompt. */
const MAX_GROUP_BLOCK_CHARS = 4000;

/** Hard cap on the final narrative length (Chinese characters / code points). */
const MAX_NARRATIVE_CHARS = 500;

const BUILTIN_GROUP_DIGEST =
  '你是社区运营观察助手。把下面某个群今天的聊天记录压缩成 200 字以内的中文要点摘要：今日主要话题、求助/反馈/产品建议、氛围与情绪、活跃或亮点成员、值得运营跟进的点。只基于记录、不要编造、没有就写"无"，输出纯文本。';

const BUILTIN_ANALYST =
  '你是 SeeDAO 数字城邦的社区运营分析师。根据下面今天采集到的各群摘要与指标，写一份极简的当日社区运营日报（简体中文，飞书群阅读）。**全文不超过 500 字**，只挑当天最值得运营关注的、不要堆数据。结构三块：【今日概览】1~2 句；【关键动态】3~5 条（从成员增减、话题热点、氛围情绪、求助反馈、知识库浏览、活动报名里挑重点合并写、不必每类都写）；【运营建议】2~3 条可执行的下一步。只基于给定数据、不得编造；标为"仅指标"的群只能用其数量、不可复述内容。一律简体中文+中国大陆用语；严禁使用「」『』等引号，强调/标题用【】、书名群名用《》。输出纯文本，不要 Markdown 代码块。';

function tierLabel(tier: ChatTier): string {
  return tier === 'work' ? '工作群' : tier === 'member' ? '会员群' : '公开群';
}

/** Load a tunable prompt from workspaces/<soul>/prompts/<file>, falling back to the built-in text. */
function loadPrompt(soul: string, file: string, fallback: string): string {
  try {
    const txt = readFileSync(join(PROJECT_ROOT, 'workspaces', soul, 'prompts', file), 'utf-8').trim();
    return txt || fallback;
  } catch {
    return fallback;
  }
}

/** Resolve the kimi profile (timeout/extraArgs) from the agents defaults; undefined → kimi.ts defaults. */
function resolveKimiProfile(): KimiProfile | undefined {
  try {
    const cfg = loadConfigs();
    const name = cfg.agents.defaults.kimi ?? 'default';
    return cfg.kimi.profiles[name] ?? cfg.kimi.profiles['default'];
  } catch {
    return undefined;
  }
}

/** Render one chat's content as "名字: 文本" lines under a labeled header, capped to a char budget. */
function groupRawBlock(chat: ChatDayDigest): string {
  const header = `《${chat.name}》（${tierLabel(chat.tier)}，消息${chat.messageCount}，活跃${chat.activeMembers}）`;
  const body: string[] = [];
  let chars = 0;
  for (const l of chat.lines) {
    const line = `${l.name}: ${l.text}`;
    if (chars + line.length > MAX_GROUP_BLOCK_CHARS) {
      body.push('…（更多省略）');
      break;
    }
    body.push(line);
    chars += line.length + 1;
  }
  return `${header}\n${body.join('\n')}`;
}

/** Assemble the structured data block handed to the reduce (analyst) pass. */
function buildDataBlock(data: DayData, groupSections: string[], dateLabel?: string): string {
  const out: string[] = [];
  out.push(`[统计区间] ${dateLabel ?? `${localDateTimeFromEpochSec(data.range.from)} ~ ${localDateTimeFromEpochSec(data.range.to)}`}`);
  out.push(`[总消息数] ${data.totalMessages}　[有活动的群] ${data.chats.length}`);
  out.push('');
  out.push('[各群摘要]');
  out.push(groupSections.length ? groupSections.join('\n\n') : '（公开/会员群今日无可摘要内容）');

  const metricOnly = data.chats.filter((c) => !c.contentIncluded && c.messageCount > 0);
  if (metricOnly.length) {
    out.push('');
    out.push('[仅指标群·不摘要内容]');
    out.push(metricOnly.map((c) => `《${c.name}》消息${c.messageCount} 活跃${c.activeMembers}`).join('；'));
  }

  const m = data.members;
  out.push('');
  out.push(
    `[成员动态] 新增：${m.joined.length ? m.joined.map((x) => x.name || x.openId).join('、') : '无'}` +
      `；离开：${m.left.length ? m.left.map((x) => x.name || x.openId).join('、') : '无'}` +
      `；改名：${m.renamed} 人；围观群在场：${m.presentExternal}（较日初 ${m.presentExternalDelta >= 0 ? '+' : ''}${m.presentExternalDelta}）`,
  );

  if (data.docs.length) {
    out.push('');
    out.push('[知识库浏览·热门]');
    out.push(data.docs.slice(0, 15).map((d) => `《${d.title}》${d.readers} 人`).join('；'));
  }

  if (data.upcomingEvents.length) {
    out.push('');
    out.push('[活动报名·进行中]');
    out.push(
      data.upcomingEvents
        .map((e) => `《${e.title}》报名 ${e.accepted}（开始 ${localDateFromEpochSec(e.startTime)}）`)
        .join('；'),
    );
  }
  return out.join('\n');
}

/** Create (recursively) and return a per-Kimi-call working directory; execFileSync ENOENTs if cwd is missing. */
function freshWorkDir(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Truncate to at most max code points, backing off to the last sentence/section boundary for a clean end. */
export function hardTruncate(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  let cut = chars.slice(0, max).join('');
  const boundary = cut.match(/[\s\S]*[。！？\n]/); // last full sentence/line within the budget
  if (boundary && [...boundary[0]].length >= max * 0.6) cut = boundary[0];
  return cut.trim() + '…';
}

/**
 * Guarantee the narrative is <= max code points. The reduce prompt only *asks* for the limit and the
 * model often overshoots, so: if over, run one compression pass that must preserve 【运营建议】; if that
 * still overshoots, hard-truncate at a sentence boundary. Compression failures fall back to truncation.
 */
async function enforceNarrativeLength(
  text: string,
  max: number,
  tmpBase: string,
  timeoutMs?: number,
  extraArgs?: string[],
): Promise<string> {
  if ([...text].length <= max) return text;
  log.info(`运营报告洞察：叙事 ${[...text].length} 字超过 ${max}，压缩中。`);
  try {
    const prompt =
      `下面这份社区运营日报超过了字数上限。请在**保持【今日概览】【关键动态】【运营建议】三块结构、且必须完整保留【运营建议】**的前提下，` +
      `压缩到 ${max} 字以内（简体中文，纯文本，不要复述本提示）：\n\n${text}`;
    const out = (
      await runKimiAsync({
        prompt,
        workDir: freshWorkDir(tmpBase, 'compress'),
        continueSession: false,
        timeoutMs,
        extraArgs,
      })
    ).trim();
    if (out && [...out].length <= max) return out;
    if (out && [...out].length < [...text].length) text = out; // keep the shorter draft for truncation
  } catch (e) {
    log.warn('运营报告洞察：压缩失败，改用硬截断：', (e as Error).message);
  }
  return hardTruncate(text, max);
}

/** Run fn over items with at most n concurrent executions, preserving input order in the result. */
async function mapWithConcurrency<T, R>(
  items: T[],
  n: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  };
  const lanes = Math.max(1, Math.min(n, items.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return results;
}

export interface NarrativeOptions {
  /** Workspace whose prompts/ + kimi profile to use (default 'tudigong'). */
  soul?: string;
  contentTiers?: ChatTier[];
  maxLinesPerChat?: number;
  /** Combined raw-content budget under which we do a single Kimi pass (default 6000 chars). */
  singlePassCharLimit?: number;
  /** Hard cap on final narrative length in code points (default 500); enforced via compress→truncate. */
  maxChars?: number;
  /** Max concurrent map-phase Kimi calls (default 3). */
  mapConcurrency?: number;
  /** Human-readable label for the statistics window (e.g. "2026-06-25"). */
  dateLabel?: string;
}

/**
 * Produce the community-ops narrative for a logical-day window, or null when there is nothing to say
 * or Kimi fails. Pre-fetches the day's records (privacy-filtered), runs single-pass for small days or
 * map-reduce for large ones, and returns the final report text. Never throws into the report pipeline.
 */
export async function generateOpsNarrative(
  range: { from: number; to: number },
  opts: NarrativeOptions = {},
): Promise<string | null> {
  const soul = opts.soul ?? 'tudigong';
  const data = gatherDayData(range, {
    contentTiers: opts.contentTiers,
    maxLinesPerChat: opts.maxLinesPerChat,
  });

  const hasAnything =
    data.totalMessages > 0 ||
    data.docs.length > 0 ||
    data.upcomingEvents.length > 0 ||
    data.members.joined.length > 0 ||
    data.members.left.length > 0;
  if (!hasAnything) {
    log.info('运营报告洞察：当日无采集数据，跳过 AI 洞察。');
    return null;
  }

  const kimi = resolveKimiProfile();
  const timeoutMs = kimi?.timeoutMs;
  const extraArgs = kimi?.extraArgs;
  const analyst = loadPrompt(soul, 'ops-report-analyst.md', BUILTIN_ANALYST);

  const contentChats = data.chats.filter((c) => c.contentIncluded && c.lines.length > 0);
  const rawBlocks = contentChats.map((c) => ({ chat: c, block: groupRawBlock(c) }));
  const totalChars = rawBlocks.reduce((sum, b) => sum + b.block.length, 0);
  const singleLimit = opts.singlePassCharLimit ?? 6000;

  const tmpBase = mkdtempSync(join(tmpdir(), `ops-narrative-${soul}-`));
  try {
    let groupSections: string[];
    if (totalChars <= singleLimit || contentChats.length <= 1) {
      // Single pass — raw group content flows straight into the reduce prompt.
      groupSections = rawBlocks.map((b) => b.block);
      log.info(`运营报告洞察：单次模式（${contentChats.length} 个内容群，约 ${totalChars} 字）。`);
    } else {
      // Map — summarize each group on its own, bounded concurrency; failed groups are dropped.
      const mapInstr = loadPrompt(soul, 'ops-report-group-digest.md', BUILTIN_GROUP_DIGEST);
      log.info(`运营报告洞察：map-reduce 模式（${contentChats.length} 个内容群，约 ${totalChars} 字）。`);
      const digests = await mapWithConcurrency(rawBlocks, opts.mapConcurrency ?? 3, async (b, i) => {
        try {
          const out = (
            await runKimiAsync({
              prompt: `${mapInstr}\n\n${b.block}`,
              workDir: freshWorkDir(tmpBase, `map-${i}`),
              continueSession: false,
              timeoutMs,
              extraArgs,
            })
          ).trim();
          return out ? `《${b.chat.name}》（消息${b.chat.messageCount}，活跃${b.chat.activeMembers}）：${out}` : '';
        } catch (e) {
          log.warn(`运营报告洞察：群【${b.chat.name}】摘要失败：`, (e as Error).message);
          return '';
        }
      });
      groupSections = digests.filter(Boolean);
    }

    const reducePrompt = `${analyst}\n\n以下是今日采集数据：\n${buildDataBlock(data, groupSections, opts.dateLabel)}`;
    const reduced = (
      await runKimiAsync({
        prompt: reducePrompt,
        workDir: freshWorkDir(tmpBase, 'reduce'),
        continueSession: false,
        timeoutMs,
        extraArgs,
      })
    ).trim();
    if (!reduced) {
      log.warn('运营报告洞察：Kimi 返回空文本，跳过叙事。');
      return null;
    }
    return await enforceNarrativeLength(reduced, opts.maxChars ?? MAX_NARRATIVE_CHARS, tmpBase, timeoutMs, extraArgs);
  } catch (e) {
    log.error('运营报告洞察生成失败：', (e as Error).message);
    return null;
  } finally {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
