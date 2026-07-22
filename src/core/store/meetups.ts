import { getDb } from '../db.js';

// Activity meetup store: CRUD for activity_meetups / activity_meetup_tags /
// meetup_subscriptions. All operations target the per-soul tudigong.db (getDb()).

/** A confirmed or cancelled community activity meetup, with its tag list attached. */
export interface ActivityMeetup {
  id: number;
  /** Feishu recurring-series UUID (bare, without the _<digits> occurrence suffix). */
  larkEventId: string;
  title: string;
  description: string;
  /** RFC 5545 recurrence rule string; empty string for a one-off event. */
  recurrence: string;
  startTime: number;
  endTime: number;
  /** Feishu VC join URL (vchat.meeting_url); empty string when no VC was created. */
  meetupUrl: string;
  /** Feishu calendar deep-link (app_link); empty string when absent. */
  appLink: string;
  /** Public calendar share link (feishu.cn/calendar/share?token=...); empty string when absent. */
  shareLink: string;
  calendarId: string;
  createdBy: string;
  /** 'confirmed' | 'cancelled' */
  status: string;
  createdAt: number;
  updatedAt: number;
  /** Associated tags; populated by queries that JOIN activity_meetup_tags. */
  tags: string[];
}

/** Minimal input required to record a new activity meetup. */
export interface ActivityMeetupInput {
  larkEventId: string;
  title: string;
  description?: string;
  recurrence?: string;
  startTime: number;
  endTime: number;
  meetupUrl?: string;
  appLink?: string;
  shareLink?: string;
  calendarId?: string;
  createdBy?: string;
}

/** Fields that can be updated on an existing meetup. */
export interface ActivityMeetupUpdate {
  title?: string;
  description?: string;
  recurrence?: string;
  startTime?: number;
  endTime?: number;
  meetupUrl?: string;
  appLink?: string;
}

function rowToMeetup(row: Record<string, unknown>, tags: string[]): ActivityMeetup {
  return {
    id: Number(row['id']),
    larkEventId: String(row['lark_event_id'] ?? ''),
    title: String(row['title'] ?? ''),
    description: String(row['description'] ?? ''),
    recurrence: String(row['recurrence'] ?? ''),
    startTime: Number(row['start_time']),
    endTime: Number(row['end_time']),
    meetupUrl: String(row['meetup_url'] ?? ''),
    appLink: String(row['app_link'] ?? ''),
    shareLink: String(row['share_link'] ?? ''),
    calendarId: String(row['calendar_id'] ?? ''),
    createdBy: String(row['created_by'] ?? ''),
    status: String(row['status'] ?? 'confirmed'),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    tags,
  };
}

/** Fetch tags for one or more meetup ids. Returns a map of id → tag[]. */
async function fetchTagsForIds(ids: number[]): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (ids.length === 0) return map;
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const db = await getDb();
  const { rows } = await db.query<{ meetup_id: number; tag: string }>(
    `SELECT meetup_id, tag FROM activity_meetup_tags WHERE meetup_id IN (${placeholders})`,
    ids,
  );
  for (const r of rows) {
    const list = map.get(r.meetup_id) ?? [];
    list.push(r.tag);
    map.set(r.meetup_id, list);
  }
  return map;
}

/**
 * Insert a new activity meetup row and return its auto-incremented id.
 * Does not set tags — call setMeetupTags separately.
 *
 * The INSERT carries a RETURNING clause (supported by both node:sqlite and PostgreSQL) so the new
 * row's id can be read back without relying on `lastInsertRowid`, which the query-based executor
 * interface has no equivalent for.
 */
export async function insertMeetup(m: ActivityMeetupInput): Promise<number> {
  const db = await getDb();
  const { rows } = await db.query<{ id: number }>(`
    INSERT INTO activity_meetups
      (lark_event_id, title, description, recurrence, start_time, end_time,
       meetup_url, app_link, share_link, calendar_id, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id
  `, [
    m.larkEventId,
    m.title,
    m.description ?? '',
    m.recurrence ?? '',
    m.startTime,
    m.endTime,
    m.meetupUrl ?? '',
    m.appLink ?? '',
    m.shareLink ?? '',
    m.calendarId ?? '',
    m.createdBy ?? '',
  ]);
  return Number(rows[0].id);
}

