import { getDb, shouldDivertSoulWrites } from '../db.js';
import { enqueueOutboxWrite } from '../pg-outbox.js';

export interface MessageRow {
  messageId: string;
  chatId: string;
  senderOpenId: string;
  senderIdType?: string;
  senderType?: string;
  senderTenantKey?: string;
  senderName: string;
  msgType: string;
  text: string;
  mentions: string[];
  threadId?: string;
  /** Message this one replies to (Feishu `reply_to`). Empty on an original post. */
  replyToId?: string;
  /** First message of the reply chain (Feishu `root_id`). Equals replyToId when the parent is itself an original post. */
  rootId?: string;
  threadMessagePosition?: number;
  messagePosition?: number;
  createTime: number;
  updated?: boolean;
  deleted?: boolean;
  raw?: string;
}

/** Escape LIKE/ILIKE wildcard characters so user-supplied search text is matched literally. */
function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function upsertChat(c: {
  chatId: string;
  name?: string;
  chatType?: string;
  chatMode?: string;
  external?: boolean;
  tenantKey?: string;
  larkProfile?: string;
}): Promise<void> {
  const db = await getDb();
  await db.query(`
    INSERT INTO chats(chat_id, name, chat_type, chat_mode, external, tenant_key, lark_profile)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT(chat_id) DO UPDATE SET
      name         = CASE WHEN excluded.name <> '' THEN excluded.name ELSE chats.name END,
      external     = excluded.external,
      tenant_key   = CASE WHEN excluded.tenant_key IS NOT NULL THEN excluded.tenant_key ELSE chats.tenant_key END,
      lark_profile = CASE WHEN excluded.lark_profile IS NOT NULL THEN excluded.lark_profile ELSE chats.lark_profile END,
      updated_at   = unixepoch()
  `, [
    c.chatId,
    c.name ?? '',
    c.chatType ?? null,
    c.chatMode ?? null,
    c.external ? 1 : 0,
    c.tenantKey ?? null,
    c.larkProfile ?? null,
  ]);
}

/**
 * Insert a message row, ensuring the parent chat exists first.
 * Returns true when the row was newly inserted (false when already present).
 */
export async function insertMessage(m: MessageRow): Promise<boolean> {
  const cols = [
    'message_id', 'chat_id', 'sender_open_id', 'sender_id_type', 'sender_type',
    'sender_tenant_key', 'sender_name', 'msg_type', 'text', 'mentions',
    'thread_id', 'reply_to_id', 'root_id', 'thread_message_position', 'message_position',
    'create_time', 'updated', 'deleted', 'raw',
  ];
  const values = [
    m.messageId,
    m.chatId,
    m.senderOpenId,
    m.senderIdType ?? null,
    m.senderType ?? null,
    m.senderTenantKey ?? null,
    m.senderName,
    m.msgType,
    m.text,
    JSON.stringify(m.mentions),
    m.threadId ?? null,
    m.replyToId ?? null,
    m.rootId ?? null,
    m.threadMessagePosition ?? null,
    m.messagePosition ?? null,
    Number.isFinite(m.createTime) ? Math.trunc(m.createTime) : 0,
    m.updated ? 1 : 0,
    m.deleted ? 1 : 0,
    m.raw ?? null,
  ];
  // Append-only telemetry: while the soul PG pool's circuit breaker is open, divert straight to the
  // local outbox instead of attempting PostgreSQL — this also skips the FK-satisfying chats
  // placeholder insert below, which would otherwise itself attempt (and block on) a broken
  // connection on every single captured message; replayOutbox() re-derives that placeholder from the
  // queued row's chat_id at replay time (see pg-outbox.ts). Treated as newly-inserted for the caller:
  // real duplicate detection is deferred to replay's ON CONFLICT DO NOTHING.
  if (shouldDivertSoulWrites()) {
    await enqueueOutboxWrite('messages', cols, values);
    return true;
  }
  const db = await getDb();
  // Satisfy the foreign key: create a placeholder chat row if it does not exist yet.
  await db.query('INSERT INTO chats(chat_id) VALUES($1) ON CONFLICT DO NOTHING', [m.chatId]);
  const { rowCount } = await db.query(
    `INSERT INTO messages(${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`,
    values,
  );
  return rowCount > 0;
}

