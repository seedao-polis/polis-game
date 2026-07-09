import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGICAL_DAY_START_HOUR,
  logicalDayStart,
  logicalMonthStart,
  logicalWeekStart,
  logicalDayCalendarDate,
  logicalDayIndex,
  parseHHMM,
  formatHHMM,
  clampDayOfMonth,
  localDate,
  localDateFromEpochSec,
  localDateTimeFromEpochSec,
  MAX_TIMEOUT_MS,
  safeSetTimeout,
  weeklyReportRange,
} from './time.js';

test('parseHHMM parses valid times to minutes-from-midnight', () => {
  assert.equal(parseHHMM('00:00'), 0);
  assert.equal(parseHHMM('05:00'), 300);
  assert.equal(parseHHMM('23:59'), 1439);
  assert.equal(parseHHMM(' 9:30 '), 570); // trims, allows 1-digit hour
});

test('parseHHMM rejects malformed or out-of-range input', () => {
  assert.equal(parseHHMM(undefined), null);
  assert.equal(parseHHMM(''), null);
  assert.equal(parseHHMM('24:00'), null); // total minutes >= 24*60
  assert.equal(parseHHMM('1230'), null); // missing colon
  assert.equal(parseHHMM('ab:cd'), null);
});

test('parseHHMM does not validate the minutes field (documents existing leniency)', () => {
  // The minute group is not range-checked; only the total-minutes bound applies.
  // Config-driven window times are trusted, so this lenient behaviour is preserved.
  assert.equal(parseHHMM('12:60'), 12 * 60 + 60);
});

test('formatHHMM zero-pads hours and minutes', () => {
  const d = new Date(2026, 5, 20, 5, 7, 0, 0);
  assert.equal(formatHHMM(d.getTime()), '05:07');
});

test('clampDayOfMonth clamps to the real last day of the month', () => {
  assert.equal(clampDayOfMonth(31, 2026, 5), 30); // June has 30 days
  assert.equal(clampDayOfMonth(31, 2026, 0), 31); // January has 31
  assert.equal(clampDayOfMonth(29, 2025, 1), 28); // Feb 2025 (non-leap)
  assert.equal(clampDayOfMonth(29, 2024, 1), 29); // Feb 2024 (leap)
  assert.equal(clampDayOfMonth(0, 2026, 5), 1); // floor at 1
  assert.equal(clampDayOfMonth(-5, 2026, 5), 1);
});

test('logicalDayStart anchors before 05:00 to the previous calendar day at 05:00', () => {
  // 03:00 on the 20th belongs to the logical day that started 05:00 on the 19th
  const before = new Date(2026, 5, 20, 3, 0, 0, 0);
  const s1 = logicalDayStart(before);
  assert.equal(s1.getFullYear(), 2026);
  assert.equal(s1.getMonth(), 5);
  assert.equal(s1.getDate(), 19);
  assert.equal(s1.getHours(), LOGICAL_DAY_START_HOUR);

  // 06:00 on the 20th belongs to the logical day that started 05:00 on the 20th
  const after = new Date(2026, 5, 20, 6, 0, 0, 0);
  const s2 = logicalDayStart(after);
  assert.equal(s2.getDate(), 20);
  assert.equal(s2.getHours(), LOGICAL_DAY_START_HOUR);

  // exactly 05:00 is the start of the new logical day
  const at = new Date(2026, 5, 20, 5, 0, 0, 0);
  assert.equal(logicalDayStart(at).getDate(), 20);
});

test('logicalMonthStart anchors to the 1st at 05:00 of the logical month', () => {
  // 02:00 on July 1st still belongs to June's logical month (logical day = June 30)
  const m = logicalMonthStart(new Date(2026, 6, 1, 2, 0, 0, 0));
  assert.equal(m.getFullYear(), 2026);
  assert.equal(m.getMonth(), 5); // June
  assert.equal(m.getDate(), 1);
  assert.equal(m.getHours(), LOGICAL_DAY_START_HOUR);
});

