import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { resolveLarkRun, RUNTIME_DIR } from './paths.js';
import { runFileSync } from './subprocess.js';

// ── lark-cli wrapper (Feishu official CLI, dual user/bot identity) ─────────────────
// Run run.js directly via node to avoid the Windows .cmd shim and Chinese/emoji argument encoding issues.
// Identity = profile = app = enterprise: always pass --profile for SeeDAO, otherwise it falls back to the old app and gets blocked.
// All send/receive functions also accept and forward profile (larkExec inserts --profile at the front of args).

const MAX_BUFFER = 20 * 1024 * 1024;

export interface LarkMessage {
  messageId: string;
  position: number;
  content: string;
  msgType: string;
  createTime: string;
  sender: Record<string, unknown>;
  /** Targets that were @-mentioned (open_id list), used for mention-trigger detection */
  mentions: string[];
  /** Sender display name (for collection; absent from list API responses, so often empty) */
  senderName: string;
  /** Sender open_id extracted from sender.id when sender.id_type === 'open_id' */
  senderOpenId: string;
  /** Raw sender.id_type value */
  senderIdType?: string;
  /** Raw sender.sender_type value (e.g. 'user', 'app') */
  senderType?: string;
  /** Raw sender.tenant_key value */
  senderTenantKey?: string;
  /** Thread identifier for threaded messages */
  threadId?: string;
  /** Position of this message within its thread */
  threadMessagePosition?: number;
  /** Emoji reactions on this message; only populated when listMessages is called with includeReactions. */
  reactions?: MessageReaction[];
}

/** A single emoji reaction on a message (one reactor + one emoji), from the message-list reactions.details[]. */
export interface MessageReaction {
  /** open_id of the person who reacted */
  reactorOpenId: string;
  /** emoji_type, e.g. 'PARTY' / 'THUMBSUP' */
  emojiType: string;
  /** operator_type, e.g. 'user' (a person) vs 'app' (a bot) */
  operatorType: string;
  /** when the reaction was added (unix seconds); 0 when absent */
  actionTime: number;
}

/** Single chat entry from internal-group discovery results. */
export interface LarkChat {
  chatId: string;
  name: string;
  /** Whether it is an external group (external=true means a cross-tenant external group) */
  external: boolean;
}

export interface LarkExecOptions {
  /** lark-cli global profile name (maps to enterprise/identity), inserted as --profile at the front of args */
  profile?: string;
}

