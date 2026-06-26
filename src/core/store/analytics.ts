import { getDb } from '../db.js';

// ── calendar event RSVP round time-series ──────────────────────
// One row per (poll-round × event). Symmetric to member_sync_rounds: synced_at+event_id is UNIQUE
// so rounds are idempotent. accepted is the headline signup count; the other three RSVP buckets are
// stored separately for post-hoc analysis. signup_total = all non-removed attendees (reference field).

export interface CalendarEventRsvpRoundInput {
  /** poll timestamp, unix SECONDS */
  syncedAt: number;
  /** Feishu calendar event id (UUID + recurrence-instance suffix) */
  eventId: string;
  /** organizer_calendar_id from +agenda */
  calendarId: string;
  /** event title, redundantly stored to avoid re-fetching */
  title: string;
  /** event start, unix seconds */
  startTime: number;
  /** event end, unix seconds */
  endTime: number;
  /** rsvp_status=accept — the headline signup count */
  accepted: number;
  /** rsvp_status=decline */
  declined: number;
  /** rsvp_status=tentative */
  tentative: number;
  /** rsvp_status=needs_action */
  needsAction: number;
  /** all non-removed attendees (accepted+declined+tentative+needsAction), reference only */
  signupTotal: number;
  /** 'live' (recorded in real time) | 'backfill' (reserved; Feishu has no RSVP snapshot API) */
  source?: 'live' | 'backfill';
}

/**
 * Record one calendar-event RSVP round into the ops time-series. (synced_at, event_id) is UNIQUE,
 * so a round already recorded for that instant+event is left untouched (idempotent). Returns true
 * when a new row was inserted. Best-effort: never throws into the poll loop.
 */
