import { getDb, tx, getLpDb } from '../db.js';
import { canonicalId } from './gamification.js';
import { applyNameOverride } from '../name-overrides.js';

export interface SilentMember {
  openId: string;
  /** display name (latest non-empty captured sender_name, else profile name, else '') */
  name: string;
  /** last message time in ms (messages.create_time unit) */
  lastSpoke: number;
  /** chat_id of their most recent message — a roster to look their name up in when it's missing */
  chatId: string;
}

export interface DirectoryChat {
  chatId: string;
  name: string;
  /** number of members currently present in this chat */
  present: number;
}

export interface SilentMemberReport {
  /** the whole candidate pool: every member currently present in a monitored chat, minus excludes */
  members: SilentMember[];
  /** subset whose last message predates the cutoff — INCLUDING people who have never spoken (lastSpoke=0) */
  silent: SilentMember[];
  /** the monitored chats that contributed members (the search scope) */
  chats: DirectoryChat[];
  /** the cutoff used, in ms (now - silent window) */
  cutoffMs: number;
}

/**
 * Survey community members for the "lurker" selection. The candidate pool is the member directory
 * restricted to the event's SOURCE group(s) — `sourceChatIds` (when omitted, all monitored chats) —
 * i.e. everyone currently present in those groups (internal AND external), whether or not they ever
 * spoke, minus `excludeOpenIds`. Each member's last-spoke time is joined from messages
 * (0 = never spoke). The "silent" subset is everyone whose last message predates `cutoffMs`, which by
 * definition INCLUDES never-spoke members (the ultimate lurkers). Sorted oldest-spoke first so a
 * caller can pick the quietest as a forced-fire fallback. `chats` lists the source groups searched.
 *
 * Source ≠ target: the event is announced to its configured target regardless of these groups.
 * `cutoffMs` is in MILLISECONDS (matches messages.create_time via larkTimeToMs).
 */
export function silentMemberReport(
  cutoffMs: number,
  opts: { sourceChatIds?: string[]; excludeOpenIds?: string[] } = {},
): SilentMemberReport {
  try {
    const db = getDb();
    const excludes = (opts.excludeOpenIds ?? []).filter(Boolean);
    const sources = (opts.sourceChatIds ?? []).filter(Boolean);
    const notIn = excludes.length ? `AND cm.open_id NOT IN (${excludes.map(() => '?').join(',')})` : '';
    // Source-group restriction: only members present in the event's source group(s).
    const srcIn = sources.length ? `AND cm.chat_id IN (${sources.map(() => '?').join(',')})` : '';
    // One row per distinct present member (in the source groups), with their latest message time
    // (0 = never), name from the directory, and a representative chat. Never/oldest-spoke first.
    const rows = db.prepare(`
      SELECT
        cm.open_id AS open_id,
        (SELECT cmn.name FROM chat_members cmn
         WHERE cmn.open_id = cm.open_id AND cmn.name <> ''
         ORDER BY cmn.last_seen DESC LIMIT 1) AS name,
        COALESCE((SELECT MAX(m.create_time) FROM messages m WHERE m.sender_open_id = cm.open_id), 0) AS last_spoke,
        MIN(cm.chat_id) AS chat_id
      FROM chat_members cm
      WHERE cm.present = 1
        ${notIn}
        ${srcIn}
      GROUP BY cm.open_id
      ORDER BY last_spoke ASC
    `).all(...excludes, ...sources) as Array<{ open_id: string; name: string | null; last_spoke: number; chat_id: string }>;
    const members: SilentMember[] = rows.map((r) => ({
      openId: r.open_id,
      name: r.name ?? '',
      lastSpoke: r.last_spoke ?? 0,
      chatId: r.chat_id ?? '',
    }));
    const silent = members.filter((m) => m.lastSpoke < cutoffMs); // lastSpoke=0 (never) is < cutoff too
    const chatRows = db.prepare(`
      SELECT cm.chat_id AS chat_id,
             COALESCE((SELECT c.name FROM chats c WHERE c.chat_id = cm.chat_id), '') AS name,
             COUNT(*) AS present
      FROM chat_members cm
      WHERE cm.present = 1
        ${srcIn}
      GROUP BY cm.chat_id
      ORDER BY present DESC
    `).all(...sources) as Array<{ chat_id: string; name: string; present: number }>;
    const chats: DirectoryChat[] = chatRows.map((r) => ({ chatId: r.chat_id, name: r.name, present: r.present }));
    return { members, silent, chats, cutoffMs };
  } catch {
    return { members: [], silent: [], chats: [], cutoffMs };
  }
}

