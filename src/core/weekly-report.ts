// Weekly community ops report: gather one week's data, generate AI narrative, write to Feishu wiki.
// The report is anchored at Thursday 21:00 local time (weeklyReportRange) and published to a new
// wiki node under the configured parent page. A notification with the wiki URL is sent to the ops
// chat when a notify chat ID is provided. Dry-run skips all writes and prints the content.

import { log } from './log.js';
import { gatherDayData } from './ops-narrative.js';
import { eventsStartingBetween } from './store.js';
import {
  createWikiNode,
  appendDocxContent,
  sendText,
} from './lark.js';
import {
  weeklyReportRange,
  localDateTimeFromEpochSec,
  localDateFromEpochSec,
} from './time.js';
import { loadConfigs, listAgents, resolveAgentProfile, resolveChatTarget } from './configs.js';
import { generateWeeklyNarrative } from './weekly-narrative.js';

export interface WeeklyReportOptions {
  /** Wiki space ID override (falls back to configs/lark.json weeklyReportWiki.spaceId). */
  spaceId?: string;
  /** Wiki parent node token override (falls back to weeklyReportWiki.parentNodeToken). */
  parentNodeToken?: string;
  /** Lark profile override (falls back to the first enabled agent's profile). */
  profile?: string;
  /** Feishu chat ID to notify after publishing (optional). */
  notifyChatId?: string;
  /** When true, gather data and generate narrative but skip all wiki writes and notifications. */
  dryRun?: boolean;
  /** Set false to skip the AI narrative section (default: true). */
  narrative?: boolean;
  /** Set false to skip the post-publish group notification (default: true). */
  notify?: boolean;
  /** When set, append into this existing docx document instead of creating a new wiki node. */
  reuseDocumentId?: string;
  /** Node token for the reused document, used only to build the display URL. */
  reuseNodeToken?: string;
}

/** Resolve wiki coordinates from options, then from configs, with clear error on missing config. */
function resolveWikiCoords(opts: WeeklyReportOptions): { spaceId: string; parentNodeToken: string } {
  const spaceId = opts.spaceId;
  const parentNodeToken = opts.parentNodeToken;
  if (spaceId && parentNodeToken) return { spaceId, parentNodeToken };

  try {
    const cfg = loadConfigs();
    const wiki = cfg.lark.weeklyReportWiki;
    if (wiki?.spaceId && wiki?.parentNodeToken) {
      return {
        spaceId: spaceId ?? wiki.spaceId,
        parentNodeToken: parentNodeToken ?? wiki.parentNodeToken,
      };
    }
  } catch {
    // fall through to the error below
  }
  throw new Error(
    '未配置周报知识库坐标。请在 configs/lark.json 的 weeklyReportWiki 中设置 spaceId 和 parentNodeToken，' +
      '或通过 --space-id / --wiki-token 命令行参数指定。',
  );
}

/** Resolve the lark profile for wiki writes (first enabled agent, mirrors eventSendProfile in supervisor). */
function resolveProfile(opts: WeeklyReportOptions): string | undefined {
  if (opts.profile) return opts.profile;
  try {
    const cfg = loadConfigs();
    for (const id of listAgents(cfg)) {
      if (cfg.agents.agents[id]?.enabled) return resolveAgentProfile(id, cfg).larkProfile;
    }
  } catch {
    // config unavailable
  }
  return undefined;
}

