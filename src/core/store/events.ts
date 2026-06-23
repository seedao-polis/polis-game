import { getDb } from '../db.js';

export function upsertEventType(t: {
  eventTypeId: string;
  title?: string;
  description?: string;
  scope?: string;
  targetChatId?: string | null;
  baseImage?: string | null;
  renderConfig?: string | null;
  enabled?: boolean;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO event_types(event_type_id, title, description, scope, target_chat_id, base_image, render_config, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(event_type_id) DO UPDATE SET
      title=excluded.title, description=excluded.description, scope=excluded.scope,
      target_chat_id=excluded.target_chat_id, base_image=excluded.base_image,
      render_config=excluded.render_config, enabled=excluded.enabled, updated_at=unixepoch()
  `).run(
    t.eventTypeId, t.title ?? '', t.description ?? '', t.scope ?? 'global',
    t.targetChatId ?? null, t.baseImage ?? null, t.renderConfig ?? null, t.enabled === false ? 0 : 1,
  );
}

export interface EventDispatchInput {
  eventTypeId: string;
  triggerReason?: string;
  scope?: string;
  actorOpenId?: string | null;
  target?: string | null;
  renderedImage?: string | null;
  payload?: object | null;
}

export function insertEventDispatch(d: EventDispatchInput): number {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO event_dispatches(event_type_id, trigger_reason, scope, actor_open_id, target, rendered_image, payload, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    d.eventTypeId, d.triggerReason ?? '', d.scope ?? 'global', d.actorOpenId ?? null,
    d.target ?? null, d.renderedImage ?? null, d.payload != null ? JSON.stringify(d.payload) : null,
  );
  return Number(info.lastInsertRowid) || 0;
}

export function updateEventDispatch(
  id: number,
  patch: { status?: 'pending' | 'sent' | 'failed'; messageId?: string | null; errorMsg?: string | null; sentAt?: number },
): void {
  if (!id) return;
  const db = getDb();
  if (patch.status !== undefined) db.prepare('UPDATE event_dispatches SET status = ? WHERE id = ?').run(patch.status, id);
  if (patch.messageId !== undefined) db.prepare('UPDATE event_dispatches SET message_id = ? WHERE id = ?').run(patch.messageId ?? null, id);
  if (patch.errorMsg !== undefined) db.prepare('UPDATE event_dispatches SET error_msg = ? WHERE id = ?').run(patch.errorMsg ?? null, id);
  if (patch.sentAt !== undefined) db.prepare('UPDATE event_dispatches SET sent_at = ? WHERE id = ?').run(patch.sentAt, id);
}

export function hasSuccessfulDispatch(eventTypeId: string, actorOpenId: string): boolean {
  try {
    const row = getDb()
      .prepare("SELECT 1 FROM event_dispatches WHERE event_type_id = ? AND actor_open_id = ? AND status = 'sent' LIMIT 1")
      .get(eventTypeId, actorOpenId);
    return !!row;
  } catch {
    return false;
  }
}

export function getEventDispatchByMessageId(messageId: string): { id: number; eventTypeId: string } | null {
  try {
    const row = getDb()
      .prepare('SELECT id, event_type_id FROM event_dispatches WHERE message_id = ?')
      .get(messageId) as { id: number; event_type_id: string } | undefined;
    return row ? { id: row.id, eventTypeId: row.event_type_id } : null;
  } catch {
    return null;
  }
}

// ── event schedule state (timed+random triggers) ──────────────
// One row per scheduled event. The day-planner sets last_eval_at + next_fire_at when it picks a
// within-window time for the new logical day (consuming the everyDays cadence); the roll at that time
// records last_fire_at/last_outcome and clears next_fire_at. Persisting next_fire_at lets a restart
// re-arm the same instant rather than re-randomise or double-fire.

export interface ScheduleState {
  /** when the event was last planned for a logical day (consumes the everyDays cadence) */
  lastEvalAt: number | null;
  /** when it last actually fired */
  lastFireAt: number | null;
  /** outcome of the last roll: 'fired' | 'missed' | 'skipped' | 'send-failed' */
  lastOutcome: string | null;
  /** a planned-but-not-yet-rolled within-window fire time (unix seconds), or null */
  nextFireAt: number | null;
}

export function getScheduleState(eventTypeId: string): ScheduleState {
  try {
    const row = getDb()
      .prepare('SELECT last_eval_at, last_fire_at, last_outcome, next_fire_at FROM event_schedule_state WHERE event_type_id = ?')
      .get(eventTypeId) as
      | { last_eval_at: number | null; last_fire_at: number | null; last_outcome: string | null; next_fire_at: number | null }
      | undefined;
    return {
      lastEvalAt: row?.last_eval_at ?? null,
      lastFireAt: row?.last_fire_at ?? null,
      lastOutcome: row?.last_outcome ?? null,
      nextFireAt: row?.next_fire_at ?? null,
    };
  } catch {
    return { lastEvalAt: null, lastFireAt: null, lastOutcome: null, nextFireAt: null };
  }
}

/**
 * Plan a within-window fire for an event: record the chosen fire time (`fireAtUnix`) and stamp
 * `evalAtUnix` as the cadence anchor (so it won't be re-planned until everyDays later).
 */
export function planScheduleFire(eventTypeId: string, fireAtUnix: number, evalAtUnix: number): void {
  try {
    getDb().prepare(`
      INSERT INTO event_schedule_state(event_type_id, last_eval_at, next_fire_at)
      VALUES (?, ?, ?)
      ON CONFLICT(event_type_id) DO UPDATE SET
        last_eval_at = excluded.last_eval_at,
        next_fire_at = excluded.next_fire_at
    `).run(eventTypeId, evalAtUnix, fireAtUnix);
  } catch {
    /* best-effort */
  }
}

export function resolveScheduleRoll(
  eventTypeId: string,
  outcome: 'fired' | 'missed' | 'skipped' | 'send-failed',
): void {
  try {
    const now = Math.floor(Date.now() / 1000);
    getDb().prepare(`
      UPDATE event_schedule_state
      SET last_outcome = ?,
          last_fire_at = CASE WHEN ? = 'fired' THEN ? ELSE last_fire_at END,
          next_fire_at = NULL
      WHERE event_type_id = ?
    `).run(outcome, outcome, now, eventTypeId);
  } catch {
    /* best-effort */
  }
}