export interface MemberRef {
  openId: string;
  name: string;
}

export interface SyncChatMembersResult {
  /** number of members new to this chat's directory this round */
  added: number;
  /** size of the current roster (people present now) */
  total: number;
  /** number of members previously present but absent now */
  left: number;
  /** number of members whose display name changed */
  renamed: number;
  joinedMembers: MemberRef[];
  leftMembers: MemberRef[];
  renamedMembers: MemberRef[];
}

/**
 * Reconcile a chat's roster against the directory. Roster members are upserted as present=1 with
 * their current name (so a rename is picked up); members previously present but absent now are
 * flagged present=0 but KEPT (they may return). Nothing is ever deleted. Any EXISTING profile (an
 * actual interactor) also has its display name refreshed — but no profile is created here, to keep
 * non-participants out of the gamification table. Returns added / left / renamed counts.
 */
export function syncChatMembers(
  chatId: string,
  members: Map<string, string>,
): SyncChatMembersResult {
  return tx(() => {
    const db = getDb();
    const prior = db.prepare('SELECT open_id, name, present FROM chat_members WHERE chat_id = ?').all(chatId) as Array<{ open_id: string; name: string; present: number }>;
    const oldName = new Map(prior.map((r) => [r.open_id, r.name]));
    const wasPresent = new Set(prior.filter((r) => r.present === 1).map((r) => r.open_id));
    // Flag everyone absent first; the upsert flips present back for the current roster. Rows survive.
    db.prepare('UPDATE chat_members SET present = 0 WHERE chat_id = ?').run(chatId);
    const up = db.prepare(`
      INSERT INTO chat_members(chat_id, open_id, name, present, last_seen)
      VALUES (?, ?, ?, 1, unixepoch())
      ON CONFLICT(chat_id, open_id) DO UPDATE SET
        name      = CASE WHEN excluded.name <> '' THEN excluded.name ELSE chat_members.name END,
        present   = 1,
        last_seen = unixepoch()
    `);
    // Keep an existing interactor's profile name fresh on rename. UPDATE-only (no INSERT) so we never
    // add a non-participant to profiles (the daily LP floor reset would otherwise grant them LP).
    // Names live in the shared LP database (profiles); refresh the canonical identity's name on rename.
    const freshenProfile = getLpDb().prepare('UPDATE profiles SET name = ? WHERE open_id = ? AND name <> ?');
    // Collect the (open_id, name) of each joiner/renamer so the periodic round can be persisted with
    // its full detail. A joiner's name is the current one; a renamer's name is the NEW one.
    const joinedMembers: MemberRef[] = [];
    const renamedMembers: MemberRef[] = [];
    for (const [openId, name] of members) {
      up.run(chatId, openId, name ?? '');
      if (!oldName.has(openId)) {
        joinedMembers.push({ openId, name: name ?? '' });
      } else if (name && oldName.get(openId) && oldName.get(openId) !== name) {
        renamedMembers.push({ openId, name });
      }
      if (name) freshenProfile.run(name, canonicalId(openId), name);
    }
    // A leaver was present before but is absent from the current roster; record their last-known name.
    const leftMembers: MemberRef[] = [];
    for (const openId of wasPresent) {
      if (!members.has(openId)) leftMembers.push({ openId, name: oldName.get(openId) ?? '' });
    }
    return {
      added: joinedMembers.length,
      total: members.size,
      left: leftMembers.length,
      renamed: renamedMembers.length,
      joinedMembers,
      leftMembers,
      renamedMembers,
    };
  });
}

