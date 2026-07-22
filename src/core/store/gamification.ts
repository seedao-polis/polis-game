import { getDb, tx, getLpDb, lpTx, shouldDivertSoulWrites, type SqlExecutor } from '../db.js';
import { enqueueOutboxWrite } from '../pg-outbox.js';
import { localDate } from '../time.js';
import { applyNameOverride, loadSelfServiceOverrides } from '../name-overrides.js';

const FIRST_CONTACT_PT = 120;

const DAILY_CHECKIN_PT = 3;

// Resolve an open_id to its canonical LP identity (set up via `agent link`), so a person's points and
// badges follow them across agents even though each Feishu app assigns them a different open_id. Returns
// the input unchanged when it has no alias. Reads the link table from the shared LP database.
async function cid(openId: string): Promise<string> {
  if (!openId) return openId;
  try {
    const db = await getLpDb();
    const { rows } = await db.query<{ canonical_id?: string }>(
      'SELECT canonical_id FROM identity_links WHERE open_id = $1', [openId],
    );
    return rows[0]?.canonical_id || openId;
  } catch {
    return openId;
  }
}

/** Public resolver: the canonical LP identity for an open_id (its alias target via `agent link`, or itself). */
export async function canonicalId(openId: string): Promise<string> {
  return cid(openId);
}

export async function getProfile(
  openId: string
): Promise<{ openId: string; name: string; ptBalance: number; level: number; firstSeen: number; lastSeen: number } | null> {
  const db = await getLpDb();
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM profiles WHERE open_id = $1', [await cid(openId)]);
  const row = rows[0];
  if (!row) return null;
  return {
    openId: row['open_id'] as string,
    // Apply the preferred-name display override (raw captured name stays in the DB).
    name: await applyNameOverride(row['open_id'] as string, (row['name'] as string) ?? ''),
    ptBalance: (row['pt_balance'] as number) ?? 0,
    level: (row['level'] as number) ?? 1,
    firstSeen: (row['first_seen'] as number) ?? 0,
    lastSeen: (row['last_seen'] as number) ?? 0,
  };
}

/**
 * Upsert a user profile without an enclosing transaction.
 * Preserves the existing name when the supplied name is empty.
 */
export async function upsertProfileRaw(openId: string, name?: string): Promise<void> {
  const db = await getLpDb();
  await db.query(`
    INSERT INTO profiles(open_id, name) VALUES ($1, $2)
    ON CONFLICT(open_id) DO UPDATE SET
      name      = CASE WHEN excluded.name <> '' THEN excluded.name ELSE profiles.name END,
      last_seen = unixepoch()
  `, [await cid(openId), name ?? '']);
}

/**
 * Append one row to the activities log without an enclosing transaction.
 * Payload objects are serialised to JSON; null is stored as SQL NULL.
 * Lives in the per-soul database (getDb) — PostgreSQL-backed for tudigong, SQLite for every other soul.
 */
export async function recordActivityRaw(
  type: string,
  actorOpenId: string | null,
  chatId: string | null,
  refMessageId: string | null,
  payload?: object | null,
): Promise<void> {
  const db = await getDb();
  await db.query(`
    INSERT INTO activities(type, actor_open_id, chat_id, ref_message_id, payload)
    VALUES ($1, $2, $3, $4, $5)
  `, [type, actorOpenId ?? null, chatId ?? null, refMessageId ?? null, payload != null ? JSON.stringify(payload) : null]);
}

export async function recordActivity(
  type: string,
  actorOpenId: string | null,
  chatId: string | null,
  refMessageId: string | null,
  payload?: object | null,
): Promise<void> {
  // Append-only telemetry: while the soul PG pool's circuit breaker is open, divert straight to the
  // local outbox instead of attempting (and blocking on) a real transaction — see pg-outbox.ts.
  if (shouldDivertSoulWrites()) {
    await enqueueOutboxWrite('activities', ['type', 'actor_open_id', 'chat_id', 'ref_message_id', 'payload'], [
      type, actorOpenId ?? null, chatId ?? null, refMessageId ?? null, payload != null ? JSON.stringify(payload) : null,
    ]);
    return;
  }
  await tx(() => recordActivityRaw(type, actorOpenId, chatId, refMessageId, payload));
}

