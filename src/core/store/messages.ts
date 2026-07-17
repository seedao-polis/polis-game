import { getDb } from '../db.js';

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

export function upsertChat(c: {
  chatId: string;
  name?: string;
  chatType?: string;
  chatMode?: string;
  external?: boolean;
  tenantKey?: string;
  larkProfile?: string;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO chats(chat_id, name, chat_type, chat_mode, external, tenant_key, lark_profile)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      name         = CASE WHEN excluded.name <> '' THEN excluded.name ELSE chats.name END,
      external     = excluded.external,
      tenant_key   = CASE WHEN excluded.tenant_key IS NOT NULL THEN excluded.tenant_key ELSE chats.tenant_key END,
      lark_profile = CASE WHEN excluded.lark_profile IS NOT NULL THEN excluded.lark_profile ELSE chats.lark_profile END,
      updated_at   = unixepoch()
  `).run(
    c.chatId,
    c.name ?? '',
    c.chatType ?? null,
    c.chatMode ?? null,
    c.external ? 1 : 0,
    c.tenantKey ?? null,
    c.larkProfile ?? null,
  );
}

/**
 * Insert a message row, ensuring the parent chat exists first.
 * Returns true when the row was newly inserted (false when already present).
 */
export function insertMessage(m: MessageRow): boolean {
  const db = getDb();
  // Satisfy the foreign key: create a placeholder chat row if it does not exist yet.
  db.prepare('INSERT OR IGNORE INTO chats(chat_id) VALUES(?)').run(m.chatId);
  const result = db.prepare(`
    INSERT OR IGNORE INTO messages(
      message_id, chat_id, sender_open_id, sender_id_type, sender_type,
      sender_tenant_key, sender_name, msg_type, text, mentions,
      thread_id, reply_to_id, root_id, thread_message_position, message_position,
      create_time, updated, deleted, raw
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
  );
  return (result.changes as number) > 0;
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
 * Full-text search over persisted messages using the trigram FTS5 index.
 * When the query is empty, returns the most recent rows by create_time instead.
 */
export function searchMessages(query: string, limit = 20): MessageRow[] {
  const db = getDb();
  if (!query.trim()) {
    const rows = db.prepare(
      'SELECT * FROM messages ORDER BY create_time DESC LIMIT ?'
    ).all(limit) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  }
  // Wrap the query as a quoted FTS5 string literal so arbitrary user input (which may
  // contain MATCH operators or punctuation) is treated as a plain phrase, not query syntax.
  const phrase = `"${query.replace(/"/g, '""')}"`;
  const rows = db.prepare(`
    SELECT m.* FROM messages_fts f
    JOIN messages m ON m.rowid = f.rowid
    WHERE messages_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(phrase, limit) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

/** Look up one captured message by id. Returns null when it was never captured (or was deleted). */
export function getMessageRow(messageId: string): MessageRow | null {
  if (!messageId) return null;
  const row = getDb().prepare(
    'SELECT * FROM messages WHERE message_id = ? AND deleted = 0'
  ).get(messageId) as Record<string, unknown> | undefined;
  return row ? rowToMessage(row) : null;
}

/**
 * Return the messages of a single thread (topic), oldest→newest, for feeding the agent the
 * conversation backstory. The bot only receives @-mentioned events, but the user-poll path
 * captures the whole thread (including the original post that mentioned someone else), so this
 * query is what surfaces that missing context. An optional excludeMessageId drops the current
 * message (it is appended separately as "用户最新消息").
 */
export function getThreadContext(
  threadId: string,
  opts: { limit?: number; excludeMessageId?: string } = {}
): MessageRow[] {
  if (!threadId) return [];
  const limit = opts.limit ?? 15;
  const rows = getDb().prepare(
    `SELECT * FROM messages
       WHERE thread_id = ? AND deleted = 0 AND (? IS NULL OR message_id <> ?)
       ORDER BY create_time DESC LIMIT ?`
  ).all(threadId, opts.excludeMessageId ?? null, opts.excludeMessageId ?? null, limit) as Record<string, unknown>[];
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
export function getRecentChatMessages(
  chatId: string,
  opts: { limit?: number; excludeMessageId?: string; sinceMs?: number } = {}
): MessageRow[] {
  if (!chatId) return [];
  const limit = opts.limit ?? 8;
  const rows = getDb().prepare(
    `SELECT * FROM messages
       WHERE chat_id = ? AND deleted = 0 AND (? IS NULL OR message_id <> ?)
         AND (? IS NULL OR create_time >= ?)
       ORDER BY create_time DESC LIMIT ?`
  ).all(
    chatId,
    opts.excludeMessageId ?? null, opts.excludeMessageId ?? null,
    opts.sinceMs ?? null, opts.sinceMs ?? null,
    limit,
  ) as Record<string, unknown>[];
  return rows.map(rowToMessage).reverse(); // oldest→newest
}

/**
 * Return every non-deleted message whose create_time falls in the half-open window [fromSec, toSec),
 * oldest→newest. Powers the daily ops-report narrative: callers group by chat_id and classify each
 * chat's tier (getChatTier) to decide which content may be summarized.
 *
 * Args are Unix SECONDS (matching the other *Between queries), but messages.create_time is stored in
 * MILLISECONDS (Feishu's unit, via larkTimeToMs), so the window is converted to ms for the comparison.
 */
export function messagesBetween(fromSec: number, toSec: number): MessageRow[] {
  const fromMs = Math.trunc(fromSec) * 1000;
  const toMs = Math.trunc(toSec) * 1000;
  const rows = getDb().prepare(
    `SELECT * FROM messages
       WHERE create_time >= ? AND create_time < ? AND deleted = 0
       ORDER BY create_time ASC`
  ).all(fromMs, toMs) as Record<string, unknown>[];
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
export function getChatMeta(chatId: string): ChatMeta | null {
  const row = getDb()
    .prepare('SELECT chat_id, name, external, chat_mode FROM chats WHERE chat_id = ?')
    .get(chatId) as Record<string, unknown> | undefined;
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
export function getMessagesByUser(openId: string, limit = 50, sinceUnix?: number): MessageRow[] {
  const db = getDb();
  if (sinceUnix !== undefined) {
    const rows = db.prepare(
      'SELECT * FROM messages WHERE sender_open_id = ? AND create_time >= ? ORDER BY create_time DESC LIMIT ?'
    ).all(openId, sinceUnix, limit) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  }
  const rows = db.prepare(
    'SELECT * FROM messages WHERE sender_open_id = ? ORDER BY create_time DESC LIMIT ?'
  ).all(openId, limit) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}
