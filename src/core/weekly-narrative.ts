// Weekly community ops narrative: map-reduce Kimi pipeline for the five-aspect weekly report.
// Takes pre-gathered DayData (one week's window) and a list of events that occurred in the window;
// returns plain text covering five community aspects or null when data is absent or Kimi fails.

import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { type DayData, type ChatDayDigest } from './ops-narrative.js';
import { runKimiAsync } from './kimi.js';
import { log } from './log.js';
import { localDateFromEpochSec, localDateTimeFromEpochSec } from './time.js';
import { loadConfigs, type KimiProfile } from './configs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

// Safety-net cap on the weekly narrative in Unicode code points. The report is written into a docx
// with no practical length limit, so this is set well above the prompt's target length to keep all
// five aspects intact; it only guards against a runaway generation, never trimming a normal report.
export const WEEKLY_NARRATIVE_CHARS = 20000;

/** Per-group content budget for the map (group digest) phase. */
const MAX_WEEKLY_GROUP_CHARS = 5000;

/** Minimum char count for the single-pass threshold. */
const SINGLE_PASS_CHAR_LIMIT = 8000;

const BUILTIN_WEEKLY_GROUP_DIGEST =
  '你是社区运营观察助手。把下面某个群本周的聊天记录压缩成 300~400 字的中文要点摘要：' +
  '本周主要话题、成员分享或推荐的内容及作品、招募或号召行动、氛围与情绪、值得运营跟进的点。' +
  '特别标出：分享类内容（如「分享一个」「推荐大家」「这个值得看」）、招募及 CTA 类内容。' +
  '原样保留记录中出现的链接 URL，方便后续引用。' +
  '只基于记录、不要编造、没有就写"无"，输出纯文本要点。';

const BUILTIN_WEEKLY_ANALYST =
  '你是 SeeDAO 数字城邦的社区运营分析师。根据下面过去一周（周四 21:00 至周四 21:00）' +
  '采集到的各群摘要、成员动态、知识库浏览和活动信息，生成一份详尽、有层次、好读的社区动态周报正文（简体中文）。\n\n' +
  '【输出格式】用 Markdown：\n' +
  '- 不要输出一级标题（#），正文从二级标题（##）开始；整篇不要用代码块包裹。\n' +
  '- 五个面向各用一个二级标题（形如「## 🗣️ 面向一·社区聊天主题」），五个面向必须齐全、缺一不可。\n' +
  '- 每个面向内多用无序列点（- ）分条陈述，要点较多时用三级标题（###）再细分，让层次分明。\n' +
  '- 每个标题和关键要点前恰当加入 emoji 点缀，提升可读性（不要滥用）。\n' +
  '- 凡提到成员分享的内容、外部资源、活动或文档，数据中带链接的用 [名称](链接) 形式给出；关键结论可用 **加粗**。\n' +
  '- 每个面向内容充实，各约 400~600 字。\n\n' +
  '【五个面向】\n' +
  '## 🗣️ 面向一·社区聊天主题：各群主要讨论话题、热点内容、值得关注的交流。\n' +
  '## 🎨 面向二·成员分享与作品：成员推荐或分享的内容、链接、作品展示（尽量附链接）；无足够数据写「本周暂无」。\n' +
  '## 📈 面向三·社区运营动态：人数变化（加入/离开/围观群人数）、发言活跃度、知识库浏览热点、社区治理状态（从消息萃取提案/投票/决议，无则写「本周暂无」）。\n' +
  '## 📣 面向四·招募与号召：本周招募信息、征人需求、行动号召；无足够数据写「本周暂无」。\n' +
  '## 📅 面向五·本周活动与行事历：已发生活动回顾（报名及参与情况）、即将到来的活动预告。\n\n' +
  '【纪律】只基于给定数据、不得编造；标为"仅指标"的群只能用其数量、不可复述内容。' +
  '一律简体中文+中国大陆用语；强调或标签用【】、书名群名用《》，不要用「」『』；正文里避免出现裸的 < 或 > 符号。';