/**
 * Append one LP ledger entry and apply its delta to the balance, without an enclosing transaction
 * or a read-back. Shared by every LP mutation (grant/check-in/floor-reset/first-contact — but NOT
 * spendPt, which needs the atomic guarded UPDATE below instead) so the ledger-and-balance pair stays
 * consistent in one place. Takes an already-resolved executor (the caller already awaited getLpDb()
 * before entering the transaction).
 */
async function ledgerRaw(
  db: SqlExecutor,
  openId: string,
  delta: number,
  reason: string,
  refMessageId?: string | null,
): Promise<void> {
  await db.query(`
    INSERT INTO pt_ledger(user_open_id, delta, reason, ref_message_id)
    VALUES ($1, $2, $3, $4)
  `, [openId, delta, reason, refMessageId ?? null]);
  await db.query('UPDATE profiles SET pt_balance = pt_balance + $1 WHERE open_id = $2', [delta, openId]);
}

async function balanceRaw(db: SqlExecutor, openId: string): Promise<number> {
  const { rows } = await db.query<{ pt_balance: number }>('SELECT pt_balance FROM profiles WHERE open_id = $1', [openId]);
  return rows[0]?.pt_balance ?? 0;
}

/**
 * Credit or debit LP points for a user.
 * Ensures the profile row exists, appends a ledger entry, and updates the balance atomically.
 * Returns the new balance.
 */
export async function grantPt(openId: string, delta: number, reason: string, refMessageId?: string): Promise<number> {
  const id = await cid(openId);
  return lpTx(async () => {
    const db = await getLpDb();
    await upsertProfileRaw(id);
    await ledgerRaw(db, id, delta, reason, refMessageId);
    return balanceRaw(db, id);
  });
}

/**
 * Whether an LP ledger entry already exists for a given (reason, ref_message_id) pair. Used as an
 * idempotency gate so a one-off reward keyed to a specific message (e.g. 收录自介 → +60 LP for that
 * self-intro) is granted at most once, no matter how many times the trigger is repeated.
 */
export async function hasPtGrantForRef(reason: string, refMessageId: string): Promise<boolean> {
  if (!reason || !refMessageId) return false;
  const db = await getLpDb();
  const { rows } = await db.query(
    'SELECT 1 FROM pt_ledger WHERE reason = $1 AND ref_message_id = $2 LIMIT 1', [reason, refMessageId],
  );
  return rows.length > 0;
}

/**
 * Every LP ledger entry booked under a given (reason, ref_message_id) pair, oldest first.
 * Lets a already-completed grant be re-read as the source of truth instead of being recomputed —
 * e.g. re-rendering a settled post shows the amounts that were actually credited, so a later change
 * to the payout formula can never make an old post disagree with its own ledger.
 */
export async function ptGrantsForRef(
  reason: string,
  refMessageId: string,
): Promise<Array<{ openId: string; delta: number }>> {
  if (!reason || !refMessageId) return [];
  const db = await getLpDb();
  const { rows } = await db.query<{ user_open_id: string; delta: number }>(
    'SELECT user_open_id, delta FROM pt_ledger WHERE reason = $1 AND ref_message_id = $2 ORDER BY id',
    [reason, refMessageId],
  );
  return rows.map((r) => ({ openId: String(r.user_open_id), delta: Number(r.delta) }));
}

/**
 * Net LP change for a user across every pt_ledger row tagged with a given ref_message_id — i.e.
 * everything that happened during one interaction turn, whoever booked it (the framework's own
 * cost/grant/refund, or an LLM-driven pt_grant MCP call). Backs the reply footer's "this turn's
 * net change", replacing the framework's own two-entry running total so anything the model does
 * mid-turn via pt_grant is reflected too.
 *
 * The first-contact welcome grant is deliberately excluded: it shares this turn's ref_message_id
 * (recordInteraction seeds it with the triggering message id) but is a one-off welcome gift, not
 * something this turn earned — folding it in would turn a newcomer's first footer into
 * "0.0 → 119.9 (+119.9)" instead of the intended "120.0 → 119.9 (-0.1)".
 */