function rowToMessage(row: Record<string, unknown>): MessageRow {
  return {
    messageId: row['message_id'] as string,
    chatId: row['chat_id'] as string,
    senderOpenId: (row['sender_open_id'] as string) ?? '',
    senderIdType: (row['sender_id_type'] as string | null) ?? undefined,
    senderType: (row['sender_type'] as string | null) ?? undefined,
    senderTenantKey: (row['sender_tenant_key'] as string | null) ?? undefined,
    senderName: (row['sender_name'] as string) ?? '',
    msgType: (row['msg_type'] as string) ?? 'text',
    text: (row['text'] as string) ?? '',
    mentions: (() => {
      try { return JSON.parse((row['mentions'] as string) ?? '[]') as string[]; }
      catch { return []; }
    })(),
    threadId: (row['thread_id'] as string | null) ?? undefined,
    replyToId: (row['reply_to_id'] as string | null) ?? undefined,
    rootId: (row['root_id'] as string | null) ?? undefined,
    threadMessagePosition: (row['thread_message_position'] as number | null) ?? undefined,
    messagePosition: (row['message_position'] as number | null) ?? undefined,
    createTime: (row['create_time'] as number) ?? 0,
    updated: Boolean(row['updated']),
    deleted: Boolean(row['deleted']),
    raw: (row['raw'] as string | null) ?? undefined,
  };
}

/**
 * Substring search over persisted messages. When the query is empty, returns the most recent rows
 * by create_time instead. Case-insensitive (ILIKE): PostgreSQL's LIKE is case-sensitive, unlike
 * SQLite's ASCII-only case-insensitive default; user input is escaped so literal `%`/`_` in a search
 * phrase aren't treated as wildcards. A full-table ILIKE scan (no trigram/FTS index backing it) is an
 * accepted cost at this table's size — see the migration plan's FTS5→ILIKE downgrade rationale.
 */