/** Format an epoch-second timestamp as "YYYY/MM/DD" using local time for report titles. */
function localDateSlash(sec: number): string {
  const d = new Date(sec * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

/** Escape Markdown-significant characters in an inline value (member names, doc/event titles). */
function mdInline(text: string): string {
  return text.replace(/([\\`*_[\]<>~|#])/g, '\\$1');
}

/**
 * Build the structured-data Markdown section (member stats, knowledge-base views, events) as
 * emoji-prefixed headings with bullet lists, ready to render as native docx blocks.
 */
function buildDataSectionMarkdown(
  weekData: Awaited<ReturnType<typeof gatherDayData>>,
  eventsInWindow: Array<{ eventId: string; title: string; startTime: number }>,
): string {
  const sections: string[] = ['## 📊 数据摘要'];

  const m = weekData.members;
  const joinedNames = m.joined.length ? `：${mdInline(m.joined.map((x) => x.name || x.openId).join('、'))}` : '';
  const leftNames = m.left.length ? `：${mdInline(m.left.map((x) => x.name || x.openId).join('、'))}` : '';
  const netSign = m.presentExternalDelta >= 0 ? '+' : '';
  sections.push(
    [
      '### 👥 成员动态',
      `- ➕ 本周新增 **${m.joined.length}** 人${joinedNames}`,
      `- ➖ 本周离开 **${m.left.length}** 人${leftNames}`,
      `- 👀 围观群在场：**${m.presentExternal}** 人（本周净 ${netSign}${m.presentExternalDelta}）`,
      `- 💬 总消息量：**${weekData.totalMessages}** 条`,
    ].join('\n'),
  );

  if (weekData.docs.length > 0) {
    sections.push(
      [
        '### 📚 知识库浏览热点',
        ...weekData.docs.slice(0, 15).map((doc) => `- 《${mdInline(doc.title)}》 ${doc.readers} 人阅读`),
      ].join('\n'),
    );
  }

  if (eventsInWindow.length > 0) {
    sections.push(
      [
        '### 🎉 本周活动',
        ...eventsInWindow.map((ev) => `- 《${mdInline(ev.title)}》（${localDateFromEpochSec(ev.startTime)}）`),
      ].join('\n'),
    );
  }

  if (weekData.upcomingEvents.length > 0) {
    sections.push(
      [
        '### 🔮 即将到来的活动',
        ...weekData.upcomingEvents.map(
          (ev) => `- 《${mdInline(ev.title)}》 报名 ${ev.accepted} 人（开始 ${localDateFromEpochSec(ev.startTime)}）`,
        ),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}

/**
 * Gather a week's community data, generate an AI narrative via Kimi, write the report to a new
 * Feishu wiki page, and optionally notify the ops chat. In dry-run mode, all network/wiki writes are
 * skipped and the generated content is printed to the log instead.
 *
 * `ref` controls which Thursday 21:00 anchor to use — pass the current time for a live scheduled
 * run, or a past date to regenerate a historical report.
 */
export async function generateAndSendWeeklyReport(
  ref: Date = new Date(),
  opts: WeeklyReportOptions = {},
): Promise<void> {
  const range = weeklyReportRange(ref);
  const fromStr = localDateTimeFromEpochSec(range.from);
  const toStr = localDateTimeFromEpochSec(range.to);
  const titleDate = localDateSlash(range.to);
  const reportTitle = `${titleDate} 社区动态周报`;
  const dryRun = opts.dryRun ?? false;
  const includeNarrative = opts.narrative !== false;

  log.info(`周报生成开始（${fromStr} ~ ${toStr}，dryRun=${dryRun}）`);

  // Gather one week of community data.
  const weekData = await gatherDayData(range);
  const eventsInWindow = await eventsStartingBetween(range.from, range.to);
  log.info(
    `周报数据采集完成：${weekData.totalMessages} 条消息，${weekData.chats.length} 个群，` +
      `${eventsInWindow.length} 个本周活动，${weekData.upcomingEvents.length} 个即将到来的活动。`,
  );

  // Generate AI narrative.
  let narrative: string | null = null;
  if (includeNarrative) {
    narrative = await generateWeeklyNarrative(weekData, eventsInWindow, {
      soul: process.env.AGENT_SOUL ?? 'tudigong',
    });
  }

  // Build docx Markdown content: a single H1 title, the AI narrative (H2 aspects), then a data section.
  const mdParts: string[] = [`# ${reportTitle}`, `> 📅 统计范围：${fromStr} ~ ${toStr}`];
  if (narrative) mdParts.push(narrative.trim());
  mdParts.push('---');
  mdParts.push(buildDataSectionMarkdown(weekData, eventsInWindow));
  const mdContent = mdParts.join('\n\n');

  if (dryRun) {
    log.info(`[dry-run] 周报标题：${reportTitle}`);
    log.info(`[dry-run] 周报 Markdown 内容（${[...mdContent].length} 字符）：`);
    log.info(mdContent.slice(0, 4000) + (mdContent.length > 4000 ? '\n...(截断)' : ''));
    log.info('[dry-run] 跳过知识库写入与通知。');
    return;
  }

  // Resolve the target document: reuse an existing one, or create a new wiki node under the parent.
  const profile = resolveProfile(opts);
  let nodeToken: string;
  let documentId: string;
  if (opts.reuseDocumentId) {
    documentId = opts.reuseDocumentId;
    nodeToken = opts.reuseNodeToken ?? opts.reuseDocumentId;
    log.info(`周报：复用已有文档（docId=${documentId}）…`);
  } else {
    const wiki = resolveWikiCoords(opts);
    log.info(`周报：创建知识库节点（space=${wiki.spaceId}，parent=${wiki.parentNodeToken}）…`);
    const created = await createWikiNode(wiki.spaceId, wiki.parentNodeToken, reportTitle, { profile });
    nodeToken = created.nodeToken;
    documentId = created.documentId;
  }
  const wikiUrl = `https://seedao2049.feishu.cn/wiki/${nodeToken}`;
  log.info(`周报：目标文档（nodeToken=${nodeToken}，docId=${documentId}）→ ${wikiUrl}`);

  // Write report content into the docx, replacing any existing content so re-runs stay idempotent.
  log.info('周报：写入文档内容…');
  const appendOk = await appendDocxContent(documentId, mdContent, {
    profile,
    overwrite: true,
    format: 'markdown',
  });
  if (!appendOk) {
    log.warn(`周报：文档内容写入失败（docId=${documentId}），节点已创建但内容为空，请手动补充。`);
  } else {
    log.info('周报：文档内容写入成功。');
  }

  // Send notification to the ops chat (single target, not broadcast). Skipped when notify is false.
  const notifyChatId =
    opts.notify === false ? undefined : (opts.notifyChatId ?? resolveChatTarget('运营小天地'));
  if (notifyChatId) {
    try {
      await sendText(
        { chatId: notifyChatId },
        `【社区动态周报已发布】${reportTitle}\n统计范围：${fromStr} ~ ${toStr}\n查看详情：${wikiUrl}`,
        { as: 'bot' },
      );
      log.info(`周报：通知已发送至群 ${notifyChatId}。`);
    } catch (e) {
      log.warn('周报：通知发送失败：', (e as Error).message);
    }
  }

  log.info(`周报生成完成：${wikiUrl}`);
}
