import { getDb, tx, getLpDb, lpTx } from '../db.js';
import { localDate } from '../time.js';
import { applyNameOverride } from '../name-overrides.js';

const FIRST_CONTACT_PT = 120;

const DAILY_CHECKIN_PT = 3;

// Resolve an open_id to its canonical LP identity (set up via `agent link`), so a person's points and
// badges follow them across agents even though each Feishu app assigns them a different open_id. Returns
// the input unchanged when it has no alias. Reads the link table from the shared LP database.
function cid(openId: string): string {
  if (!openId) return openId;
  try {
    const row = getLpDb()
      .prepare('SELECT canonical_id FROM identity_links WHERE open_id = ?')
      .get(openId) as { canonical_id?: string } | undefined;
    return row?.canonical_id || openId;
  } catch {
    return openId;
  }
}

/** Public resolver: the canonical LP identity for an open_id (its alias target via `agent link`, or itself). */
export function canonicalId(openId: string): string {
  return cid(openId);
}

export function getProfile(
  openId: string
): { openId: string; name: string; ptBalance: number; level: number; firstSeen: number; lastSeen: number } | null {
  const db = getLpDb();
  const row = db.prepare('SELECT * FROM profiles WHERE open_id = ?').get(cid(openId)) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    openId: row['open_id'] as string,
    // Apply the preferred-name display override (raw captured name stays in the DB).
    name: applyNameOverride(row['open_id'] as string, (row['name'] as string) ?? ''),
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
export function upsertProfileRaw(openId: string, name?: string): void {
  const db = getLpDb();
  db.prepare(`
    INSERT INTO profiles(open_id, name) VALUES (?, ?)
    ON CONFLICT(open_id) DO UPDATE SET
      name      = CASE WHEN excluded.name <> '' THEN excluded.name ELSE profiles.name END,
      last_seen = unixepoch()
  `).run(cid(openId), name ?? '');
}

/**
 * Append one row to the activities log without an enclosing transaction.
 * Payload objects are serialised to JSON; null is stored as SQL NULL.
 */
export function recordActivityRaw(
  type: string,
  actorOpenId: string | null,
  chatId: string | null,
  refMessageId: string | null,
  payload?: object | null,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO activities(type, actor_open_id, chat_id, ref_message_id, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(type, actorOpenId ?? null, chatId ?? null, refMessageId ?? null, payload != null ? JSON.stringify(payload) : null);
}

export function recordActivity(
  type: string,
  actorOpenId: string | null,
  chatId: string | null,
  refMessageId: string | null,
  payload?: object | null,
): void {
  tx(() => recordActivityRaw(type, actorOpenId, chatId, refMessageId, payload));
}

/**
 * Append one LP ledger entry and apply its delta to the balance, without an enclosing transaction
 * or a read-back. Shared by every LP mutation (grant/spend/check-in/floor-reset/first-contact) so
 * the ledger-and-balance pair stays consistent in one place.
 */
function ledgerRaw(
  db: ReturnType<typeof getDb>,
  openId: string,
  delta: number,
  reason: string,
  refMessageId?: string | null,
): void {
  db.prepare(`
    INSERT INTO pt_ledger(user_open_id, delta, reason, ref_message_id)
    VALUES (?, ?, ?, ?)
  `).run(openId, delta, reason, refMessageId ?? null);
  db.prepare('UPDATE profiles SET pt_balance = pt_balance + ? WHERE open_id = ?').run(delta, openId);
}

function balanceRaw(db: ReturnType<typeof getDb>, openId: string): number {
  const row = db.prepare('SELECT pt_balance FROM profiles WHERE open_id = ?').get(openId) as
    | { pt_balance: number }
    | undefined;
  return row?.pt_balance ?? 0;
}

/**
 * Credit or debit LP points for a user.
 * Ensures the profile row exists, appends a ledger entry, and updates the balance atomically.
 * Returns the new balance.
 */
export function grantPt(openId: string, delta: number, reason: string, refMessageId?: string): number {
  const id = cid(openId);
  return lpTx(() => {
    const db = getLpDb();
    upsertProfileRaw(id);
    ledgerRaw(db, id, delta, reason, refMessageId);
    return balanceRaw(db, id);
  });
}

/**
 * Whether an LP ledger entry already exists for a given (reason, ref_message_id) pair. Used as an
 * idempotency gate so a one-off reward keyed to a specific message (e.g. 收录自介 → +60 LP for that
 * self-intro) is granted at most once, no matter how many times the trigger is repeated.
 */
export function hasPtGrantForRef(reason: string, refMessageId: string): boolean {
  if (!reason || !refMessageId) return false;
  const row = getLpDb()
    .prepare('SELECT 1 FROM pt_ledger WHERE reason = ? AND ref_message_id = ? LIMIT 1')
    .get(reason, refMessageId);
  return row != null;
}

/**
 * Every LP ledger entry booked under a given (reason, ref_message_id) pair, oldest first.
 * Lets a already-completed grant be re-read as the source of truth instead of being recomputed —
 * e.g. re-rendering a settled post shows the amounts that were actually credited, so a later change
 * to the payout formula can never make an old post disagree with its own ledger.
 */
export function ptGrantsForRef(
  reason: string,
  refMessageId: string,
): Array<{ openId: string; delta: number }> {
  if (!reason || !refMessageId) return [];
  const rows = getLpDb()
    .prepare(
      'SELECT user_open_id, delta FROM pt_ledger WHERE reason = ? AND ref_message_id = ? ORDER BY id',
    )
    .all(reason, refMessageId) as Array<{ user_open_id: string; delta: number }>;
  return rows.map((r) => ({ openId: String(r.user_open_id), delta: Number(r.delta) }));
}

/** A user's most recent LP ledger entries (newest first) — backs the "recent changes" query. */
export function recentPtLedger(
  openId: string,
  limit = 3,
): Array<{ delta: number; reason: string; createdAt: number }> {
  if (!openId) return [];
  const rows = getLpDb()
    .prepare(
      'SELECT delta, reason, created_at FROM pt_ledger WHERE user_open_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    )
    .all(cid(openId), Math.max(1, limit)) as Array<{ delta: number; reason: string; created_at: number }>;
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
export function awardBadge(openId: string, badgeId: string, ref?: string): boolean {
  const id = cid(openId);
  return lpTx(() => {
    const db = getLpDb();
    upsertProfileRaw(id);
    const result = db.prepare(`
      INSERT OR IGNORE INTO user_badges(user_open_id, badge_id, ref) VALUES (?, ?, ?)
    `).run(id, badgeId, ref ?? null);
    return (result.changes as number) > 0;
  });
}

export function upsertBadge(b: {
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
}): void {
  const db = getLpDb();
  db.prepare(`
    INSERT INTO badges(badge_id, name, description, emoji, headline, file, title, type, role, endorser, duration, category, event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  `).run(
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
  );
}

/**
 * List badges.
 * With openId: returns that user's earned badges (joined from user_badges).
 * Without: returns the full badge catalogue.
 */
export function listBadges(
  openId?: string
): Array<{ badgeId: string; name: string; description: string; emoji: string; headline: string; type: string; file: string; awardedAt?: number }> {
  const db = getLpDb();
  if (openId) {
    const rows = db.prepare(`
      SELECT b.badge_id, b.name, b.description, b.emoji, b.headline, b.type, b.file, ub.awarded_at
      FROM user_badges ub
      JOIN badges b ON b.badge_id = ub.badge_id
      WHERE ub.user_open_id = ?
      ORDER BY ub.awarded_at DESC
    `).all(cid(openId)) as Record<string, unknown>[];
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
  const rows = db.prepare('SELECT badge_id, name, description, emoji, headline, type, file FROM badges ORDER BY created_at').all() as Record<string, unknown>[];
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
 */
export function findOpenIdsByName(name: string): Array<{ openId: string; name: string }> {
  const db = getDb();
  const query = `
    SELECT DISTINCT open_id, name FROM chat_members
    WHERE name = ? AND present = 1
    ORDER BY last_seen DESC
  `;
  let rows = db.prepare(query).all(name) as Array<{ open_id: string; name: string }>;
  if (rows.length === 0) {
    const trimmed = name.trim();
    if (trimmed !== name) {
      rows = db.prepare(query).all(trimmed) as Array<{ open_id: string; name: string }>;
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
export function listBadgeDefinitions(): BadgeDefinition[] {
  const rows = getLpDb()
    .prepare('SELECT badge_id, name, description, emoji, headline, file, title, type, role, endorser, duration, category, event FROM badges ORDER BY created_at')
    .all() as Record<string, unknown>[];
  return rows.map(rowToBadgeDefinition);
}

/**
 * Delete a badge definition by badge_id or name, together with every holding of it in user_badges
 * (the FK would otherwise block the delete). Deleting a badge is a catalogue-level operation — the
 * grants disappear with it. Returns true when a definition was removed, false when the ref matched
 * nothing. Runs in a single transaction so the badge and its holdings are removed atomically.
 */
export function deleteBadge(ref: string): boolean {
  return lpTx(() => {
    const db = getLpDb();
    const row = db.prepare('SELECT badge_id FROM badges WHERE badge_id = ? OR name = ? LIMIT 1').get(ref, ref) as { badge_id?: string } | undefined;
    if (!row?.badge_id) return false;
    db.prepare('DELETE FROM user_badges WHERE badge_id = ?').run(row.badge_id);
    db.prepare('DELETE FROM badges WHERE badge_id = ?').run(row.badge_id);
    return true;
  });
}

/**
 * Retrieve a badge definition by badge_id or name (badge_name). Returns the full row including
 * all v17 fields, or undefined if no match is found.
 */
export function getBadge(ref: string): BadgeDefinition | undefined {
  const db = getLpDb();
  const row = db.prepare(`
    SELECT badge_id, name, description, emoji, headline, file, title, type, role, endorser, duration, category, event
    FROM badges WHERE badge_id = ? OR name = ? LIMIT 1
  `).get(ref, ref) as Record<string, unknown> | undefined;
  return row ? rowToBadgeDefinition(row) : undefined;
}

export function leaderboard(limit = 10): Array<{ openId: string; name: string; ptBalance: number }> {
  const db = getLpDb();
  // Exclude treasure-chest virtual accounts (chests.chest_id): they are LP storage, not participants,
  // and would otherwise crowd out real members once a chest accumulates a large balance.
  const rows = db.prepare(`
    SELECT open_id, name, pt_balance FROM profiles
    WHERE open_id NOT IN (SELECT chest_id FROM chests)
    ORDER BY pt_balance DESC
    LIMIT ?
  `).all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    openId: r['open_id'] as string,
    // Apply the display-name override (operator config + self-service 改名) like every other surface.
    name: applyNameOverride(r['open_id'] as string, (r['name'] as string) ?? ''),
    ptBalance: (r['pt_balance'] as number) ?? 0,
  }));
}

/**
 * Persist a member's self-chosen display name (the "@我 改名 <名字>" command). Written to the shared
 * name_overrides table keyed by open_id — under BOTH the raw open_id and its canonical LP identity — so
 * that both the roster path (memberName, keyed by the raw open_id) and the LP path (getProfile /
 * leaderboard, keyed by the canonical id) resolve it. The name is applied at render time on top of the
 * raw captured Feishu name, which the 5-minute roster sync keeps overwriting; the override is what makes
 * the rename stick. Empty / whitespace-only names are ignored. Returns the trimmed name that was stored.
 */
export function setPreferredName(openId: string, name: string): string {
  const clean = (name ?? '').trim();
  if (!openId || !clean) return '';
  const canonical = cid(openId);
  const ids = canonical === openId ? [openId] : [openId, canonical];
  lpTx(() => {
    const db = getLpDb();
    const up = db.prepare(`
      INSERT INTO name_overrides(open_id, name, updated_at) VALUES (?, ?, unixepoch())
      ON CONFLICT(open_id) DO UPDATE SET name = excluded.name, updated_at = unixepoch()
    `);
    for (const id of ids) up.run(id, clean);
  });
  return clean;
}

/**
 * Deduct LP from a user's balance for a paid action.
 * Ensures the profile exists first; returns false without writing any data when the
 * balance is insufficient. On success writes one ledger debit and updates the balance.
 */
export function spendPt(openId: string, cost: number, reason: string, refMessageId?: string): boolean {
  const id = cid(openId);
  return lpTx(() => {
    const db = getLpDb();
    ensureProfileRaw(id);
    if (balanceRaw(db, id) < cost) return false;
    ledgerRaw(db, id, -cost, reason, refMessageId);
    return true;
  });
}

/**
 * Bring all users whose LP balance is below the daily floor up to that floor.
 * Writes one ledger credit per affected user and returns the count of users updated.
 */
export function resetDailyPtFloor(floor = 10): { affected: number } {
  return lpTx(() => {
    const db = getLpDb();
    // Exclude treasure-chest virtual accounts — the daily floor top-up is a member benefit, not
    // something a chest (which may legitimately sit at/near 0 between deposits) should receive.
    const rows = db.prepare(`
      SELECT open_id, pt_balance FROM profiles
      WHERE pt_balance < ? AND open_id NOT IN (SELECT chest_id FROM chests)
    `).all(floor) as Array<{ open_id: string; pt_balance: number }>;
    for (const r of rows) {
      // delta brings the balance up to the floor; ledgerRaw applies it (balance + delta == floor).
      ledgerRaw(db, r.open_id, floor - r.pt_balance, 'daily_floor_reset');
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
export function resetAllPtTo(target = FIRST_CONTACT_PT, reason = 'manual_reset'): { affected: number; target: number } {
  return lpTx(() => {
    const db = getLpDb();
    // Exclude treasure-chest virtual accounts — a blanket community reset must never wipe out chest
    // funds (e.g. the 公益宝箱's accumulated balance) by forcing them to the same target as members.
    const rows = db.prepare(`
      SELECT open_id, pt_balance FROM profiles
      WHERE open_id NOT IN (SELECT chest_id FROM chests)
    `).all() as Array<{ open_id: string; pt_balance: number }>;
    let affected = 0;
    for (const r of rows) {
      const delta = target - r.pt_balance;
      if (delta === 0) continue; // already at target; no ledger entry needed
      ledgerRaw(db, r.open_id, delta, reason);
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
export function rewardTask(openId: string, taskId: string, amount: number): number {
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
export function buildStatusFooter(openId: string, delta: number, label?: string): string {
  const profile = getProfile(openId) ?? ensureProfile(openId);
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
export function checkIn(openId: string): { firstToday: boolean; awarded: number; date: string; balance: number } {
  const date = localDate(new Date());
  const id = cid(openId);
  return lpTx(() => {
    const db = getLpDb();
    ensureProfileRaw(id);
    const res = db.prepare(
      'INSERT OR IGNORE INTO checkins(user_open_id, checkin_date, pt_awarded) VALUES (?, ?, ?)'
    ).run(id, date, DAILY_CHECKIN_PT);
    const firstToday = (res.changes as number) > 0;
    if (firstToday) ledgerRaw(db, id, DAILY_CHECKIN_PT, 'daily_checkin');
    return { firstToday, awarded: firstToday ? DAILY_CHECKIN_PT : 0, date, balance: balanceRaw(db, id) };
  });
}

/**
 * Ensure a profile row exists without an enclosing transaction. A brand-new profile is seeded with
 * the first-contact LP grant (recorded in the ledger) and the first-contact badge; an existing
 * profile keeps its balance and only has its display name refreshed when a non-empty one is given.
 * Returns true when the profile was created by this call.
 */
function ensureProfileRaw(openId: string, name?: string, refMessageId?: string): boolean {
  const db = getLpDb();
  const id = cid(openId);
  const isNew = getProfile(id) === null;
  upsertProfileRaw(id, name);
  if (isNew) {
    ledgerRaw(db, id, FIRST_CONTACT_PT, 'first_contact', refMessageId);
    db.prepare('INSERT OR IGNORE INTO user_badges(user_open_id, badge_id) VALUES (?, ?)').run(id, 'first_contact');
  }
  return isNew;
}

/**
 * Ensure a profile exists, initializing a brand-new one with the first-contact grant and badge.
 * Returns the profile, which is never null.
 */
export function ensureProfile(
  openId: string,
  name?: string,
): { openId: string; name: string; ptBalance: number; firstSeen: number; lastSeen: number } {
  return lpTx(() => {
    ensureProfileRaw(openId, name);
    return getProfile(openId)!;
  });
}

/**
 * Record a user interaction: ensure the profile exists (seeding a new one with the first-contact
 * grant and badge) and log the activity. All writes share a single transaction.
 * Returns { isNew:false, ptGranted:0 } immediately when openId is falsy.
 */
export function recordInteraction(
  openId: string,
  name: string,
  chatId: string,
  messageId: string,
): { isNew: boolean; ptGranted: number } {
  if (!openId) return { isNew: false, ptGranted: 0 };
  // LP cluster (shared db) and the activity log (per-agent db) are different databases, so they can't
  // share one transaction; each gets its own.
  const isNew = lpTx(() => ensureProfileRaw(openId, name, messageId));
  tx(() => recordActivityRaw('mention', openId, chatId, messageId));
  return { isNew, ptGranted: isNew ? FIRST_CONTACT_PT : 0 };
}

/**
 * Whether a user has a first-contact record — i.e. has ever interacted with the agent (which seeds
 * the profile + the 'first_contact' badge in {@link ensureProfile}). Used to gate event rewards on
 * "曾经 @ 过机器人". Returns false for members we only ever saw lurking in group captures.
 */
export function hasFirstContact(openId: string): boolean {
  if (!openId) return false;
  try {
    const row = getLpDb()
      .prepare("SELECT 1 FROM user_badges WHERE user_open_id = ? AND badge_id = 'first_contact' LIMIT 1")
      .get(cid(openId));
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Whether a user holds a given badge. General-purpose role-permission check (badges double as roles,
 * e.g. 'predict_judge' gates who may announce a community-prediction result), unlike hasFirstContact
 * which is hardcoded to one badge id.
 */
export function hasBadge(openId: string, badgeId: string): boolean {
  if (!openId || !badgeId) return false;
  try {
    const row = getLpDb()
      .prepare('SELECT 1 FROM user_badges WHERE user_open_id = ? AND badge_id = ? LIMIT 1')
      .get(cid(openId), badgeId);
    return !!row;
  } catch {
    return false;
  }
}