export async function searchMessages(query: string, limit = 20): Promise<MessageRow[]> {
  const db = await getDb();
  if (!query.trim()) {
    const { rows } = await db.query<Record<string, unknown>>(
      'SELECT * FROM messages ORDER BY create_time DESC LIMIT $1', [limit],
    );
    return rows.map(rowToMessage);
  }
  const like = `%${escapeLikePattern(query.trim())}%`;
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM messages WHERE text ILIKE $1 ESCAPE '\\' ORDER BY create_time DESC LIMIT $2`,
    [like, limit],
  );
  return rows.map(rowToMessage);
}

/** Look up one captured message by id. Returns null when it was never captured (or was deleted). */
export async function getMessageRow(messageId: string): Promise<MessageRow | null> {
  if (!messageId) return null;
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT * FROM messages WHERE message_id = $1 AND deleted = 0', [messageId],
  );
  return rows[0] ? rowToMessage(rows[0]) : null;
}

/**
 * Return the messages of a single thread (topic), oldest→newest, for feeding the agent the
 * conversation backstory. The bot only receives @-mentioned events, but the user-poll path
 * captures the whole thread (including the original post that mentioned someone else), so this
 * query is what surfaces that missing context. An optional excludeMessageId drops the current
 * message (it is appended separately as "用户最新消息").
 */
export async function getThreadContext(
  threadId: string,
  opts: { limit?: number; excludeMessageId?: string } = {}
): Promise<MessageRow[]> {
  if (!threadId) return [];
  const limit = opts.limit ?? 15;
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    // $2 is reused (not cast): PostgreSQL resolves a placeholder's type left-to-right from the first
    // typed context it meets, so the typed `message_id <> $2` comparison must come BEFORE the untyped
    // `$2 IS NULL` check (the reverse order fails with "could not determine data type of parameter").
    // An explicit `::text` cast would sidestep that but is rejected by SQLite's fallback executor.
    `SELECT * FROM messages
       WHERE thread_id = $1 AND deleted = 0 AND (message_id <> $2 OR $2 IS NULL)
       ORDER BY create_time DESC LIMIT $3`,
    [threadId, opts.excludeMessageId ?? null, limit],
  );
  return rows.map(rowToMessage).reverse(); // oldest→newest
}

/**
 * Return the most recent messages of a chat, oldest→newest. Used as a fallback context window for
 * non-topic chats (which have no thread_id). An optional excludeMessageId drops the current message.
 *
 * sinceMs (absolute epoch ms) drops anything older. Without it "the last 8 rows" can reach back
 * arbitrarily far in a quiet chat — measured across live chats, 4 of 11 had their last 8 messages
 * spanning over 72 hours, one of them 17 days — and the caller then labels them to the model as
 * "最近的对话上下文". An absolute cutoff rather than a max-age keeps this a pure query: the caller
 * anchors it on the triggering message's own timestamp, so it never depends on wall-clock now.
 */
export async function getRecentChatMessages(
  chatId: string,
  opts: { limit?: number; excludeMessageId?: string; sinceMs?: number } = {}
): Promise<MessageRow[]> {
  if (!chatId) return [];
  const limit = opts.limit ?? 8;
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    // Each optional filter reuses one placeholder (not cast): PostgreSQL resolves a placeholder's type
    // left-to-right from the first typed context it meets, so each typed comparison must come BEFORE
    // its own untyped `IS NULL` check (the reverse order fails with "could not determine data type of
    // parameter"). An explicit `::text`/`::bigint` cast would sidestep that but is rejected by SQLite's
    // fallback executor.
    `SELECT * FROM messages
       WHERE chat_id = $1 AND deleted = 0 AND (message_id <> $2 OR $2 IS NULL)
         AND (create_time >= $3 OR $3 IS NULL)
       ORDER BY create_time DESC LIMIT $4`,
    [chatId, opts.excludeMessageId ?? null, opts.sinceMs ?? null, limit],
  );
  return rows.map(rowToMessage).reverse(); // oldest→newest
}

/**
 * When the handled_messages feature (SCHEMA_V39) was applied, in ms. The backfill must never process
 * messages older than this: before the feature existed nothing was marked handled, so every historical
 * @-mention would look unhandled and be re-answered on first startup. Anchoring the backfill floor here
 * makes the first post-deploy run a no-op on history and correct from then on. Falls back to now (fully
 * conservative) if the row is somehow absent.
 */
export async function backfillEpochMs(): Promise<number> {
  const db = await getDb();
  const { rows } = await db.query<{ applied_at?: number }>(
    'SELECT applied_at FROM schema_migrations WHERE version = 39',
  );
  const appliedAt = rows[0]?.applied_at;
  return appliedAt ? appliedAt * 1000 : Date.now();
}

/** True once the bot has acted on this inbound message (see handled_messages / SCHEMA_V39). */
export async function wasMessageHandled(messageId: string): Promise<boolean> {
  if (!messageId) return false;
  const db = await getDb();
  const { rows } = await db.query('SELECT 1 FROM handled_messages WHERE message_id = $1', [messageId]);
  return rows.length > 0;
}

/** Mark an inbound message as acted-on. Idempotent. */
export async function markMessageHandled(messageId: string): Promise<void> {
  if (!messageId) return;
  if (shouldDivertSoulWrites()) {
    await enqueueOutboxWrite('handled_messages', ['message_id'], [messageId]);
    return;
  }
  const db = await getDb();
  await db.query('INSERT INTO handled_messages(message_id) VALUES ($1) ON CONFLICT DO NOTHING', [messageId]);
}

/**
 * Top-level messages the poll path captured (raw IS NULL — never arrived as an event) that the bot
 * has NOT yet handled, since sinceMs. These are @-mentions the event stream missed while stalled: the
 * poll collector still recorded them, but only the event path replies, so they went unanswered. The
 * mention filter is left to the caller (mentions are parsed from the JSON column). Newest first, capped.
 */
export async function unhandledPolledMessagesSince(sinceMs: number, limit = 50): Promise<MessageRow[]> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT m.* FROM messages m
       WHERE m.create_time >= $1 AND m.deleted = 0
         AND (m.raw IS NULL OR m.raw = '')
         AND NOT EXISTS (SELECT 1 FROM handled_messages h WHERE h.message_id = m.message_id)
       ORDER BY m.create_time DESC LIMIT $2`,
    [Math.trunc(sinceMs), limit],
  );
  return rows.map(rowToMessage);
}

