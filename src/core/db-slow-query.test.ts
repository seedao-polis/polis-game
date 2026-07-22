import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySlowQuery } from './db.js';

// Attribution of a slow PostgreSQL query to a cause. This is pure arithmetic over four numbers, but
// getting it wrong is expensive in a way a wrong number is not: the operator reads the WARN prefix and
// acts on it, and each cause has a different — mutually useless — remedy. Production shipped a version
// that discounted event-loop blocking from execution ONLY, so a process blocking its own loop for 70s
// logged "PG 池等待 77436ms（…池等待 70772ms…队0）" and pointed straight at raising the pool size, which
// cannot help. Every case below is stated as "these timings, therefore this cause".
//
// A fixed threshold is passed explicitly so the assertions do not move with AGENT_PG_SLOW_QUERY_MS.
const T = 2000;

test('slow execution with an idle loop blames the database', () => {
  const cause = classifySlowQuery({ execMs: 9000, execBlockedMs: 0, poolWaitMs: 0, waitBlockedMs: 0 }, T);
  assert.equal(cause, 'db');
});

test('slow execution that is entirely event-loop blocking blames the loop, not the database', () => {
  const cause = classifySlowQuery({ execMs: 9000, execBlockedMs: 8800, poolWaitMs: 0, waitBlockedMs: 0 }, T);
  assert.equal(cause, 'loop');
});

test('a long pool wait that is entirely event-loop blocking blames the loop, NOT pool starvation', () => {
  // The exact production shape: 09:03:01 — 池等待 70772ms with 事件循环阻塞约 76658ms and an empty queue.
  // A blocked loop cannot resolve pool.connect()'s promise any more than it can read a reply off the
  // socket, so blocked time must be discounted from the wait too. Discounting it from execution alone
  // leaves waitMs at 70772 and misreports this as 'pool'.
  const cause = classifySlowQuery(
    { execMs: 6664, execBlockedMs: 5900, poolWaitMs: 70772, waitBlockedMs: 70758 }, T,
  );
  assert.equal(cause, 'loop');
});

test('a long pool wait with an idle loop blames pool starvation', () => {
  const cause = classifySlowQuery({ execMs: 40, execBlockedMs: 0, poolWaitMs: 5000, waitBlockedMs: 0 }, T);
  assert.equal(cause, 'pool');
});

test('genuine database slowness outranks a blocked wait', () => {
  // Both phases are inflated, but execution is still slow on its own merits after discounting: the
  // database is a real finding and must not be masked by concurrent loop blocking.
  const cause = classifySlowQuery(
    { execMs: 9000, execBlockedMs: 100, poolWaitMs: 30000, waitBlockedMs: 29900 }, T,
  );
  assert.equal(cause, 'db');
});

test('blocking split across both phases still adds up to a loop verdict', () => {
  // Neither phase crosses the threshold alone once discounted, but 1200+1100 of blocking does — this
  // used to fall through to DEBUG and disappear from the log entirely.
  const cause = classifySlowQuery(
    { execMs: 1300, execBlockedMs: 1200, poolWaitMs: 1200, waitBlockedMs: 1100 }, T,
  );
  assert.equal(cause, 'loop');
});

test('nothing crossing the threshold reports no cause', () => {
  const cause = classifySlowQuery({ execMs: 300, execBlockedMs: 50, poolWaitMs: 100, waitBlockedMs: 0 }, T);
  assert.equal(cause, 'none');
});

test('blocked time exceeding its phase still lands on the loop, never on db or pool', () => {
  // execBlockedMs can legitimately exceed execMs: it is max(counter delta, tick staleness), and the
  // staleness fallback can measure a stall that began before this phase did. (Note this pins the
  // verdict, not the `Math.max(0, …)` floors themselves — a negative discounted value fails a `>=`
  // comparison exactly like a floored zero does, so the floors are defensive rather than load-bearing.)
  const cause = classifySlowQuery(
    { execMs: 500, execBlockedMs: 9000, poolWaitMs: 400, waitBlockedMs: 9000 }, T,
  );
  assert.equal(cause, 'loop');
});

test('the threshold is inclusive at the boundary', () => {
  assert.equal(classifySlowQuery({ execMs: T, execBlockedMs: 0, poolWaitMs: 0, waitBlockedMs: 0 }, T), 'db');
  assert.equal(classifySlowQuery({ execMs: T - 1, execBlockedMs: 0, poolWaitMs: 0, waitBlockedMs: 0 }, T), 'none');
});
