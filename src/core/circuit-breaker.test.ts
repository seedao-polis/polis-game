import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PgCircuitBreaker,
  isPgConnectionLayerError,
  shouldCountAsCircuitFailure,
  isPgUnavailableError,
  PgUnavailableError,
} from './circuit-breaker.js';

// Pure state-machine + classification tests — no PostgreSQL required. The integration-level wiring
// (db.ts's actual pools feeding these breakers) is covered by db-circuit.pg.test.ts.

test('isPgConnectionLayerError: recognizes OS/driver connection codes and messages', () => {
  assert.equal(isPgConnectionLayerError({ code: 'ECONNREFUSED' }), true);
  assert.equal(isPgConnectionLayerError({ code: 'ECONNRESET' }), true);
  assert.equal(isPgConnectionLayerError({ code: '57014' }), true); // query_canceled (statement_timeout)
  assert.equal(isPgConnectionLayerError({ message: 'Connection terminated unexpectedly' }), true);
  assert.equal(isPgConnectionLayerError({ message: 'canceling statement due to statement timeout' }), true);
});

test('isPgConnectionLayerError: an application-level SQL error is never a connection-layer signal', () => {
  assert.equal(isPgConnectionLayerError({ code: '23505', message: 'duplicate key value violates unique constraint' }), false);
  assert.equal(isPgConnectionLayerError({ code: '42601', message: 'syntax error at or near "SELCT"' }), false);
  assert.equal(isPgConnectionLayerError(new Error('undefined column "foo"')), false);
  assert.equal(isPgConnectionLayerError(null), false);
  assert.equal(isPgConnectionLayerError(undefined), false);
});

test('shouldCountAsCircuitFailure: a fast genuine connection refusal counts', () => {
  const e = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:5432' };
  // Fast failure: almost no elapsed time, no blocking at all.
  assert.equal(shouldCountAsCircuitFailure(e, 5, 0, 2000), true);
});

test('shouldCountAsCircuitFailure: THE critical case — a failure explained by event-loop blocking must NOT count', () => {
  // Mirrors the exact shape of the 2026-07-22 production incident (pg-migration-playbook.md §7):
  // a synchronous execFileSync call starved the event loop for minutes, and by the time it resumed,
  // an idle pooled connection had been dropped and surfaced as ECONNRESET — elapsed time is almost
  // entirely accounted for by the loop-lag sampler's blocked-time counter, not by PostgreSQL itself.
  const e = { code: 'ECONNRESET', message: 'read ECONNRESET' };
  assert.equal(shouldCountAsCircuitFailure(e, 540_000, 539_800, 2000), false);
});

test('shouldCountAsCircuitFailure: an application-level error never counts, no matter the timing', () => {
  const e = { code: '23505', message: 'duplicate key value violates unique constraint' };
  assert.equal(shouldCountAsCircuitFailure(e, 9000, 0, 2000), false);
});

test('shouldCountAsCircuitFailure: genuine slow database failure (not loop-explained) counts', () => {
  const e = { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' };
  // Elapsed is large, but blocking accounts for only a small fraction — the remainder is real.
  assert.equal(shouldCountAsCircuitFailure(e, 9000, 100, 2000), true);
});

test('PgUnavailableError: recognized by isPgUnavailableError, not by a plain Error', () => {
  const e = new PgUnavailableError('shared');
  assert.equal(isPgUnavailableError(e), true);
  assert.equal(isPgUnavailableError(new Error('shared')), false);
  assert.match(e.message, /shared/);
});

test('circuit breaker: opens after N consecutive counted failures, stays closed below the threshold', () => {
  const cb = new PgCircuitBreaker({ label: 'test', failThreshold: 3, probeIntervalMs: 50 });
  assert.equal(cb.state, 'closed');
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.state, 'closed', 'must stay closed below the threshold');
  cb.recordFailure();
  assert.equal(cb.state, 'open', 'must open on the Nth consecutive failure');
});

