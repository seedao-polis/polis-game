import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from './log.js';
import {
  sendTelegramPhoto,
  sendTelegramMessage,
  isTelegramConfigured,
} from './telegram.js';
import {
  memberSyncRoundsBetween,
  calendarEventRsvpHistory,
  calendarEventRsvpAll,
  eventsStartingBetween,
  wikiSpacesBetween,
  docViewersBetween,
  chatMemberOpenIds,
  upcomingTrackedEventIds,
} from './store.js';
import {
  listWikiNodesDeep,
  listChatMembers,
  uploadImage,
  sendPost,
  type WikiNode,
  type PostElement,
} from './lark.js';
import {
  LOGICAL_DAY_START_HOUR,
  logicalDayStart,
  logicalMonthStart,
  localDateFromEpochSec,
  localDateTimeFromEpochSec,
} from './time.js';
import { resolveChatTarget } from './configs.js';
import { generateOpsNarrative } from './ops-narrative.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

// Prefer the dedicated venv; fall back to system python3 if not yet set up.
const VENV_PY = join(PROJECT_ROOT, 'scripts', '.venv', 'bin', 'python3');
const PY_BIN = existsSync(VENV_PY) ? VENV_PY : 'python3';
const RENDER_PY = join(PROJECT_ROOT, 'scripts', 'render_report.py');

// Event titles containing any of these keywords are internal meetings, excluded from signup stats.
const EXCLUDED_EVENT_KEYWORDS = ['市政厅每周二'];

// Wiki node titles ending with any of these extensions are concrete file attachments, excluded from the tree.
const EXCLUDED_FILE_EXTENSIONS = ['.png', '.gif', '.jpg', '.jpeg', '.pdf', '.md'];

// Members of these chats count as SeeDAO staff; the wiki tree colors each node by its non-staff reader
// share. Resolved from configs/lark.json's knownInternalChats aliases at report time; unconfigured
// aliases are dropped (no staff coloring for that group rather than an error).
function staffChatIds(): string[] {
  return ['市政厅工作群', '运营小天地']
    .map((alias) => resolveChatTarget(alias))
    .filter((id): id is string => Boolean(id));
}

/** True when a wiki node title is a concrete file attachment that should not appear as a tree node. */
function isExcludedFileTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  return EXCLUDED_FILE_EXTENSIONS.some((ext) => t.endsWith(ext));
}

/**
 * Drop transient single-point dips from a member-count series. A read glitch appears as one point
 * far below both neighbors that immediately recovers; legitimate membership changes do not.
 */
function dropMemberDips<T extends { presentExternal: number }>(rounds: T[]): T[] {
  if (rounds.length < 3) return rounds;
  return rounds.filter((r, i) => {
    const prev = rounds[i - 1]?.presentExternal;
    const next = rounds[i + 1]?.presentExternal;
    if (prev === undefined || next === undefined) return true;
    return !(r.presentExternal < prev * 0.85 && r.presentExternal < next * 0.85);
  });
}

type Period = 'daily' | 'monthly';

interface ChartPoint {
  t: number;
  y: number;
}

interface LineSeries {
  name: string;
  points: ChartPoint[];
}

interface TreeNode {
  token: string;
  parent: string | null;
  title: string;
  // Total distinct readers of this document.
  readers: number;
  // Distinct readers who are not SeeDAO staff; drives node color and the "(nonstaff) total" label.
  nonstaff: number;
}

interface ChartSpec {
  type: 'line' | 'tree';
  key: string;
  title: string;
  subtitle?: string;
  y_label?: string;
  x_format?: string;
  lines?: LineSeries[];
  nodes?: TreeNode[];
}

interface ReportSpec {
  period: Period;
  range: { from: number; to: number };
  width: number;
  height: number;
  dpi: number;
  charts: ChartSpec[];
  out_dir: string;
}