export function recordCalendarEventRsvpRound(r: CalendarEventRsvpRoundInput): boolean {
  try {
    const info = getDb().prepare(`
      INSERT OR IGNORE INTO calendar_event_rsvp_rounds(
        synced_at, event_id, calendar_id, title, start_time, end_time,
        accepted, declined, tentative, needs_action, signup_total, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Math.trunc(r.syncedAt),
      r.eventId,
      r.calendarId,
      r.title,
      r.startTime,
      r.endTime,
      r.accepted,
      r.declined,
      r.tentative,
      r.needsAction,
      r.signupTotal,
      r.source ?? 'live',
    );
    return (info.changes as number) > 0;
  } catch {
    return false;
  }
}

export interface CalendarEventRsvpRoundRow {
  id: number;
  syncedAt: number;
  eventId: string;
  calendarId: string;
  title: string;
  startTime: number;
  endTime: number;
  accepted: number;
  declined: number;
  tentative: number;
  needsAction: number;
  signupTotal: number;
  source: string;
}

export function recentCalendarEventRsvpRounds(limit = 50): CalendarEventRsvpRoundRow[] {
  try {
    const rows = getDb().prepare(`
      SELECT id, synced_at, event_id, calendar_id, title, start_time, end_time,
             accepted, declined, tentative, needs_action, signup_total, source
      FROM calendar_event_rsvp_rounds ORDER BY synced_at DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      syncedAt: Number(r.synced_at),
      eventId: String(r.event_id ?? ''),
      calendarId: String(r.calendar_id ?? ''),
      title: String(r.title ?? ''),
      startTime: Number(r.start_time),
      endTime: Number(r.end_time),
      accepted: Number(r.accepted),
      declined: Number(r.declined),
      tentative: Number(r.tentative),
      needsAction: Number(r.needs_action),
      signupTotal: Number(r.signup_total),
      source: String(r.source ?? ''),
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch the most recent RSVP round for a specific event, for change detection in the poll loop.
 * Returns null when the event has never been recorded.
 */
export function latestCalendarEventRsvpRound(eventId: string): CalendarEventRsvpRoundRow | null {
  try {
    const r = getDb().prepare(`
      SELECT id, synced_at, event_id, calendar_id, title, start_time, end_time,
             accepted, declined, tentative, needs_action, signup_total, source
      FROM calendar_event_rsvp_rounds
      WHERE event_id = ? ORDER BY synced_at DESC LIMIT 1
    `).get(eventId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: Number(r.id),
      syncedAt: Number(r.synced_at),
      eventId: String(r.event_id ?? ''),
      calendarId: String(r.calendar_id ?? ''),
      title: String(r.title ?? ''),
      startTime: Number(r.start_time),
      endTime: Number(r.end_time),
      accepted: Number(r.accepted),
      declined: Number(r.declined),
      tentative: Number(r.tentative),
      needsAction: Number(r.needs_action),
      signupTotal: Number(r.signup_total),
      source: String(r.source ?? ''),
    };
  } catch {
    return null;
  }
}

// ── knowledge-base document view-record events ─────────────────
// Append-only log of detected document views. The Feishu access-record API returns one entry per
// distinct viewer carrying their most-recent view time, so UNIQUE(file_token, viewer_id, last_view_time)
// + INSERT OR IGNORE turns repeated polling into change detection: an unchanged record is ignored,
// while a new viewer or an advanced view time inserts a fresh row. One row marks one observed view at
// the polled granularity, not a running snapshot.

export interface DocViewEventInput {
  /** underlying document object token */
  fileToken: string;
  /** document type (docx/sheet/bitable/mindnote/file/doc) */
  fileType: string;
  /** where the document was discovered: 'wiki' | 'drive' */
  source: string;
  /** wiki space id when the document came from a knowledge base, else empty */
  spaceId: string;
  /** document title, redundantly stored to avoid re-fetching */
  title: string;
  /** viewer open_id */
  viewerId: string;
  /** viewer display name */
  viewerName: string;
  /** viewer's most-recent view time, unix seconds */
  lastViewTime: number;
}

/**
 * Record one observed document view. (file_token, viewer_id, last_view_time) is UNIQUE, so a view
 * already recorded is left untouched (idempotent); returns true only when a new view was inserted.
 * Best-effort: never throws into the poll loop.
 */
export function recordDocViewEvent(e: DocViewEventInput): boolean {
  try {
    const info = getDb().prepare(`
      INSERT OR IGNORE INTO doc_view_events(
        file_token, file_type, source, space_id, title, viewer_id, viewer_name, last_view_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      e.fileToken,
      e.fileType,
      e.source,
      e.spaceId,
      e.title,
      e.viewerId,
      e.viewerName,
      Math.trunc(e.lastViewTime),
    );
    return (info.changes as number) > 0;
  } catch {
    return false;
  }
}

export interface DocViewEventRow {
  id: number;
  fileToken: string;
  fileType: string;
  source: string;
  spaceId: string;
  title: string;
  viewerId: string;
  viewerName: string;
  lastViewTime: number;
  recordedAt: number;
}

export function recentDocViewEvents(limit = 50): DocViewEventRow[] {
  try {
    const rows = getDb().prepare(`
      SELECT id, file_token, file_type, source, space_id, title,
             viewer_id, viewer_name, last_view_time, recorded_at
      FROM doc_view_events ORDER BY last_view_time DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      fileToken: String(r.file_token ?? ''),
      fileType: String(r.file_type ?? ''),
      source: String(r.source ?? ''),
      spaceId: String(r.space_id ?? ''),
      title: String(r.title ?? ''),
      viewerId: String(r.viewer_id ?? ''),
      viewerName: String(r.viewer_name ?? ''),
      lastViewTime: Number(r.last_view_time),
      recordedAt: Number(r.recorded_at),
    }));
  } catch {
    return [];
  }
}

/**
 * Return RSVP rounds for a specific event where synced_at falls in [fromSec, toSec), ordered by
 * time ascending. Used to build per-event signup trend lines in the report.
 */
export function calendarEventRsvpHistory(
  eventId: string,
  fromSec: number,
  toSec: number,
): CalendarEventRsvpRoundRow[] {
  try {
    const rows = getDb().prepare(`
      SELECT id, synced_at, event_id, calendar_id, title, start_time, end_time,
             accepted, declined, tentative, needs_action, signup_total, source
      FROM calendar_event_rsvp_rounds
      WHERE event_id = ? AND synced_at >= ? AND synced_at < ?
      ORDER BY synced_at ASC
    `).all(eventId, fromSec, toSec) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      syncedAt: Number(r.synced_at),
      eventId: String(r.event_id ?? ''),
      calendarId: String(r.calendar_id ?? ''),
      title: String(r.title ?? ''),
      startTime: Number(r.start_time),
      endTime: Number(r.end_time),
      accepted: Number(r.accepted),
      declined: Number(r.declined),
      tentative: Number(r.tentative),
      needsAction: Number(r.needs_action),
      signupTotal: Number(r.signup_total),
      source: String(r.source ?? ''),
    }));
  } catch {
    return [];
  }
}

