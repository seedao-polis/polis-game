import { getDb, shouldDivertSoulWrites } from '../db.js';
import { enqueueOutboxWrite } from '../pg-outbox.js';
import { chunked, multiRowValues } from './batch.js';

// Chat reaction harvest store. The reaction-sync poll observes emoji reactions on the last N messages of
// each non-work group and records each (message, reactor, emoji) here, deduped by the composite PK. Each
// row carries the reaction's action_time, so a member's like count within a *logical week* is a windowed
// COUNT(*) by reactor — this drives the like-maniac milestone (fires once when a member reaches 66
// reactions inside the current logical week). The like_maniac_weeks ledger gates it to once per week.

/** One observed reaction to record (from lark MessageReaction + its message/chat context). */
export interface ChatReactionRow {
  messageId: string;
  chatId: string;
  reactorOpenId: string;
  emojiType: string;
  /** unix seconds the reaction was added; 0 when unknown */
  actionTime?: number;
}

/**
 * Record one observed reaction. Idempotent: re-seeing the same (message, reactor, emoji) on a later poll
 * is a no-op. Returns true only when this reaction was NEWLY inserted (so the caller can tally the
 * per-member delta for the current round). Best-effort — never throws into the poll loop.
 */
export async function recordChatReaction(r: ChatReactionRow): Promise<boolean> {
  return (await recordChatReactions([r])).length > 0;
}

/** Max rows per multi-row VALUES batch (5 params each stays far below either backend's limit). */
const REACTION_BATCH_ROWS = 300;

/** Identity of one reaction, matching the (message_id, reactor_open_id, emoji_type) primary key. */
function reactionKey(messageId: string, reactorOpenId: string, emojiType: string): string {
  return `${messageId} ${reactorOpenId} ${emojiType}`;
}

/**
 * Record a batch of observed reactions. Idempotent per the composite PK; the return value is the
 * subset that was NEWLY inserted, in input order, so the caller can tally the per-member delta for
 * this round. Best-effort — never throws into the poll loop.
 *
 * One round trip per batch rather than per reaction: a sweep re-observes every reaction still visible
 * on the last N messages of each chat, so nearly all of those statements were no-ops paying a full
 * round trip each.
 */
export async function recordChatReactions(reactions: ChatReactionRow[]): Promise<ChatReactionRow[]> {
  const valid = reactions.filter((r) => r.messageId && r.reactorOpenId && r.emojiType);
  if (valid.length === 0) return [];
  // Collapse repeats first: a duplicate inside one statement would be skipped by ON CONFLICT anyway,
  // but it would then be missing from RETURNING and misread as "already recorded".
  const unique = new Map<string, ChatReactionRow>();
  for (const r of valid) unique.set(reactionKey(r.messageId, r.reactorOpenId, r.emojiType), r);

  // Append-only reaction harvest: while the soul PG pool's circuit breaker is open, divert straight to
  // the local outbox instead of attempting PostgreSQL. Every unique reaction is treated as accepted —
  // real dedup against what is already in PostgreSQL is deferred to replay's ON CONFLICT DO NOTHING
  // against the (message_id, reactor_open_id, emoji_type) primary key.
  if (shouldDivertSoulWrites()) {
    const list = [...unique.values()];
    for (const r of list) {
      await enqueueOutboxWrite('chat_reactions', ['message_id', 'chat_id', 'reactor_open_id', 'emoji_type', 'action_time'], [
        r.messageId, r.chatId, r.reactorOpenId, r.emojiType, r.actionTime ?? 0,
      ]);
    }
    return list;
  }

  const insertedKeys = new Set<string>();
  try {
    const db = await getDb();
    for (const batch of chunked([...unique.values()], REACTION_BATCH_ROWS)) {
      const { clause, params } = multiRowValues(batch.map((r) => [
        r.messageId, r.chatId, r.reactorOpenId, r.emojiType, r.actionTime ?? 0,
      ]));
      const { rows } = await db.query<{ message_id: string; reactor_open_id: string; emoji_type: string }>(
        `INSERT INTO chat_reactions(message_id, chat_id, reactor_open_id, emoji_type, action_time)
         VALUES ${clause} ON CONFLICT DO NOTHING
         RETURNING message_id, reactor_open_id, emoji_type`,
        params,
      );
      for (const r of rows) {
        insertedKeys.add(reactionKey(String(r.message_id), String(r.reactor_open_id), String(r.emoji_type)));
      }
    }
  } catch {
    /* best-effort: keep whatever earlier batches already confirmed */
  }
  return [...unique.values()].filter((r) => insertedKeys.has(reactionKey(r.messageId, r.reactorOpenId, r.emojiType)));
}

