// Per-pool PostgreSQL circuit breaker. One instance guards each independent pg.Pool (the soul
// database and the shared LP economy each have their own — see db.ts); a pool failing does not imply
// the other pool is also unhealthy, so each breaker's state is tracked and reasoned about separately.
//
// This is deliberately per-process, in-memory, non-persisted state: it is a local, seconds-to-minutes
// degradation signal for a single-machine deployment, not a source of truth shared across processes.
// The one artifact that DOES need to survive process boundaries is the outbox file (pg-outbox.ts).
import { classifySlowQuery, type SlowQueryTiming } from './db-slow-query.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

/** Read an integer knob from the environment, preserving an explicit 0 (= feature disabled at its floor). */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Consecutive counted failures before a closed breaker trips open. */
export const PG_CIRCUIT_FAIL_THRESHOLD = envInt('AGENT_PG_CIRCUIT_FAIL_THRESHOLD', 5);
/** How long an open breaker waits before allowing a single half-open probe through. */
export const PG_CIRCUIT_PROBE_MS = envInt('AGENT_PG_CIRCUIT_PROBE_MS', 12000);

/**
 * Raised when an operation against a PostgreSQL-backed pool is refused outright because that pool's
 * circuit breaker is open — distinct from a plain business rejection (e.g. spendPt's "insufficient
 * balance"). Never wraps a SQLite fallback: full LP failover was evaluated and explicitly rejected
 * (split-brain risk), so this is always a hard stop, not a degrade-and-continue.
 */
export class PgUnavailableError extends Error {
  constructor(label: string) {
    super(`PostgreSQL（${label}）当前不可用（断路器 open），已拒绝本次请求`);
    this.name = 'PgUnavailableError';
  }
}

export function isPgUnavailableError(e: unknown): e is PgUnavailableError {
  return e instanceof PgUnavailableError;
}

/** User-facing refusal text for LP-mutating commands/tools while the shared PG pool is unavailable. */
export const PG_UNAVAILABLE_REPLY_ZH = 'LP 系统维护中，请稍后再试。';

/**
 * node-postgres/OS-level error codes that unambiguously indicate a broken connection, a refused
 * connection attempt, or a server-cancelled statement — as opposed to an application-level SQL error
 * (constraint violation, syntax error, undefined column, …) which says nothing about whether
 * PostgreSQL itself is reachable. Only the former should ever count toward a circuit breaker: an
 * application bug that throws a unique_violation on every call must never be mistaken for an outage.
 */
const CONNECTION_LAYER_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN',
  '57014', // query_canceled — includes statement_timeout cancellations
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', '08001', '08003', '08004', '08006', // connection_exception family
  '28P01', // invalid_password
]);
const CONNECTION_LAYER_MSG_RE =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EPIPE|connection terminated|Connection terminated unexpectedly|timeout expired|canceling statement due to statement timeout|password authentication failed|terminating connection|server closed the connection|the database system is (starting up|shutting down)|Client has encountered a connection error/i;

/**
 * Whether a thrown error is a connection-layer failure (unreachable server, dropped connection,
 * cancelled statement) as opposed to an application-level SQL error. Exported for tests; production
 * call sites go through shouldCountAsCircuitFailure, which adds the event-loop-blocking discount.
 */
export function isPgConnectionLayerError(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null | undefined;
  if (!err) return false;
  if (err.code && CONNECTION_LAYER_CODES.has(err.code)) return true;
  const msg = err.message ?? String(e);
  return CONNECTION_LAYER_MSG_RE.test(msg);
}

/**
 * Whether a PG failure observed after `elapsedMs` (of which `blockedMs` was spent with the event loop
 * itself stalled, per db.ts's loop-lag sampler) should count toward a circuit breaker's failure tally.
 *
 * This is the single most important correctness rule in this module (see the 2026-07-22 12-minute
 * incident recorded in pg-migration-playbook.md §7): a starved event loop produces real
 * ECONNRESET/timeout errors that say nothing about whether PostgreSQL itself is reachable — a
 * synchronous call elsewhere in the process (e.g. execFileSync in kimi.ts/lark.ts) can starve the
 * loop for minutes, during which idle pooled connections get dropped and queries appear to fail, but
 * the database itself never stopped responding. Reusing classifySlowQuery's discount arithmetic
 * (dbMs = elapsed − blocked) answers exactly this: if the failure is still unexplained after
 * subtracting blocked time, it is real; if blocked time alone accounts for it, it is not.
 *
 * Only genuine connection-layer errors are eligible in the first place — an application-level SQL
 * error is never loop-induced and is simply never a circuit-breaker signal at all.
 */
