import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketSignupPoints } from './ops-report.js';

// SIGNUP_BUCKET_SEC is 3600 (one hour) inside ops-report.ts.

test('bucketSignupPoints returns [] for empty input', () => {
  assert.deepEqual(bucketSignupPoints([], 10_000), []);
});

test('bucketSignupPoints keeps the last value per hour bucket and closes at the event start', () => {
  const points = [
    { t: 100, y: 1 },
    { t: 200, y: 3 },
    { t: 3000, y: 5 }, // still hour-0 bucket [0,3600)
    { t: 3700, y: 6 }, // hour-1 bucket [3600,7200)
    { t: 7000, y: 8 },
    { t: 7300, y: 9 }, // hour-2 bucket [7200,10800)
  ];
  const out = bucketSignupPoints(points, 10_000);
  assert.deepEqual(out, [
    { t: 3000, y: 5 }, // last of hour-0
    { t: 7000, y: 8 }, // last of hour-1
    { t: 7300, y: 9 }, // last of hour-2
    { t: 10_000, y: 9 }, // closing point at event start, carrying the final count
  ]);
});

test('bucketSignupPoints collapses a single bucket to its last point plus the closing point', () => {
  const out = bucketSignupPoints([{ t: 100, y: 1 }, { t: 200, y: 4 }], 500);
  assert.deepEqual(out, [{ t: 200, y: 4 }, { t: 500, y: 4 }]);
});

test('bucketSignupPoints omits the closing point when endSec is at or before the last point', () => {
  const out = bucketSignupPoints([{ t: 100, y: 1 }, { t: 7300, y: 9 }], 7000);
  // Two buckets -> (100,1) then (7300,9); endSec 7000 <= 7300 so no closing point.
  assert.deepEqual(out, [{ t: 100, y: 1 }, { t: 7300, y: 9 }]);
});

test('bucketSignupPoints preserves a non-monotonic count (accepts can drop as people withdraw)', () => {
  const out = bucketSignupPoints(
    [{ t: 100, y: 5 }, { t: 3700, y: 8 }, { t: 7300, y: 6 }],
    8000,
  );
  assert.deepEqual(out, [
    { t: 100, y: 5 },
    { t: 3700, y: 8 },
    { t: 7300, y: 6 },
    { t: 8000, y: 6 },
  ]);
});