/**
 * Resolve the [from, to) time range in unix seconds for a report period.
 * Time is logical-day based: a day spans 05:00 local to 05:00 the next day.
 *
 * daily:   from = logical-day start (05:00); to = next logical-day start (05:00), capped at now
 * monthly: from = logical-month start (1st 05:00); to = next logical-month start (1st 05:00), capped at now
 */
function resolveRange(period: Period, ref: Date): { from: number; to: number } {
  const nowSec = Math.floor(Date.now() / 1000);

  if (period === 'daily') {
    const start = logicalDayStart(ref);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return {
      from: Math.floor(start.getTime() / 1000),
      to: Math.min(Math.floor(end.getTime() / 1000), nowSec),
    };
  }

  // monthly
  const start = logicalMonthStart(ref);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1, LOGICAL_DAY_START_HOUR, 0, 0, 0);
  return {
    from: Math.floor(start.getTime() / 1000),
    to: Math.min(Math.floor(end.getTime() / 1000), nowSec),
  };
}

/**
 * Resolve the set of SeeDAO staff open_ids by fetching the staff chats' members live, so the
 * classification is refreshed each time a report is generated. Falls back to the locally-synced
 * member directory when the live fetch yields nothing.
 */
async function resolveStaffOpenIds(): Promise<Set<string>> {
  const set = new Set<string>();
  const chatIds = staffChatIds();
  for (const chatId of chatIds) {
    try {
      for (const openId of (await listChatMembers(chatId)).keys()) set.add(openId);
    } catch {
      // skip this chat on failure and rely on the remaining chats or the fallback
    }
  }
  if (set.size === 0 && chatIds.length > 0) {
    for (const id of await chatMemberOpenIds(chatIds)) set.add(id);
  }
  return set;
}

/**
 * Build the member-count line series from member_sync_rounds as raw 5-minute points across the
 * whole range (daily and monthly alike).
 */
async function buildMemberLine(range: { from: number; to: number }): Promise<LineSeries> {
  const rounds = dropMemberDips(await memberSyncRoundsBetween(range.from, range.to));
  return {
    name: 'SeeDAO 2.0 围观群',
    points: rounds.map((r) => ({ t: r.syncedAt, y: r.presentExternal })),
  };
}

/** Monthly signup chart downsample bucket: one point per hour keeps a month-long, multi-event trend
 *  readable instead of thousands of raw 5-minute points. */
const SIGNUP_BUCKET_SEC = 3600;

const isTrackedEventTitle = (title: string): boolean =>
  !EXCLUDED_EVENT_KEYWORDS.some((kw) => title.includes(kw));

/**
 * Downsample a running-count series to one representative point per SIGNUP_BUCKET_SEC bucket, keeping
 * the LAST value seen in each bucket (the accepted count as of that hour). A closing point is appended
 * at endSec (the event start) so the line clearly terminates when signup closes. Points must be sorted
 * ascending by t. Pure/exported for testing.
 */
export function bucketSignupPoints(points: ChartPoint[], endSec: number): ChartPoint[] {
  if (points.length === 0) return [];
  const out: ChartPoint[] = [];
  let curBucket = Math.floor(points[0]!.t / SIGNUP_BUCKET_SEC);
  let last = points[0]!;
  for (const p of points) {
    const b = Math.floor(p.t / SIGNUP_BUCKET_SEC);
    if (b !== curBucket) {
      out.push(last);
      curBucket = b;
    }
    last = p;
  }
  out.push(last);
  // Extend the line to the event start with the final count so it visibly ends at signup close.
  if (endSec > last.t) out.push({ t: endSec, y: last.y });
  return out;
}

/**
 * Build per-event signup line series.
 *  - daily: events still upcoming as of now, raw 5-minute points across the day (live tracking).
 *  - monthly: every event whose start_time fell in the month, each drawn as its full signup-to-start
 *    trend (from first recorded round up to the event start), downsampled to hourly points. This is a
 *    retrospective of the closed month, so past events must be included — upcomingTrackedEventIds would
 *    drop them all.
 * Internal-meeting titles are excluded in both modes.
 */