export async function netPtChangeForRef(refMessageId: string, openId: string): Promise<number> {
  if (!refMessageId || !openId) return 0;
  const db = await getLpDb();
  const { rows } = await db.query<{ net: number }>(
    `SELECT COALESCE(SUM(delta), 0) AS net FROM pt_ledger
     WHERE ref_message_id = $1 AND user_open_id = $2 AND reason != 'first_contact'`,
    [refMessageId, await cid(openId)],
  );
  return Number(rows[0]?.net ?? 0);
}

/** A user's most recent LP ledger entries (newest first) — backs the "recent changes" query. */
export async function recentPtLedger(
  openId: string,
  limit = 3,
): Promise<Array<{ delta: number; reason: string; createdAt: number }>> {
  if (!openId) return [];
  const db = await getLpDb();
  // Tie-break on id DESC (not SQLite's implicit rowid, which PostgreSQL has no equivalent of — id is
  // the real auto-increment primary key and orders identically).
  const { rows } = await db.query<{ delta: number; reason: string; created_at: number }>(
    'SELECT delta, reason, created_at FROM pt_ledger WHERE user_open_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [await cid(openId), Math.max(1, limit)],
  );
  return rows.map((r) => ({
    delta: Number(r.delta),
    reason: String(r.reason ?? ''),
    createdAt: Number(r.created_at),
  }));
}

/**
 * Award a badge to a user.
 * Returns true when newly granted; false when the user already holds the badge.
 */
