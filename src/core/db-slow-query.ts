// Slow-query cause attribution, split out of db.ts so it can be imported by modules that must NOT
// depend on db.ts itself (circuit-breaker.ts uses it to classify PG failures without creating an
// import cycle back into the module that constructs the circuit breakers). db.ts re-exports
// `classifySlowQuery` so existing call sites (and its own test file) keep importing it from db.js.

/** What a slow query's timings actually blame, once event-loop blocking is discounted per phase. */
export type SlowQueryCause = 'db' | 'pool' | 'loop' | 'none';

export interface SlowQueryTiming {
  /** total statement execution time, including any time the loop was blocked during it */
  execMs: number;
  /** of execMs, how much the event loop was blocked */
  execBlockedMs: number;
  /** total time waiting for a pooled connection, including any time the loop was blocked during it */
  poolWaitMs: number;
  /** of poolWaitMs, how much the event loop was blocked */
  waitBlockedMs: number;
}

/**
 * Attribute a slow query to a cause. A blocked event loop inflates BOTH phases — a blocked loop
 * cannot resolve the pool's connect() promise any more than it can read a statement's reply off the
 * socket — so blocked time is subtracted from the phase it was measured in:
 *   - 'db'   → execution still slow after discounting blocking: the database or its network path;
 *   - 'pool' → the wait is still slow after discounting blocking: genuine pool starvation, some
 *              transaction is squatting on connections;
 *   - 'loop' → neither phase is slow on its own; this process starved itself and the database was fine;
 *   - 'none' → nothing crossed the threshold.
 *
 * Exported because this classification is the whole difference between "add connections" and "stop
 * blocking the loop", and it has been wrong in production before: discounting blocked time from
 * execution ALONE reported a blocked loop as pool starvation, whose obvious remedy (a bigger pool)
 * cannot possibly help. The circuit breaker reuses this same arithmetic for a second purpose: telling
 * a genuine connection-layer failure apart from one that is really the loop's own fault (see
 * circuit-breaker.ts's shouldCountAsCircuitFailure).
 */
export function classifySlowQuery(t: SlowQueryTiming, thresholdMs: number): SlowQueryCause {
  const dbMs = Math.max(0, t.execMs - t.execBlockedMs);
  const waitMs = Math.max(0, t.poolWaitMs - t.waitBlockedMs);
  if (dbMs >= thresholdMs) return 'db';
  if (waitMs >= thresholdMs) return 'pool';
  if (t.execBlockedMs + t.waitBlockedMs >= thresholdMs) return 'loop';
  return 'none';
}