async function buildSignupLines(period: Period, range: { from: number; to: number }): Promise<LineSeries[]> {
  return period === 'monthly' ? buildMonthlySignupLines(range) : buildDailySignupLines(range);
}

async function buildDailySignupLines(range: { from: number; to: number }): Promise<LineSeries[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const events = (await upcomingTrackedEventIds(nowSec)).filter((ev) => isTrackedEventTitle(ev.title));
  const lines: LineSeries[] = [];
  for (const ev of events) {
    const rounds = await calendarEventRsvpHistory(ev.eventId, range.from, range.to);
    if (rounds.length === 0) continue;
    lines.push({ name: ev.title, points: rounds.map((r) => ({ t: r.syncedAt, y: r.accepted })) });
  }
  return lines;
}

async function buildMonthlySignupLines(range: { from: number; to: number }): Promise<LineSeries[]> {
  const events = (await eventsStartingBetween(range.from, range.to)).filter((ev) => isTrackedEventTitle(ev.title));
  const lines: LineSeries[] = [];
  for (const ev of events) {
    // Full history up to the event start (RSVP polling already stops at start, so this is the whole curve).
    const rounds = (await calendarEventRsvpAll(ev.eventId)).filter((r) => r.syncedAt <= ev.startTime);
    if (rounds.length === 0) continue;
    const points = bucketSignupPoints(rounds.map((r) => ({ t: r.syncedAt, y: r.accepted })), ev.startTime);
    lines.push({ name: ev.title, points });
  }
  return lines;
}

/**
 * Build wiki tree nodes by fetching live wiki structure and joining with doc_view_events.
 *
 * Discovers which spaces had activity in the range, fetches their node trees, joins with
 * unique-reader counts, then prunes to nodes with readers>0 and their ancestor paths.
 * Returns an empty array when no readers were found (caller skips the tree chart).
 */
async function buildWikiTreeNodes(range: { from: number; to: number }): Promise<TreeNode[]> {
  const spaceIds = await wikiSpacesBetween(range.from, range.to);
  if (spaceIds.length === 0) return [];

  const viewersByToken = await docViewersBetween(range.from, range.to);
  const staffSet = await resolveStaffOpenIds();

  // Collect all wiki nodes across all active spaces.
  const allNodes: WikiNode[] = [];
  for (const spaceId of spaceIds) {
    const nodes = await listWikiNodesDeep(spaceId);
    allNodes.push(...nodes);
  }

  if (allNodes.length === 0) return [];

  // Build a lookup from nodeToken -> node for ancestor path traversal.
  const byToken = new Map<string, WikiNode>();
  for (const n of allNodes) {
    byToken.set(n.nodeToken, n);
  }

  // The doc_view_events key is file_token = objToken; readers are that document's distinct viewers.
  const viewersOf = (n: WikiNode): string[] => viewersByToken.get(n.objToken) ?? [];

  // Identify nodes with at least one reader, excluding concrete file attachments by title.
  const hasReaders = new Set<string>(
    allNodes
      .filter((n) => viewersOf(n).length > 0 && !isExcludedFileTitle(n.title))
      .map((n) => n.nodeToken),
  );

  if (hasReaders.size === 0) return [];

  // Walk each reader-node up to its root, collecting ancestor tokens.
  const keepSet = new Set<string>(hasReaders);
  for (const token of hasReaders) {
    let cur = byToken.get(token);
    while (cur && cur.parentNodeToken) {
      if (keepSet.has(cur.parentNodeToken)) break; // already included
      keepSet.add(cur.parentNodeToken);
      cur = byToken.get(cur.parentNodeToken);
    }
  }

  // Return only pruned nodes; each node carries its reader count and non-staff reader share.
  return allNodes
    .filter((n) => keepSet.has(n.nodeToken))
    .map((n) => {
      const viewers = viewersOf(n);
      const total = viewers.length;
      const nonStaff = viewers.filter((v) => !staffSet.has(v)).length;
      return {
        token: n.nodeToken,
        parent: n.parentNodeToken || null,
        title: n.title,
        readers: total,
        nonstaff: nonStaff,
      };
    });
}

