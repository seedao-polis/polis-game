import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGICAL_DAY_START_HOUR,
  logicalDayStart,
  logicalMonthStart,
  logicalDayCalendarDate,
  logicalDayIndex,
  parseHHMM,
  formatHHMM,
  clampDayOfMonth,
  localDate,
  localDateFromEpochSec,
  localDateTimeFromEpochSec,
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