export function presentMemberCount(chatId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ? AND present = 1').get(chatId) as { n: number };
  return row?.n ?? 0;
}

export type ChatInactiveReason = 'dissolved' | 'inaccessible';

/**
 * Mark a chat INACTIVE (stop servicing it): stamp chats.dissolved_at + inactive_reason and mark its
 * whole roster absent (present=0; rows are kept). Idempotent — keeps the first reason/timestamp on
 * repeat calls. Best-effort. Returns the number of members flipped from present to absent.
 */
export function markChatInactive(chatId: string, reason: ChatInactiveReason): number {
  if (!chatId) return 0;
  try {
    return tx(() => {
      const db = getDb();
      // Ensure the chat row exists so the flag sticks even for a chat we only ever polled.
      db.prepare('INSERT OR IGNORE INTO chats(chat_id) VALUES (?)').run(chatId);
      db.prepare(
        'UPDATE chats SET dissolved_at = unixepoch(), inactive_reason = ? WHERE chat_id = ? AND dissolved_at IS NULL'
      ).run(reason, chatId);
      const info = db.prepare('UPDATE chat_members SET present = 0 WHERE chat_id = ? AND present = 1').run(chatId);
      return Number(info.changes) || 0;
    });
  } catch {
    return 0;
  }
}

export function clearChatInactive(chatId: string): void {
  if (!chatId) return;
  try {
    getDb().prepare('UPDATE chats SET dissolved_at = NULL, inactive_reason = NULL WHERE chat_id = ?').run(chatId);
  } catch {
    /* best-effort */
  }
}

export function listInactiveChats(): Array<{ chatId: string; name: string; inactiveAt: number; reason: string }> {
  try {
    const rows = getDb().prepare(
      'SELECT chat_id, name, dissolved_at, inactive_reason FROM chats WHERE dissolved_at IS NOT NULL ORDER BY dissolved_at DESC'
    ).all() as Array<{ chat_id: string; name: string; dissolved_at: number; inactive_reason: string | null }>;
    return rows.map((r) => ({
      chatId: r.chat_id,
      name: r.name ?? '',
      inactiveAt: r.dissolved_at,
      reason: r.inactive_reason ?? 'dissolved',
    }));
  } catch {
    return [];
  }
}

export function isChatInactive(chatId: string): boolean {
  return chatInactiveReason(chatId) !== null;
}

export function chatInactiveReason(chatId: string): ChatInactiveReason | null {
  if (!chatId) return null;
  try {
    const row = getDb()
      .prepare('SELECT inactive_reason FROM chats WHERE chat_id = ? AND dissolved_at IS NOT NULL')
      .get(chatId) as { inactive_reason: string | null } | undefined;
    if (!row) return null;
    return row.inactive_reason === 'inaccessible' ? 'inaccessible' : 'dissolved';
  } catch {
    return null;
  }
}

export function recordChatMember(chatId: string, openId: string, name: string): void {
  if (!chatId || !openId || !name) return;
  try {
    getDb().prepare(`
      INSERT INTO chat_members(chat_id, open_id, name, present, last_seen)
      VALUES (?, ?, ?, 1, unixepoch())
      ON CONFLICT(chat_id, open_id) DO UPDATE SET
        name = excluded.name, last_seen = unixepoch()
    `).run(chatId, openId, name);
  } catch {
    /* best-effort */
  }
}

export function memberName(openId: string): string {
  if (!openId) return '';
  try {
    const row = getDb()
      .prepare("SELECT name FROM chat_members WHERE open_id = ? AND name <> '' ORDER BY last_seen DESC LIMIT 1")
      .get(openId) as { name: string } | undefined;
    return applyNameOverride(openId, row?.name ?? '');
  } catch {
    return '';
  }
}