/**
 * Build a Simplified Chinese text summary from the assembled spec data.
 * Computes member net change, signup totals, and top wiki documents.
 */
function buildTextSummary(
  period: Period,
  range: { from: number; to: number },
  memberLine: LineSeries,
  signupLines: LineSeries[],
  wikiNodes: TreeNode[],
): string {
  const label = period === 'daily' ? '每日' : '每月';
  const fromDate = localDateFromEpochSec(range.from);
  const toDate = localDateFromEpochSec(range.to - 1);
  const dateRange = period === 'daily' ? fromDate : `${fromDate} ~ ${toDate}`;

  const lines: string[] = [`【${label}运营数据】${dateRange}`];

  // Member net change.
  const periodWord = period === 'daily' ? '本日' : '本月';
  const pts = memberLine.points;
  if (pts.length >= 2) {
    const first = pts[0]!.y;
    const last = pts[pts.length - 1]!.y;
    const delta = last - first;
    const sign = delta >= 0 ? '+' : '';
    lines.push(`· 围观群人数：${last}（${periodWord}${sign}${delta}）`);
  } else if (pts.length === 1) {
    lines.push(`· 围观群人数：${pts[0]!.y}`);
  } else {
    lines.push('· 围观群人数：暂无数据');
  }

  // Signup totals. Monthly is a retrospective of events held that month; daily tracks still-upcoming ones.
  if (signupLines.length === 0) {
    lines.push(period === 'monthly' ? '· 活动报名：本月无活动' : '· 活动报名：无进行中追踪活动');
  } else {
    let totalSignups = 0;
    for (const s of signupLines) {
      const last = s.points.at(-1);
      if (last) totalSignups += last.y;
    }
    lines.push(
      period === 'monthly'
        ? `· 活动报名：本月 ${signupLines.length} 场活动，累计报名 ${totalSignups} 人`
        : `· 活动报名：追踪 ${signupLines.length} 场活动，累计报名 ${totalSignups} 人`,
    );
  }

  // Wiki readers and top docs. Each doc's reader count is deduplicated per person; the total sums
  // those per-doc counts, so it is reader-instances (a person reading N docs counts N), not distinct people.
  const readerDocs = wikiNodes.filter((n) => n.readers > 0);
  if (readerDocs.length === 0) {
    lines.push('· 知识库阅读：暂无阅读数据');
  } else {
    const totalReaders = readerDocs.reduce((sum, n) => sum + n.readers, 0);
    lines.push(`· 知识库阅读：累计 ${totalReaders} 读者人次（去重读者），覆盖 ${readerDocs.length} 份知识库文档`);
  }

  return lines.join('\n');
}

/**
 * Invoke the Python renderer as a subprocess. Returns a map of chart key -> absolute PNG path.
 * Collects stderr and logs as warnings. Parses the last stdout line as JSON.
 */
function renderViaPython(specPath: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(PY_BIN, [RENDER_PY, specPath], {
      cwd: join(PROJECT_ROOT, 'scripts'),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 90_000,
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });

    child.on('error', reject);
    child.on('close', (code) => {
      if (err.trim()) {
        log.warn('Python渲染警告：' + err.trim().replace(/\n/g, ' '));
      }
      if (code !== 0) {
        return reject(new Error(`render_report.py 退出码 ${code}`));
      }
      const lines = out.trim().split('\n');
      const last = lines.pop() ?? '';
      try {
        resolve(JSON.parse(last) as Record<string, string>);
      } catch (e) {
        reject(new Error(`解析Python输出JSON失败：${last}`));
      }
    });
  });
}

/**
 * Deliver the report to Feishu as a single rich-text post: the text summary followed by the chart
 * images. Targets a group chat or a P2P user (open_id). Images upload under the bot identity, and
 * must live under the process cwd for lark-cli's file sandbox.
 */