test('logicalWeekStart anchors to Monday 05:00 of the logical week (Mon→Sun)', () => {
  // 2026-07-06 is a Monday (2026-07-02 is a Thursday per project context).
  const assertWeek = (d: Date, year: number, month: number, date: number) => {
    const w = logicalWeekStart(d);
    assert.equal(w.getDay(), 1, 'week starts on a Monday');
    assert.equal(w.getHours(), LOGICAL_DAY_START_HOUR);
    assert.equal(w.getFullYear(), year);
    assert.equal(w.getMonth(), month);
    assert.equal(w.getDate(), date);
  };

  // Monday 06:00 → this Monday 05:00 opens the week.
  assertWeek(new Date(2026, 6, 6, 6, 0, 0, 0), 2026, 6, 6);
  // Monday exactly at 05:00 → the new week starts.
  assertWeek(new Date(2026, 6, 6, 5, 0, 0, 0), 2026, 6, 6);
  // Thursday mid-week → still the Monday 2026-07-06 week.
  assertWeek(new Date(2026, 6, 9, 15, 0, 0, 0), 2026, 6, 6);
  // Monday 03:00 (before 05:00) is logically still Sunday → the PREVIOUS week (Mon 2026-06-29).
  assertWeek(new Date(2026, 6, 6, 3, 0, 0, 0), 2026, 5, 29);
  // Sunday 23:00 is the last day of the week that opened Monday 2026-06-29.
  assertWeek(new Date(2026, 6, 5, 23, 0, 0, 0), 2026, 5, 29);
});