export function shouldCountAsCircuitFailure(
  e: unknown,
  elapsedMs: number,
  blockedMs: number,
  thresholdMs: number,
): boolean {
  if (!isPgConnectionLayerError(e)) return false;
  const timing: SlowQueryTiming = { execMs: elapsedMs, execBlockedMs: blockedMs, poolWaitMs: 0, waitBlockedMs: 0 };
  return classifySlowQuery(timing, thresholdMs) !== 'loop';
}

export interface CircuitBreakerOptions {
  /** Short human-readable name for this pool, used in PgUnavailableError's message and log/alert lines. */
  label: string;
  failThreshold?: number;
  probeIntervalMs?: number;
}

type StateChangeListener = (from: CircuitState, to: CircuitState, label: string) => void;

/**
 * Per-pool failure detector: closed (healthy, fully transparent) → open (short-circuiting) after
 * failThreshold consecutive COUNTED failures → half-open (exactly one probe allowed through) once
 * probeIntervalMs has elapsed since opening → closed again on that probe's success, or straight back
 * to open on its failure.
 *
 * allowRequest() is the single gate both the LP refusal path (Phase 1) and the soul outbox-diversion
 * decision (Phase 2) call before doing any real work: it returns true when the caller should proceed
 * against the real pool (closed, or this call IS the throttled probe) and false when it should not
 * (open, cooldown not yet elapsed). Everything else in this class only reacts to outcomes the caller
 * reports back via recordSuccess()/recordFailure() — the breaker itself never touches the network.
 */
export class PgCircuitBreaker {
  readonly label: string;
  private readonly failThreshold: number;
  private readonly probeIntervalMs: number;
  private _state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private listeners: StateChangeListener[] = [];

  constructor(opts: CircuitBreakerOptions) {
    this.label = opts.label;
    this.failThreshold = opts.failThreshold ?? PG_CIRCUIT_FAIL_THRESHOLD;
    this.probeIntervalMs = opts.probeIntervalMs ?? PG_CIRCUIT_PROBE_MS;
  }

  get state(): CircuitState {
    return this._state;
  }

  /** Register a state-transition listener (e.g. the Phase 4 ops-chat alert). Returns an unsubscribe function. */
  subscribe(fn: StateChangeListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private transition(to: CircuitState): void {
    if (to === this._state) return;
    const from = this._state;
    this._state = to;
    for (const l of this.listeners) {
      try {
        l(from, to, this.label);
      } catch {
        /* a listener must never break the breaker itself */
      }
    }
  }

  /**
   * Whether a call about to be attempted should be allowed to actually reach PostgreSQL. Mutating:
   * this is what performs the open→half-open transition and claims the single probe slot, so call it
   * at most once per real attempt (never just to "peek" — use `.state` for a read-only check).
   */
  allowRequest(): boolean {
    if (this._state === 'closed') return true;
    if (this._state === 'open') {
      if (Date.now() - this.openedAt < this.probeIntervalMs) return false;
      this.transition('half-open');
      this.probeInFlight = true;
      return true;
    }
    // half-open: only the first caller in this window gets the probe slot; everyone else is refused
    // so a burst of concurrent callers cannot turn the probe itself into a small stampede.
    if (!this.probeInFlight) {
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  /** A successful query/connection: closes the breaker (from any state) and resets the failure tally. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
    if (this._state !== 'closed') this.transition('closed');
  }

  /** A counted failure (caller has already applied shouldCountAsCircuitFailure). */
  recordFailure(): void {
    if (this._state === 'open') return; // already tripped; nothing new until the probe cooldown elapses
    if (this._state === 'half-open') {
      this.probeInFlight = false;
      this.openedAt = Date.now();
      this.transition('open');
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failThreshold) {
      this.openedAt = Date.now();
      this.transition('open');
    }
  }

  /** Test-only: force the breaker back to a fresh closed state without notifying listeners. */
  reset(): void {
    this._state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
  }
}