async function sendReportToLark(
  target: { chatId?: string; userId?: string },
  title: string,
  textSummary: string,
  pngPaths: string[],
): Promise<void> {
  const content: PostElement[][] = [];
  for (const line of textSummary.split('\n')) {
    content.push([{ tag: 'text', text: line }]);
  }
  // A blank line before each image separates the summary from the charts and the charts from
  // one another, so the images are not cramped together.
  for (const png of pngPaths) {
    const key = await uploadImage(png);
    if (!key) continue;
    content.push([{ tag: 'text', text: '' }]);
    content.push([{ tag: 'img', image_key: key }]);
  }
  await sendPost(target, { title, content }, { as: 'bot' });
}

/** Format the report date label in local time: YYYY-MM-DD for daily, YYYY-MM for monthly. */
function formatRangeLabel(period: Period, fromSec: number): string {
  const full = localDateFromEpochSec(fromSec);
  return period === 'daily' ? full : full.slice(0, 7);
}

interface ReportTargets {
  // Feishu group chat id to post the report to.
  larkChat?: string;
  // Feishu user open_id to post the report to (P2P preview).
  larkUser?: string;
  // Set false to skip the AI community-ops narrative (CLI --no-narrative); env OPS_REPORT_NARRATIVE=0 also disables.
  narrative?: boolean;
}

