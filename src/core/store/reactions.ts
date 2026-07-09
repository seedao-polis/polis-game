import { getDb } from '../db.js';

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
export function recordChatReaction(r: ChatReactionRow): boolean {
  if (!r.messageId || !r.reactorOpenId || !r.emojiType) return false;
  try {
    const res = getDb()
      .prepare(
        `INSERT OR IGNORE INTO chat_reactions(message_id, chat_id, reactor_open_id, emoji_type, action_time)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(r.messageId, r.chatId, r.reactorOpenId, r.emojiType, r.actionTime ?? 0);
    return (res.changes as number) > 0;
  } catch {
    return false;
  }
}

/** Cumulative count of distinct reactions this member has made (across all recorded non-work groups). */
export function memberReactionCount(openId: string): number {
  if (!openId) return 0;
  try {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM chat_reactions WHERE reactor_open_id = ?')
      .get(openId) as { n: number } | undefined;
    return row?.n ?? 0;
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
export function weeklyMemberReactionCount(openId: string, startSec: number, endSec: number): number {
  if (!openId) return 0;
  try {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM chat_reactions
         WHERE reactor_open_id = ? AND action_time >= ? AND action_time < ?`
      )
      .get(openId, startSec, endSec) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Total reactions recorded so far (used to tell a first-ever seed round from a steady-state one). */
export function chatReactionCount(): number {
  try {
    const row = getDb().prepare('SELECT COUNT(*) AS n FROM chat_reactions').get() as { n: number } | undefined;
    return row?.n ?? 0;
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
export function recordLikeManiacWeek(weekStart: number, openId: string, name: string, count: number): boolean {
  if (!openId || !Number.isFinite(weekStart)) return false;
  try {
    const res = getDb()
      .prepare(
        `INSERT OR IGNORE INTO like_maniac_weeks(week_start, open_id, name, reaction_count)
         VALUES (?, ?, ?, ?)`
      )
      .run(weekStart, openId, name ?? '', count);
    return (res.changes as number) > 0;
  } catch {
    return false;
  }
}

/** Whether the like-maniac milestone has already fired for this member in the given logical week. */
export function isLikeManiacWeekRecorded(weekStart: number, openId: string): boolean {
  if (!openId || !Number.isFinite(weekStart)) return false;
  try {
    const row = getDb()
      .prepare('SELECT 1 FROM like_maniac_weeks WHERE week_start = ? AND open_id = ?')
      .get(weekStart, openId);
    return !!row;
  } catch {
    return false;
  }
}

// ── auto-pinned popular messages ──────────────────────────────────────────────

/**
 * Record that a message has been auto-pinned. Idempotent: returns true only when this message was NEWLY
 * recorded (so the caller pins it exactly once and skips it on later polls). Best-effort — never throws.
 */
export function recordPinnedMessage(messageId: string, chatId: string, reactorCount: number): boolean {
  if (!messageId || !chatId) return false;
  try {
    const res = getDb()
      .prepare(
        `INSERT OR IGNORE INTO pinned_messages(message_id, chat_id, reactor_count) VALUES (?, ?, ?)`
      )
      .run(messageId, chatId, reactorCount);
    return (res.changes as number) > 0;
  } catch {
    return false;
  }
}

/** Whether a message has already been auto-pinned (so the poll doesn't re-pin it). */
export function isMessagePinned(messageId: string): boolean {
  if (!messageId) return false;
  try {
    const row = getDb().prepare('SELECT 1 FROM pinned_messages WHERE message_id = ?').get(messageId);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Our auto-pins in a chat that exceed `cap`, oldest first — i.e. everything past the newest `cap` rows.
 * Used to enforce a per-chat cap: after adding a pin, unpin these (the oldest beyond the cap). Returns
 * message_ids ordered oldest→newest. Only rows WE recorded are considered, so human pins are untouched.
 */
export function pinnedMessagesOldestBeyond(chatId: string, cap: number): string[] {
  if (!chatId || cap < 0) return [];
  try {
    const rows = getDb()
      .prepare(
        `SELECT message_id FROM pinned_messages WHERE chat_id = ?
         ORDER BY pinned_at DESC, rowid DESC LIMIT -1 OFFSET ?`
      )
      .all(chatId, cap) as Array<{ message_id: string }>;
    // OFFSET returns them newest→oldest; reverse so callers unpin oldest first.
    return rows.map((r) => r.message_id).reverse();
  } catch {
    return [];
  }
}

/** Drop a message from the auto-pin tracking table (after it has been unpinned or is gone). */
export function removePinnedMessage(messageId: string): void {
  if (!messageId) return;
  try {
    getDb().prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(messageId);
  } catch {
    /* best-effort */
  }
}