test('circuit breaker: a success resets the failure tally (no partial-credit toward opening)', () => {
  const cb = new PgCircuitBreaker({ label: 'test', failThreshold: 3, probeIntervalMs: 50 });
  cb.recordFailure();
  cb.recordFailure();
  cb.recordSuccess();
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.state, 'closed', 'the two failures after the reset must not combine with the two before it');
});

test('circuit breaker: allowRequest() refuses everything while open, until the probe cooldown elapses', async () => {
  const cb = new PgCircuitBreaker({ label: 'test', failThreshold: 1, probeIntervalMs: 40 });
  cb.recordFailure();
  assert.equal(cb.state, 'open');
  assert.equal(cb.allowRequest(), false, 'must refuse immediately after opening');
  assert.equal(cb.allowRequest(), false, 'must keep refusing before the cooldown elapses');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(cb.allowRequest(), true, 'must allow exactly one probe once the cooldown has elapsed');
  assert.equal(cb.state, 'half-open');
});

test('circuit breaker: half-open allows only ONE probe through — concurrent callers in the same window are refused', async () => {
  const cb = new PgCircuitBreaker({ label: 'test', failThreshold: 1, probeIntervalMs: 30 });
  cb.recordFailure();
  await new Promise((r) => setTimeout(r, 40));
  const first = cb.allowRequest();
  const second = cb.allowRequest();
  const third = cb.allowRequest();
  assert.deepEqual([first, second, third], [true, false, false], 'only the first caller gets the probe slot');
});

test('circuit breaker: a successful probe closes the breaker; a failed probe reopens it', async () => {
  const cbOk = new PgCircuitBreaker({ label: 'test', failThreshold: 1, probeIntervalMs: 20 });
  cbOk.recordFailure();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(cbOk.allowRequest(), true);
  cbOk.recordSuccess();
  assert.equal(cbOk.state, 'closed');

  const cbFail = new PgCircuitBreaker({ label: 'test', failThreshold: 1, probeIntervalMs: 20 });
  cbFail.recordFailure();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(cbFail.allowRequest(), true);
  cbFail.recordFailure();
  assert.equal(cbFail.state, 'open', 'a failed probe must reopen the breaker, not leave it half-open');
});

test('circuit breaker: happy path is fully transparent — closed always allows, never opens without failures', () => {
  const cb = new PgCircuitBreaker({ label: 'test', failThreshold: 5, probeIntervalMs: 12_000 });
  for (let i = 0; i < 50; i++) {
    assert.equal(cb.allowRequest(), true);
    cb.recordSuccess();
  }
  assert.equal(cb.state, 'closed');
});

test('circuit breaker: reset() returns a fresh closed state for test isolation', () => {
  const cb = new PgCircuitBreaker({ label: 'test', failThreshold: 1, probeIntervalMs: 50 });
  cb.recordFailure();
  assert.equal(cb.state, 'open');
  cb.reset();
  assert.equal(cb.state, 'closed');
  assert.equal(cb.allowRequest(), true);
});

test('circuit breaker: subscribe() notifies listeners of every transition with (from, to, label)', () => {
  const cb = new PgCircuitBreaker({ label: 'my-pool', failThreshold: 1, probeIntervalMs: 10_000 });
  const seen: Array<[string, string, string]> = [];
  const unsubscribe = cb.subscribe((from, to, label) => seen.push([from, to, label]));
  cb.recordFailure();
  assert.deepEqual(seen, [['closed', 'open', 'my-pool']]);
  unsubscribe();
  cb.reset();
  cb.recordFailure();
  assert.equal(seen.length, 1, 'an unsubscribed listener must not be called again');
});

test('circuit breaker: a listener throwing never breaks the breaker itself', () => {
  const cb = new PgCircuitBreaker({ label: 'test', failThreshold: 1, probeIntervalMs: 10_000 });
  cb.subscribe(() => {
    throw new Error('boom');
  });
  assert.doesNotThrow(() => cb.recordFailure());
  assert.equal(cb.state, 'open');
});