/** Cumulative count of distinct reactions this member has made (across all recorded non-work groups). */
export async function memberReactionCount(openId: string): Promise<number> {
  if (!openId) return 0;
  try {
    const db = await getDb();
    const { rows } = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM chat_reactions WHERE reactor_open_id = $1',
      [openId],
    );
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Count of distinct reactions this member made within a time window [startSec, endSec) — matched on the
 * reaction's action_time (unix seconds). Used to drive the like-maniac milestone off the *current logical
 * week* instead of an all-time total. Rows with an unknown action_time (0) fall outside any real week and
 * are naturally excluded.
 */
export async function weeklyMemberReactionCount(openId: string, startSec: number, endSec: number): Promise<number> {
  if (!openId) return 0;
  try {
    const db = await getDb();
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM chat_reactions
       WHERE reactor_open_id = $1 AND action_time >= $2 AND action_time < $3`,
      [openId, startSec, endSec],
    );
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Total reactions recorded so far (used to tell a first-ever seed round from a steady-state one). */
export async function chatReactionCount(): Promise<number> {
  try {
    const db = await getDb();
    const { rows } = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM chat_reactions');
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

// ── like-maniac weekly announcement ledger ────────────────────────────────────

/**
 * Record that the like-maniac milestone has fired for a member in a given logical week (keyed by the
 * week's start epoch-seconds). Idempotent: returns true only when this (week, member) was NEWLY recorded,
 * so the caller announces exactly once per member per week. Best-effort — never throws into the poll.
 */
export async function recordLikeManiacWeek(weekStart: number, openId: string, name: string, count: number): Promise<boolean> {
  if (!openId || !Number.isFinite(weekStart)) return false;
  try {
    const db = await getDb();
    const { rowCount } = await db.query(
      `INSERT INTO like_maniac_weeks(week_start, open_id, name, reaction_count)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [weekStart, openId, name ?? '', count],
    );
    return rowCount > 0;
  } catch {
    return false;
  }
}

/** Whether the like-maniac milestone has already fired for this member in the given logical week. */
export async function isLikeManiacWeekRecorded(weekStart: number, openId: string): Promise<boolean> {
  if (!openId || !Number.isFinite(weekStart)) return false;
  try {
    const db = await getDb();
    const { rows } = await db.query(
      'SELECT 1 FROM like_maniac_weeks WHERE week_start = $1 AND open_id = $2',
      [weekStart, openId],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

// ── auto-pinned popular messages ──────────────────────────────────────────────

/**
 * Record that a message has been auto-pinned. Idempotent: returns true only when this message was NEWLY
 * recorded (so the caller pins it exactly once and skips it on later polls). Best-effort — never throws.
 */
export async function recordPinnedMessage(messageId: string, chatId: string, reactorCount: number): Promise<boolean> {
  if (!messageId || !chatId) return false;
  try {
    const db = await getDb();
    const { rowCount } = await db.query(
      `INSERT INTO pinned_messages(message_id, chat_id, reactor_count) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [messageId, chatId, reactorCount],
    );
    return rowCount > 0;
  } catch {
    return false;
  }
}

/** Whether a message has already been auto-pinned (so the poll doesn't re-pin it). */
export async function isMessagePinned(messageId: string): Promise<boolean> {
  if (!messageId) return false;
  try {
    const db = await getDb();
    const { rows } = await db.query('SELECT 1 FROM pinned_messages WHERE message_id = $1', [messageId]);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Our auto-pins in a chat that exceed `cap`, oldest first — i.e. everything past the newest `cap` rows.
 * Used to enforce a per-chat cap: after adding a pin, unpin these (the oldest beyond the cap). Returns
 * message_ids ordered oldest→newest. Only rows WE recorded are considered, so human pins are untouched.
 */
export async function pinnedMessagesOldestBeyond(chatId: string, cap: number): Promise<string[]> {
  if (!chatId || cap < 0) return [];
  try {
    const db = await getDb();
    // pinned_messages' primary key (message_id) is not a sortable surrogate, and SQLite's implicit
    // rowid has no PostgreSQL equivalent, so ties in pinned_at are left unordered between them.
    // LIMIT 1000000000 stands in for SQLite's "no limit" LIMIT -1, which PostgreSQL rejects.
    const { rows } = await db.query<{ message_id: string }>(
      `SELECT message_id FROM pinned_messages WHERE chat_id = $1
       ORDER BY pinned_at DESC LIMIT 1000000000 OFFSET $2`,
      [chatId, cap],
    );
    // OFFSET returns them newest→oldest; reverse so callers unpin oldest first.
    return rows.map((r) => r.message_id).reverse();
  } catch {
    return [];
  }
}

/** Drop a message from the auto-pin tracking table (after it has been unpinned or is gone). */
export async function removePinnedMessage(messageId: string): Promise<void> {
  if (!messageId) return;
  try {
    const db = await getDb();
    await db.query('DELETE FROM pinned_messages WHERE message_id = $1', [messageId]);
  } catch {
    /* best-effort */
  }
}