/**
 * Replace the tag set for a meetup. Deletes all existing tags for the meetup,
 * then inserts the new ones. Idempotent when called with the same tags.
 */
export async function setMeetupTags(meetupId: number, tags: string[]): Promise<void> {
  const db = await getDb();
  await db.query('DELETE FROM activity_meetup_tags WHERE meetup_id = $1', [meetupId]);
  for (const tag of tags) {
    await db.query('INSERT INTO activity_meetup_tags(meetup_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING', [meetupId, tag.trim()]);
  }
}

/**
 * Fetch a single meetup by its local integer id, including its tags.
 * Returns null when no matching row exists.
 */
export async function getMeetupById(id: number): Promise<ActivityMeetup | null> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM activity_meetups WHERE id = $1', [id]);
  const row = rows[0];
  if (!row) return null;
  const tagMap = await fetchTagsForIds([Number(row['id'])]);
  return rowToMeetup(row, tagMap.get(Number(row['id'])) ?? []);
}

/**
 * Fetch a single meetup by its Feishu lark_event_id (bare series UUID).
 * Returns null when not found.
 */
export async function getMeetupByEventId(larkEventId: string): Promise<ActivityMeetup | null> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM activity_meetups WHERE lark_event_id = $1', [larkEventId]);
  const row = rows[0];
  if (!row) return null;
  const tagMap = await fetchTagsForIds([Number(row['id'])]);
  return rowToMeetup(row, tagMap.get(Number(row['id'])) ?? []);
}

/**
 * Soft-cancel a meetup by setting its status to 'cancelled' and bumping updated_at.
 * Returns true when a row was updated, false when the id was not found.
 */
export async function cancelMeetup(id: number): Promise<boolean> {
  const db = await getDb();
  const { rowCount } = await db.query(`
    UPDATE activity_meetups SET status = 'cancelled', updated_at = unixepoch() WHERE id = $1
  `, [id]);
  return rowCount > 0;
}

/**
 * Update editable fields on an existing meetup. Only provided (non-undefined) fields
 * are written; updated_at is always bumped. Returns true when a row was changed.
 */