export function chatName(chatId: string): string {
  if (!chatId) return '';
  try {
    const row = getDb()
      .prepare("SELECT name FROM chats WHERE chat_id = ? AND name IS NOT NULL AND name <> ''")
      .get(chatId) as { name: string } | undefined;
    return row?.name ?? '';
  } catch {
    return '';
  }
}

/**
 * Directory head-counts (deduped distinct open_ids):
 *   distinct        — everyone EVER seen (incl. leavers) = 名册累计
 *   present         — distinct present right now across all chats = 当前在群去重人数
 *   presentInternal — distinct present in internal chats (chats.external 0/null)
 *   presentExternal — distinct present in external chats (chats.external = 1)
 * internal + external can exceed present (someone in both kinds is counted once in each).
 */
export function directoryStats(): { distinct: number; present: number; presentInternal: number; presentExternal: number } {
  try {
    const db = getDb();
    const distinct = (db.prepare('SELECT COUNT(DISTINCT open_id) AS n FROM chat_members').get() as { n: number }).n;
    const present = (db.prepare('SELECT COUNT(DISTINCT open_id) AS n FROM chat_members WHERE present = 1').get() as { n: number }).n;
    const presentInternal = (db.prepare(`
      SELECT COUNT(DISTINCT cm.open_id) AS n FROM chat_members cm
      LEFT JOIN chats c ON c.chat_id = cm.chat_id
      WHERE cm.present = 1 AND COALESCE(c.external, 0) = 0
    `).get() as { n: number }).n;
    const presentExternal = (db.prepare(`
      SELECT COUNT(DISTINCT cm.open_id) AS n FROM chat_members cm
      LEFT JOIN chats c ON c.chat_id = cm.chat_id
      WHERE cm.present = 1 AND COALESCE(c.external, 0) = 1
    `).get() as { n: number }).n;
    return { distinct, present, presentInternal, presentExternal };
  } catch {
    return { distinct: 0, present: 0, presentInternal: 0, presentExternal: 0 };
  }
}

/**
 * Render a list of members as the ops-detail string "(open_id, name),(open_id, name)". Whitespace in
 * a name is collapsed to single spaces (so the line stays single-field-safe); empty list → "".
 */
export function formatMemberRefs(refs: MemberRef[]): string {
  return refs
    .map((r) => `(${r.openId}, ${String(r.name ?? '').replace(/\s+/g, ' ').trim()})`)
    .join(',');
}

export interface MemberSyncRoundInput {
  /** when the round completed, in unix SECONDS */
  syncedAt: number;
  /** number of chats covered this round */
  chatCount: number;
  /** 在群合计: sum of each chat's present count (a member in N chats counts N times) */
  presentTotal: number;
  /** 当前在群去重人数: distinct present across all chats (live = directoryStats().present) */
  presentDistinct?: number;
  /** 内部群去重在群人数 */
  presentInternal?: number;
  /** 外部群去重在群人数 */
  presentExternal?: number;
  /** 本轮新增 */
  joinedCount: number;
  /** 本轮离开 */
  leftCount: number;
  /** 本轮改名 */
  renamedCount: number;
  /** 名册累计: distinct open_ids ever seen */
  rosterTotal: number;
  /** "(ou, name),…" detail (live rounds); backfilled rounds leave these empty */
  joinedDetail?: string;
  leftDetail?: string;
  renamedDetail?: string;
  /** 'live' (recorded as it happened) | 'backfill' (reconstructed from logs) */
  source?: 'live' | 'backfill';
}

/**
 * Record one member-sync round into the ops time-series. synced_at is UNIQUE, so a round already
 * recorded for that instant is left untouched (idempotent: backfill never double-counts). Returns
 * true when a new row was inserted. Best-effort: never throws into the sync loop.
 */