/**
 * Return the distinct wiki space_ids seen in doc_view_events where last_view_time falls in
 * [fromSec, toSec). Used to discover which wiki spaces had activity during the report window
 * so the tree chart only builds trees for active spaces.
 */
export function wikiSpacesBetween(fromSec: number, toSec: number): string[] {
  try {
    const rows = getDb().prepare(`
      SELECT DISTINCT space_id
      FROM doc_view_events
      WHERE source = 'wiki'
        AND space_id != ''
        AND last_view_time >= ? AND last_view_time < ?
    `).all(fromSec, toSec) as Array<{ space_id: string }>;
    return rows.map((r) => String(r.space_id));
  } catch {
    return [];
  }
}

/**
 * Return a map of file_token -> unique reader count where last_view_time falls in [fromSec, toSec).
 * Counts DISTINCT viewer_id per file to give per-document unique-reader stats for the wiki tree.
 */
export function docViewReadersBetween(fromSec: number, toSec: number): Map<string, number> {
  try {
    const rows = getDb().prepare(`
      SELECT file_token, COUNT(DISTINCT viewer_id) AS unique_readers
      FROM doc_view_events
      WHERE last_view_time >= ? AND last_view_time < ?
      GROUP BY file_token
    `).all(fromSec, toSec) as Array<{ file_token: string; unique_readers: number }>;
    const m = new Map<string, number>();
    for (const r of rows) {
      m.set(String(r.file_token), Number(r.unique_readers));
    }
    return m;
  } catch {
    return new Map();
  }
}

/**
 * Return per-document reader digests where last_view_time falls in [fromSec, toSec): each document's
 * title and its DISTINCT reader count, most-read first. Title-and-count only (no viewer identities)
 * keeps the daily narrative privacy-safe. Rows are grouped by file_token; the most recent non-empty
 * title for that token is used. Documents with no resolvable title are dropped.
 */
export function docReaderDigestBetween(
  fromSec: number,
  toSec: number,
): Array<{ title: string; readers: number }> {
  try {
    const rows = getDb().prepare(`
      SELECT
        (SELECT d2.title FROM doc_view_events d2
          WHERE d2.file_token = d.file_token AND d2.title <> ''
          ORDER BY d2.last_view_time DESC LIMIT 1) AS title,
        COUNT(DISTINCT d.viewer_id) AS readers
      FROM doc_view_events d
      WHERE d.last_view_time >= ? AND d.last_view_time < ?
      GROUP BY d.file_token
      ORDER BY readers DESC
    `).all(fromSec, toSec) as Array<{ title: string | null; readers: number }>;
    return rows
      .map((r) => ({ title: String(r.title ?? ''), readers: Number(r.readers) }))
      .filter((r) => r.title !== '');
  } catch {
    return [];
  }
}

/**
 * Return a map of file_token -> distinct viewer open_ids whose last_view_time falls in [fromSec, toSec).
 * Lets callers classify a document's readers (e.g. staff vs non-staff) for the wiki tree coloring.
 */
export function docViewersBetween(fromSec: number, toSec: number): Map<string, string[]> {
  try {
    const rows = getDb().prepare(`
      SELECT DISTINCT file_token, viewer_id
      FROM doc_view_events
      WHERE last_view_time >= ? AND last_view_time < ?
    `).all(fromSec, toSec) as Array<{ file_token: string; viewer_id: string }>;
    const m = new Map<string, string[]>();
    for (const r of rows) {
      const token = String(r.file_token);
      const arr = m.get(token) ?? [];
      arr.push(String(r.viewer_id));
      m.set(token, arr);
    }
    return m;
  } catch {
    return new Map();
  }
}

/**
 * Return distinct upcoming (not yet started) event ids that have appeared in calendar_event_rsvp_rounds
 * and whose start_time > nowSec. Used to enumerate active signup-tracking events for the report.
 */
export function upcomingTrackedEventIds(nowSec: number): Array<{ eventId: string; title: string; startTime: number }> {
  try {
    const rows = getDb().prepare(`
      SELECT DISTINCT event_id, title, start_time
      FROM calendar_event_rsvp_rounds
      WHERE start_time > ?
      ORDER BY start_time ASC
    `).all(nowSec) as Array<{ event_id: string; title: string; start_time: number }>;
    return rows.map((r) => ({
      eventId: String(r.event_id),
      title: String(r.title ?? ''),
      startTime: Number(r.start_time),
    }));
  } catch {
    return [];
  }
}