/** Resolve the Kimi profile settings (timeout, extraArgs) for the weekly pipeline. */
function resolveKimiProfile(): KimiProfile | undefined {
  try {
    const cfg = loadConfigs();
    const name = cfg.agents.defaults.kimi ?? 'default';
    return cfg.kimi.profiles[name] ?? cfg.kimi.profiles['default'];
  } catch {
    return undefined;
  }
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

/** Create (recursively) and return a per-Kimi-call working directory. */
function freshWorkDir(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run fn over items with at most n concurrent executions, preserving input order. */
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

function tierLabel(tier: string): string {
  return tier === 'work' ? '工作群' : tier === 'member' ? '会员群' : '公开群';
}

/** Render one chat's content as lines under a labeled header, capped to the per-group char budget. */
function groupWeeklyBlock(chat: ChatDayDigest): string {
  const header = `《${chat.name}》（${tierLabel(chat.tier)}，消息${chat.messageCount}，活跃${chat.activeMembers}）`;
  const body: string[] = [];
  let chars = 0;
  for (const l of chat.lines) {
    const line = `${l.name}: ${l.text}`;
    if (chars + line.length > MAX_WEEKLY_GROUP_CHARS) {
      body.push('...（更多省略）');
      break;
    }
    body.push(line);
    chars += line.length + 1;
  }
  return `${header}\n${body.join('\n')}`;
}

/** Build the structured data block passed to the analyst (reduce) Kimi call. */
function buildWeeklyDataBlock(
  data: DayData,
  groupSections: string[],
  eventsInWindow: Array<{ eventId: string; title: string; startTime: number }>,
): string {
  const out: string[] = [];
  out.push(
    `[统计区间] ${localDateTimeFromEpochSec(data.range.from)} ~ ${localDateTimeFromEpochSec(data.range.to)}`,
  );
  out.push(`[总消息数] ${data.totalMessages}　[有活动的群] ${data.chats.length}`);
  out.push('');
  out.push('[各群摘要（含分享及 CTA 语义萃取）]');
  out.push(
    groupSections.length ? groupSections.join('\n\n') : '（公开及会员群本周无可摘要内容）',
  );

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
      `；改名：${m.renamed} 人；围观群在场：${m.presentExternal}` +
      `（本周净 ${m.presentExternalDelta >= 0 ? '+' : ''}${m.presentExternalDelta}）`,
  );

  if (data.docs.length) {
    out.push('');
    out.push('[知识库浏览·热门]');
    out.push(data.docs.slice(0, 15).map((d) => `《${d.title}》${d.readers} 人`).join('；'));
  }

  if (eventsInWindow.length) {
    out.push('');
    out.push('[本周已发生的活动]');
    out.push(
      eventsInWindow.map((e) => `《${e.title}》（开始 ${localDateFromEpochSec(e.startTime)}）`).join('；'),
    );
  }

  if (data.upcomingEvents.length) {
    out.push('');
    out.push('[即将到来的活动·报名进行中]');
    out.push(
      data.upcomingEvents
        .map((e) => `《${e.title}》报名 ${e.accepted} 人（开始 ${localDateFromEpochSec(e.startTime)}）`)
        .join('；'),
    );
  }
  return out.join('\n');
}

export interface WeeklyNarrativeOptions {
  soul?: string;
  maxChars?: number;
  mapConcurrency?: number;
}

/**
 * Generate the five-aspect weekly community ops narrative from a week's gathered data.
 *
 * Uses the same Kimi map-reduce pattern as the daily ops narrative, adapted for the weekly
 * window and the five-aspect prompt structure. The map phase summarizes each group's week;
 * the reduce phase synthesizes everything into the structured report.
 *
 * Returns null when there is nothing meaningful to summarize or when every Kimi call fails.
 * Never throws — failures are logged and the caller should treat null as "skip AI section".
 */
export async function generateWeeklyNarrative(
  data: DayData,
  eventsInWindow: Array<{ eventId: string; title: string; startTime: number }>,
  opts: WeeklyNarrativeOptions = {},
): Promise<string | null> {
  const soul = opts.soul ?? 'tudigong';
  const maxChars = opts.maxChars ?? WEEKLY_NARRATIVE_CHARS;

  const hasAnything =
    data.totalMessages > 0 ||
    data.docs.length > 0 ||
    data.upcomingEvents.length > 0 ||
    eventsInWindow.length > 0 ||
    data.members.joined.length > 0 ||
    data.members.left.length > 0;

  if (!hasAnything) {
    log.info('周报洞察：本周无采集数据，跳过 AI 洞察。');
    return null;
  }

  const kimi = resolveKimiProfile();
  const timeoutMs = kimi?.timeoutMs;
  const extraArgs = kimi?.extraArgs;
  const mapInstr = loadPrompt(soul, 'weekly-report-group-digest.md', BUILTIN_WEEKLY_GROUP_DIGEST);
  const analystInstr = loadPrompt(soul, 'weekly-report-analyst.md', BUILTIN_WEEKLY_ANALYST);

  const contentChats = data.chats.filter((c) => c.contentIncluded && c.lines.length > 0);
  const rawBlocks = contentChats.map((c) => ({ chat: c, block: groupWeeklyBlock(c) }));
  const totalChars = rawBlocks.reduce((sum, b) => sum + b.block.length, 0);

  const tmpBase = mkdtempSync(join(tmpdir(), `weekly-narrative-${soul}-`));
  try {
    let groupSections: string[];
    if (totalChars <= SINGLE_PASS_CHAR_LIMIT || contentChats.length <= 1) {
      groupSections = rawBlocks.map((b) => b.block);
      log.info(`周报洞察：单次模式（${contentChats.length} 个内容群，约 ${totalChars} 字）。`);
    } else {
      log.info(`周报洞察：map-reduce 模式（${contentChats.length} 个内容群，约 ${totalChars} 字）。`);
      const digests = await mapWithConcurrency(
        rawBlocks,
        opts.mapConcurrency ?? 3,
        async (b, i) => {
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
            return out
              ? `《${b.chat.name}》（消息${b.chat.messageCount}，活跃${b.chat.activeMembers}）：${out}`
              : '';
          } catch (e) {
            log.warn(`周报洞察：群《${b.chat.name}》摘要失败：`, (e as Error).message);
            return '';
          }
        },
      );
      groupSections = digests.filter(Boolean);
    }

    const dataBlock = buildWeeklyDataBlock(data, groupSections, eventsInWindow);
    const reducePrompt = `${analystInstr}\n\n以下是本周采集数据：\n${dataBlock}`;
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
      log.warn('周报洞察：Kimi 返回空文本，跳过洞察。');
      return null;
    }

    const chars = [...reduced];
    if (chars.length <= maxChars) return reduced;
    log.info(`周报洞察：叙事 ${chars.length} 字超过 ${maxChars}，截断。`);
    return chars.slice(0, maxChars).join('').trim() + '...';
  } catch (e) {
    log.error('周报洞察生成失败：', (e as Error).message);
    return null;
  } finally {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