export function recordMemberSyncRound(r: MemberSyncRoundInput): boolean {
  try {
    const info = getDb().prepare(`
      INSERT OR IGNORE INTO member_sync_rounds(
        synced_at, chat_count, present_total, present_distinct, present_internal, present_external,
        joined_count, left_count, renamed_count,
        roster_total, joined_detail, left_detail, renamed_detail, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Math.trunc(r.syncedAt),
      r.chatCount,
      r.presentTotal,
      r.presentDistinct ?? 0,
      r.presentInternal ?? 0,
      r.presentExternal ?? 0,
      r.joinedCount,
      r.leftCount,
      r.renamedCount,
      r.rosterTotal,
      r.joinedDetail ?? '',
      r.leftDetail ?? '',
      r.renamedDetail ?? '',
      r.source ?? 'live',
    );
    return (info.changes as number) > 0;
  } catch {
    return false;
  }
}

export function earliestMemberRoundAt(source?: 'live' | 'backfill'): number | null {
  try {
    const db = getDb();
    const row = source
      ? db.prepare('SELECT MIN(synced_at) AS t FROM member_sync_rounds WHERE source = ?').get(source) as { t: number | null }
      : db.prepare('SELECT MIN(synced_at) AS t FROM member_sync_rounds').get() as { t: number | null };
    return row?.t ?? null;
  } catch {
    return null;
  }
}

export interface MemberSyncRoundRow {
  id: number;
  syncedAt: number;
  chatCount: number;
  presentTotal: number;
  presentDistinct: number;
  presentInternal: number;
  presentExternal: number;
  joinedCount: number;
  leftCount: number;
  renamedCount: number;
  rosterTotal: number;
  joinedDetail: string;
  leftDetail: string;
  renamedDetail: string;
  source: string;
}

export function recentMemberSyncRounds(limit = 50): MemberSyncRoundRow[] {
  try {
    const rows = getDb().prepare(`
      SELECT id, synced_at, chat_count, present_total, present_distinct, present_internal, present_external,
             joined_count, left_count, renamed_count,
             roster_total, joined_detail, left_detail, renamed_detail, source
      FROM member_sync_rounds ORDER BY synced_at DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      syncedAt: Number(r.synced_at),
      chatCount: Number(r.chat_count),
      presentTotal: Number(r.present_total),
      presentDistinct: Number(r.present_distinct),
      presentInternal: Number(r.present_internal),
      presentExternal: Number(r.present_external),
      joinedCount: Number(r.joined_count),
      leftCount: Number(r.left_count),
      renamedCount: Number(r.renamed_count),
      rosterTotal: Number(r.roster_total),
      joinedDetail: String(r.joined_detail ?? ''),
      leftDetail: String(r.left_detail ?? ''),
      renamedDetail: String(r.renamed_detail ?? ''),
      source: String(r.source ?? ''),
    }));
  } catch {
    return [];
  }
}

export function deleteBackfillRounds(): number {
  try {
    const info = getDb().prepare("DELETE FROM member_sync_rounds WHERE source = 'backfill'").run();
    return Number(info.changes) || 0;
  } catch {
    return 0;
  }
}

/**
 * Return member-sync rounds where synced_at falls in [fromSec, toSec), ordered by time ascending.
 * Mirrors the shape of recentMemberSyncRounds but bounded by a time window rather than a row limit.
 */
export function memberSyncRoundsBetween(fromSec: number, toSec: number): MemberSyncRoundRow[] {
  try {
    const rows = getDb().prepare(`
      SELECT id, synced_at, chat_count, present_total, present_distinct, present_internal, present_external,
             joined_count, left_count, renamed_count,
             roster_total, joined_detail, left_detail, renamed_detail, source
      FROM member_sync_rounds
      WHERE synced_at >= ? AND synced_at < ?
      ORDER BY synced_at ASC
    `).all(fromSec, toSec) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      syncedAt: Number(r.synced_at),
      chatCount: Number(r.chat_count),
      presentTotal: Number(r.present_total),
      presentDistinct: Number(r.present_distinct),
      presentInternal: Number(r.present_internal),
      presentExternal: Number(r.present_external),
      joinedCount: Number(r.joined_count),
      leftCount: Number(r.left_count),
      renamedCount: Number(r.renamed_count),
      rosterTotal: Number(r.roster_total),
      joinedDetail: String(r.joined_detail ?? ''),
      leftDetail: String(r.left_detail ?? ''),
      renamedDetail: String(r.renamed_detail ?? ''),
      source: String(r.source ?? ''),
    }));
  } catch {
    return [];
  }
}

