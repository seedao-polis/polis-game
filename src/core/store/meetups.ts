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
function fetchTagsForIds(ids: number[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT meetup_id, tag FROM activity_meetup_tags WHERE meetup_id IN (${placeholders})`)
    .all(...ids) as Array<{ meetup_id: number; tag: string }>;
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
 */
export function insertMeetup(m: ActivityMeetupInput): number {
  const res = getDb().prepare(`
    INSERT INTO activity_meetups
      (lark_event_id, title, description, recurrence, start_time, end_time,
       meetup_url, app_link, share_link, calendar_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
  );
  return Number(res.lastInsertRowid);
}

/**
 * Replace the tag set for a meetup. Deletes all existing tags for the meetup,
 * then inserts the new ones. Idempotent when called with the same tags.
 */
export function setMeetupTags(meetupId: number, tags: string[]): void {
  const db = getDb();
  db.prepare('DELETE FROM activity_meetup_tags WHERE meetup_id = ?').run(meetupId);
  const insert = db.prepare('INSERT OR IGNORE INTO activity_meetup_tags(meetup_id, tag) VALUES (?, ?)');
  for (const tag of tags) {
    insert.run(meetupId, tag.trim());
  }
}

/**
 * Fetch a single meetup by its local integer id, including its tags.
 * Returns null when no matching row exists.
 */
export function getMeetupById(id: number): ActivityMeetup | null {
  const row = getDb().prepare('SELECT * FROM activity_meetups WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const tagMap = fetchTagsForIds([Number(row['id'])]);
  return rowToMeetup(row, tagMap.get(Number(row['id'])) ?? []);
}

/**
 * Fetch a single meetup by its Feishu lark_event_id (bare series UUID).
 * Returns null when not found.
 */
export function getMeetupByEventId(larkEventId: string): ActivityMeetup | null {
  const row = getDb().prepare('SELECT * FROM activity_meetups WHERE lark_event_id = ?').get(larkEventId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const tagMap = fetchTagsForIds([Number(row['id'])]);
  return rowToMeetup(row, tagMap.get(Number(row['id'])) ?? []);
}

/**
 * Soft-cancel a meetup by setting its status to 'cancelled' and bumping updated_at.
 * Returns true when a row was updated, false when the id was not found.
 */
export function cancelMeetup(id: number): boolean {
  const res = getDb().prepare(`
    UPDATE activity_meetups SET status = 'cancelled', updated_at = unixepoch() WHERE id = ?
  `).run(id);
  return (res.changes ?? 0) > 0;
}

/**
 * Update editable fields on an existing meetup. Only provided (non-undefined) fields
 * are written; updated_at is always bumped. Returns true when a row was changed.
 */
export function updateMeetup(id: number, updates: ActivityMeetupUpdate): boolean {
  const sets: string[] = [];
  // SQLInputValue = null | number | bigint | string | NodeJS.ArrayBufferView
  const params: (string | number | null)[] = [];
  if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
  if (updates.recurrence !== undefined) { sets.push('recurrence = ?'); params.push(updates.recurrence); }
  if (updates.startTime !== undefined) { sets.push('start_time = ?'); params.push(updates.startTime); }
  if (updates.endTime !== undefined) { sets.push('end_time = ?'); params.push(updates.endTime); }
  if (updates.meetupUrl !== undefined) { sets.push('meetup_url = ?'); params.push(updates.meetupUrl); }
  if (updates.appLink !== undefined) { sets.push('app_link = ?'); params.push(updates.appLink); }
  if (sets.length === 0) return false;
  sets.push('updated_at = unixepoch()');
  const res = getDb().prepare(`UPDATE activity_meetups SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  return (res.changes ?? 0) > 0;
}

/**
 * Return all confirmed meetups whose start_time falls within [startSec, endSec).
 * Includes each meetup's tags. Ordered by start_time ascending.
 */
export function meetupsOnDate(startSec: number, endSec: number): ActivityMeetup[] {
  const rows = getDb().prepare(`
    SELECT * FROM activity_meetups
    WHERE status = 'confirmed' AND start_time >= ? AND start_time < ?
    ORDER BY start_time ASC
  `).all(startSec, endSec) as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => Number(r['id']));
  const tagMap = fetchTagsForIds(ids);
  return rows.map((r) => rowToMeetup(r, tagMap.get(Number(r['id'])) ?? []));
}

/**
 * Return all confirmed meetups whose end_time is in the future, ordered by start_time.
 * Used by the CLI digest preview.
 */
export function listUpcomingMeetups(): ActivityMeetup[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = getDb().prepare(`
    SELECT * FROM activity_meetups
    WHERE status = 'confirmed' AND end_time > ?
    ORDER BY start_time ASC
  `).all(nowSec) as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => Number(r['id']));
  const tagMap = fetchTagsForIds(ids);
  return rows.map((r) => rowToMeetup(r, tagMap.get(Number(r['id'])) ?? []));
}

/**
 * Return meetups relevant to "what's coming up" context: confirmed, and either not yet ended or
 * recurring. A recurring series is stored as a single row keyed to its first occurrence, so it
 * stays relevant after that first occurrence passes; single events drop off once ended. Ordered by
 * start_time ascending. Feeds the background block injected into the serve prompt.
 */
export function listActiveMeetupsForContext(): ActivityMeetup[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = getDb().prepare(`
    SELECT * FROM activity_meetups
    WHERE status = 'confirmed' AND (end_time > ? OR recurrence != '')
    ORDER BY start_time ASC
  `).all(nowSec) as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => Number(r['id']));
  const tagMap = fetchTagsForIds(ids);
  return rows.map((r) => rowToMeetup(r, tagMap.get(Number(r['id'])) ?? []));
}

/**
 * Return all meetups (confirmed and cancelled) ordered by start_time.
 * Used by the wiki update job to render the full activity calendar page.
 */
export function listAllMeetupsForWiki(): ActivityMeetup[] {
  const rows = getDb().prepare(`
    SELECT * FROM activity_meetups ORDER BY start_time ASC
  `).all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => Number(r['id']));
  const tagMap = fetchTagsForIds(ids);
  return rows.map((r) => rowToMeetup(r, tagMap.get(Number(r['id'])) ?? []));
}

// ── subscription store ────────────────────────────────────────

/**
 * Subscribe an open_id to a meetup tag. Returns true when a new row was inserted,
 * false when the subscription already existed.
 */
export function subscribeMeetupTag(openId: string, tag: string): boolean {
  const res = getDb().prepare(`
    INSERT OR IGNORE INTO meetup_subscriptions(user_open_id, tag) VALUES (?, ?)
  `).run(openId, tag.trim());
  return (res.changes ?? 0) > 0;
}

/**
 * Unsubscribe an open_id from a meetup tag. Returns true when a row was deleted,
 * false when the subscription did not exist.
 */
export function unsubscribeMeetupTag(openId: string, tag: string): boolean {
  const res = getDb().prepare(`
    DELETE FROM meetup_subscriptions WHERE user_open_id = ? AND tag = ?
  `).run(openId, tag.trim());
  return (res.changes ?? 0) > 0;
}

/**
 * List all tags that an open_id has subscribed to, in insertion order.
 */
export function listMeetupSubscriptions(openId: string): string[] {
  const rows = getDb().prepare(`
    SELECT tag FROM meetup_subscriptions WHERE user_open_id = ? ORDER BY created_at ASC
  `).all(openId) as Array<{ tag: string }>;
  return rows.map((r) => r.tag);
}

/**
 * Return the open_ids of all users who have subscribed to a given tag.
 */
export function subscribersForTag(tag: string): string[] {
  const rows = getDb().prepare(`
    SELECT user_open_id FROM meetup_subscriptions WHERE tag = ?
  `).all(tag.trim()) as Array<{ user_open_id: string }>;
  return rows.map((r) => r.user_open_id);
}