/**
 * Keys for re-scanning recently-engaged threads: the distinct thread_id AND root_id values seen in
 * messages since sinceMs. Both forms are accepted by listThreadMessages (it resolves an om_ root id to
 * its thread), and events populate these inconsistently — some thread replies carry root_id but no
 * thread_id — so unioning the two widens coverage. Newest-first, capped. A dormant thread whose ONLY
 * recent activity is an un-captured missed reply cannot appear here (nothing links it in the DB); that
 * residual gap is bounded by the event-stream recycle (see RECYCLE_MS), not recovered here.
 */
export async function recentThreadScanKeysSince(sinceMs: number, limit = 40): Promise<string[]> {
  const db = await getDb();
  const truncated = Math.trunc(sinceMs);
  const { rows } = await db.query<{ key: string }>(
    `SELECT key, MAX(t) AS mt FROM (
        SELECT thread_id AS key, create_time AS t FROM messages
          WHERE thread_id IS NOT NULL AND thread_id <> '' AND create_time >= $1 AND deleted = 0
        UNION ALL
        SELECT root_id AS key, create_time AS t FROM messages
          WHERE root_id IS NOT NULL AND root_id <> '' AND create_time >= $2 AND deleted = 0
     ) AS combined GROUP BY key ORDER BY mt DESC LIMIT $3`,
    [truncated, truncated, limit],
  );
  return rows.map((r) => r.key);
}

/**
 * Return every non-deleted message whose create_time falls in the half-open window [fromSec, toSec),
 * oldest→newest. Powers the daily ops-report narrative: callers group by chat_id and classify each
 * chat's tier (getChatTier) to decide which content may be summarized.
 *
 * Args are Unix SECONDS (matching the other *Between queries), but messages.create_time is stored in
 * MILLISECONDS (Feishu's unit, via larkTimeToMs), so the window is converted to ms for the comparison.
 */
export async function messagesBetween(fromSec: number, toSec: number): Promise<MessageRow[]> {
  const fromMs = Math.trunc(fromSec) * 1000;
  const toMs = Math.trunc(toSec) * 1000;
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM messages
       WHERE create_time >= $1 AND create_time < $2 AND deleted = 0
       ORDER BY create_time ASC`,
    [fromMs, toMs],
  );
  return rows.map(rowToMessage);
}

/** Lightweight chat metadata (display name + external flag) for labeling/grouping in reports. */
export interface ChatMeta {
  chatId: string;
  name: string;
  external: boolean;
  chatMode?: string;
}

/** Look up a chat's display name and external flag from the chats table; null when unknown. */
export async function getChatMeta(chatId: string): Promise<ChatMeta | null> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT chat_id, name, external, chat_mode FROM chats WHERE chat_id = $1', [chatId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    chatId: row['chat_id'] as string,
    name: (row['name'] as string) ?? '',
    external: Boolean(row['external']),
    chatMode: (row['chat_mode'] as string | null) ?? undefined,
  };
}

/**
 * Retrieve messages sent by a specific user, ordered by most recent first.
 * An optional sinceUnix timestamp (Unix seconds) filters to messages at or after that time.
 */
export async function getMessagesByUser(openId: string, limit = 50, sinceUnix?: number): Promise<MessageRow[]> {
  const db = await getDb();
  if (sinceUnix !== undefined) {
    const { rows } = await db.query<Record<string, unknown>>(
      'SELECT * FROM messages WHERE sender_open_id = $1 AND create_time >= $2 ORDER BY create_time DESC LIMIT $3',
      [openId, sinceUnix, limit],
    );
    return rows.map(rowToMessage);
  }
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT * FROM messages WHERE sender_open_id = $1 ORDER BY create_time DESC LIMIT $2',
    [openId, limit],
  );
  return rows.map(rowToMessage);
}
