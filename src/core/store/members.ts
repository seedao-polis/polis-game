import { getDb, tx, getLpDb, shouldDivertSoulWrites } from '../db.js';
import { enqueueOutboxWrite } from '../pg-outbox.js';
import { applyNameOverride } from '../name-overrides.js';
import { chunked } from './batch.js';

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

/** Build a comma-joined `$N,$N+1,...` placeholder list starting at the given 1-based index. */
function placeholderList(start: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `$${start + i}`).join(',');
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
export async function silentMemberReport(
  cutoffMs: number,
  opts: { sourceChatIds?: string[]; excludeOpenIds?: string[] } = {},
): Promise<SilentMemberReport> {
  try {
    const db = await getDb();
    const excludes = (opts.excludeOpenIds ?? []).filter(Boolean);
    const sources = (opts.sourceChatIds ?? []).filter(Boolean);
    const notIn = excludes.length ? `AND cm.open_id NOT IN (${placeholderList(1, excludes.length)})` : '';
    // Source-group restriction: only members present in the event's source group(s).
    const srcIn = sources.length ? `AND cm.chat_id IN (${placeholderList(excludes.length + 1, sources.length)})` : '';
    // One row per distinct present member (in the source groups), with their latest message time
    // (0 = never), name from the directory, and a representative chat. Never/oldest-spoke first.
    const { rows } = await db.query<{ open_id: string; name: string | null; last_spoke: number; chat_id: string }>(`
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
    `, [...excludes, ...sources]);
    const members: SilentMember[] = rows.map((r) => ({
      openId: r.open_id,
      name: r.name ?? '',
      lastSpoke: r.last_spoke ?? 0,
      chatId: r.chat_id ?? '',
    }));
    const silent = members.filter((m) => m.lastSpoke < cutoffMs); // lastSpoke=0 (never) is < cutoff too
    // A fresh IN-clause, re-numbered from $1 (this is a separate query from the one above).
    const chatSrcIn = sources.length ? `AND cm.chat_id IN (${placeholderList(1, sources.length)})` : '';
    const { rows: chatRows } = await db.query<{ chat_id: string; name: string; present: number }>(`
      SELECT cm.chat_id AS chat_id,
             COALESCE((SELECT c.name FROM chats c WHERE c.chat_id = cm.chat_id), '') AS name,
             COUNT(*) AS present
      FROM chat_members cm
      WHERE cm.present = 1
        ${chatSrcIn}
      GROUP BY cm.chat_id
      ORDER BY present DESC
    `, [...sources]);
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

/** Max rows per multi-row VALUES batch (3 params each stays far below either backend's limit). */
const UPSERT_BATCH_ROWS = 200;
/** Max ids per IN (...) list for the batched lookups/updates below. */
const IN_BATCH_IDS = 400;

/**
 * Reconcile a chat's roster against the directory. Roster members are upserted as present=1 with
 * their current name (so a rename is picked up); members previously present but absent now are
 * flagged present=0 but KEPT (they may return). Nothing is ever deleted. Any EXISTING profile (an
 * actual interactor) also has its display name refreshed — but no profile is created here, to keep
 * non-participants out of the gamification table. Returns added / left / renamed counts.
 *
 * Batched: the whole reconcile runs in ~a handful of statements (one prior-state read, multi-row
 * VALUES upserts, one leaver flip, and set-based profile-name lookups) instead of 2-3 statements per
 * member — with async backends, per-member round-trips made a 600-member sync hold its transaction
 * for minutes. The joined/left/renamed increments are computed from the same prior-state snapshot the
 * per-member version used, so the MemberRef outputs are unchanged.
 *
 * Note: the profile-name freshen below reaches into the shared LP database (getLpDb) from inside a
 * soul transaction (tx()/getDb()) — a cross-database write that was never covered by the enclosing
 * transaction even when both were SQLite files (each getDb()/getLpDb() call opens an independent
 * handle unless they resolve to the same file), so this is a pre-existing best-effort gap, not one
 * introduced by the async refactor. See the migration plan's non-goals list.
 */
export async function syncChatMembers(
  chatId: string,
  members: Map<string, string>,
): Promise<SyncChatMembersResult> {
  return tx(async () => {
    const db = await getDb();
    const { rows: prior } = await db.query<{ open_id: string; name: string; present: number }>(
      'SELECT open_id, name, present FROM chat_members WHERE chat_id = $1', [chatId],
    );
    const oldName = new Map(prior.map((r) => [r.open_id, r.name]));
    const wasPresent = new Set(prior.filter((r) => r.present === 1).map((r) => r.open_id));

    // Diff in memory against the prior snapshot. A joiner's name is the current one; a renamer's name
    // is the NEW one — identical to the per-member logic this replaces.
    const roster = [...members.entries()];
    const joinedMembers: MemberRef[] = [];
    const renamedMembers: MemberRef[] = [];
    for (const [openId, name] of roster) {
      if (!oldName.has(openId)) {
        joinedMembers.push({ openId, name: name ?? '' });
      } else if (name && oldName.get(openId) && oldName.get(openId) !== name) {
        renamedMembers.push({ openId, name });
      }
    }
    // A leaver was present before but is absent from the current roster; record their last-known name.
    const leftMembers: MemberRef[] = [];
    for (const openId of wasPresent) {
      if (!members.has(openId)) leftMembers.push({ openId, name: oldName.get(openId) ?? '' });
    }

    // Upsert the whole roster as present=1 in multi-row VALUES batches. Members is a Map, so a batch
    // never carries the same (chat_id, open_id) twice (ON CONFLICT would reject that).
    for (const batch of chunked(roster, UPSERT_BATCH_ROWS)) {
      const values: string[] = [];
      const params: unknown[] = [];
      for (const [openId, name] of batch) {
        const base = params.length;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, 1, unixepoch())`);
        params.push(chatId, openId, name ?? '');
      }
      await db.query(`
        INSERT INTO chat_members(chat_id, open_id, name, present, last_seen)
        VALUES ${values.join(',')}
        ON CONFLICT(chat_id, open_id) DO UPDATE SET
          name      = CASE WHEN excluded.name <> '' THEN excluded.name ELSE chat_members.name END,
          present   = 1,
          last_seen = unixepoch()
      `, params);
    }

    // Flip ONLY the leavers to present=0 (rows survive — they may return). Equivalent end state to the
    // old "flag everyone absent, then flip the roster back" but without rewriting every row.
    for (const batch of chunked(leftMembers, IN_BATCH_IDS)) {
      await db.query(
        `UPDATE chat_members SET present = 0 WHERE chat_id = $1 AND open_id IN (${placeholderList(2, batch.length)})`,
        [chatId, ...batch.map((m) => m.openId)],
      );
    }

    await freshenProfileNames(roster);

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

/**
 * Keep EXISTING interactors' profile display names fresh from the roster (shared LP database).
 * UPDATE-only (no INSERT) so a non-participant is never added to profiles (the daily LP floor reset
 * would otherwise grant them LP). Set-based replacement for the old per-member canonicalId() +
 * guarded UPDATE pair: resolve canonical identities in bulk, read the current profile names in bulk,
 * then update only the (rare) profiles whose stored name actually differs. Mirrors the old per-row
 * semantics: an empty roster name never writes, a NULL profile name is left untouched (the old
 * `name <> $3` guard was three-valued and skipped NULLs), and when several roster entries map to one
 * canonical identity the last roster entry wins (the per-row loop's overwrite order).
 */
async function freshenProfileNames(roster: Array<[string, string]>): Promise<void> {
  const named = roster.filter(([, name]) => !!name);
  if (named.length === 0) return;
  const lpDb = await getLpDb();

  // Canonical LP identity per open_id (alias target via `agent link`, or itself). Degrades to the
  // identity mapping when the link table is unreadable — same fallback as canonicalId().
  const canonical = new Map<string, string>(named.map(([openId]) => [openId, openId]));
  try {
    for (const batch of chunked([...canonical.keys()], IN_BATCH_IDS)) {
      const { rows } = await lpDb.query<{ open_id: string; canonical_id: string }>(
        `SELECT open_id, canonical_id FROM identity_links WHERE open_id IN (${placeholderList(1, batch.length)})`,
        batch,
      );
      for (const r of rows) {
        if (r.canonical_id) canonical.set(String(r.open_id), String(r.canonical_id));
      }
    }
  } catch {
    /* unlinked fallback: each open_id is its own canonical identity */
  }

  // Desired display name per canonical identity (last roster entry wins on collision).
  const desired = new Map<string, string>();
  for (const [openId, name] of named) desired.set(canonical.get(openId) as string, name);

  // Read current names for existing profiles only, then update just the ones that really changed.
  const changed: Array<{ openId: string; name: string }> = [];
  for (const batch of chunked([...desired.keys()], IN_BATCH_IDS)) {
    const { rows } = await lpDb.query<{ open_id: string; name: string | null }>(
      `SELECT open_id, name FROM profiles WHERE open_id IN (${placeholderList(1, batch.length)})`,
      batch,
    );
    for (const r of rows) {
      const want = desired.get(String(r.open_id));
      if (want && r.name != null && r.name !== want) changed.push({ openId: String(r.open_id), name: want });
    }
  }
  for (const c of changed) {
    await lpDb.query('UPDATE profiles SET name = $1 WHERE open_id = $2', [c.name, c.openId]);
  }
}

export async function presentMemberCount(chatId: string): Promise<number> {
  const db = await getDb();
  const { rows } = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = $1 AND present = 1', [chatId]);
  return rows[0]?.n ?? 0;
}

export type ChatInactiveReason = 'dissolved' | 'inaccessible';

/**
 * Mark a chat INACTIVE (stop servicing it): stamp chats.dissolved_at + inactive_reason and mark its
 * whole roster absent (present=0; rows are kept). Idempotent — keeps the first reason/timestamp on
 * repeat calls. Best-effort. Returns the number of members flipped from present to absent.
 */
export async function markChatInactive(chatId: string, reason: ChatInactiveReason): Promise<number> {
  if (!chatId) return 0;
  try {
    return await tx(async () => {
      const db = await getDb();
      // Ensure the chat row exists so the flag sticks even for a chat we only ever polled.
      await db.query('INSERT INTO chats(chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING', [chatId]);
      await db.query(
        'UPDATE chats SET dissolved_at = unixepoch(), inactive_reason = $1 WHERE chat_id = $2 AND dissolved_at IS NULL',
        [reason, chatId],
      );
      const { rowCount } = await db.query('UPDATE chat_members SET present = 0 WHERE chat_id = $1 AND present = 1', [chatId]);
      return rowCount || 0;
    });
  } catch {
    return 0;
  }
}

export async function clearChatInactive(chatId: string): Promise<void> {
  if (!chatId) return;
  try {
    const db = await getDb();
    await db.query('UPDATE chats SET dissolved_at = NULL, inactive_reason = NULL WHERE chat_id = $1', [chatId]);
  } catch {
    /* best-effort */
  }
}

export async function listInactiveChats(): Promise<Array<{ chatId: string; name: string; inactiveAt: number; reason: string }>> {
  try {
    const db = await getDb();
    const { rows } = await db.query<{ chat_id: string; name: string; dissolved_at: number; inactive_reason: string | null }>(
      'SELECT chat_id, name, dissolved_at, inactive_reason FROM chats WHERE dissolved_at IS NOT NULL ORDER BY dissolved_at DESC',
    );
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

export async function isChatInactive(chatId: string): Promise<boolean> {
  return (await chatInactiveReason(chatId)) !== null;
}

export async function chatInactiveReason(chatId: string): Promise<ChatInactiveReason | null> {
  if (!chatId) return null;
  try {
    const db = await getDb();
    const { rows } = await db.query<{ inactive_reason: string | null }>(
      'SELECT inactive_reason FROM chats WHERE chat_id = $1 AND dissolved_at IS NOT NULL', [chatId],
    );
    const row = rows[0];
    if (!row) return null;
    return row.inactive_reason === 'inaccessible' ? 'inaccessible' : 'dissolved';
  } catch {
    return null;
  }
}

export async function recordChatMember(chatId: string, openId: string, name: string): Promise<void> {
  if (!chatId || !openId || !name) return;
  try {
    const db = await getDb();
    await db.query(`
      INSERT INTO chat_members(chat_id, open_id, name, present, last_seen)
      VALUES ($1, $2, $3, 1, unixepoch())
      ON CONFLICT(chat_id, open_id) DO UPDATE SET
        name = excluded.name, last_seen = unixepoch()
    `, [chatId, openId, name]);
  } catch {
    /* best-effort */
  }
}

export async function memberName(openId: string): Promise<string> {
  if (!openId) return '';
  try {
    const db = await getDb();
    const { rows } = await db.query<{ name: string }>(
      "SELECT name FROM chat_members WHERE open_id = $1 AND name <> '' ORDER BY last_seen DESC LIMIT 1", [openId],
    );
    return applyNameOverride(openId, rows[0]?.name ?? '');
  } catch {
    return '';
  }
}

export async function chatName(chatId: string): Promise<string> {
  if (!chatId) return '';
  try {
    const db = await getDb();
    const { rows } = await db.query<{ name: string }>(
      "SELECT name FROM chats WHERE chat_id = $1 AND name IS NOT NULL AND name <> ''", [chatId],
    );
    return rows[0]?.name ?? '';
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
export async function directoryStats(): Promise<{ distinct: number; present: number; presentInternal: number; presentExternal: number }> {
  try {
    const db = await getDb();
    const distinct = (await db.query<{ n: number }>('SELECT COUNT(DISTINCT open_id) AS n FROM chat_members')).rows[0].n;
    const present = (await db.query<{ n: number }>('SELECT COUNT(DISTINCT open_id) AS n FROM chat_members WHERE present = 1')).rows[0].n;
    const presentInternal = (await db.query<{ n: number }>(`
      SELECT COUNT(DISTINCT cm.open_id) AS n FROM chat_members cm
      LEFT JOIN chats c ON c.chat_id = cm.chat_id
      WHERE cm.present = 1 AND COALESCE(c.external, 0) = 0
    `)).rows[0].n;
    const presentExternal = (await db.query<{ n: number }>(`
      SELECT COUNT(DISTINCT cm.open_id) AS n FROM chat_members cm
      LEFT JOIN chats c ON c.chat_id = cm.chat_id
      WHERE cm.present = 1 AND COALESCE(c.external, 0) = 1
    `)).rows[0].n;
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
export async function recordMemberSyncRound(r: MemberSyncRoundInput): Promise<boolean> {
  const cols = [
    'synced_at', 'chat_count', 'present_total', 'present_distinct', 'present_internal', 'present_external',
    'joined_count', 'left_count', 'renamed_count',
    'roster_total', 'joined_detail', 'left_detail', 'renamed_detail', 'source',
  ];
  const values = [
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
  ];
  try {
    // Append-only ops time-series: divert to the local outbox while the soul PG pool's circuit
    // breaker is open, rather than attempting (and blocking on) a broken connection every ~5 minutes.
    if (shouldDivertSoulWrites()) {
      await enqueueOutboxWrite('member_sync_rounds', cols, values);
      return true;
    }
    const db = await getDb();
    const { rowCount } = await db.query(
      `INSERT INTO member_sync_rounds(${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (synced_at) DO NOTHING`,
      values,
    );
    return rowCount > 0;
  } catch {
    return false;
  }
}

export async function earliestMemberRoundAt(source?: 'live' | 'backfill'): Promise<number | null> {
  try {
    const db = await getDb();
    const { rows } = source
      ? await db.query<{ t: number | null }>('SELECT MIN(synced_at) AS t FROM member_sync_rounds WHERE source = $1', [source])
      : await db.query<{ t: number | null }>('SELECT MIN(synced_at) AS t FROM member_sync_rounds');
    return rows[0]?.t ?? null;
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

export async function recentMemberSyncRounds(limit = 50): Promise<MemberSyncRoundRow[]> {
  try {
    const db = await getDb();
    const { rows } = await db.query<Record<string, unknown>>(`
      SELECT id, synced_at, chat_count, present_total, present_distinct, present_internal, present_external,
             joined_count, left_count, renamed_count,
             roster_total, joined_detail, left_detail, renamed_detail, source
      FROM member_sync_rounds ORDER BY synced_at DESC LIMIT $1
    `, [limit]);
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

export async function deleteBackfillRounds(): Promise<number> {
  try {
    const db = await getDb();
    const { rowCount } = await db.query("DELETE FROM member_sync_rounds WHERE source = 'backfill'");
    return rowCount || 0;
  } catch {
    return 0;
  }
}

/**
 * Return member-sync rounds where synced_at falls in [fromSec, toSec), ordered by time ascending.
 * Mirrors the shape of recentMemberSyncRounds but bounded by a time window rather than a row limit.
 */
export async function memberSyncRoundsBetween(fromSec: number, toSec: number): Promise<MemberSyncRoundRow[]> {
  try {
    const db = await getDb();
    const { rows } = await db.query<Record<string, unknown>>(`
      SELECT id, synced_at, chat_count, present_total, present_distinct, present_internal, present_external,
             joined_count, left_count, renamed_count,
             roster_total, joined_detail, left_detail, renamed_detail, source
      FROM member_sync_rounds
      WHERE synced_at >= $1 AND synced_at < $2
      ORDER BY synced_at ASC
    `, [fromSec, toSec]);
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
export async function chatMemberOpenIds(chatIds: string[]): Promise<Set<string>> {
  const set = new Set<string>();
  if (chatIds.length === 0) return set;
  try {
    const db = await getDb();
    const { rows } = await db.query<{ open_id: string }>(`
      SELECT DISTINCT open_id FROM chat_members
      WHERE present = 1 AND chat_id IN (${placeholderList(1, chatIds.length)})
    `, chatIds);
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
 * Return the n-th present member of a chat by arrival order (first_seen ascending), 1-based. Ties
 * on first_seen are broken arbitrarily — there is no cross-backend equivalent of SQLite's implicit
 * rowid to order by, so a stable secondary key is intentionally not enforced. This matches the
 * semantics of the present-member count that drives the milestone, so the n-th present member is
 * "第 n 位访客". Returns null when the chat has fewer than n present members.
 */
export async function nthPresentMemberByArrival(chatId: string, n: number): Promise<VisitorPerson | null> {
  if (n < 1) return null;
  const db = await getDb();
  const { rows } = await db.query<{ open_id: string; name: string; first_seen: number }>(`
    SELECT open_id, name, first_seen FROM chat_members
    WHERE chat_id = $1 AND present = 1
    ORDER BY first_seen ASC
    LIMIT 1 OFFSET $2
  `, [chatId, n - 1]);
  const row = rows[0];
  if (!row) return null;
  return { openId: String(row.open_id), name: String(row.name ?? ''), firstSeen: Number(row.first_seen) };
}

/** A frozen visitor-count milestone record. */
export interface VisitorMilestone { milestone: number; openId: string; name: string; reachedAt: number; }

/** True when the given milestone has already been recorded for the chat (announced-once ledger). */
export async function hasVisitorMilestone(chatId: string, milestone: number): Promise<boolean> {
  const db = await getDb();
  const { rows } = await db.query(
    'SELECT 1 FROM visitor_milestones WHERE chat_id = $1 AND milestone = $2', [chatId, milestone],
  );
  return rows.length > 0;
}

/**
 * Freeze a visitor-count milestone: who the milestone-th visitor was and when it was reached.
 * Idempotent on (chat_id, milestone) — keeps the first record on repeat calls (INSERT OR IGNORE).
 */
export async function recordVisitorMilestone(chatId: string, milestone: number, openId: string, name: string, reachedAt: number): Promise<void> {
  const db = await getDb();
  await db.query(`
    INSERT INTO visitor_milestones(chat_id, milestone, open_id, name, reached_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (chat_id, milestone) DO NOTHING
  `, [chatId, milestone, openId, name, reachedAt]);
}

/** List all recorded milestones for a chat, ascending by milestone. */
export async function listVisitorMilestones(chatId: string): Promise<VisitorMilestone[]> {
  const db = await getDb();
  const { rows } = await db.query<{ milestone: number; open_id: string; name: string; reached_at: number }>(`
    SELECT milestone, open_id, name, reached_at FROM visitor_milestones
    WHERE chat_id = $1 ORDER BY milestone ASC
  `, [chatId]);
  return rows.map((r) => ({ milestone: Number(r.milestone), openId: String(r.open_id), name: String(r.name ?? ''), reachedAt: Number(r.reached_at) }));
}

// ── pending newcomer-welcome queue ────────────────────────────────────────────
// The roster sync enqueues genuinely new members here; a scheduled digest (08:30/14:30/20:30) drains
// them into ONE batched welcome. See db.ts SCHEMA_V33.

/**
 * Queue members for the next welcome digest. INSERT OR IGNORE on (chat_id, open_id) keeps the first
 * enqueue (so a member seen as "joined" more than once before a digest is welcomed only once), and a
 * later name refresh is not needed — the digest resolves a live display name anyway. No-op on empty.
 */
export async function enqueuePendingWelcome(chatId: string, members: MemberRef[]): Promise<void> {
  if (!chatId || members.length === 0) return;
  await tx(async () => {
    const db = await getDb();
    for (const m of members) {
      if (!m.openId) continue;
      await db.query(`
        INSERT INTO pending_welcome(chat_id, open_id, name)
        VALUES ($1, $2, $3)
        ON CONFLICT (chat_id, open_id) DO NOTHING
      `, [chatId, m.openId, m.name ?? '']);
    }
  });
}

/**
 * Members currently queued for a chat's next welcome digest, oldest first. Ties on queued_at are
 * broken arbitrarily — there is no cross-backend equivalent of SQLite's implicit rowid to order by.
 */
export async function listPendingWelcome(chatId: string): Promise<MemberRef[]> {
  const db = await getDb();
  const { rows } = await db.query<{ open_id: string; name: string }>(
    'SELECT open_id, name FROM pending_welcome WHERE chat_id = $1 ORDER BY queued_at ASC', [chatId],
  );
  return rows.map((r) => ({ openId: String(r.open_id), name: String(r.name ?? '') }));
}

/** Drop every queued member for a chat (called after a digest sends, whether or not anyone was welcomed). */
export async function clearPendingWelcome(chatId: string): Promise<void> {
  if (!chatId) return;
  const db = await getDb();
  await db.query('DELETE FROM pending_welcome WHERE chat_id = $1', [chatId]);
}