/** Split long text into Telegram-safe chunks (<= ~3500 chars), preferring paragraph then line breaks. */
function splitForTelegram(text: string, maxChars = 3500): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let cur = '';
  for (const para of text.split('\n\n')) {
    const piece = cur ? `${cur}\n\n${para}` : para;
    if (piece.length <= maxChars) {
      cur = piece;
      continue;
    }
    if (cur) {
      chunks.push(cur);
      cur = '';
    }
    if (para.length <= maxChars) {
      cur = para;
      continue;
    }
    let rest = para; // a single paragraph longer than the limit — hard-split.
    while (rest.length > maxChars) {
      chunks.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    cur = rest;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Core report pipeline: gather data, spawn Python renderer, deliver to Telegram and/or Feishu. */
async function generateAndSendReport(period: Period, ref: Date, targets: ReportTargets = {}): Promise<void> {
  const range = resolveRange(period, ref);
  const xFmt = period === 'daily' ? '%H:%M' : '%m-%d';
  const label = period === 'daily' ? '每日' : '每月';
  const dateLabel = formatRangeLabel(period, range.from);
  const dateSlash = dateLabel.replace(/-/g, '/');
  const dayWord = period === 'daily' ? '当日' : '当月';

  log.info(`运营报告生成开始（period=${period}，date=${dateLabel}）`);

  const memberLine = await buildMemberLine(range);
  const signupLines = await buildSignupLines(period, range);
  const wikiNodes = await buildWikiTreeNodes(range);

  // Output under the repo so lark-cli's cwd-relative file sandbox can upload the images.
  const out_dir = await mkdtemp(join(PROJECT_ROOT, '.ops-report-'));
  try {
    await renderAndDeliver();
  } finally {
    await rm(out_dir, { recursive: true, force: true });
  }

  async function renderAndDeliver(): Promise<void> {

  const charts: ChartSpec[] = [
    {
      type: 'line',
      key: 'member',
      title: `${dateSlash} ${dayWord}围观群人数趋势`,
      y_label: '群成员人数',
      x_format: xFmt,
      lines: [memberLine],
    },
  ];

  if (signupLines.length > 0) {
    charts.push({
      type: 'line',
      key: 'signup',
      title: period === 'monthly'
        ? `${dateSlash} 各活动报名趋势（报名至活动开始）`
        : `${dateSlash} 活动报名人数趋势`,
      y_label: '报名人数',
      x_format: xFmt,
      lines: signupLines,
    });
  }

  const hasWikiData = wikiNodes.length > 0;
  if (hasWikiData) {
    charts.push({
      type: 'tree',
      key: 'wiki',
      title: '知识库阅读热点（去重读者数）',
      subtitle: `统计时间 ${localDateTimeFromEpochSec(range.from)} ~ ${localDateTimeFromEpochSec(range.to)}　偏红=非工作人员读者占比越高　格式: (非工作人员读者数) 去重读者数`,
      nodes: wikiNodes,
    });
  }

  const spec: ReportSpec = {
    period,
    range,
    width: 1920,
    height: 1080,
    dpi: 200,
    charts,
    out_dir,
  };

  const specPath = join(out_dir, 'spec.json');
  await writeFile(specPath, JSON.stringify(spec, null, 2), 'utf-8');

  let pngs: Record<string, string> = {};
  try {
    pngs = await renderViaPython(specPath);
    log.info(`运营报告渲染完成：${Object.keys(pngs).join(', ')}`);
  } catch (e) {
    log.error('运营报告Python渲染失败：', (e as Error).message);
  }

  const textSummary = buildTextSummary(period, range, memberLine, signupLines, wikiNodes);
  const orderedKeys = ['member', 'signup', 'wiki'];

  // AI community-ops narrative (map-reduce over the day's collected records). Best-effort: any failure
  // degrades to the mechanical summary so the charts still ship. Disable with OPS_REPORT_NARRATIVE=0 or
  // targets.narrative === false (CLI --no-narrative). Monthly reports skip it (too coarse for chat digest).
  let narrative: string | null = null;
  if (period === 'daily' && targets.narrative !== false && process.env.OPS_REPORT_NARRATIVE !== '0') {
    try {
      narrative = await generateOpsNarrative(range, { dateLabel });
      if (narrative) log.info('运营报告洞察生成完成');
    } catch (e) {
      log.error('运营报告洞察生成失败：', (e as Error).message);
    }
  }
  const deliveryBody = narrative ? `${narrative}\n\n【数据摘要】\n${textSummary}` : textSummary;

  // Optional Feishu delivery (group chat or P2P preview), independent of Telegram.
  if (targets.larkChat || targets.larkUser) {
    try {
      await sendReportToLark(
        { chatId: targets.larkChat, userId: targets.larkUser },
        `SeeDAO ${label}运营数据 · ${dateLabel}`,
        deliveryBody,
        orderedKeys.map((k) => pngs[k]).filter((p): p is string => Boolean(p)),
      );
      log.info('运营报告已发送到飞书');
    } catch (e) {
      log.error('运营报告发送飞书失败：', (e as Error).message);
    }
  }

  if (!isTelegramConfigured()) {
    log.warn('Telegram未配置，跳过Telegram发送（已完成渲染）');
    return;
  }

  // Send each chart separately (three independent messages per spec decision).
  const captions: Record<string, string> = {
    member: `【${label}运营报告 ${dateLabel}】围观群人数`,
    signup: `【${label}运营报告 ${dateLabel}】活动报名人数`,
    wiki: `【${label}运营报告 ${dateLabel}】知识库阅读热点（去重读者数）`,
  };

  for (const key of orderedKeys) {
    if (pngs[key]) {
      try {
        await sendTelegramPhoto(pngs[key]!, captions[key]);
      } catch (e) {
        log.error(`发送图表失败（${key}）：`, (e as Error).message);
      }
    }
  }

  for (const chunk of splitForTelegram(deliveryBody)) {
    try {
      await sendTelegramMessage(chunk);
    } catch (e) {
      log.error('发送文字摘要失败：', (e as Error).message);
    }
  }

  log.info('运营报告发送完成');
  }
}

/**
 * Generate and send the daily ops report. ref defaults to today (pass yesterday for scheduled runs).
 */
export async function generateAndSendDailyReport(ref = new Date(), targets: ReportTargets = {}): Promise<void> {
  await generateAndSendReport('daily', ref, targets);
}

/**
 * Generate and send the monthly ops report. ref defaults to current month (pass last month for scheduled runs).
 */
export async function generateAndSendMonthlyReport(ref = new Date(), targets: ReportTargets = {}): Promise<void> {
  await generateAndSendReport('monthly', ref, targets);
}
