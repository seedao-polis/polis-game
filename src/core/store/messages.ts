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
      thread_id, thread_message_position, message_position,
      create_time, updated, deleted, raw
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
 */
export function getRecentChatMessages(
  chatId: string,
  opts: { limit?: number; excludeMessageId?: string } = {}
): MessageRow[] {
  if (!chatId) return [];
  const limit = opts.limit ?? 8;
  const rows = getDb().prepare(
    `SELECT * FROM messages
       WHERE chat_id = ? AND deleted = 0 AND (? IS NULL OR message_id <> ?)
       ORDER BY create_time DESC LIMIT ?`
  ).all(chatId, opts.excludeMessageId ?? null, opts.excludeMessageId ?? null, limit) as Record<string, unknown>[];
  return rows.map(rowToMessage).reverse(); // oldest→newest
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