export async function awardBadge(openId: string, badgeId: string, ref?: string): Promise<boolean> {
  const id = await cid(openId);
  return lpTx(async () => {
    const db = await getLpDb();
    await upsertProfileRaw(id);
    const { rowCount } = await db.query(
      `INSERT INTO user_badges(user_open_id, badge_id, ref) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [id, badgeId, ref ?? null],
    );
    return rowCount > 0;
  });
}

export async function upsertBadge(b: {
  badgeId: string;
  name: string;
  description?: string;
  emoji?: string;
  headline?: string;
  file?: string;
  title?: string;
  type?: string;
  role?: string;
  endorser?: string;
  duration?: string;
  category?: string;
  event?: string;
}): Promise<void> {
  const db = await getLpDb();
  await db.query(`
    INSERT INTO badges(badge_id, name, description, emoji, headline, file, title, type, role, endorser, duration, category, event)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT(badge_id) DO UPDATE SET
      name        = excluded.name,
      description = excluded.description,
      emoji       = excluded.emoji,
      headline    = excluded.headline,
      file        = excluded.file,
      title       = excluded.title,
      type        = excluded.type,
      role        = excluded.role,
      endorser    = excluded.endorser,
      duration    = excluded.duration,
      category    = excluded.category,
      event       = excluded.event
  `, [
    b.badgeId,
    b.name,
    b.description ?? '',
    b.emoji ?? '',
    b.headline ?? '',
    b.file ?? '',
    b.title ?? '',
    b.type ?? '',
    b.role ?? '',
    b.endorser ?? '',
    b.duration ?? '',
    b.category ?? '',
    b.event ?? '',
  ]);
}

/**
 * List badges.
 * With openId: returns that user's earned badges (joined from user_badges).
 * Without: returns the full badge catalogue.
 */
export async function listBadges(
  openId?: string
): Promise<Array<{ badgeId: string; name: string; description: string; emoji: string; headline: string; type: string; file: string; awardedAt?: number }>> {
  const db = await getLpDb();
  if (openId) {
    const { rows } = await db.query<Record<string, unknown>>(`
      SELECT b.badge_id, b.name, b.description, b.emoji, b.headline, b.type, b.file, ub.awarded_at
      FROM user_badges ub
      JOIN badges b ON b.badge_id = ub.badge_id
      WHERE ub.user_open_id = $1
      ORDER BY ub.awarded_at DESC
    `, [await cid(openId)]);
    return rows.map((r) => ({
      badgeId: r['badge_id'] as string,
      name: r['name'] as string,
      description: (r['description'] as string) ?? '',
      emoji: (r['emoji'] as string) ?? '',
      headline: (r['headline'] as string) ?? '',
      type: (r['type'] as string) ?? '',
      file: (r['file'] as string) ?? '',
      awardedAt: r['awarded_at'] as number,
    }));
  }
  const { rows } = await db.query<Record<string, unknown>>('SELECT badge_id, name, description, emoji, headline, type, file FROM badges ORDER BY created_at');
  return rows.map((r) => ({
    badgeId: r['badge_id'] as string,
    name: r['name'] as string,
    description: (r['description'] as string) ?? '',
    emoji: (r['emoji'] as string) ?? '',
    headline: (r['headline'] as string) ?? '',
    type: (r['type'] as string) ?? '',
    file: (r['file'] as string) ?? '',
  }));
}

/**
 * Reverse-lookup open_ids by display name from the chat_members directory.
 * Exact match first; if no results, retries with trimmed input.
 * Returns distinct open_ids ordered by most-recently-seen, with the matched name.
 * Lives in the per-soul database (getDb) — PostgreSQL-backed for tudigong, SQLite for every other soul.
 */
export async function findOpenIdsByName(name: string): Promise<Array<{ openId: string; name: string }>> {
  const db = await getDb();
  const query = `
    SELECT DISTINCT open_id, name FROM chat_members
    WHERE name = $1 AND present = 1
    ORDER BY last_seen DESC
  `;
  let { rows } = await db.query<{ open_id: string; name: string }>(query, [name]);
  if (rows.length === 0) {
    const trimmed = name.trim();
    if (trimmed !== name) {
      rows = (await db.query<{ open_id: string; name: string }>(query, [trimmed])).rows;
    }
  }
  return rows.map((r) => ({ openId: r.open_id, name: r.name }));
}

/** Full badge definition row (all v17 fields). Shared by getBadge / listBadgeDefinitions. */
export interface BadgeDefinition {
  badgeId: string; name: string; description: string; emoji: string;
  headline: string; file: string; title: string; type: string; role: string;
  endorser: string; duration: string; category: string; event: string;
}

/** Map a raw badges row to a BadgeDefinition, coalescing every optional column to ''. */
function rowToBadgeDefinition(row: Record<string, unknown>): BadgeDefinition {
  return {
    badgeId: row['badge_id'] as string,
    name: row['name'] as string,
    description: (row['description'] as string) ?? '',
    emoji: (row['emoji'] as string) ?? '',
    headline: (row['headline'] as string) ?? '',
    file: (row['file'] as string) ?? '',
    title: (row['title'] as string) ?? '',
    type: (row['type'] as string) ?? '',
    role: (row['role'] as string) ?? '',
    endorser: (row['endorser'] as string) ?? '',
    duration: (row['duration'] as string) ?? '',
    category: (row['category'] as string) ?? '',
    event: (row['event'] as string) ?? '',
  };
}

/**
 * The full badge catalogue with every v17 field, ordered by creation time. Unlike {@link listBadges}
 * (which projects only the columns the profile view needs), this returns complete definitions so the
 * wiki renderer can show type / duration / description without a second query.
 */
export async function listBadgeDefinitions(): Promise<BadgeDefinition[]> {
  const db = await getLpDb();
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT badge_id, name, description, emoji, headline, file, title, type, role, endorser, duration, category, event FROM badges ORDER BY created_at',
  );
  return rows.map(rowToBadgeDefinition);
}

/**
 * Delete a badge definition by badge_id or name, together with every holding of it in user_badges
 * (the FK would otherwise block the delete). Deleting a badge is a catalogue-level operation — the
 * grants disappear with it. Returns true when a definition was removed, false when the ref matched
 * nothing. Runs in a single transaction so the badge and its holdings are removed atomically.
 */
export async function deleteBadge(ref: string): Promise<boolean> {
  return lpTx(async () => {
    const db = await getLpDb();
    const { rows } = await db.query<{ badge_id?: string }>('SELECT badge_id FROM badges WHERE badge_id = $1 OR name = $2 LIMIT 1', [ref, ref]);
    const row = rows[0];
    if (!row?.badge_id) return false;
    await db.query('DELETE FROM user_badges WHERE badge_id = $1', [row.badge_id]);
    await db.query('DELETE FROM badges WHERE badge_id = $1', [row.badge_id]);
    return true;
  });
}

/**
 * Retrieve a badge definition by badge_id or name (badge_name). Returns the full row including
 * all v17 fields, or undefined if no match is found.
 */
export async function getBadge(ref: string): Promise<BadgeDefinition | undefined> {
  const db = await getLpDb();
  const { rows } = await db.query<Record<string, unknown>>(`
    SELECT badge_id, name, description, emoji, headline, file, title, type, role, endorser, duration, category, event
    FROM badges WHERE badge_id = $1 OR name = $2 LIMIT 1
  `, [ref, ref]);
  return rows[0] ? rowToBadgeDefinition(rows[0]) : undefined;
}

export async function leaderboard(limit = 10): Promise<Array<{ openId: string; name: string; ptBalance: number }>> {
  const db = await getLpDb();
  // Exclude treasure-chest virtual accounts (chests.chest_id): they are LP storage, not participants,
  // and would otherwise crowd out real members once a chest accumulates a large balance.
  const { rows } = await db.query<Record<string, unknown>>(`
    SELECT open_id, name, pt_balance FROM profiles
    WHERE open_id NOT IN (SELECT chest_id FROM chests)
    ORDER BY pt_balance DESC
    LIMIT $1
  `, [limit]);
  // Batch-preload every self-service name override once (limit caps at 100 — see mcp-server.ts's zod
  // schema), instead of resolving each row's display name with its own query: over a network-backed
  // PostgreSQL connection that would turn one query into up to 100 extra round-trips per leaderboard
  // call. applyNameOverride still checks the (synchronous, in-memory) operator config first and only
  // consults this preloaded map for the self-service layer, so precedence matches every other surface.
  const overrides = await loadSelfServiceOverrides(db);
  return Promise.all(rows.map(async (r) => ({
    openId: r['open_id'] as string,
    name: await applyNameOverride(r['open_id'] as string, (r['name'] as string) ?? '', overrides),
    ptBalance: (r['pt_balance'] as number) ?? 0,
  })));
}

/**
 * Persist a member's self-chosen display name (the "@我 改名 <名字>" command). Written to the shared
 * name_overrides table keyed by open_id — under BOTH the raw open_id and its canonical LP identity — so
 * that both the roster path (memberName, keyed by the raw open_id) and the LP path (getProfile /
 * leaderboard, keyed by the canonical id) resolve it. The name is applied at render time on top of the
 * raw captured Feishu name, which the 5-minute roster sync keeps overwriting; the override is what makes
 * the rename stick. Empty / whitespace-only names are ignored. Returns the trimmed name that was stored.
 */
export async function setPreferredName(openId: string, name: string): Promise<string> {
  const clean = (name ?? '').trim();
  if (!openId || !clean) return '';
  const canonical = await cid(openId);
  const ids = canonical === openId ? [openId] : [openId, canonical];
  await lpTx(async () => {
    const db = await getLpDb();
    for (const id of ids) {
      await db.query(`
        INSERT INTO name_overrides(open_id, name, updated_at) VALUES ($1, $2, unixepoch())
        ON CONFLICT(open_id) DO UPDATE SET name = excluded.name, updated_at = unixepoch()
      `, [id, clean]);
    }
  });
  return clean;
}

/**
 * Deduct LP from a user's balance for a paid action.
 * Ensures the profile exists first; returns false without writing any data when the balance is
 * insufficient. The balance check and the debit are ONE atomic guarded UPDATE (WHERE pt_balance >=
 * cost ... RETURNING), not a separate read-then-write — under PostgreSQL's MVCC, two concurrent
 * spendPt calls against the same profile no longer serialize for free the way SQLite's single-file
 * lock used to, so a plain "read balance, then decide, then write" would let both readers see the
 * pre-spend balance and both succeed, overspending the account. This is the one function in the LP
 * layer whose logic changed (not just its SQL dialect) for the PostgreSQL migration.
 */
export async function spendPt(openId: string, cost: number, reason: string, refMessageId?: string): Promise<boolean> {
  const id = await cid(openId);
  return lpTx(async () => {
    const db = await getLpDb();
    await ensureProfileRaw(id);
    const { rowCount } = await db.query(
      `UPDATE profiles SET pt_balance = pt_balance - $1 WHERE open_id = $2 AND pt_balance >= $1 RETURNING pt_balance`,
      [cost, id],
    );
    if (rowCount === 0) return false; // insufficient balance (or concurrently spent below cost)
    await db.query(
      `INSERT INTO pt_ledger(user_open_id, delta, reason, ref_message_id) VALUES ($1, $2, $3, $4)`,
      [id, -cost, reason, refMessageId ?? null],
    );
    return true;
  });
}

/**
 * Bring all users whose LP balance is below the daily floor up to that floor.
 * Writes one ledger credit per affected user and returns the count of users updated.
 */
export async function resetDailyPtFloor(floor = 10): Promise<{ affected: number }> {
  return lpTx(async () => {
    const db = await getLpDb();
    // Exclude treasure-chest virtual accounts — the daily floor top-up is a member benefit, not
    // something a chest (which may legitimately sit at/near 0 between deposits) should receive.
    const { rows } = await db.query<{ open_id: string; pt_balance: number }>(`
      SELECT open_id, pt_balance FROM profiles
      WHERE pt_balance < $1 AND open_id NOT IN (SELECT chest_id FROM chests)
    `, [floor]);
    for (const r of rows) {
      // delta brings the balance up to the floor; ledgerRaw applies it (balance + delta == floor).
      await ledgerRaw(db, r.open_id, floor - r.pt_balance, 'daily_floor_reset');
    }
    return { affected: rows.length };
  });
}

/**
 * Set every user's LP balance to an exact target value (default: the first-contact grant).
 * Unlike the daily floor reset, this both lifts and lowers balances so the whole community lands
 * on the same number. Writes one ledger entry per user whose balance actually changes (delta != 0)
 * so the ledger stays the source of truth; never writes a raw UPDATE outside the ledger path.
 * Returns the target applied and the count of users whose balance moved.
 */
export async function resetAllPtTo(target = FIRST_CONTACT_PT, reason = 'manual_reset'): Promise<{ affected: number; target: number }> {
  return lpTx(async () => {
    const db = await getLpDb();
    // Exclude treasure-chest virtual accounts — a blanket community reset must never wipe out chest
    // funds (e.g. the 公益宝箱's accumulated balance) by forcing them to the same target as members.
    const { rows } = await db.query<{ open_id: string; pt_balance: number }>(`
      SELECT open_id, pt_balance FROM profiles
      WHERE open_id NOT IN (SELECT chest_id FROM chests)
    `);
    let affected = 0;
    for (const r of rows) {
      const delta = target - r.pt_balance;
      if (delta === 0) continue; // already at target; no ledger entry needed
      await ledgerRaw(db, r.open_id, delta, reason);
      affected++;
    }
    return { affected, target };
  });
}

/**
 * Grant LP to a user as a task completion reward.
 * Delegates to grantPt with a task-prefixed reason tag; returns the new balance.
 * Reserved as an interface for the task system.
 */
export async function rewardTask(openId: string, taskId: string, amount: number): Promise<number> {
  return grantPt(openId, amount, `task:${taskId}`);
}

/**
 * Build a short LP status footer for appending to agent replies.
 * Accepts an optional classification label (e.g. "访谈中", "画重点") to display alongside the
 * balance. Three output forms depending on delta and label:
 *   delta=0, no label  → "🌱 LP : 120.0"            (check-in no-op, no arrow, no parens)
 *   delta=0, label     → "🌱 LP : 120.0 (访谈中)"    (net-zero interview, no arrow)
 *   delta≠0            → "🌱 LP : 120.0 → 119.9 (-0.1)" or "… (画重点, +0.3)"
 * Returns a pre-formatted two-line string (leading blank line included) ready for direct
 * concatenation; a missing profile is initialized first so the balance is always real.
 */
export async function buildStatusFooter(openId: string, delta: number, label?: string): Promise<string> {
  const profile = (await getProfile(openId)) ?? (await ensureProfile(openId));
  const after = profile.ptBalance;
  const tag = profile.name ? `[${profile.name}] ` : ''; // prefix only when name is set
  const fmt = (n: number) => n.toFixed(1); // LP is fractional; always show one decimal place

  const parts: string[] = [];
  if (label) parts.push(label);
  if (delta !== 0) parts.push(`${delta >= 0 ? '+' : ''}${fmt(delta)}`);

  if (parts.length === 0) {
    // delta=0 and no label: balance only (e.g. repeated check-in)
    return `\n\n${tag}🌱 LP : ${fmt(after)}`;
  }
  if (delta === 0) {
    // delta=0 but label present (e.g. 访谈中): no arrow, just balance + label
    return `\n\n${tag}🌱 LP : ${fmt(after)} (${parts.join(', ')})`;
  }
  // delta≠0: show before → after with label and/or numeric delta in parens
  const before = after - delta;
  return `\n\n${tag}🌱 LP : ${fmt(before)} → ${fmt(after)} (${parts.join(', ')})`;
}

/**
 * Strip any LP/AP status footer the model echoed into its own reply, so the framework-appended footer
 * is the only one. Matches whole lines like "[name] 🌱 LP : 120.0 → 119.9 (-0.1)" (also the legacy
 * "🍎 AP" form, since older replies in the conversation context still carry it). Collapses the blank
 * lines left behind and trims trailing whitespace.
 */
export function stripStatusFooter(text: string): string {
  return text
    .replace(/^[ \t]*(?:\[[^\]\n]*\][ \t]*)?(?:🌱[ \t]*LP|🍎[ \t]*AP)[ \t]*[:：][^\n]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
}

/**
 * Split a reply into its body and the single trailing status footer this framework appended (if any),
 * so the two can be logged on separate lines (the body is the model's actual answer). Anchored at the
 * end of the string, so it is robust to whatever whitespace the body contains. Returns footer:'' when
 * there is no trailing footer (gating / error replies, or no-charge paths).
 */
export function splitStatusFooter(text: string): { body: string; footer: string } {
  const m = text.match(/\n*[ \t]*(?:\[[^\]\n]*\][ \t]*)?(?:🌱[ \t]*LP|🍎[ \t]*AP)[ \t]*[:：][^\n]*$/);
  if (!m || m.index === undefined) return { body: text, footer: '' };
  return { body: text.slice(0, m.index).replace(/\s+$/, ''), footer: m[0].trim() };
}

/**
 * Daily check-in for a user, keyed by the local calendar date and unique per day.
 * The first check-in of the day awards LP (recorded in the ledger); later attempts on the same day
 * leave the balance unchanged. Ensures the profile exists first. Returns whether this was the first
 * check-in today, the LP awarded, the date key, and the resulting balance.
 */
export async function checkIn(openId: string): Promise<{ firstToday: boolean; awarded: number; date: string; balance: number }> {
  const date = localDate(new Date());
  const id = await cid(openId);
  return lpTx(async () => {
    const db = await getLpDb();
    await ensureProfileRaw(id);
    const { rowCount } = await db.query(
      'INSERT INTO checkins(user_open_id, checkin_date, pt_awarded) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [id, date, DAILY_CHECKIN_PT],
    );
    const firstToday = rowCount > 0;
    if (firstToday) await ledgerRaw(db, id, DAILY_CHECKIN_PT, 'daily_checkin');
    return { firstToday, awarded: firstToday ? DAILY_CHECKIN_PT : 0, date, balance: await balanceRaw(db, id) };
  });
}

/**
 * Ensure a profile row exists without an enclosing transaction. A brand-new profile is seeded with
 * the first-contact LP grant (recorded in the ledger) and the first-contact badge; an existing
 * profile keeps its balance and only has its display name refreshed when a non-empty one is given.
 * Returns true when the profile was created by this call.
 */
async function ensureProfileRaw(openId: string, name?: string, refMessageId?: string): Promise<boolean> {
  const db = await getLpDb();
  const id = await cid(openId);
  const isNew = (await getProfile(id)) === null;
  await upsertProfileRaw(id, name);
  if (isNew) {
    await ledgerRaw(db, id, FIRST_CONTACT_PT, 'first_contact', refMessageId);
    await db.query('INSERT INTO user_badges(user_open_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, 'first_contact']);
  }
  return isNew;
}

/**
 * Ensure a profile exists, initializing a brand-new one with the first-contact grant and badge.
 * Returns the profile, which is never null.
 */
export async function ensureProfile(
  openId: string,
  name?: string,
): Promise<{ openId: string; name: string; ptBalance: number; firstSeen: number; lastSeen: number }> {
  return lpTx(async () => {
    await ensureProfileRaw(openId, name);
    return (await getProfile(openId))!;
  });
}

/**
 * Record a user interaction: ensure the profile exists (seeding a new one with the first-contact
 * grant and badge) and log the activity. All writes share a single transaction.
 * Returns { isNew:false, ptGranted:0 } immediately when openId is falsy.
 */
export async function recordInteraction(
  openId: string,
  name: string,
  chatId: string,
  messageId: string,
): Promise<{ isNew: boolean; ptGranted: number }> {
  if (!openId) return { isNew: false, ptGranted: 0 };
  // LP cluster (shared db) and the activity log (per-agent db) are different databases, so they can't
  // share one transaction; each gets its own. recordActivity is recordActivityRaw's own tx()-wrapping
  // public entry point (it also carries the Phase 2 outbox-diversion check), so this reuses it rather
  // than duplicating the wrapping here.
  const isNew = await lpTx(() => ensureProfileRaw(openId, name, messageId));
  await recordActivity('mention', openId, chatId, messageId);
  return { isNew, ptGranted: isNew ? FIRST_CONTACT_PT : 0 };
}

/**
 * Whether a user has a first-contact record — i.e. has ever interacted with the agent (which seeds
 * the profile + the 'first_contact' badge in {@link ensureProfile}). Used to gate event rewards on
 * "曾经 @ 过机器人". Returns false for members we only ever saw lurking in group captures.
 */
export async function hasFirstContact(openId: string): Promise<boolean> {
  if (!openId) return false;
  try {
    const db = await getLpDb();
    const { rows } = await db.query(
      "SELECT 1 FROM user_badges WHERE user_open_id = $1 AND badge_id = 'first_contact' LIMIT 1", [await cid(openId)],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether a user holds a given badge. General-purpose role-permission check (badges double as roles,
 * e.g. 'predict_judge' gates who may announce a community-prediction result), unlike hasFirstContact
 * which is hardcoded to one badge id.
 */
export async function hasBadge(openId: string, badgeId: string): Promise<boolean> {
  if (!openId || !badgeId) return false;
  try {
    const db = await getLpDb();
    const { rows } = await db.query('SELECT 1 FROM user_badges WHERE user_open_id = $1 AND badge_id = $2 LIMIT 1', [await cid(openId), badgeId]);
    return rows.length > 0;
  } catch {
    return false;
  }
}

