import { getDb } from '../db.js';

export async function upsertEventType(t: {
  eventTypeId: string;
  title?: string;
  description?: string;
  scope?: string;
  targetChatId?: string | null;
  baseImage?: string | null;
  renderConfig?: string | null;
  enabled?: boolean;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `
    INSERT INTO event_types(event_type_id, title, description, scope, target_chat_id, base_image, render_config, enabled, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, unixepoch())
    ON CONFLICT(event_type_id) DO UPDATE SET
      title=excluded.title, description=excluded.description, scope=excluded.scope,
      target_chat_id=excluded.target_chat_id, base_image=excluded.base_image,
      render_config=excluded.render_config, enabled=excluded.enabled, updated_at=unixepoch()
  `,
    [
      t.eventTypeId, t.title ?? '', t.description ?? '', t.scope ?? 'global',
      t.targetChatId ?? null, t.baseImage ?? null, t.renderConfig ?? null, t.enabled === false ? 0 : 1,
    ],
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

/**
 * The INSERT carries a RETURNING clause (supported by both node:sqlite and PostgreSQL) so the new
 * row's id can be read back without relying on `lastInsertRowid`, which the PostgreSQL query
 * interface introduced later has no equivalent for.
 */
export async function insertEventDispatch(d: EventDispatchInput): Promise<number> {
  const db = await getDb();
  const { rows } = await db.query<{ id: number }>(
    `
    INSERT INTO event_dispatches(event_type_id, trigger_reason, scope, actor_open_id, target, rendered_image, payload, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
    RETURNING id
  `,
    [
      d.eventTypeId, d.triggerReason ?? '', d.scope ?? 'global', d.actorOpenId ?? null,
      d.target ?? null, d.renderedImage ?? null, d.payload != null ? JSON.stringify(d.payload) : null,
    ],
  );
  return Number(rows[0]?.id) || 0;
}

export async function updateEventDispatch(
  id: number,
  patch: { status?: 'pending' | 'sent' | 'failed'; messageId?: string | null; errorMsg?: string | null; sentAt?: number },
): Promise<void> {
  if (!id) return;
  const db = await getDb();
  if (patch.status !== undefined) await db.query('UPDATE event_dispatches SET status = $1 WHERE id = $2', [patch.status, id]);
  if (patch.messageId !== undefined) await db.query('UPDATE event_dispatches SET message_id = $1 WHERE id = $2', [patch.messageId ?? null, id]);
  if (patch.errorMsg !== undefined) await db.query('UPDATE event_dispatches SET error_msg = $1 WHERE id = $2', [patch.errorMsg ?? null, id]);
  if (patch.sentAt !== undefined) await db.query('UPDATE event_dispatches SET sent_at = $1 WHERE id = $2', [patch.sentAt, id]);
}

export async function hasSuccessfulDispatch(eventTypeId: string, actorOpenId: string): Promise<boolean> {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      "SELECT 1 FROM event_dispatches WHERE event_type_id = $1 AND actor_open_id = $2 AND status = 'sent' LIMIT 1",
      [eventTypeId, actorOpenId],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function getEventDispatchByMessageId(messageId: string): Promise<{ id: number; eventTypeId: string } | null> {
  try {
    const db = await getDb();
    const { rows } = await db.query<{ id: number; event_type_id: string }>(
      'SELECT id, event_type_id FROM event_dispatches WHERE message_id = $1',
      [messageId],
    );
    const row = rows[0];
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

export async function getScheduleState(eventTypeId: string): Promise<ScheduleState> {
  try {
    const db = await getDb();
    const { rows } = await db.query<{
      last_eval_at: number | null; last_fire_at: number | null; last_outcome: string | null; next_fire_at: number | null;
    }>(
      'SELECT last_eval_at, last_fire_at, last_outcome, next_fire_at FROM event_schedule_state WHERE event_type_id = $1',
      [eventTypeId],
    );
    const row = rows[0];
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
export async function planScheduleFire(eventTypeId: string, fireAtUnix: number, evalAtUnix: number): Promise<void> {
  try {
    const db = await getDb();
    await db.query(
      `
      INSERT INTO event_schedule_state(event_type_id, last_eval_at, next_fire_at)
      VALUES ($1, $2, $3)
      ON CONFLICT(event_type_id) DO UPDATE SET
        last_eval_at = excluded.last_eval_at,
        next_fire_at = excluded.next_fire_at
    `,
      [eventTypeId, evalAtUnix, fireAtUnix],
    );
  } catch {
    /* best-effort */
  }
}

export async function resolveScheduleRoll(
  eventTypeId: string,
  outcome: 'fired' | 'missed' | 'skipped' | 'send-failed',
): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const db = await getDb();
    await db.query(
      `
      UPDATE event_schedule_state
      SET last_outcome = $1,
          last_fire_at = CASE WHEN $2 = 'fired' THEN $3 ELSE last_fire_at END,
          next_fire_at = NULL
      WHERE event_type_id = $4
    `,
      [outcome, outcome, now, eventTypeId],
    );
  } catch {
    /* best-effort */
  }
}