test('logicalDayCalendarDate returns local midnight of the logical day date', () => {
  const before = new Date(2026, 5, 20, 3, 0, 0, 0);
  const d = logicalDayCalendarDate(before);
  assert.equal(d.getDate(), 19);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

test('logicalDayIndex is stable within a logical day and increments across the 05:00 boundary', () => {
  const day20Morning = new Date(2026, 5, 20, 6, 0, 0, 0).getTime();
  const day20Night = new Date(2026, 5, 20, 23, 0, 0, 0).getTime();
  const day21EarlyAm = new Date(2026, 5, 21, 4, 0, 0, 0).getTime(); // still logical day 20
  const day21Morning = new Date(2026, 5, 21, 6, 0, 0, 0).getTime(); // logical day 21

  assert.equal(logicalDayIndex(day20Morning), logicalDayIndex(day20Night));
  assert.equal(logicalDayIndex(day20Morning), logicalDayIndex(day21EarlyAm));
  assert.equal(logicalDayIndex(day21Morning), logicalDayIndex(day20Morning) + 1);
});

test('localDate formats in local time, not UTC', () => {
  const d = new Date(2026, 0, 5, 12, 0, 0, 0); // Jan 5
  assert.equal(localDate(d), '2026-01-05');
});

test('localDateFromEpochSec / localDateTimeFromEpochSec round-trip a known local instant', () => {
  const d = new Date(2026, 5, 20, 9, 8, 0, 0);
  const sec = Math.floor(d.getTime() / 1000);
  assert.equal(localDateFromEpochSec(sec), '2026-06-20');
  assert.equal(localDateTimeFromEpochSec(sec), '2026-06-20 09:08');
});

test('MAX_TIMEOUT_MS is Node\'s 32-bit setTimeout ceiling', () => {
  assert.equal(MAX_TIMEOUT_MS, 2 ** 31 - 1);
});

test('safeSetTimeout fires once, after the full delay, when delay is under the chunk', async () => {
  let count = 0;
  await new Promise<void>((resolve) => {
    safeSetTimeout(() => {
      count += 1;
      resolve();
    }, 20);
  });
  assert.equal(count, 1);
});

test('safeSetTimeout chains beyond the chunk without firing early (the overflow-loop regression)', async () => {
  // With a plain setTimeout, a delay above the ceiling overflows to 1ms and fires almost immediately —
  // exactly what made the monthly ops report loop. Here chunkMs stands in for MAX_TIMEOUT_MS so the
  // chaining path (delay > chunk) runs fast. The callback must NOT fire until the whole delay elapses.
  let count = 0;
  const firedEarly = await new Promise<boolean>((resolve) => {
    safeSetTimeout(() => { count += 1; }, 60, 20); // 60ms via 20ms chunks -> 3 hops
    // One chunk in, it must not have fired yet (a naive overflow would already be at count=1).
    setTimeout(() => resolve(count > 0), 25);
  });
  assert.equal(firedEarly, false, 'callback fired before the full delay elapsed');

  // And it eventually fires exactly once (no loop, no double-fire).
  await new Promise<void>((r) => setTimeout(r, 80));
  assert.equal(count, 1);
});

// --- weeklyReportRange ---
// All tests use 2026-07-02 as the reference Thursday (the date is given as Thursday in the project
// context). Dates: 2026-07-01 = Wednesday, 2026-07-02 = Thursday, 2026-07-03 = Friday,
// and the previous Thursday is 2026-06-25.

test('weeklyReportRange window is always exactly 7 days', () => {
  const cases = [
    new Date(2026, 6, 3, 10, 0, 0, 0),   // Friday
    new Date(2026, 6, 2, 21, 0, 0, 0),   // Thursday exactly at 21:00
    new Date(2026, 6, 2, 21, 1, 0, 0),   // Thursday at 21:01
    new Date(2026, 6, 2, 20, 59, 0, 0),  // Thursday before 21:00
    new Date(2026, 6, 1, 12, 0, 0, 0),   // Wednesday
  ];
  for (const ref of cases) {
    const r = weeklyReportRange(ref);
    assert.equal(r.to - r.from, 7 * 24 * 3600, `window should be 7 days for ${ref}`);
  }
});

test('weeklyReportRange: to is always <= ref', () => {
  const cases = [
    new Date(2026, 6, 2, 21, 0, 0, 0),   // Thursday exactly at 21:00
    new Date(2026, 6, 2, 21, 1, 0, 0),   // Thursday at 21:01
    new Date(2026, 6, 2, 20, 59, 0, 0),  // Thursday before 21:00
    new Date(2026, 6, 3, 10, 0, 0, 0),   // Friday
    new Date(2026, 6, 1, 12, 0, 0, 0),   // Wednesday
  ];
  for (const ref of cases) {
    const r = weeklyReportRange(ref);
    assert.ok(r.to * 1000 <= ref.getTime(), `to should be <= ref for ${ref}`);
  }
});

test('weeklyReportRange: Thursday exactly at 21:00 anchors to that instant', () => {
  const ref = new Date(2026, 6, 2, 21, 0, 0, 0); // 2026-07-02 Thursday 21:00
  const r = weeklyReportRange(ref);
  const d = new Date(r.to * 1000);
  assert.equal(d.getDay(), 4);           // Thursday
  assert.equal(d.getHours(), 21);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getDate(), 2);          // July 2
  assert.equal(d.getMonth(), 6);         // July (0-based)
  assert.equal(d.getFullYear(), 2026);
});

test('weeklyReportRange: Thursday at 21:01 anchors to 21:00 of the same day', () => {
  const ref = new Date(2026, 6, 2, 21, 1, 0, 0); // 2026-07-02 Thursday 21:01
  const r = weeklyReportRange(ref);
  const d = new Date(r.to * 1000);
  assert.equal(d.getDay(), 4);
  assert.equal(d.getHours(), 21);
  assert.equal(d.getDate(), 2);
  assert.equal(d.getMonth(), 6);
});

test('weeklyReportRange: Thursday before 21:00 steps back to the previous Thursday 21:00', () => {
  const ref = new Date(2026, 6, 2, 20, 59, 0, 0); // 2026-07-02 Thursday 20:59
  const r = weeklyReportRange(ref);
  const d = new Date(r.to * 1000);
  assert.equal(d.getDay(), 4);
  assert.equal(d.getHours(), 21);
  assert.equal(d.getDate(), 25);         // 2026-06-25 (previous Thursday)
  assert.equal(d.getMonth(), 5);         // June
  assert.equal(d.getFullYear(), 2026);
});

test('weeklyReportRange: Friday anchors to the Thursday 21:00 of the same week', () => {
  const ref = new Date(2026, 6, 3, 10, 0, 0, 0); // 2026-07-03 Friday 10:00
  const r = weeklyReportRange(ref);
  const d = new Date(r.to * 1000);
  assert.equal(d.getDay(), 4);
  assert.equal(d.getHours(), 21);
  assert.equal(d.getDate(), 2);          // 2026-07-02 Thursday
  assert.equal(d.getMonth(), 6);
});

test('weeklyReportRange: Wednesday anchors to the previous Thursday 21:00', () => {
  const ref = new Date(2026, 6, 1, 12, 0, 0, 0); // 2026-07-01 Wednesday 12:00
  const r = weeklyReportRange(ref);
  const d = new Date(r.to * 1000);
  assert.equal(d.getDay(), 4);
  assert.equal(d.getHours(), 21);
  assert.equal(d.getDate(), 25);         // 2026-06-25 Thursday
  assert.equal(d.getMonth(), 5);         // June
  assert.equal(d.getFullYear(), 2026);
});