function larkExec(args: string[], opts: LarkExecOptions = {}): any {
  const run = resolveLarkRun();
  if (!run) {
    throw new Error(
      '找不到 lark-cli 的 run.js。请 npm i -g @larksuite/cli 或设置环境变量 LARK_RUN。'
    );
  }
  const finalArgs = opts.profile ? ['--profile', opts.profile, ...args] : args;
  // stdio: pipe stdout AND stderr so we CAPTURE them rather than letting Node forward the child's
  // stderr straight to our own — lark-cli prints its full error envelope (e.g. a 232009 "chat
  // dissolved") to stderr, which would otherwise leak to the console/log on every failed call.
  const r = runFileSync('node', [run, ...finalArgs], {
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // On success parse stdout; on failure fall back to the combined stdout+stderr (the error envelope
  // may land on either stream). If the call produced no output at all, surface the failure.
  const out = r.ok ? r.stdout : r.combined;
  if (!r.ok && !out) throw new Error(r.error?.message || 'lark-cli 调用失败');
  try {
    return JSON.parse(out);
  } catch {
    return { ok: false, raw: out };
  }
}

export function authStatus(profile?: string): any {
  return larkExec(['auth', 'status'], { profile });
}

/**
 * Fetch the display name of a Feishu user by their open_id.
 * Uses the user identity (--as user) because the bot identity cannot retrieve names from the contact API.
 * Returns an empty string when the name is unavailable or the call fails; never throws.
 */
export function getUserName(openId: string, profile?: string): string {
  try {
    const res = larkExec(
      ['contact', '+get-user', '--user-id', openId, '--user-id-type', 'open_id', '--as', 'user', '--format', 'json'],
      { profile }
    );
    const name = res?.data?.user?.name;
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

/**
 * Fetch a chat's member roster as an open_id -> display-name map, paging until exhausted. Unlike the
 * contact API, this returns names for CROSS-TENANT/EXTERNAL members too (their display name within
 * the shared group), which is the only way to name external lurkers. Native command -> success is
 * code===0. Best-effort for transient/partial failures: returns whatever it gathered (empty map),
 * never throws. The ONE exception is a definitive "chat gone / we're not in it" error (dissolved 232009,
 * kicked out, no permission): that is THROWN as a LarkApiError so callers can stand the chat down,
 * instead of being silently swallowed into an empty roster and re-polled forever.
 */
export function listChatMembers(chatId: string, opts: { profile?: string } = {}): Map<string, string> {
  const out = new Map<string, string>();
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    // Safety cap: 20 pages * 100 = 2000 members.
    const params: Record<string, unknown> = { chat_id: chatId, member_id_type: 'open_id', page_size: 100 };
    if (pageToken) params.page_token = pageToken;
    let res: any;
    try {
      res = larkExec(
        ['im', 'chat.members', 'get', '--params', JSON.stringify(params), '--as', 'user', '--format', 'json'],
        { profile: opts.profile }
      );
    } catch {
      break; // transport blip (CLI produced no output) → return what we have so far
    }
    if (res?.code !== 0) {
      // Surface a permanent "chat gone / inaccessible" so the caller can stop servicing this chat;
      // swallow everything else (transient blip / partial page) and return what we gathered.
      const apiErr = new LarkApiError('读取群成员失败', res);
      if (isChatGoneError(apiErr) || isChatInaccessibleError(apiErr)) throw apiErr;
      break;
    }
    const items: any[] = res.data?.items ?? [];
    for (const it of items) {
      const id = it?.member_id;
      const name = it?.name;
      if (typeof id === 'string' && typeof name === 'string' && name) out.set(id, name);
    }
    const next = res.data?.page_token ?? '';
    if (res.data?.has_more === true && next) pageToken = next;
    else break;
  }
  return out;
}

export function isLoggedIn(profile?: string): boolean {
  const auth = authStatus(profile);
  const user = auth?.identities?.user;
  return !!(user && (user.available || user.status === 'ready'));
}

/** A single Feishu calendar event returned by the +agenda shortcut. */
export interface CalendarEvent {
  eventId: string;
  summary: string;
  startTimeSec: number;
  endTimeSec: number;
  calendarId: string;
  /** Feishu deep link to open this event's detail (from the event's app_link field); '' if absent. */
  appLink: string;
}

/**
 * The recurring-series key for an event id. +agenda expands a recurring event into one item per
 * occurrence, each with event_id "<series-uuid>_<unix-ts>"; the uuid identifies the series. A
 * non-recurring event has its own unique uuid, so this collapses occurrences of the same series
 * while leaving distinct events distinct. UUIDs contain no '_', so only the occurrence separator is
 * stripped; an id without a trailing _<digits> is returned unchanged.
 */
export function recurringSeriesKey(eventId: string): string {
  const m = /^(.*)_\d+$/.exec(eventId);
  return m ? m[1] : eventId;
}

/**
 * Fetch upcoming calendar events in the given ISO 8601 date/time window via the +agenda shortcut.
 * +agenda aggregates all calendars visible to the user (primary + shared), which includes community
 * events created on shared calendars. Success is ok===true (shortcut envelope, not code===0).
 * Each event's start_time / end_time is a {datetime, timezone} object; datetime is ISO 8601 and is
 * converted to unix seconds. Fields missing or producing NaN are defaulted to 0. Best-effort: any
 * failure returns [] and never throws into the caller's poll loop.
 */
export function listUpcomingCalendarEvents(opts: {
  profile?: string;
  startIso: string;
  endIso: string;
}): CalendarEvent[] {
  try {
    const res = larkExec(
      ['calendar', '+agenda', '--start', opts.startIso, '--end', opts.endIso, '--as', 'user', '--format', 'json'],
      { profile: opts.profile }
    );
    if (res?.ok !== true) return [];
    const items: any[] = Array.isArray(res.data) ? res.data : [];
    const out: CalendarEvent[] = [];
    for (const ev of items) {
      const eventId = typeof ev?.event_id === 'string' ? ev.event_id : '';
      if (!eventId) continue;
      const summary = typeof ev?.summary === 'string' ? ev.summary : '';
      const startRaw = ev?.start_time?.datetime;
      const endRaw = ev?.end_time?.datetime;
      const startTimeSec = typeof startRaw === 'string'
        ? Math.floor(new Date(startRaw).getTime() / 1000)
        : 0;
      const endTimeSec = typeof endRaw === 'string'
        ? Math.floor(new Date(endRaw).getTime() / 1000)
        : 0;
      const calendarId = typeof ev?.organizer_calendar_id === 'string' ? ev.organizer_calendar_id : '';
      const appLink = typeof ev?.app_link === 'string' ? ev.app_link : '';
      out.push({
        eventId,
        summary,
        startTimeSec: Number.isNaN(startTimeSec) ? 0 : startTimeSec,
        endTimeSec: Number.isNaN(endTimeSec) ? 0 : endTimeSec,
        calendarId,
        appLink,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** A single attendee entry from the event.attendees list native API. */
export interface CalendarAttendee {
  userId: string;
  displayName: string;
  rsvpStatus: string;
  type: string;
  isExternal: boolean;
}

/**
 * Fetch all attendees for a given calendar event, paging until has_more is false (cap: 20 pages).
 * Uses the native event.attendees list API — success is code===0 (not ok). Mirrors the listChatMembers
 * paging structure: page_token-based loop, 20-page safety cap, best-effort on partial failures.
 * is_external only appears on external attendees; internal members omit the field (treated as false).
 */
export function listEventAttendees(
  calendarId: string,
  eventId: string,
  opts: { profile?: string } = {}
): CalendarAttendee[] {
  const out: CalendarAttendee[] = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    // Safety cap: 20 pages * 100 = 2000 attendees.
    const params: Record<string, unknown> = {
      calendar_id: calendarId,
      event_id: eventId,
      user_id_type: 'open_id',
      page_size: 100,
    };
    if (pageToken) params.page_token = pageToken;
    let res: any;
    try {
      res = larkExec(
        ['calendar', 'event.attendees', 'list', '--params', JSON.stringify(params), '--as', 'user', '--format', 'json'],
        { profile: opts.profile }
      );
    } catch {
      break; // transport blip → return what we have so far
    }
    if (res?.code !== 0) break;
    const items: any[] = res.data?.items ?? [];
    for (const it of items) {
      const userId = typeof it?.user_id === 'string' ? it.user_id : '';
      const displayName = typeof it?.display_name === 'string' ? it.display_name : '';
      const rsvpStatus = typeof it?.rsvp_status === 'string' ? it.rsvp_status : '';
      const type = typeof it?.type === 'string' ? it.type : '';
      const isExternal = !!it?.is_external;
      out.push({ userId, displayName, rsvpStatus, type, isExternal });
    }
    const next = res.data?.page_token ?? '';
    if (res.data?.has_more === true && next) pageToken = next;
    else break;
  }
  return out;
}

/**
 * Fetch the public web share link for a calendar event — a `https://www.feishu.cn/calendar/share?token=…`
 * URL that opens in a browser, via the native event share_info API. event_id must be the full occurrence
 * id (the agenda's `<uuid>_<ts>` form; the bare uuid is rejected). Best-effort: returns '' on any failure
 * so the caller can fall back to the in-app app_link.
 */
export function getEventShareLink(calendarId: string, eventId: string, opts: { profile?: string } = {}): string {
  try {
    const res = larkExec(
      ['calendar', 'events', 'share_info', '--calendar-id', calendarId, '--event-id', eventId, '--as', 'user', '--format', 'json'],
      { profile: opts.profile }
    );
    const link = res?.data?.share_link;
    return typeof link === 'string' ? link : '';
  } catch {
    return '';
  }
}

// ── knowledge-base document view-record polling ────────────────
// Read-side wrappers for tracking who has viewed which knowledge-base document and when. The Feishu
// access-record API (drive file.view_records) is per-file and returns one entry per distinct viewer
// carrying that viewer's MOST-RECENT view time — a viewer list, not a per-visit event stream — so
// polling surfaces new viewers and advancing view times. The API requires the caller to own or
// administer the file; a caller with only edit/read access is rejected and that file is treated as a
// coverage gap rather than a hard error.

/** A wiki space (knowledge base) visible to the caller. */
export interface WikiSpace {
  spaceId: string;
  name: string;
}

/** A wiki knowledge-base node paired with the underlying document object it wraps. */
export interface WikiNode {
  nodeToken: string;
  objToken: string;
  objType: string;
  title: string;
  hasChild: boolean;
  spaceId: string;
  /** Token of the parent node; empty string means this node is a space root. */
  parentNodeToken: string;
}

/** A single viewer's access record for a file: who they are and when they most recently viewed it. */
export interface FileViewRecord {
  viewerId: string;
  name: string;
  lastViewTimeSec: number;
}

/** A file or folder entry from the user's Drive. */
export interface DriveFile {
  token: string;
  type: string;
  name: string;
  ownerId: string;
  parentToken: string;
}

/**
 * List the wiki spaces (knowledge bases) visible to the current user identity. Native command —
 * success is code===0, items in data.items, paged via has_more/page_token. Best-effort: returns what
 * it gathered, never throws.
 */
export function listWikiSpaces(opts: { profile?: string } = {}): WikiSpace[] {
  const out: WikiSpace[] = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const params: Record<string, unknown> = { page_size: 50 };
    if (pageToken) params.page_token = pageToken;
    let res: any;
    try {
      res = larkExec(
        ['wiki', 'spaces', 'list', '--params', JSON.stringify(params), '--as', 'user', '--format', 'json'],
        { profile: opts.profile }
      );
    } catch {
      break;
    }
    if (res?.code !== 0) break;
    const items: any[] = res.data?.items ?? [];
    for (const it of items) {
      const spaceId = typeof it?.space_id === 'string' ? it.space_id : '';
      if (!spaceId) continue;
      out.push({ spaceId, name: typeof it?.name === 'string' ? it.name : '' });
    }
    const next = res.data?.page_token ?? '';
    if (res.data?.has_more === true && next) pageToken = next;
    else break;
  }
  return out;
}

/**
 * List the direct child nodes under a wiki space root (parentNodeToken empty) or a parent node, paging
 * until exhausted. Native command — success is code===0. Best-effort: returns what it gathered.
 */
function listWikiChildNodes(spaceId: string, parentNodeToken: string, opts: { profile?: string }): WikiNode[] {
  const out: WikiNode[] = [];
  let pageToken = '';
  for (let page = 0; page < 50; page++) {
    const params: Record<string, unknown> = { space_id: spaceId, page_size: 50 };
    if (parentNodeToken) params.parent_node_token = parentNodeToken;
    if (pageToken) params.page_token = pageToken;
    let res: any;
    try {
      res = larkExec(
        ['wiki', 'nodes', 'list', '--params', JSON.stringify(params), '--as', 'user', '--format', 'json'],
        { profile: opts.profile }
      );
    } catch {
      break;
    }
    if (res?.code !== 0) break;
    const items: any[] = res.data?.items ?? [];
    for (const it of items) {
      const nodeToken = typeof it?.node_token === 'string' ? it.node_token : '';
      const objToken = typeof it?.obj_token === 'string' ? it.obj_token : '';
      if (!nodeToken || !objToken) continue;
      out.push({
        nodeToken,
        objToken,
        objType: typeof it?.obj_type === 'string' ? it.obj_type : '',
        title: typeof it?.title === 'string' ? it.title : '',
        hasChild: it?.has_child === true,
        spaceId,
        parentNodeToken: typeof it?.parent_node_token === 'string' ? it.parent_node_token : '',
      });
    }
    const next = res.data?.page_token ?? '';
    if (res.data?.has_more === true && next) pageToken = next;
    else break;
  }
  return out;
}

/**
 * Walk an entire wiki space and return every node (root level plus all descendants), following
 * has_child to recurse. Bounded breadth-first traversal (caps visited parents and total nodes) to stay
 * safe on very large spaces or shortcut cycles. Best-effort: returns what it could gather.
 */
export function listWikiNodesDeep(spaceId: string, opts: { profile?: string } = {}): WikiNode[] {
  const all: WikiNode[] = [];
  const seen = new Set<string>();
  const queue: string[] = ['']; // '' = space root
  let visited = 0;
  while (queue.length > 0 && visited < 500 && all.length < 5000) {
    const parent = queue.shift() as string;
    visited += 1;
    for (const node of listWikiChildNodes(spaceId, parent, opts)) {
      if (seen.has(node.nodeToken)) continue;
      seen.add(node.nodeToken);
      all.push(node);
      if (node.hasChild) queue.push(node.nodeToken);
    }
  }
  return all;
}

/** Result of a successful wiki node creation. */
export interface CreatedWikiNode {
  nodeToken: string;
  /** obj_token of the underlying docx document. */
  documentId: string;
}

/**
 * Create a new wiki node (docx type, origin ownership) as a child of `parentNodeToken` inside
 * `spaceId`. Uses the native wiki/v2 API — success is code===0. The caller must supply a `profile`
 * that holds a user identity with `wiki:node:create` and `docx:document:create` scopes.
 *
 * Throws {@link LarkApiError} on API rejection; returns the pair (nodeToken, documentId) on success.
 */
export function createWikiNode(
  spaceId: string,
  parentNodeToken: string,
  title: string,
  opts: { profile?: string } = {}
): CreatedWikiNode {
  const body = {
    parent_node_token: parentNodeToken,
    obj_type: 'docx',
    node_type: 'origin',
    title,
  };
  const res = larkExec(
    ['api', 'POST', `/open-apis/wiki/v2/spaces/${spaceId}/nodes`,
      '--data', JSON.stringify(body),
      '--as', 'user',
      '--format', 'json'],
    { profile: opts.profile }
  );
  if (res?.code !== 0) {
    throw new LarkApiError(`创建知识库节点失败（space=${spaceId}）`, res);
  }
  const node = res?.data?.node;
  const nodeToken = typeof node?.node_token === 'string' ? node.node_token : '';
  const documentId = typeof node?.obj_token === 'string' ? node.obj_token : '';
  if (!nodeToken || !documentId) {
    throw new LarkApiError('创建知识库节点：响应缺少 node_token / obj_token', res);
  }
  return { nodeToken, documentId };
}

/**
 * Write content into an existing docx document: append to the end (default) or replace the whole
 * body (opts.overwrite). Content is Feishu docx v2 block XML by default, or Markdown when
 * opts.format is 'markdown' — Feishu renders Markdown headings, bullet lists, links, and network
 * images into native docx blocks. Uses `docs +update --api-version v2`.
 *
 * Requires the profile to hold both `docx:document:write_only` and `docx:document:readonly` scopes
 * as user identity: the shortcut reads the document to locate the end block before writing.
 *
 * Returns true when the shortcut reports ok; returns false when the API rejects the request, so the
 * caller can degrade gracefully without crashing the pipeline.
 */
export function appendDocxContent(
  documentId: string,
  content: string,
  opts: { profile?: string; overwrite?: boolean; format?: 'markdown' | 'xml' } = {}
): boolean {
  const args = ['docs', '+update',
    '--api-version', 'v2',
    '--doc', documentId,
    '--command', opts.overwrite ? 'overwrite' : 'append',
    '--content', content,
    '--as', 'user',
    '--format', 'json'];
  if (opts.format === 'markdown') args.push('--doc-format', 'markdown');
  const res = larkExec(args, { profile: opts.profile });
  return res?.ok === true;
}

/**
 * Insert an image into an existing docx document at a best-effort position using
 * `docs +media-insert`. Handles the multi-step upload-and-embed orchestration transparently.
 * Requires `docs:document.media:upload` scope as user identity.
 *
 * `filePath` must be either an absolute path or a path relative to the current working directory.
 * Returns true on success, false on any failure; never throws so it can safely wrap optional steps.
 */
export function insertDocxImage(
  documentId: string,
  filePath: string,
  opts: { profile?: string } = {}
): boolean {
  try {
    const res = larkExec(
      ['docs', '+media-insert',
        '--doc', documentId,
        '--file', filePath,
        '--type', 'image',
        '--as', 'user',
        '--format', 'json'],
      { profile: opts.profile }
    );
    return res?.ok === true;
  } catch {
    return false;
  }
}

/**
 * List the files and folders directly under a Drive folder (the user's root when folderToken is
 * empty), paging until exhausted. Native command — success is code===0, entries in data.files.
 * Best-effort: returns what it gathered.
 */
function listDriveFolder(folderToken: string, opts: { profile?: string }): DriveFile[] {
  const out: DriveFile[] = [];
  let pageToken = '';
  for (let page = 0; page < 50; page++) {
    const params: Record<string, unknown> = { page_size: 50 };
    if (folderToken) params.folder_token = folderToken;
    if (pageToken) params.page_token = pageToken;
    let res: any;
    try {
      res = larkExec(
        ['drive', 'files', 'list', '--params', JSON.stringify(params), '--as', 'user', '--format', 'json'],
        { profile: opts.profile }
      );
    } catch {
      break;
    }
    if (res?.code !== 0) break;
    const files: any[] = res.data?.files ?? [];
    for (const f of files) {
      const token = typeof f?.token === 'string' ? f.token : '';
      if (!token) continue;
      out.push({
        token,
        type: typeof f?.type === 'string' ? f.type : '',
        name: typeof f?.name === 'string' ? f.name : '',
        ownerId: typeof f?.owner_id === 'string' ? f.owner_id : '',
        parentToken: typeof f?.parent_token === 'string' ? f.parent_token : '',
      });
    }
    const next = res.data?.page_token ?? '';
    if (res.data?.has_more === true && next) pageToken = next;
    else break;
  }
  return out;
}

/**
 * Walk the user's Drive from the root (or a given folder) and return every non-folder file, recursing
 * into subfolders. Bounded breadth-first traversal (caps folders visited and files collected) to stay
 * cheap on large drives. Best-effort: returns what it could gather.
 */
export function listDriveFilesDeep(opts: { profile?: string; rootFolderToken?: string } = {}): DriveFile[] {
  const files: DriveFile[] = [];
  const seen = new Set<string>();
  const queue: string[] = [opts.rootFolderToken ?? ''];
  let visited = 0;
  while (queue.length > 0 && visited < 200 && files.length < 2000) {
    const folder = queue.shift() as string;
    if (seen.has(folder)) continue;
    seen.add(folder);
    visited += 1;
    for (const entry of listDriveFolder(folder, opts)) {
      if (entry.type === 'folder') queue.push(entry.token);
      else files.push(entry);
    }
  }
  return files;
}

/**
 * List the access records of a single Drive/wiki document, paging until exhausted. Native command —
 * success is code===0. Any failure is thrown as a LarkApiError so the caller can distinguish a
 * permission gap (caller does not own/administer the file) via {@link isViewRecordForbiddenError} from
 * a transient blip. Each record carries the viewer's open_id, display name, and most-recent view time
 * (unix seconds). file_type must be one of doc/docx/sheet/bitable/mindnote/wiki/file.
 */
export function listFileViewRecords(
  fileToken: string,
  fileType: string,
  opts: { profile?: string } = {}
): FileViewRecord[] {
  const out: FileViewRecord[] = [];
  let pageToken = '';
  for (let page = 0; page < 40; page++) {
    // Safety cap: 40 pages * 50 = 2000 viewers.
    const params: Record<string, unknown> = {
      file_token: fileToken,
      file_type: fileType,
      viewer_id_type: 'open_id',
      page_size: 50,
    };
    if (pageToken) params.page_token = pageToken;
    const res = larkExec(
      ['drive', 'file.view_records', 'list', '--params', JSON.stringify(params), '--as', 'user', '--format', 'json'],
      { profile: opts.profile }
    );
    if (res?.code !== 0) throw new LarkApiError('读取文档访问记录失败', res);
    const items: any[] = res.data?.items ?? [];
    for (const it of items) {
      const viewerId = typeof it?.viewer_id === 'string' ? it.viewer_id : '';
      if (!viewerId) continue;
      const t = Number(it?.last_view_time);
      out.push({
        viewerId,
        name: typeof it?.name === 'string' ? it.name : '',
        lastViewTimeSec: Number.isFinite(t) ? t : 0,
      });
    }
    const next = res.data?.page_token ?? '';
    if (res.data?.has_more === true && next) pageToken = next;
    else break;
  }
  return out;
}

/** Whether an error is the Feishu "no permission to read this file's access records" rejection. */
export function isViewRecordForbiddenError(e: unknown): boolean {
  return e instanceof LarkApiError && e.code === 1069603;
}

/** Extract the open_id list of @-mentioned targets from a raw message object. */
function extractMentions(m: any): string[] {
  const raw: any[] = Array.isArray(m?.mentions) ? m.mentions : [];
  const ids: string[] = [];
  for (const mention of raw) {
    const id = mention?.id?.open_id ?? mention?.open_id ?? mention?.id;
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

/** Extract the display name from a sender object (for collection; try to obtain a readable name). */
function extractSenderName(sender: any): string {
  if (!sender || typeof sender !== 'object') return '';
  return (
    sender.sender_name ??
    sender.name ??
    sender.user_name ??
    sender.sender_id?.name ??
    ''
  );
}

/**
 * Extract sender identity fields from a raw sender object.
 * The list API returns { id, id_type, sender_type, tenant_key }; the open_id is in
 * sender.id only when id_type === 'open_id'.
 */
function extractSenderFields(sender: any): {
  senderOpenId: string;
  senderIdType?: string;
  senderType?: string;
  senderTenantKey?: string;
} {
  if (!sender || typeof sender !== 'object') {
    return { senderOpenId: '' };
  }
  const idType: string | undefined = sender.id_type;
  const openId = idType === 'open_id' && typeof sender.id === 'string' ? sender.id : '';
  return {
    senderOpenId: openId,
    senderIdType: idType,
    senderType: typeof sender.sender_type === 'string' ? sender.sender_type : undefined,
    senderTenantKey: typeof sender.tenant_key === 'string' ? sender.tenant_key : undefined,
  };
}

/** Normalize a positive epoch to milliseconds (values that look like seconds are scaled up). */
function normalizeEpochMs(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n < 1e12 ? n * 1000 : n);
}

/**
 * Convert a message timestamp to epoch milliseconds. Accepts a numeric epoch (seconds or
 * milliseconds) or a formatted "YYYY-MM-DD HH:MM" string; returns 0 when unparseable.
 */
export function larkTimeToMs(raw: unknown): number {
  if (raw == null) return 0;
  if (typeof raw === 'number') return normalizeEpochMs(raw);
  const s = String(raw).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return normalizeEpochMs(Number(s));
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Decide whether a failed lark read response is a *transient* server-side blip (self-heals on the
 * next poll) rather than a stable condition. Feishu code 2200 is the generic "Internal Error"
 * (a 5xx-equivalent that comes and goes); a non-JSON `raw` body means the CLI itself crashed or
 * timed out before producing a result. Stable failures — dissolved chat, removed from chat, missing
 * permission, bad chat_id — are NOT transient and must surface and back off instead of being retried
 * blindly. Renames are never an error here: chat_id is immutable, so reads keep working across them.
 */
export function isTransientLarkError(res: any): boolean {
  if (!res || res.ok !== false) return false;
  if (typeof res.raw === 'string') return true; // CLI crash / non-JSON output → transport blip
  if (res.error?.code === 2200) return true; // Feishu generic server-side Internal Error
  const msg = String(res.error?.message ?? '').toLowerCase();
  return /internal error|timeout|timed out|temporar|try again|rate limit|too many request/.test(msg);
}

/**
 * Error raised by lark read calls, carrying the structured fields a caller needs to react: the
 * Feishu error code / subtype / log_id (for cross-referencing in the open platform) and a
 * `retryable` flag derived from {@link isTransientLarkError}. The message stays human-readable
 * ("读取消息失败：Internal Error") so existing `(e as Error).message` logging is unchanged.
 */
export class LarkApiError extends Error {
  readonly code?: number;
  readonly subtype?: string;
  readonly logId?: string;
  readonly retryable: boolean;
  constructor(action: string, res: any) {
    const detail =
      res?.error?.message ?? (typeof res?.raw === 'string' ? '响应解析失败' : JSON.stringify(res));
    super(`${action}：${detail}`);
    this.name = 'LarkApiError';
    this.code = typeof res?.error?.code === 'number' ? res.error.code : undefined;
    this.subtype = typeof res?.error?.subtype === 'string' ? res.error.subtype : undefined;
    this.logId = typeof res?.error?.log_id === 'string' ? res.error.log_id : undefined;
    this.retryable = isTransientLarkError(res);
  }
}

/**
 * Feishu error codes that mean a chat is permanently GONE for us — retrying will never succeed, so the
 * caller should stop polling/syncing it rather than back off and keep trying forever:
 *   232009 — the chat has already been dissolved (群已解散).
 * Add sibling "no longer a member / chat not found" codes here as they're confirmed in the wild.
 */
const CHAT_GONE_CODES = new Set<number>([232009]);

/**
 * Whether an error means the target chat is permanently gone (dissolved / disbanded), as opposed to a
 * transient blip ({@link isTransientLarkError}) or a normal stable error. Code-based first (robust),
 * with a tight message fallback for envelopes that omit the numeric code.
 */
export function isChatGoneError(e: unknown): boolean {
  if (!(e instanceof LarkApiError)) return false;
  if (e.code != null && CHAT_GONE_CODES.has(e.code)) return true;
  return /dissolved|disbanded/i.test(e.message);
}

/**
 * Whether an error means we currently can't access the chat — typically because the bot/user was
 * removed from it or lost permission (e.g. Feishu "Bot/User can NOT be out of the chat."). UNLIKE a
 * dissolved chat this is POSSIBLY recoverable (we may be re-added), so callers should stand down only
 * after it persists (several consecutive occurrences), not on the first hit. Message-pattern based,
 * since the numeric codes vary across the read/member/send APIs; the conservative gate guards against
 * the occasional odd-worded transient. A dissolved chat ({@link isChatGoneError}) is NOT counted here.
 */
export function isChatInaccessibleError(e: unknown): boolean {
  if (!(e instanceof LarkApiError)) return false;
  if (isChatGoneError(e)) return false; // dissolved is its own (permanent) category
  return /not in (the )?(chat|group)|out of the chat|bot.*not in|no permission|permission denied|forbidden|not authoriz|no access|invalid.*receive_id/i.test(
    e.message
  );
}

export function listMessages(
  chatId: string,
  opts: { pageSize?: number; sort?: 'asc' | 'desc'; profile?: string; includeReactions?: boolean } = {}
): LarkMessage[] {
  // The message-list API returns each message's emoji reactions inline (reactions.details[]); the poll
  // loop suppresses them with --no-reactions since it doesn't need them. Pass includeReactions to keep
  // them (used by the reaction-harvest sync for the like-maniac milestone).
  const res = larkExec(
    [
      'im',
      '+chat-messages-list',
      '--chat-id',
      chatId,
      '--page-size',
      String(opts.pageSize ?? 20),
      '--sort',
      opts.sort ?? 'desc',
      ...(opts.includeReactions ? [] : ['--no-reactions']),
      '--format',
      'json',
    ],
    { profile: opts.profile }
  );
  if (!res.ok) {
    throw new LarkApiError('读取消息失败', res);
  }
  const items: any[] = res.data?.messages ?? [];
  return items.map((m) => {
    const senderFields = extractSenderFields(m.sender);
    return {
      messageId: m.message_id,
      position: Number.parseInt(m.message_position, 10),
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      msgType: m.msg_type,
      createTime: m.create_time,
      sender: m.sender ?? {},
      mentions: extractMentions(m),
      senderName: extractSenderName(m.sender),
      senderOpenId: senderFields.senderOpenId,
      senderIdType: senderFields.senderIdType,
      senderType: senderFields.senderType,
      senderTenantKey: senderFields.senderTenantKey,
      threadId: typeof m.thread_id === 'string' ? m.thread_id : undefined,
      threadMessagePosition: m.thread_message_position != null
        ? Number(m.thread_message_position)
        : undefined,
      ...(opts.includeReactions ? { reactions: extractReactions(m) } : {}),
    };
  });
}

/**
 * Extract the flat list of emoji reactions from a message's reactions.details[]. Each detail is one
 * reactor + one emoji; the operator carries the reactor's open_id and type ('user' vs 'app'). Returns
 * an empty array when the message has no reactions.
 */
function extractReactions(m: any): MessageReaction[] {
  const details: any[] = m?.reactions?.details ?? [];
  const out: MessageReaction[] = [];
  for (const d of details) {
    const openId = d?.operator?.operator_id;
    if (typeof openId !== 'string' || !openId) continue;
    out.push({
      reactorOpenId: openId,
      emojiType: typeof d?.emoji_type === 'string' ? d.emoji_type : '',
      operatorType: typeof d?.operator?.operator_type === 'string' ? d.operator.operator_type : '',
      actionTime: Number.parseInt(d?.action_time, 10) || 0,
    });
  }
  return out;
}

/**
 * Discover "all groups" visible to the current account (as the user identity), automatically paging until
 * has_more=false, returning each group's chatId / name / external flag. The caller can filter as needed
 * (e.g. keep only internal groups where external===false).
 * +chat-list caps at 100 per page, so it exhausts pages one by one via page_token.
 */
export function listChats(profile?: string): LarkChat[] {
  const out: LarkChat[] = [];
  let pageToken = '';
  for (let page = 0; page < 100; page++) {
    // Safety cap: at most 100 pages (10,000 groups in theory), to avoid infinite paging on anomalies
    const args = ['im', '+chat-list', '--as', 'user', '--page-size', '100', '--format', 'json'];
    if (pageToken) args.push('--page-token', pageToken);
    const res = larkExec(args, { profile });
    if (!res.ok) {
      throw new LarkApiError('读取群清单失败', res);
    }
    const items: any[] = res.data?.chats ?? res.data?.items ?? res.data?.list ?? [];
    for (const c of items) {
      out.push({
        chatId: c.chat_id ?? c.chatId ?? '',
        name: c.name ?? c.chat_name ?? '',
        external: parseExternal(c),
      });
    }
    const next = res.data?.page_token ?? res.data?.pageToken ?? '';
    if (res.data?.has_more === true && next) {
      pageToken = next;
    } else {
      break;
    }
  }
  return out;
}

/** Decide internal vs. external from a group object: the external flag takes priority, otherwise infer from the tenant tag. */
function parseExternal(c: any): boolean {
  if (typeof c?.external === 'boolean') return c.external;
  if (typeof c?.is_external === 'boolean') return c.is_external;
  // Some responses mark it as a string INT / EXT or chat_mode; when undeterminable, conservatively treat as internal (external=false).
  const tag = (c?.tenant_tag ?? c?.scope ?? '').toString().toUpperCase();
  if (tag === 'EXT' || tag === 'EXTERNAL') return true;
  return false;
}

export function sendText(
  target: { chatId?: string; userId?: string },
  text: string,
  opts: { as?: 'user' | 'bot'; profile?: string } = {}
): { ok: boolean; messageId?: string } {
  const idArgs = target.chatId
    ? ['--chat-id', target.chatId]
    : ['--user-id', target.userId as string];
  const asArgs = opts.as ? ['--as', opts.as] : [];
  const res = larkExec(
    [
      'im',
      '+messages-send',
      ...idArgs,
      ...asArgs,
      '--text',
      text,
      '--format',
      'json',
    ],
    { profile: opts.profile }
  );
  if (!res.ok) {
    throw new Error(`发送消息失败：${res.error?.message ?? JSON.stringify(res)}`);
  }
  return { ok: true, messageId: res.data?.message_id };
}

/**
 * Upload a local image file to Feishu (bot identity only) and return its image_key (img_xxx),
 * or null on failure. Used by the event system to send rendered images.
 * Invocation: `im images create --data '{"image_type":"message"}' --file image=<path> --as bot`.
 */
export function uploadImage(filePath: string, opts: { profile?: string } = {}): string | null {
  // lark-cli sandboxes --file to a cwd-relative path (absolute paths are rejected with
  // "cannot open file"). Convert to a path relative to the process cwd before passing.
  const rel = path.isAbsolute(filePath) ? path.relative(process.cwd(), filePath) : filePath;
  const res = larkExec(
    [
      'im',
      'images',
      'create',
      '--data',
      JSON.stringify({ image_type: 'message' }),
      '--file',
      `image=${rel}`,
      '--as',
      'bot',
      '--format',
      'json',
    ],
    { profile: opts.profile }
  );
  if (res?.code === 0 && res.data?.image_key) return res.data.image_key as string;
  return null;
}

/**
 * Download a file/image resource attached to a message and return the absolute local path (or null on
 * failure). Cached under the repo-local `.agent/attachments/` runtime dir, keyed by file_key, so each
 * resource is fetched at most once. Uses the user identity (the poller reads as the user). lark-cli's
 * `--output` must be a cwd-relative path with no `..` traversal, so the cache dir lives under the repo
 * root (the process cwd for the running agent); if a safe relative path cannot be expressed, returns null.
 */
export function downloadMessageResource(
  messageId: string,
  fileKey: string,
  opts: { type?: 'file' | 'image'; profile?: string; fileName?: string; as?: 'user' | 'bot' } = {}
): string | null {
  if (!messageId || !fileKey) return null;
  const type = opts.type ?? 'file';
  const as = opts.as ?? 'user';
  const ext = opts.fileName ? path.extname(opts.fileName) : '';
  const cacheDir = path.join(RUNTIME_DIR, 'attachments');
  const abs = path.join(cacheDir, `${fileKey}${ext}`);
  try {
    // Cache hit: a non-empty file already downloaded.
    if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return abs;
    fs.mkdirSync(cacheDir, { recursive: true });
    const rel = path.relative(process.cwd(), abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // outside cwd → can't pass a safe relative --output
    const res = larkExec(
      [
        'im',
        '+messages-resources-download',
        '--message-id', messageId,
        '--file-key', fileKey,
        '--type', type,
        '--output', rel,
        '--as', as,
        '--format', 'json',
      ],
      { profile: opts.profile }
    );
    // Accept when the CLI reports success OR the file simply materialized (older CLI envelopes vary).
    if ((res?.code === 0 || res == null) && fs.existsSync(abs) && fs.statSync(abs).size > 0) return abs;
    if (fs.existsSync(abs) && fs.statSync(abs).size > 0) return abs;
    return null;
  } catch {
    return null;
  }
}

/** A single element inside a Feishu "post" (rich-text) paragraph. */
export type PostElement =
  | { tag: 'text'; text: string }
  | { tag: 'md'; text: string }
  | { tag: 'at'; user_id: string; user_name?: string }
  | { tag: 'img'; image_key: string };

/**
 * Send a Feishu "post" (rich-text) message — one cohesive message (one message_id, so reactions can
 * later be tallied on it). `content` is an array of paragraphs; each paragraph an array of elements
 * (text / markdown / @-mention / image), letting an event mix an image, blank lines and an @-mention
 * in a single message. Send to a group (target.chatId) or P2P (target.userId = open_id).
 */
export function sendPost(
  target: { chatId?: string; userId?: string },
  post: { title?: string; content: PostElement[][] },
  opts: { as?: 'user' | 'bot'; profile?: string } = {}
): { ok: boolean; messageId?: string } {
  const idArgs = target.chatId
    ? ['--chat-id', target.chatId]
    : ['--user-id', target.userId as string];
  const asArgs = opts.as ? ['--as', opts.as] : ['--as', 'bot'];
  const body = { zh_cn: { title: post.title ?? '', content: post.content } };
  const res = larkExec(
    [
      'im',
      '+messages-send',
      ...idArgs,
      '--msg-type',
      'post',
      '--content',
      JSON.stringify(body),
      ...asArgs,
      '--format',
      'json',
    ],
    { profile: opts.profile }
  );
  if (!res?.ok) {
    throw new Error(`发送 post 消息失败：${res?.error?.message ?? JSON.stringify(res)}`);
  }
  return { ok: true, messageId: res.data?.message_id };
}

/**
 * Reply to an existing message (via +messages-reply, requires an om_ message ID).
 * When inThread=true, the reply goes into the thread stream the original message belongs to: in a topic group
 * (topic mode) this avoids being treated as a new topic and the reply appears in the original thread; in a
 * regular group it becomes an in-thread reply to that message.
 */
export function replyText(
  messageId: string,
  text: string,
  opts: { as?: 'user' | 'bot'; profile?: string; inThread?: boolean } = {}
): { ok: boolean; messageId?: string } {
  const asArgs = opts.as ? ['--as', opts.as] : [];
  const threadArgs = opts.inThread ? ['--reply-in-thread'] : [];
  const res = larkExec(
    [
      'im',
      '+messages-reply',
      '--message-id',
      messageId,
      ...threadArgs,
      ...asArgs,
      '--text',
      text,
      '--format',
      'json',
    ],
    { profile: opts.profile }
  );
  if (!res.ok) {
    throw new Error(`回复消息失败：${res.error?.message ?? JSON.stringify(res)}`);
  }
  return { ok: true, messageId: res.data?.message_id };
}

/**
 * Recall (撤回) a previously sent message by its message_id. Native command (success = code===0). A
 * message can only be recalled by its sender, so use the identity that sent it (events are bot-sent,
 * so `as` defaults to 'bot'). Returns { ok, error } rather than throwing, so callers can report.
 */
export function recallMessage(
  messageId: string,
  opts: { as?: 'user' | 'bot'; profile?: string } = {}
): { ok: boolean; error?: string } {
  const asArgs = ['--as', opts.as ?? 'bot'];
  const res = larkExec(
    ['im', 'messages', 'delete', '--message-id', messageId, ...asArgs, '--yes', '--format', 'json'],
    { profile: opts.profile }
  );
  if (res?.code === 0) return { ok: true };
  return { ok: false, error: res?.error?.message ?? res?.msg ?? JSON.stringify(res) };
}

// reactions is a native OpenAPI command whose response envelope is { code: 0, data: {...} } (different from
// the { ok: true } of +messages-*), so success is determined by code===0.

/**
 * Add an emoji reaction to a message as a visual "processing / thinking" indicator, returning the reaction_id
 * for later removal. This is best-effort: when the permission is not enabled or emoji_type is invalid it returns
 * null instead of throwing, so the reply flow is unaffected.
 */
export function addReaction(
  messageId: string,
  emojiType: string,
  opts: { as?: 'user' | 'bot'; profile?: string } = {}
): string | null {
  const asArgs = opts.as ? ['--as', opts.as] : [];
  const res = larkExec(
    [
      'im',
      'reactions',
      'create',
      '--params',
      JSON.stringify({ message_id: messageId }),
      '--data',
      JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      ...asArgs,
      '--format',
      'json',
    ],
    { profile: opts.profile }
  );
  if (res?.code === 0 && res.data?.reaction_id) return res.data.reaction_id;
  return null;
}

/** Remove a previously added emoji reaction (by reaction_id); can only remove ones you added. Returns false on failure, does not throw. */
export function removeReaction(
  messageId: string,
  reactionId: string,
  opts: { as?: 'user' | 'bot'; profile?: string } = {}
): boolean {
  const asArgs = opts.as ? ['--as', opts.as] : [];
  const res = larkExec(
    [
      'im',
      'reactions',
      'delete',
      '--params',
      JSON.stringify({ message_id: messageId, reaction_id: reactionId }),
      ...asArgs,
      '--format',
      'json',
    ],
    { profile: opts.profile }
  );
  return res?.code === 0;
}

/**
 * Pin a message to the top of its chat (Feishu "Pin 消息", native `im pins create`). Best-effort:
 * returns true on success (envelope code 0), false on any failure (bot not in the chat, missing scope,
 * message deleted, …) and never throws — safe to call from a poll loop. Needs the bot to be in the chat.
 */
export function pinMessage(messageId: string, opts: { as?: 'user' | 'bot'; profile?: string } = {}): boolean {
  const asArgs = opts.as ? ['--as', opts.as] : [];
  const res = larkExec(
    ['im', 'pins', 'create', '--data', JSON.stringify({ message_id: messageId }), ...asArgs, '--format', 'json'],
    { profile: opts.profile }
  );
  return res?.code === 0;
}

/**
 * Remove a message's pin (Feishu "移除 Pin 消息", native `im pins delete`). The CLI requires the --yes
 * confirmation flag (a client-side gate, not sent to the backend). Best-effort boolean, never throws.
 */
export function unpinMessage(messageId: string, opts: { as?: 'user' | 'bot'; profile?: string } = {}): boolean {
  const asArgs = opts.as ? ['--as', opts.as] : [];
  const res = larkExec(
    ['im', 'pins', 'delete', '--params', JSON.stringify({ message_id: messageId }), '--yes', ...asArgs, '--format', 'json'],
    { profile: opts.profile }
  );
  return res?.code === 0;
}

// ── calendar event write operations ──────────────────────────
// Create / update / delete Feishu calendar events as the user identity (Ricky).
// All three operations require --as user (bot tokens cannot manage calendar events).
// Success is determined by code===0 in the native API response envelope.

/** Result returned by a successful createCalendarEvent call. */
export interface CreatedCalendarEvent {
  /** Recurring-series UUID (bare, without the _0 or _<ts> suffix). */
  eventId: string;
  /** Feishu VC join URL; empty string when vc_type was not 'vc'. */
  meetupUrl: string;
  /** Feishu calendar deep-link (app_link). */
  appLink: string;
  /** Public calendar share link (feishu.cn/calendar/share?token=...); empty string if unavailable. */
  shareLink: string;
}

/**
 * Create a Feishu calendar event via the native events.create API, optionally including a VC
 * room (vc_type:"vc"). Uses --as user so the event is owned by the configured user identity.
 * Returns the bare series UUID, VC URL, and app deep-link on success; returns null on any failure.
 *
 * The native API is used instead of the +create shortcut because only native supports vc_type.
 * recurrence must be an RFC 5545 RRULE string (e.g. "FREQ=WEEKLY;BYDAY=TH;COUNT=10"); omit
 * or leave empty for a one-off event. Timestamps are Unix seconds (integer strings to the API).
 */
export function createCalendarEvent(opts: {
  calendarId: string;
  title: string;
  startTimeSec: number;
  endTimeSec: number;
  description?: string;
  recurrence?: string;
  withVc?: boolean;
  profile?: string;
  /** open_id of the organizer to add as an accepted attendee (so they don't show as "not attending"). */
  organizerOpenId?: string;
}): CreatedCalendarEvent | null {
  const data: Record<string, unknown> = {
    summary: opts.title,
    start_time: { timestamp: String(opts.startTimeSec) },
    end_time: { timestamp: String(opts.endTimeSec) },
    attendee_ability: 'can_see_others',
  };
  if (opts.description) data['description'] = opts.description;
  if (opts.recurrence) data['recurrence'] = opts.recurrence;
  if (opts.withVc !== false) data['vchat'] = { vc_type: 'vc' };

  let res: any;
  try {
    res = larkExec(
      ['calendar', 'events', 'create',
        '--calendar-id', opts.calendarId,
        '--data', JSON.stringify(data),
        '--as', 'user',
        '--format', 'json'],
      { profile: opts.profile }
    );
  } catch {
    return null;
  }
  if (res?.code !== 0) return null;

  const ev = res.data?.event;
  const rawEventId = typeof ev?.event_id === 'string' ? ev.event_id : '';
  if (!rawEventId) return null;

  // Add the organizer as an accepted attendee. Attendees can't be set in the create body, and an
  // event with an empty attendee list shows the organizer as "not attending" in the Feishu UI.
  if (opts.organizerOpenId) {
    addEventAttendees(opts.calendarId, rawEventId, [opts.organizerOpenId], { profile: opts.profile });
  }

  const eventId = recurringSeriesKey(rawEventId);
  const meetupUrl = typeof ev?.vchat?.meeting_url === 'string' ? ev.vchat.meeting_url : '';
  const appLink = typeof ev?.app_link === 'string' ? ev.app_link : '';
  // Fetch the public calendar share link for the created series (uses the raw _0 occurrence id).
  const shareLink = getEventShareLink(opts.calendarId, rawEventId, { profile: opts.profile });
  return { eventId, meetupUrl, appLink, shareLink };
}

/**
 * Add user attendees (open_id) to a calendar event. Attendees cannot be set in the events.create
 * body, so this is a separate call. Adding the organizer makes them appear as an accepted participant
 * (an empty attendee list makes the Feishu UI show the organizer as "not attending"). Best-effort:
 * returns true on code===0, false otherwise; never throws.
 */
export function addEventAttendees(calendarId: string, eventId: string, openIds: string[], opts: { profile?: string } = {}): boolean {
  if (openIds.length === 0) return false;
  const data = { attendees: openIds.map((id) => ({ type: 'user', user_id: id })), need_notification: false };
  try {
    const res = larkExec(
      ['calendar', 'event.attendees', 'create',
        '--calendar-id', calendarId, '--event-id', eventId,
        '--user-id-type', 'open_id', '--data', JSON.stringify(data),
        '--as', 'user', '--format', 'json'],
      { profile: opts.profile }
    );
    return res?.code === 0;
  } catch {
    return false;
  }
}

/**
 * Update an existing Feishu calendar event via the +update convenience command.
 * Only the provided fields are changed; absent fields leave the event unchanged.
 * Uses --as user. Returns true on success (code===0 or ok===true), false on failure.
 */
/**
 * Feishu calendar delete/update require an occurrence-suffixed event_id (e.g. <UUID>_0); the bare
 * series UUID is rejected. Stored meetups keep the bare UUID (recurringSeriesKey), so append _0 when
 * the id carries no occurrence suffix. For a recurring series, _0 targets the whole series.
 */
function occurrenceEventId(eventId: string): string {
  return eventId.includes('_') ? eventId : `${eventId}_0`;
}

export function updateCalendarEvent(opts: {
  eventId: string;
  summary?: string;
  startIso?: string;
  endIso?: string;
  rrule?: string;
  profile?: string;
}): boolean {
  const args = ['calendar', '+update', '--event-id', occurrenceEventId(opts.eventId), '--as', 'user', '--format', 'json'];
  if (opts.summary) { args.push('--summary', opts.summary); }
  if (opts.startIso) { args.push('--start', opts.startIso); }
  if (opts.endIso) { args.push('--end', opts.endIso); }
  if (opts.rrule) { args.push('--rrule', opts.rrule); }
  try {
    const res = larkExec(args, { profile: opts.profile });
    return res?.code === 0 || res?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Delete (cancel) a Feishu calendar event. The delete API needs an occurrence-suffixed event_id, so a
 * bare stored series UUID is normalized to <UUID>_0, which removes the entire recurring series (a full
 * occurrence id deletes only that instance). Uses --as user. Returns true on success (code===0).
 */
export function cancelCalendarEvent(
  calendarId: string,
  eventId: string,
  opts: { profile?: string } = {}
): boolean {
  try {
    const res = larkExec(
      ['calendar', 'events', 'delete',
        '--calendar-id', calendarId,
        '--event-id', occurrenceEventId(eventId),
        '--as', 'user',
        '--format', 'json'],
      { profile: opts.profile }
    );
    return res?.code === 0;
  } catch {
    return false;
  }
}

/** Control handle for consumeEvents: can shut down the long-lived connection subprocess. */
export interface EventConsumer {
  /** End the long-lived connection */
  stop(): void;
  /** Get the current subprocess (for the caller to monitor) */
  child(): ChildProcess | undefined;
}

// Long-connection reconnect backoff: base interval, upper limit, and the minimum lifetime to be "considered a stable connection".
const BASE_BACKOFF_MS = 3000;
const MAX_BACKOFF_MS = 60000;
const STABLE_MS = 5000;

/** Interpret lark-cli error reports (ok:false objects) from the event subprocess stderr, extracting a readable message and fix hint. */
function parseConsumeError(stderr: string): { message: string; hint?: string } | null {
  const trimmed = stderr.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && obj.ok === false && obj.error) {
      return { message: obj.error.message ?? '未知错误', hint: obj.error.hint };
    }
  } catch {
    /* Not a single JSON object; fall back to string matching */
  }
  const m = trimmed.match(/"message"\s*:\s*"([^"]+)"/);
  if (m) {
    const h = trimmed.match(/"hint"\s*:\s*"([^"]+)"/);
    return { message: m[1], hint: h ? h[1] : undefined };
  }
  return null;
}

/**
 * Wrap the bot long-lived connection: spawn `event consume <key> --as bot` (with profile),
 * keeping stdin as a pipe (event consume treats closing stdin as a stop signal),
 * parse JSON line by line and pass it to onEvent. On connection failure, print the specific error and reconnect
 * with exponential backoff. Returns a stoppable handle.
 */
export function consumeEvents(
  profile: string | undefined,
  onEvent: (ev: Record<string, any>) => void,
  opts: { eventKey?: string } = {}
): EventConsumer {
  const run = resolveLarkRun();
  if (!run) {
    throw new Error('找不到 lark-cli run.js（npm i -g @larksuite/cli 或设 LARK_RUN）');
  }
  const eventKey = opts.eventKey ?? 'im.message.receive_v1';
  let running = true;
  let child: ChildProcess | undefined;
  let backoffMs = BASE_BACKOFF_MS;

  const start = (): void => {
    const profileArgs = profile ? ['--profile', profile] : [];
    const startedAt = Date.now();
    let stderrBuf = '';
    child = spawn(
      process.execPath,
      [run, ...profileArgs, 'event', 'consume', eventKey, '--as', 'bot'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const s = line.trim();
        if (!s.startsWith('{')) return; // Skip non-JSON info lines
        let ev: Record<string, any>;
        try {
          ev = JSON.parse(s);
        } catch {
          return;
        }
        backoffMs = BASE_BACKOFF_MS; // Reset backoff once an event is successfully received
        onEvent(ev);
      });
    }
    // Both info and errors from the event subprocess go through stderr (including ok:false subscription/permission validation errors);
    // accumulate first, then interpret it as a whole when the subprocess exits, printing the real error message and fix hint.
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString();
    });
    child.on('exit', (code) => {
      if (!running) return;
      const errInfo = parseConsumeError(stderrBuf);
      if (errInfo) {
        process.stderr.write(`事件连接失败（${eventKey}）：${errInfo.message}\n`);
        if (errInfo.hint) process.stderr.write(`  提示：${errInfo.hint}\n`);
      } else if (code) {
        process.stderr.write(`事件连接结束（code=${code}）\n`);
      }
      // Fast failures (usually subscription/permission issues that reconnecting won't fix) use exponential backoff to avoid flooding every 3 seconds;
      // if a connection that was stable for a while then drops, reconnect quickly using the base interval.
      if (Date.now() - startedAt < STABLE_MS) {
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      } else {
        backoffMs = BASE_BACKOFF_MS;
      }
      process.stderr.write(`  ${Math.round(backoffMs / 1000)} 秒后重连…\n`);
      setTimeout(start, backoffMs);
    });
  };

  start();

  return {
    stop(): void {
      running = false;
      child?.kill();
    },
    child(): ChildProcess | undefined {
      return child;
    },
  };
}
