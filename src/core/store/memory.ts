import { getDb, tx } from '../db.js';
import { filterByPolicy } from '../memory-policy.js';

// ── Long-term memory store ───────────────────────────────────────────────
// Provides typed read/write access to the memory_items table.
// Namespace format: 'global' | 'group:{chat_id}' | 'user:{open_id}' |
//                   'group_user:{chat_id}:{open_id}'
// All queries go through the Policy Filter before returning rows to callers.

export type MemoryVisibility = 'private' | 'group' | 'public' | 'admin_only';
export type MemorySensitivity = 'normal' | 'sensitive' | 'confidential';
export type MemorySource = 'manual' | 'auto';

export interface MemoryItem {
  id: number;
  /** Access scope; must be one of the four recognised namespace patterns. */
  namespace: string;
  /** Optional semantic label for fast lookup by key within a namespace. */
  key: string | null;
  /** Text content of the memory entry. */
  content: string;
  /** Visibility gate applied after namespace matching. */
  visibility: MemoryVisibility;
  /** Advisory sensitivity level (affects log redaction, not LLM access). */
  sensitivity: MemorySensitivity;
  /** Origin: 'manual' for operator-written entries; 'auto' for automatically generated summaries. */
  source: MemorySource;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface InsertMemoryInput {
  /** Required: determines access scope. No default is applied — callers must be explicit. */
  namespace: string;
  /** Optional semantic label for lookup by key. */
  key?: string;
  /** Memory content text. */
  content: string;
  /** Defaults to 'private'. */
  visibility?: MemoryVisibility;
  /** Defaults to 'normal'. */
  sensitivity?: MemorySensitivity;
  /** Defaults to 'manual'. */
  source?: MemorySource;
  /** Optional Unix-seconds expiry timestamp. */
  expiresAt?: number;
}

export interface GetFilteredMemoriesOptions {
  /** Restrict the query to these namespaces (already computed by the policy layer). */
  namespaces: string[];
  /**
   * Character budget for group-scoped namespace content combined.
   * Entries are included in updated_at DESC order until the budget is exhausted.
   */
  groupCharLimit?: number;
  /** Character budget for user-scoped namespace content combined. */
  userCharLimit?: number;
}

/** Context identifying the caller — required by the policy filter. */
export interface CallerContext {
  chatId: string;
  userOpenId: string;
}

function rowToMemoryItem(row: Record<string, unknown>): MemoryItem {
  return {
    id: row['id'] as number,
    namespace: row['namespace'] as string,
    key: (row['key'] as string | null) ?? null,
    content: row['content'] as string,
    visibility: (row['visibility'] as MemoryVisibility) ?? 'private',
    sensitivity: (row['sensitivity'] as MemorySensitivity) ?? 'normal',
    source: (row['source'] as MemorySource) ?? 'manual',
    createdAt: row['created_at'] as number,
    updatedAt: row['updated_at'] as number,
    expiresAt: (row['expires_at'] as number | null) ?? null,
  };
}

/**
 * Insert a new memory item. namespace is required and has no default; callers must be explicit
 * about the access scope to prevent accidental global leakage.
 *
 * The INSERT carries a RETURNING clause (supported by both node:sqlite and PostgreSQL) so the new
 * row's id can be read back without relying on `lastInsertRowid`, which the PostgreSQL query
 * interface introduced later has no equivalent for.
 */
export async function insertMemory(input: InsertMemoryInput): Promise<number> {
  const db = await getDb();
  const { rows } = await db.query<{ id: number }>(
    `
    INSERT INTO memory_items(namespace, key, content, visibility, sensitivity, source, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `,
    [
      input.namespace,
      input.key ?? null,
      input.content,
      input.visibility ?? 'private',
      input.sensitivity ?? 'normal',
      input.source ?? 'manual',
      input.expiresAt ?? null,
    ],
  );
  return rows[0]?.id ?? 0;
}

/**
 * Upsert a memory item by (namespace, key). When a row with the same namespace+key already
 * exists, its content and updated_at are refreshed. When key is null, always inserts a new row.
 */
export async function upsertMemory(input: InsertMemoryInput & { key: string }): Promise<number> {
  return tx(async () => {
    const db = await getDb();
    const { rows: existingRows } = await db.query<{ id: number }>(
      'SELECT id FROM memory_items WHERE namespace = $1 AND key = $2 LIMIT 1',
      [input.namespace, input.key],
    );
    const existing = existingRows[0];
    if (existing) {
      await db.query(
        `
        UPDATE memory_items
        SET content = $1, visibility = $2, sensitivity = $3, source = $4,
            expires_at = $5, updated_at = unixepoch()
        WHERE id = $6
      `,
        [
          input.content,
          input.visibility ?? 'private',
          input.sensitivity ?? 'normal',
          input.source ?? 'manual',
          input.expiresAt ?? null,
          existing.id,
        ],
      );
      return existing.id;
    }
    return insertMemory(input);
  });
}

/**
 * Retrieve memory items for the caller, filtered by namespace whitelist and then by the
 * policy layer (visibility gates). Entries are returned ordered by updated_at DESC; an optional
 * per-namespace-group character budget trims the result to avoid exhausting the context window.
 *
 * The namespaces argument must come from allowedNamespaces(ctx) — never pass an unfiltered list.
 */
export async function getFilteredMemories(
  ctx: CallerContext,
  opts: GetFilteredMemoriesOptions,
): Promise<MemoryItem[]> {
  if (opts.namespaces.length === 0) return [];
  const db = await getDb();

  // Exclude expired entries at the SQL level.
  const now = Math.floor(Date.now() / 1000);
  const placeholders = opts.namespaces.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query<Record<string, unknown>>(
    `
    SELECT * FROM memory_items
    WHERE namespace IN (${placeholders})
      AND (expires_at IS NULL OR expires_at > $${opts.namespaces.length + 1})
    ORDER BY updated_at DESC
  `,
    [...opts.namespaces, now],
  );

  const items = rows.map(rowToMemoryItem);

  // Policy filter: enforces visibility rules on top of namespace matching. Pure/synchronous.
  const allowed = filterByPolicy(items, ctx);

  // Apply per-scope character budgets to prevent prompt bloat.
  const groupLimit = opts.groupCharLimit ?? 500;
  const userLimit = opts.userCharLimit ?? 300;

  const result: MemoryItem[] = [];
  let groupChars = 0;
  let userChars = 0;

  for (const item of allowed) {
    const isUserScoped =
      item.namespace.startsWith(`user:${ctx.userOpenId}`) ||
      item.namespace.startsWith(`group_user:${ctx.chatId}:${ctx.userOpenId}`);

    if (isUserScoped) {
      if (userChars + item.content.length > userLimit) continue;
      userChars += item.content.length;
    } else {
      if (groupChars + item.content.length > groupLimit) continue;
      groupChars += item.content.length;
    }
    result.push(item);
  }

  return result;
}

/**
 * Look up a single memory item by (namespace, key). Returns null when not found or expired.
 * No policy filtering is applied here — callers are responsible for using caller-controlled
 * namespace values (e.g. constructed from the caller's own open_id).
 */
export async function getMemoryByKey(namespace: string, key: string): Promise<MemoryItem | null> {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const { rows } = await db.query<Record<string, unknown>>(
    `
    SELECT * FROM memory_items
    WHERE namespace = $1 AND key = $2
      AND (expires_at IS NULL OR expires_at > $3)
    LIMIT 1
  `,
    [namespace, key, now],
  );
  const row = rows[0];
  return row ? rowToMemoryItem(row) : null;
}

/**
 * Delete a memory item by id. Returns true when a row was deleted.
 */
export async function deleteMemory(id: number): Promise<boolean> {
  const db = await getDb();
  const { rowCount } = await db.query('DELETE FROM memory_items WHERE id = $1', [id]);
  return rowCount > 0;
}

/**
 * Delete all memory items in a namespace. Intended for administrative cleanup.
 * Returns the count of deleted rows.
 */
export async function deleteNamespace(namespace: string): Promise<number> {
  const db = await getDb();
  const { rowCount } = await db.query('DELETE FROM memory_items WHERE namespace = $1', [namespace]);
  return rowCount;
}

/**
 * Delete all memory items whose expires_at has passed.
 * Uses the DB-side unixepoch() so the comparison is clock-safe.
 * Returns the count of deleted rows.
 */
export async function purgeExpiredMemories(): Promise<number> {
  const db = await getDb();
  const { rowCount } = await db.query(
    'DELETE FROM memory_items WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()',
  );
  return rowCount;
}

// ── Operator / admin read functions (no policy filter) ────────────────────────
// These are raw-access functions for the CLI. They intentionally bypass the
// policy filter so an operator can inspect all records regardless of caller context.

export interface ListMemoriesFilter {
  namespace?: string;
  userOpenId?: string;
  chatId?: string;
  limit?: number;
}

/**
 * List memory items without any policy filtering. Intended for operator tooling only;
 * never expose the result of this function to an LLM or an untrusted caller.
 */
export async function listMemories(filter: ListMemoriesFilter = {}): Promise<MemoryItem[]> {
  const db = await getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.namespace) {
    params.push(filter.namespace);
    conditions.push(`namespace = $${params.length}`);
  }
  if (filter.userOpenId) {
    // Match namespaces that encode this open_id: user:{id} or group_user:*:{id}
    params.push(`user:${filter.userOpenId}`);
    const eqIdx = params.length;
    params.push(`group_user:%:${filter.userOpenId}`);
    const likeIdx = params.length;
    conditions.push(`(namespace = $${eqIdx} OR namespace LIKE $${likeIdx})`);
  }
  if (filter.chatId) {
    params.push(`group:${filter.chatId}`);
    const eqIdx = params.length;
    params.push(`group_user:${filter.chatId}:%`);
    const likeIdx = params.length;
    conditions.push(`(namespace = $${eqIdx} OR namespace LIKE $${likeIdx})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')} ` : '';
  const limit = filter.limit ?? 100;
  params.push(limit);
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM memory_items ${where}ORDER BY updated_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(rowToMemoryItem);
}

/**
 * Fetch a single memory item by id. Returns null when not found.
 * No policy filtering is applied — for operator / admin use only.
 */
export async function getMemoryById(id: number): Promise<MemoryItem | null> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM memory_items WHERE id = $1', [id]);
  const row = rows[0];
  return row ? rowToMemoryItem(row) : null;
}

/**
 * Retrieve the N most recent messages sent to a specific chat, ordered oldest→newest.
 * Used by the group topic aggregator to build a frequency corpus.
 */
export async function getRecentMessagesForChat(chatId: string, limit: number): Promise<Array<{ text: string }>> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT text FROM messages WHERE chat_id = $1 AND deleted = 0 ORDER BY create_time DESC LIMIT $2',
    [chatId, limit],
  );
  return rows.map((r) => ({ text: (r['text'] as string) ?? '' }));
}

/**
 * Retrieve the N most recent messages sent by a specific user in a specific chat, ordered
 * newest→oldest. Used to build the per-user summary corpus.
 */
export async function getRecentUserMessagesInChat(
  chatId: string,
  userOpenId: string,
  limit: number,
): Promise<Array<{ text: string }>> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT text FROM messages
     WHERE chat_id = $1 AND sender_open_id = $2 AND deleted = 0
     ORDER BY create_time DESC LIMIT $3`,
    [chatId, userOpenId, limit],
  );
  return rows.map((r) => ({ text: (r['text'] as string) ?? '' }));
}

/**
 * Return the distinct chat_ids that appear in the messages table (i.e. chats with
 * recorded history). Used by the daily memory maintenance job.
 */
export async function listKnownChatIds(): Promise<string[]> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>('SELECT DISTINCT chat_id FROM messages');
  return rows.map((r) => r['chat_id'] as string).filter(Boolean);
}