export async function updateMeetup(id: number, updates: ActivityMeetupUpdate): Promise<boolean> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (updates.title !== undefined) { params.push(updates.title); sets.push(`title = $${params.length}`); }
  if (updates.description !== undefined) { params.push(updates.description); sets.push(`description = $${params.length}`); }
  if (updates.recurrence !== undefined) { params.push(updates.recurrence); sets.push(`recurrence = $${params.length}`); }
  if (updates.startTime !== undefined) { params.push(updates.startTime); sets.push(`start_time = $${params.length}`); }
  if (updates.endTime !== undefined) { params.push(updates.endTime); sets.push(`end_time = $${params.length}`); }
  if (updates.meetupUrl !== undefined) { params.push(updates.meetupUrl); sets.push(`meetup_url = $${params.length}`); }
  if (updates.appLink !== undefined) { params.push(updates.appLink); sets.push(`app_link = $${params.length}`); }
  if (sets.length === 0) return false;
  sets.push('updated_at = unixepoch()');
  params.push(id);
  const db = await getDb();
  const { rowCount } = await db.query(`UPDATE activity_meetups SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  return rowCount > 0;
}

/**
 * Return all confirmed meetups whose start_time falls within [startSec, endSec).
 * Includes each meetup's tags. Ordered by start_time ascending.
 */
export async function meetupsOnDate(startSec: number, endSec: number): Promise<ActivityMeetup[]> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(`
    SELECT * FROM activity_meetups
    WHERE status = 'confirmed' AND start_time >= $1 AND start_time < $2
    ORDER BY start_time ASC
  `, [startSec, endSec]);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => Number(r['id']));
  const tagMap = await fetchTagsForIds(ids);
  return rows.map((r) => rowToMeetup(r, tagMap.get(Number(r['id'])) ?? []));
}

/**
 * Return all confirmed meetups whose end_time is in the future, ordered by start_time.
 * Used by the CLI digest preview.
 */
export async function listUpcomingMeetups(): Promise<ActivityMeetup[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(`
    SELECT * FROM activity_meetups
    WHERE status = 'confirmed' AND end_time > $1
    ORDER BY start_time ASC
  `, [nowSec]);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => Number(r['id']));
  const tagMap = await fetchTagsForIds(ids);
  return rows.map((r) => rowToMeetup(r, tagMap.get(Number(r['id'])) ?? []));
}

/**
 * Return meetups relevant to "what's coming up" context: confirmed, and either not yet ended or
 * recurring. A recurring series is stored as a single row keyed to its first occurrence, so it
 * stays relevant after that first occurrence passes; single events drop off once ended. Ordered by
 * start_time ascending. Feeds the background block injected into the serve prompt.
 */
export async function listActiveMeetupsForContext(): Promise<ActivityMeetup[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(`
    SELECT * FROM activity_meetups
    WHERE status = 'confirmed' AND (end_time > $1 OR recurrence != '')
    ORDER BY start_time ASC
  `, [nowSec]);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => Number(r['id']));
  const tagMap = await fetchTagsForIds(ids);
  return rows.map((r) => rowToMeetup(r, tagMap.get(Number(r['id'])) ?? []));
}

/**
 * Return all meetups (confirmed and cancelled) ordered by start_time.
 * Used by the wiki update job to render the full activity calendar page.
 */
export async function listAllMeetupsForWiki(): Promise<ActivityMeetup[]> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(`
    SELECT * FROM activity_meetups ORDER BY start_time ASC
  `);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => Number(r['id']));
  const tagMap = await fetchTagsForIds(ids);
  return rows.map((r) => rowToMeetup(r, tagMap.get(Number(r['id'])) ?? []));
}

// ── subscription store ────────────────────────────────────────

/**
 * Subscribe an open_id to a meetup tag. Returns true when a new row was inserted,
 * false when the subscription already existed.
 */
export async function subscribeMeetupTag(openId: string, tag: string): Promise<boolean> {
  const db = await getDb();
  const { rowCount } = await db.query(`
    INSERT INTO meetup_subscriptions(user_open_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING
  `, [openId, tag.trim()]);
  return rowCount > 0;
}

/**
 * Unsubscribe an open_id from a meetup tag. Returns true when a row was deleted,
 * false when the subscription did not exist.
 */
export async function unsubscribeMeetupTag(openId: string, tag: string): Promise<boolean> {
  const db = await getDb();
  const { rowCount } = await db.query(`
    DELETE FROM meetup_subscriptions WHERE user_open_id = $1 AND tag = $2
  `, [openId, tag.trim()]);
  return rowCount > 0;
}

/**
 * List all tags that an open_id has subscribed to, in insertion order.
 */
export async function listMeetupSubscriptions(openId: string): Promise<string[]> {
  const db = await getDb();
  const { rows } = await db.query<{ tag: string }>(`
    SELECT tag FROM meetup_subscriptions WHERE user_open_id = $1 ORDER BY created_at ASC
  `, [openId]);
  return rows.map((r) => r.tag);
}

/**
 * Return the open_ids of all users who have subscribed to a given tag.
 */
export async function subscribersForTag(tag: string): Promise<string[]> {
  const db = await getDb();
  const { rows } = await db.query<{ user_open_id: string }>(`
    SELECT user_open_id FROM meetup_subscriptions WHERE tag = $1
  `, [tag.trim()]);
  return rows.map((r) => r.user_open_id);
}