/**
 * Return the set of present member open_ids across the given chats. Used to flag which readers
 * belong to staff groups when coloring the wiki tree by browsing composition.
 */
export function chatMemberOpenIds(chatIds: string[]): Set<string> {
  const set = new Set<string>();
  if (chatIds.length === 0) return set;
  try {
    const placeholders = chatIds.map(() => '?').join(',');
    const rows = getDb().prepare(`
      SELECT DISTINCT open_id FROM chat_members
      WHERE present = 1 AND chat_id IN (${placeholders})
    `).all(...chatIds) as Array<{ open_id: string }>;
    for (const r of rows) {
      set.add(String(r.open_id));
    }
  } catch {
    // leave the set empty when the lookup fails
  }
  return set;
}

// ── visitor-count milestones ──────────────────────────────────
// The visitor-num-notify announcement counts PRESENT members, so the "N-th visitor" is the N-th
// still-present member by arrival (first_seen). These helpers freeze that identity and back the
// restart-proof announcement ledger (visitor_milestones), replacing the previous in-memory dedup.

/** A person occupying a visitor-count position. */
export interface VisitorPerson { openId: string; name: string; firstSeen: number; }

/**
 * Return the n-th present member of a chat by arrival order (first_seen asc, then rowid), 1-based.
 * This matches the semantics of the present-member count that drives the milestone, so the n-th
 * present member is "第 n 位访客". Returns null when the chat has fewer than n present members.
 */
export function nthPresentMemberByArrival(chatId: string, n: number): VisitorPerson | null {
  if (n < 1) return null;
  const row = getDb().prepare(`
    SELECT open_id, name, first_seen FROM chat_members
    WHERE chat_id = ? AND present = 1
    ORDER BY first_seen ASC, rowid ASC
    LIMIT 1 OFFSET ?
  `).get(chatId, n - 1) as { open_id: string; name: string; first_seen: number } | undefined;
  if (!row) return null;
  return { openId: String(row.open_id), name: String(row.name ?? ''), firstSeen: Number(row.first_seen) };
}

/** A frozen visitor-count milestone record. */
export interface VisitorMilestone { milestone: number; openId: string; name: string; reachedAt: number; }

/** True when the given milestone has already been recorded for the chat (announced-once ledger). */
export function hasVisitorMilestone(chatId: string, milestone: number): boolean {
  const row = getDb().prepare(
    'SELECT 1 FROM visitor_milestones WHERE chat_id = ? AND milestone = ?'
  ).get(chatId, milestone);
  return Boolean(row);
}

/**
 * Freeze a visitor-count milestone: who the milestone-th visitor was and when it was reached.
 * Idempotent on (chat_id, milestone) — keeps the first record on repeat calls (INSERT OR IGNORE).
 */
export function recordVisitorMilestone(chatId: string, milestone: number, openId: string, name: string, reachedAt: number): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO visitor_milestones(chat_id, milestone, open_id, name, reached_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(chatId, milestone, openId, name, reachedAt);
}

/** List all recorded milestones for a chat, ascending by milestone. */
export function listVisitorMilestones(chatId: string): VisitorMilestone[] {
  const rows = getDb().prepare(`
    SELECT milestone, open_id, name, reached_at FROM visitor_milestones
    WHERE chat_id = ? ORDER BY milestone ASC
  `).all(chatId) as Array<{ milestone: number; open_id: string; name: string; reached_at: number }>;
  return rows.map((r) => ({ milestone: Number(r.milestone), openId: String(r.open_id), name: String(r.name ?? ''), reachedAt: Number(r.reached_at) }));
}
