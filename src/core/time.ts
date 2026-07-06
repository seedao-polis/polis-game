// Shared time helpers for the framework's "logical day" model and local-time formatting.
//
// A *logical day* runs from 05:00 local to 04:59 the next day — the anchor used by both the
// supervisor's schedules (LP reset, ops reports, event planning) and the ops-report time ranges.
// All formatting here is deliberately LOCAL-time based: Date#toISOString would shift the calendar
// date by the UTC offset and silently mislabel a day, so it is never used for date labels.

/** Hour (local) at which a new logical day begins. */
export const LOGICAL_DAY_START_HOUR = 5;

/** Milliseconds in a 24h day. */
export const DAY_MS = 86_400_000;

/** Node's setTimeout ceiling: 2^31-1 ms (~24.8 days). Larger delays silently overflow. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * setTimeout that tolerates delays beyond Node's ~24.8-day (2^31-1 ms) ceiling. Node clamps an
 * out-of-range delay to 1ms and fires almost immediately (emitting a TimeoutOverflowWarning) — which
 * turns any self-rescheduling monthly/yearly timer into a tight infinite loop. This chains
 * intermediate timeouts so the callback only runs once the full delay has actually elapsed.
 * `chunkMs` is injectable for testing; production callers should leave it at the default.
 */
export function safeSetTimeout(
  cb: () => void,
  delayMs: number,
  chunkMs: number = MAX_TIMEOUT_MS
): ReturnType<typeof setTimeout> {
  const remaining = Math.max(0, delayMs);
  if (remaining <= chunkMs) return setTimeout(cb, remaining);
  return setTimeout(() => {
    safeSetTimeout(cb, remaining - chunkMs, chunkMs);
  }, chunkMs);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Anchor a moment to the start (05:00 local) of the logical day it belongs to. */
export function logicalDayStart(d: Date): Date {
  const anchor = new Date(d.getFullYear(), d.getMonth(), d.getDate(), LOGICAL_DAY_START_HOUR, 0, 0, 0);
  if (d.getHours() < LOGICAL_DAY_START_HOUR) {
    anchor.setDate(anchor.getDate() - 1);
  }
  return anchor;
}

/** Anchor a moment to the start (1st 05:00 local) of the logical month it belongs to. */
export function logicalMonthStart(d: Date): Date {
  const ld = logicalDayStart(d);
  return new Date(ld.getFullYear(), ld.getMonth(), 1, LOGICAL_DAY_START_HOUR, 0, 0, 0);
}

/** Local midnight of the calendar date that the logical day containing `d` belongs to. */
export function logicalDayCalendarDate(d: Date): Date {
  const shifted = new Date(d.getTime() - LOGICAL_DAY_START_HOUR * 3600 * 1000);
  return new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate());
}

/** Integer index of the logical day containing `ms` (days since epoch, shifted by the start hour). */
export function logicalDayIndex(ms: number): number {
  const d = new Date(ms - LOGICAL_DAY_START_HOUR * 3600 * 1000);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY_MS);
}

/** Parse "HH:MM" into minutes-from-midnight; returns null if malformed or out of range. */
export function parseHHMM(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const min = Number(m[1]) * 60 + Number(m[2]);
  return min >= 0 && min < 24 * 60 ? min : null;
}

/** Format an epoch-ms instant as local "HH:MM". */
export function formatHHMM(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Clamp a day-of-month to a real day of that month (e.g. 31 -> 30 in a 30-day month). */
export function clampDayOfMonth(day: number, year: number, monthIdx: number): number {
  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
  return Math.min(Math.max(1, day), daysInMonth);
}

/** Format a Date as a local "YYYY-MM-DD" string (never UTC). */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Format an epoch-second timestamp as a local "YYYY-MM-DD" string. */
export function localDateFromEpochSec(sec: number): string {
  return localDate(new Date(sec * 1000));
}

/** Format an epoch-second timestamp as a local "YYYY-MM-DD HH:MM" string. */
export function localDateTimeFromEpochSec(sec: number): string {
  const d = new Date(sec * 1000);
  return `${localDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Compute the weekly report window anchored at the most-recent Thursday 21:00 local time at or
 * before `ref`. `to` is that Thursday's 21:00 in epoch seconds; `from` is exactly 7 days prior.
 *
 * Uses local time throughout — never toISOString() — so the anchor is stable in the server
 * timezone (expected: Asia/Shanghai, UTC+8). Edge cases:
 *   - Thursday exactly at 21:00 → `to` = that instant (inclusive).
 *   - Thursday before 21:00   → `to` = the *previous* Thursday 21:00.
 *   - Any other weekday        → `to` = the most recent past Thursday 21:00.
 */
export function weeklyReportRange(ref: Date): { from: number; to: number } {
  const day = ref.getDay(); // 0 = Sun, 4 = Thu, 6 = Sat
  // Number of calendar days since the most recent Thursday.
  const daysBack = (day - 4 + 7) % 7;
  const thursday = new Date(
    ref.getFullYear(), ref.getMonth(), ref.getDate() - daysBack, 21, 0, 0, 0
  );
  // When today IS Thursday but the clock is still before 21:00, step back one week so to <= ref.
  if (thursday > ref) thursday.setDate(thursday.getDate() - 7);
  const to = Math.floor(thursday.getTime() / 1000);
  return { from: to - 7 * 24 * 3600, to };
}
