import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync as Db } from 'node:sqlite';
import pg, { types as pgTypes, type Pool as PgPool, type PoolClient, type PoolConfig } from 'pg';
import { RUNTIME_DIR } from './paths.js';
import { log } from './log.js';
import { classifySlowQuery as classifySlowQueryImpl, type SlowQueryCause, type SlowQueryTiming } from './db-slow-query.js';
import {
  PgCircuitBreaker,
  PgUnavailableError,
  isPgUnavailableError,
  PG_UNAVAILABLE_REPLY_ZH,
  shouldCountAsCircuitFailure,
} from './circuit-breaker.js';

// Re-exported for backward compatibility: db-slow-query.test.ts and any other call site imports
// classifySlowQuery from db.js. The implementation itself lives in db-slow-query.ts so
// circuit-breaker.ts can use the same arithmetic without importing db.ts (which would cycle back,
// since db.ts is the module that constructs the circuit breakers below).
export { PgUnavailableError, isPgUnavailableError, PG_UNAVAILABLE_REPLY_ZH };
export function classifySlowQuery(t: SlowQueryTiming, thresholdMs = PG_SLOW_QUERY_MS): SlowQueryCause {
  return classifySlowQueryImpl(t, thresholdMs);
}

// node-postgres defaults NUMERIC (OID 1700) and BIGINT/int8 (OID 20) columns to JS strings (arbitrary
// precision / values that could exceed Number.MAX_SAFE_INTEGER). Every NUMERIC/BIGINT column this
// schema uses (LP amounts, unix-second timestamps, auto-increment ids) stays comfortably inside
// Number's safe range, so both are coerced back to `number` here — once, at module load, before any
// Pool is constructed — to match node:sqlite's existing (always-number) behavior. Must not be set a
// second time anywhere else in the codebase.
pgTypes.setTypeParser(1700, (v: string) => parseFloat(v));
pgTypes.setTypeParser(20, (v: string) => parseInt(v, 10));

// Observability thresholds for the PostgreSQL backend (env-tunable). A query slower than
// AGENT_PG_SLOW_QUERY_MS logs a warning with the truncated SQL text; a transaction holding its pooled
// connection longer than AGENT_PG_SLOW_TX_MS logs a warning when it ends (a long-lived transaction
// both starves the small pool and blocks server-side vacuum). The routine backend-selection line is
// demoted to debug inside the MCP subprocess so each LLM turn does not mint its own log file under
// logs/; warnings and errors keep their normal level in every process.
const PG_SLOW_QUERY_MS = Number(process.env.AGENT_PG_SLOW_QUERY_MS) || 2000;
const PG_SLOW_TX_MS = Number(process.env.AGENT_PG_SLOW_TX_MS) || 30000;
const IS_MCP_PROCESS = /mcp-server/.test(process.argv[1] ?? '');

/** Read a millisecond knob from the environment, preserving an explicit 0 (= feature disabled). */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Client-side failure bounds for the PostgreSQL backend (env-tunable; 0 disables one). The database
// is reached over a WAN link, where a single lost packet turns into TCP retransmission backoff and a
// query can hang for a minute or more while the server itself sits idle. Left unbounded, every such
// stall is absorbed silently: connect() waits forever, the statement waits forever, and a transaction
// holding that connection squats on the pool for the whole stall. statement_timeout (server-side) is
// set below query_timeout (client-side) so the server cancels first and the caller sees a real
// PostgreSQL error instead of a client-side abort with the statement still running on the server.
// Deliberately NOT set: idle_in_transaction_session_timeout — tx() bodies legitimately await external
// I/O (Feishu calls) between statements, and bounding that would abort correct transactions.
const PG_CONNECT_TIMEOUT_MS = envMs('AGENT_PG_CONNECT_TIMEOUT_MS', 8000);
const PG_STATEMENT_TIMEOUT_MS = envMs('AGENT_PG_STATEMENT_TIMEOUT_MS', 15000);
const PG_IDLE_TIMEOUT_MS = envMs('AGENT_PG_IDLE_TIMEOUT_MS', 60000);

/** One-line summary of a SQL statement for log output: whitespace collapsed, length capped. */
function sqlPreview(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Distinguishes "PostgreSQL was slow" from "the reply arrived promptly but Node's event loop was
// blocked so the promise could not resolve" — a blocked loop inflates end-to-end query timings while
// the database itself is fast. An unref'd ticker accumulates every loop stall it observes into a
// monotonic counter; the counter's delta across a phase is that phase's share of blocked time,
// correct even when the stall came as several separate chunks (timers fire before poll callbacks in
// an event-loop turn, so the final chunk is counted before the query's own resolution runs). Started
// lazily with the first pool so SQLite-only souls and one-shot CLI runs are unaffected (unref keeps
// it from holding any process alive).
//
// The floor exists because timer scheduling has a few ms of inherent jitter that would otherwise
// accumulate into phantom "blocked" time and wrongly excuse a genuinely slow database. It is kept low
// (rather than at a round 100ms) so fine-grained CPU contention — hundreds of sub-100ms stalls while
// dozens of lark-cli subprocesses run — is measured instead of silently rounded down to zero.
const LOOP_TICK_MS = 250;
const LOOP_LAG_FLOOR_MS = 20;
let _lastLoopTick = 0;
let _cumLoopBlockedMs = 0;
let _maxLoopLagMs = 0;
function ensureLoopLagSampler(): void {
  if (_lastLoopTick) return;
  _lastLoopTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - _lastLoopTick - LOOP_TICK_MS;
    if (lag > LOOP_LAG_FLOOR_MS) {
      _cumLoopBlockedMs += lag;
      if (lag > _maxLoopLagMs) _maxLoopLagMs = lag;
    }
    _lastLoopTick = now;
  }, LOOP_TICK_MS).unref();
}

/**
 * Loop-tick staleness at this instant. Complements the cumulative counter: when the blocking call
 * runs inside a poll-phase callback, a query on another ready socket can resolve in that same poll
 * phase BEFORE the ticker's timer gets to record the stall — the cumulative delta misses it, but the
 * tick's staleness still exposes it.
 */
function loopTickStalenessMs(): number {
  return _lastLoopTick ? Math.max(0, Date.now() - _lastLoopTick - 500) : 0;
}

/**
 * Pool occupancy at the instant a query asked for a connection — that is the moment a wait needs
 * explaining, so all three counters are sampled before the wait, never after. Note `waiting` counts
 * the queue as it stood on arrival and so excludes this query's own turn in line: a lone waiter
 * legitimately reports 队0, and `总`/`闲` are what show the pool was saturated.
 */
export interface PoolSnapshot { total: number; idle: number; waiting: number }

/** Log prefix per cause. A stall is a real problem whatever caused it, so only 'none' stays quiet. */
const SLOW_QUERY_LABEL: Record<SlowQueryCause, string> = {
  db: 'PG 慢查询',
  pool: 'PG 池饥饿',
  loop: 'PG 查询被事件循环拖慢',
  none: 'PG 查询端到端',
};

function reportSlowQuery(i: SlowQueryTiming & { ms: number; sql: string; pool: PoolSnapshot | null }): void {
  const execHint = i.execBlockedMs >= 1000 ? `[阻塞 ${i.execBlockedMs}ms]` : '';
  const waitHint = i.waitBlockedMs >= 1000 ? `[阻塞 ${i.waitBlockedMs}ms]` : '';
  const poolHint = i.pool ? `，取连接前池 总${i.pool.total}/闲${i.pool.idle}/队${i.pool.waiting}` : '';
  const stallHint = _maxLoopLagMs >= 1000 ? `，进程最长停顿 ${_maxLoopLagMs}ms` : '';
  const detail = `（执行 ${i.execMs}ms${execHint}，池等待 ${i.poolWaitMs}ms${waitHint}${poolHint}${stallHint}）`;
  const cause = classifySlowQuery(i);
  const line = `${SLOW_QUERY_LABEL[cause]} ${i.ms}ms${detail}：${sqlPreview(i.sql)}`;
  if (cause === 'none') log.debug(line);
  else log.warn(line);
}

/**
 * Connection settings shared by both pools. Everything here exists because the server is reached
 * across a WAN link rather than a local socket:
 *   - application_name names the pool AND the OS process, so a backend seen in pg_stat_activity can
 *     be traced back to which of the several agent processes opened it;
 *   - keepAlive: the server's own tcp_keepalives_idle is 2h, long enough for a NAT or firewall on
 *     the path to drop an idle flow unnoticed — the next query on that connection then hangs on TCP
 *     retransmits instead of failing;
 *   - min/idleTimeoutMillis: pg reaps idle connections after 10s by default, so each polling sweep
 *     pays a fresh TCP+auth handshake (~2s across this link, and one lost SYN doubles it). min:1
 *     keeps the last connection from being reaped at all (pg-pool only reaps above min);
 *   - allowExitOnIdle: min:1 means an idle connection is never removed, which would keep one-shot CLI
 *     runs alive forever waiting on its socket. This unrefs idle clients so the process still exits
 *     naturally, without closing the connection the long-running serve process wants kept warm.
 */
function pgPoolConfig(schema: string, max: number, label: string): PoolConfig {
  return {
    connectionString: resolvePgConnectionString(process.env.AGENT_PG_URL as string),
    max,
    min: 1,
    allowExitOnIdle: true,
    options: `-c search_path=${schema}`,
    application_name: `${dbName()}-${label}-${process.pid}`,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: PG_IDLE_TIMEOUT_MS,
    statement_timeout: PG_STATEMENT_TIMEOUT_MS,
    query_timeout: PG_STATEMENT_TIMEOUT_MS > 0 ? PG_STATEMENT_TIMEOUT_MS + 2000 : undefined,
  };
}

/** Announce which backend a pool serves, once per process, at pool construction. */
function logBackendChoice(which: string, schema: string, max: number): void {
  const line = `${which}后端：PostgreSQL（schema=${schema}，pool max=${max}）`;
  if (IS_MCP_PROCESS) log.debug(line);
  else log.info(line);
}

/** A single query result row set, shape-compatible whether the backend is PostgreSQL or SQLite. */
export interface SqlResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

/** Minimal common query interface the store layer programs against, independent of the backend. */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlResult<T>>;
}

/**
 * The target server does not speak SSL at all: pg-connection-string >=2.14 treats
 * sslmode=prefer/require/verify-ca as aliases for verify-full and unconditionally attempts a TLS
 * handshake, which this server rejects outright ("The server does not support SSL connections")
 * instead of falling back to plaintext the way libpq's real `prefer` semantics would. AGENT_PG_URL
 * keeps the user-supplied sslmode=prefer for documentation purposes; every Pool construction strips
 * it so the driver connects in plaintext.
 */
function resolvePgConnectionString(raw: string): string {
  const u = new URL(raw);
  u.searchParams.delete('sslmode');
  return u.toString();
}

/**
 * Wrap a node:sqlite handle as a SqlExecutor so store code written once against `$N` placeholders
 * (the PostgreSQL convention) runs unchanged when AGENT_PG_URL is unset. `$1,$2,...` placeholders are
 * translated to node:sqlite's positional `?` by expanding EVERY occurrence (not just the first) into
 * its own `?` bound to `params[N-1]` — a handful of statements (e.g. spendPt's guarded UPDATE) reuse
 * the same `$N` twice, which PostgreSQL binds to one value both times but node:sqlite's `?` cannot, so
 * a naive one-shot regex substitution would silently under-supply parameters for those statements.
 * A statement is treated as row-returning (`.all()`) when it starts with SELECT/WITH or carries a
 * RETURNING clause (both node:sqlite and PostgreSQL support RETURNING on INSERT/UPDATE/DELETE);
 * everything else runs via `.run()`, reporting `changes` as rowCount with no rows.
 *
 * ILIKE (the FTS5→ILIKE downgrade's replacement operator) is SQLite-illegal syntax, so it is textually
 * downgraded to LIKE here — SQLite's LIKE is already ASCII case-insensitive by default (case-sensitive
 * only via an opt-in pragma this codebase never sets), so the substitution is behavior-preserving for
 * this fallback path; the ESCAPE clause syntax itself is identical in both engines.
 */
function sqliteExecutor(db: Db): SqlExecutor {
  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<SqlResult<T>> {
      const expanded: unknown[] = [];
      const translated = sql
        .replace(/\bILIKE\b/gi, 'LIKE')
        .replace(/\$(\d+)/g, (_match, n: string) => {
          expanded.push(params[Number(n) - 1]);
          return '?';
        });
      const rowReturning = /^\s*(select|with)\b/i.test(translated) || /\breturning\b/i.test(translated);
      const stmt = db.prepare(translated);
      if (rowReturning) {
        const rows = stmt.all(...(expanded as never[])) as T[];
        return { rows, rowCount: rows.length };
      }
      const info = stmt.run(...(expanded as never[]));
      return { rows: [], rowCount: Number(info.changes ?? 0) };
    },
  };
}

/**
 * Wrap a pg Pool or checked-out PoolClient as a SqlExecutor. The Pool case checks a connection out
 * explicitly (instead of pool.query()) so time spent waiting for a free connection is measured
 * separately from statement execution — the two have entirely different remedies (pool starvation vs
 * a slow database), and a merged number cannot tell them apart.
 *
 * Every query outcome is also reported to `breaker`: a success closes it (from any state); a failure
 * is fed through shouldCountAsCircuitFailure first, so a query that merely failed because THIS
 * process starved its own event loop (see circuit-breaker.ts's doc comment) never counts against it.
 */
function pgExecutor(client: PgPool | PoolClient, breaker: PgCircuitBreaker): SqlExecutor {
  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<SqlResult<T>> {
      const started = Date.now();
      const blockedBeforeWait = _cumLoopBlockedMs;
      const pool = (client as PgPool).totalCount !== undefined ? (client as PgPool) : null;
      // Occupancy has to be sampled BEFORE the wait, because that is the instant being explained:
      // "was the pool saturated when this query asked for a connection?". Sampling it at report time
      // instead answers a different question — what the pool looked like once this query had already
      // been served — and for a long query the two can disagree completely (siblings finish and free
      // their connections in between, so a wait caused by a full pool gets reported next to an idle one).
      const poolStats: PoolSnapshot | null = pool
        ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
        : null;
      let checked: PoolClient | null = null;
      try {
        let poolWaitMs = 0;
        let waitBlockedMs = 0;
        let conn: PgPool | PoolClient = client;
        if (pool) {
          checked = await pool.connect();
          poolWaitMs = Date.now() - started;
          waitBlockedMs = _cumLoopBlockedMs - blockedBeforeWait;
          conn = checked;
        }
        const execStart = Date.now();
        const blockedBeforeExec = _cumLoopBlockedMs;
        const res = await conn.query(sql, params as never[]);
        breaker.recordSuccess();
        const ms = Date.now() - started;
        if (ms >= PG_SLOW_QUERY_MS) {
          const execBlockedMs = Math.max(_cumLoopBlockedMs - blockedBeforeExec, loopTickStalenessMs());
          reportSlowQuery({
            ms, execMs: Date.now() - execStart, execBlockedMs, poolWaitMs, waitBlockedMs, sql,
            pool: poolStats,
          });
        }
        return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
      } catch (e) {
        // Callers usually log their own business-level failure without the SQL context; attach it here
        // once (statement + elapsed time) and rethrow unchanged.
        const elapsedMs = Date.now() - started;
        const blockedMs = Math.max(_cumLoopBlockedMs - blockedBeforeWait, loopTickStalenessMs());
        if (shouldCountAsCircuitFailure(e, elapsedMs, blockedMs, PG_SLOW_QUERY_MS)) breaker.recordFailure();
        log.error(`PG 查询失败（${elapsedMs}ms）：${sqlPreview(sql)} — ${(e as Error).message}`);
        throw e;
      } finally {
        checked?.release();
      }
    },
  };
}

// SQLite engine for the agent: a single embedded database file under the runtime
// directory, opened in WAL mode with foreign keys enforced. All access is synchronous.

// The node:sqlite builtin emits an ExperimentalWarning the first time it is loaded.
// This filter drops only that one notice (keeping stderr — the MCP JSON-RPC server's
// log channel — clean) and is installed before the module is loaded below.
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : (warning as { message?: string })?.message ?? '';
  const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string })?.type;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(msg)) return;
  return (_emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

// Load node:sqlite lazily via a synchronous require so the warning filter above is
// in place before the builtin is first evaluated (a static import would hoist ahead of it).
const _require = createRequire(import.meta.url);
function loadSqlite(): typeof import('node:sqlite') {
  return _require('node:sqlite') as typeof import('node:sqlite');
}

let _db: Db | null = null;
let _lpDb: Db | null = null;

/**
 * Name of the active soul, used to name its DB file. Each agent gets its own database:
 * workspaces/<soul>/ ⇒ .agent/<soul>.db. AGENT_SOUL is set by every entry point (serve worker,
 * supervisor, cli/ask/run) and forwarded to the MCP server's own process (Agent.buildMcpConfig),
 * so all processes serving one soul open the same file. Sanitized so it can never escape RUNTIME_DIR.
 */
function dbName(): string {
  const raw = process.env.AGENT_SOUL || 'tudigong'; // mirrors DEFAULT_SOUL in bin/agent.ts
  return raw.replace(/[^A-Za-z0-9._-]/g, '_') || 'tudigong';
}

/** Filesystem path of the database file. AGENT_DB_PATH overrides the whole path (tests use it for isolation). */
function dbPath(): string {
  return process.env.AGENT_DB_PATH || path.join(RUNTIME_DIR, `${dbName()}.db`);
}

/**
 * Whether the current soul's own database (chats/messages/TC/predict/meetups/…) is backed by
 * PostgreSQL. Unlike the shared LP economy (which moves for every soul at once, see lpUsesPg()),
 * only tudigong has been migrated — every other soul (analyst-mira, trader-yifan, …) stays on
 * SQLite indefinitely, so this checks AGENT_SOUL specifically rather than just AGENT_PG_URL.
 */
function soulUsesPg(): boolean {
  const soul = process.env.AGENT_SOUL || 'tudigong';
  return soul === 'tudigong' && !!process.env.AGENT_PG_URL;
}

/** Open (once) and return the raw node:sqlite soul handle. Internal — only tx()'s SQLite fallback needs BEGIN/COMMIT on it directly. */
async function getDbSqliteRaw(): Promise<Db> {
  if (_db) return _db;
  const { DatabaseSync } = loadSqlite();
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  runMigrations(db);
  _db = db;
  return db;
}

// One circuit breaker per independent pool (see circuit-breaker.ts). soulCircuit guards tudigong's
// own database; lpCircuit guards the shared LP economy every soul writes to. A failure on one never
// implies the other is unhealthy, so they are tracked and reasoned about completely separately —
// soulCircuit open diverts the Phase 2 telemetry tables to the outbox; lpCircuit open makes every
// LP-mutating call throw PgUnavailableError outright (Phase 1). Both are exported so supervisor.ts
// can subscribe to transitions (Phase 4 alerting) and `agent doctor` can report current state.
export const soulCircuit = new PgCircuitBreaker({ label: 'soul' });
export const lpCircuit = new PgCircuitBreaker({ label: 'shared' });

/** Read-only peek at the soul pool's breaker state — for optional read-path degradation (e.g.
 *  message_search) and for `agent doctor`. Never mutates state; use shouldDivertSoulWrites() to gate
 *  an actual write attempt. */
export function isSoulPgCircuitOpen(): boolean {
  return soulUsesPg() && soulCircuit.state === 'open';
}

/** Read-only peek at the shared LP pool's breaker state — for supervisor schedulers deciding whether
 *  to skip a run instead of failing it, and for `agent doctor`. Never mutates state. */
export function isLpPgCircuitOpen(): boolean {
  return lpUsesPg() && lpCircuit.state === 'open';
}

/**
 * Whether a soul-db write for one of pg-outbox.ts's OUTBOX_TABLES should be diverted there instead of
 * attempted against PostgreSQL. Mutating (calls soulCircuit.allowRequest()): call this exactly once
 * per write attempt, immediately before choosing between the real getDb()/tx() path and
 * enqueueOutboxWrite() — never as a side-channel status check (use isSoulPgCircuitOpen() for that).
 * When the breaker is closed this is a single cheap comparison, so the happy path pays nothing extra.
 */
export function shouldDivertSoulWrites(): boolean {
  return soulUsesPg() && !soulCircuit.allowRequest();
}

// PostgreSQL connection pool backing tudigong's own soul database. AGENT_PG_SOUL_SCHEMA overrides
// the schema search_path (default 'soul_tudigong'); only test setup uses this, mirroring
// AGENT_PG_SHARED_SCHEMA's role for the LP pool.
const dbAls = new AsyncLocalStorage<PoolClient>();
let _dbPgPool: PgPool | null = null;
function dbPgPool(): PgPool {
  if (_dbPgPool) return _dbPgPool;
  const schema = process.env.AGENT_PG_SOUL_SCHEMA || 'soul_tudigong';
  const max = Number(process.env.AGENT_PG_POOL_MAX) || 5;
  _dbPgPool = new pg.Pool(pgPoolConfig(schema, max, 'soul'));
  // An idle pooled connection dropped by the server (network blip, server restart) emits 'error' on
  // the pool; without a listener Node treats it as an unhandled 'error' event and kills the process.
  // Also feeds the circuit breaker: an idle connection getting reset IS a connection-layer signal,
  // but only when it is not itself an artifact of this process having just starved its own loop (the
  // loop-lag sampler's current staleness is the only signal available here — there is no in-flight
  // query to attribute elapsed/blocked time to, unlike pgExecutor's catch).
  _dbPgPool.on('error', (e) => {
    log.error(`PG 连接池错误（soul 库，空闲连接被断开）：${e.message}`);
    const staleness = loopTickStalenessMs();
    if (shouldCountAsCircuitFailure(e, staleness, staleness, PG_SLOW_QUERY_MS)) soulCircuit.recordFailure();
  });
  ensureLoopLagSampler();
  logBackendChoice('soul 库', schema, max);
  return _dbPgPool;
}

/**
 * Open (once) and return the current soul's database executor. PostgreSQL-backed only when
 * soulUsesPg() (tudigong + AGENT_PG_URL); every other soul keeps using the SQLite fallback, wrapped
 * so the same `$N`-placeholder SQL every store/*.ts call site now uses works unchanged there too.
 *
 * Deliberately NOT gated by soulCircuit here: Phase 2 only diverts a named set of append-only tables
 * (see pg-outbox.ts) to the outbox, at the store-function call sites that write them — every other
 * soul read/write keeps attempting PostgreSQL exactly as before, bounded by the connect/statement
 * timeouts, and reports its own outcome to soulCircuit via pgExecutor.
 */
export async function getDb(): Promise<SqlExecutor> {
  if (soulUsesPg()) {
    const client = dbAls.getStore();
    return pgExecutor(client ?? dbPgPool(), soulCircuit);
  }
  return sqliteExecutor(await getDbSqliteRaw());
}

/**
 * Close the open handles/pools and drop the singletons so the next getDb()/getLpDb() reopens.
 * Mainly for tests. Async because ending a pg.Pool is itself async (its idle connections would
 * otherwise keep a test process's event loop alive); the SQLite-only path underneath is unaffected
 * (no timing change) since it awaits nothing of its own.
 */
export async function closeDb(): Promise<void> {
  for (const h of [_db, _lpDb]) {
    if (!h) continue;
    try { h.close(); } catch { /* ignore close errors */ }
  }
  _db = null;
  _lpDb = null;
  if (_lpPgPool) {
    const pool = _lpPgPool;
    _lpPgPool = null;
    try { await pool.end(); } catch { /* ignore close errors */ }
  }
  if (_dbPgPool) {
    const pool = _dbPgPool;
    _dbPgPool = null;
    try { await pool.end(); } catch { /* ignore close errors */ }
  }
}

// All agents share ONE gamification/LP economy (points, ledger, check-ins, badges) kept in a single
// database, so a member's LP and badges are global rather than per-agent. Per-person conversational
// memory and messages stay in each agent's own <soul>.db. AGENT_LP_DB_PATH overrides the file.
function lpDbPath(): string {
  if (process.env.AGENT_DB_PATH) return process.env.AGENT_DB_PATH; // tests pin everything to one file
  return process.env.AGENT_LP_DB_PATH || path.join(RUNTIME_DIR, 'shared.db');
}

/** Whether the shared LP economy is backed by PostgreSQL (true whenever AGENT_PG_URL is configured, for every soul). */
function lpUsesPg(): boolean {
  return !!process.env.AGENT_PG_URL;
}

/** Open (once) and return the raw node:sqlite LP handle. Internal — only lpTx()'s SQLite fallback needs BEGIN/COMMIT on it directly. */
async function getLpDbSqliteRaw(): Promise<Db> {
  if (lpDbPath() === dbPath()) return getDbSqliteRaw(); // same file → one handle (tests / AGENT_SOUL pinned to the LP file)
  if (_lpDb) return _lpDb;
  const { DatabaseSync } = loadSqlite();
  const file = lpDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000'); // several agent processes may write LP to this one file concurrently
  runMigrations(db);
  _lpDb = db;
  return db;
}

// PostgreSQL connection pool backing the shared LP economy. AGENT_PG_SHARED_SCHEMA overrides the
// schema search_path (default 'shared'); only test setup uses this, so each test file's LP state can
// live in its own throwaway schema, mirroring how AGENT_DB_PATH isolates the SQLite fallback per file.
const lpAls = new AsyncLocalStorage<PoolClient>();
let _lpPgPool: PgPool | null = null;
function lpPgPool(): PgPool {
  if (_lpPgPool) return _lpPgPool;
  const schema = process.env.AGENT_PG_SHARED_SCHEMA || 'shared';
  const max = Number(process.env.AGENT_PG_POOL_MAX) || 5;
  _lpPgPool = new pg.Pool(pgPoolConfig(schema, max, 'lp'));
  // Same rationale as dbPgPool(): an unhandled pool 'error' event would kill the process. Also feeds
  // lpCircuit — see dbPgPool()'s matching handler for why the loop-lag staleness discount applies here too.
  _lpPgPool.on('error', (e) => {
    log.error(`PG 连接池错误（LP 库，空闲连接被断开）：${e.message}`);
    const staleness = loopTickStalenessMs();
    if (shouldCountAsCircuitFailure(e, staleness, staleness, PG_SLOW_QUERY_MS)) lpCircuit.recordFailure();
  });
  ensureLoopLagSampler();
  logBackendChoice('LP 库', schema, max);
  return _lpPgPool;
}

/**
 * Open (once) and return the shared LP database executor. PostgreSQL-backed whenever AGENT_PG_URL is
 * set (for every soul, not just tudigong — see the migration decision record); otherwise the SQLite
 * fallback, wrapped so `$N`-placeholder SQL (the convention every store/*.ts call site now uses)
 * still works unchanged.
 *
 * Gated by lpCircuit.allowRequest() whenever this is not already inside a bound transaction: when the
 * breaker is open this throws PgUnavailableError immediately, without ever touching the pool — LP
 * economy calls (checkIn/spendPt/grantPt/profile reads/leaderboard, …) get a fast, explicit refusal
 * instead of waiting out a connection attempt already known to fail (Phase 1; full LP failover onto
 * SQLite was evaluated and explicitly rejected — see the research report's split-brain analysis).
 * Already-bound calls (inside lpTx()) are not re-gated: lpTx() itself already gated at entry, and the
 * transaction's connection is already live.
 */
export async function getLpDb(): Promise<SqlExecutor> {
  if (lpUsesPg()) {
    const existing = lpAls.getStore();
    if (existing) return pgExecutor(existing, lpCircuit);
    if (!lpCircuit.allowRequest()) throw new PgUnavailableError(lpCircuit.label);
    return pgExecutor(lpPgPool(), lpCircuit);
  }
  return sqliteExecutor(await getLpDbSqliteRaw());
}

/**
 * Run a function inside a single atomic transaction on the shared LP database.
 *
 * PostgreSQL branch: checks out one pooled connection, BEGINs on it, and binds it to an
 * AsyncLocalStorage context so every nested getLpDb() call within `fn` (including calls made by
 * other store functions `fn` invokes, however deeply nested) resolves to that SAME connection —
 * mirroring the single-process-wide-handle behavior node:sqlite gave for free. Re-entrant: a nested
 * lpTx() while already inside one just runs inline (no second BEGIN), matching the "Raw"-suffixed
 * inner-function convention throughout store/gamification.ts that never double-wraps.
 *
 * SQLite branch (AGENT_PG_URL unset): unchanged from Phase 1 — reuses the per-agent transaction when
 * the LP file and the soul file are the same, otherwise BEGIN/COMMIT directly on the raw handle.
 *
 * PG branch is gated by lpCircuit.allowRequest() exactly like getLpDb(): when the breaker is open this
 * throws PgUnavailableError before even attempting lpPgPool().connect() (Phase 1's fast refusal). The
 * connect() attempt itself (when allowed) is also fed to lpCircuit — this is the one failure surface
 * getDb()/getLpDb()'s own pgExecutor cannot see, since it happens before any SqlExecutor exists.
 */
export async function lpTx<T>(fn: () => Promise<T>): Promise<T> {
  if (lpUsesPg()) {
    const existing = lpAls.getStore();
    if (existing) return fn();
    if (!lpCircuit.allowRequest()) throw new PgUnavailableError(lpCircuit.label);
    const started = Date.now();
    const blockedBeforeConnect = _cumLoopBlockedMs;
    let client: PoolClient;
    try {
      client = await lpPgPool().connect();
    } catch (e) {
      const elapsedMs = Date.now() - started;
      const blockedMs = Math.max(_cumLoopBlockedMs - blockedBeforeConnect, loopTickStalenessMs());
      if (shouldCountAsCircuitFailure(e, elapsedMs, blockedMs, PG_SLOW_QUERY_MS)) lpCircuit.recordFailure();
      throw e;
    }
    try {
      await client.query('BEGIN');
      const result = await lpAls.run(client, fn);
      await client.query('COMMIT');
      lpCircuit.recordSuccess();
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => { /* ignore secondary rollback failure */ });
      throw e;
    } finally {
      client.release();
      const ms = Date.now() - started;
      if (ms >= PG_SLOW_TX_MS) log.warn(`PG 长交易 ${ms}ms（LP 库）——期间独占一条池连接，留意池饥饿`);
    }
  }
  if (lpDbPath() === dbPath()) return tx(fn); // same file → reuse the per-agent transaction
  const db = await getLpDbSqliteRaw();
  db.exec('BEGIN');
  try {
    const r = await fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore secondary rollback failure */ }
    throw e;
  }
}

/**
 * Run a function inside a single atomic transaction on the current soul's own database.
 *
 * PostgreSQL branch (tudigong only, once AGENT_PG_URL is set): mirrors lpTx()'s AsyncLocalStorage
 * design exactly — checks out one pooled connection, BEGINs on it, and binds it so every nested
 * getDb() call within `fn` resolves to that SAME connection. Re-entrant: a nested tx() while already
 * inside one just runs inline (no second BEGIN).
 *
 * SQLite branch (every other soul, indefinitely — see the migration decision record): unchanged
 * from Phase 1 — BEGIN/COMMIT directly on the raw handle.
 *
 * Deliberately NOT gated by soulCircuit.allowRequest() (contrast with lpTx()): Phase 2 only diverts a
 * named set of append-only tables at their own store-function call sites (see pg-outbox.ts), which
 * skip calling tx() entirely when diverting. Every other soul transaction attempts
 * dbPgPool().connect() exactly as before, bounded by the connect timeout, and reports its own outcome
 * to soulCircuit so the breaker's state — and therefore the outbox-diversion decision elsewhere —
 * stays accurate even though this code path itself does not act on it.
 */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (soulUsesPg()) {
    const existing = dbAls.getStore();
    if (existing) return fn();
    const started = Date.now();
    const blockedBeforeConnect = _cumLoopBlockedMs;
    let client: PoolClient;
    try {
      client = await dbPgPool().connect();
    } catch (e) {
      const elapsedMs = Date.now() - started;
      const blockedMs = Math.max(_cumLoopBlockedMs - blockedBeforeConnect, loopTickStalenessMs());
      if (shouldCountAsCircuitFailure(e, elapsedMs, blockedMs, PG_SLOW_QUERY_MS)) soulCircuit.recordFailure();
      throw e;
    }
    try {
      await client.query('BEGIN');
      const result = await dbAls.run(client, fn);
      await client.query('COMMIT');
      soulCircuit.recordSuccess();
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => { /* ignore secondary rollback failure */ });
      throw e;
    } finally {
      client.release();
      const ms = Date.now() - started;
      if (ms >= PG_SLOW_TX_MS) log.warn(`PG 长交易 ${ms}ms（soul 库）——期间独占一条池连接，留意池饥饿`);
    }
  }
  const db = await getDbSqliteRaw();
  db.exec('BEGIN');
  try {
    const r = await fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore secondary rollback failure */ }
    throw e;
  }
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS chats (
  chat_id      TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  chat_type    TEXT,
  chat_mode    TEXT,
  external     INTEGER NOT NULL DEFAULT 0,
  tenant_key   TEXT,
  lark_profile TEXT,
  first_seen   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS messages (
  message_id        TEXT PRIMARY KEY,
  chat_id           TEXT NOT NULL REFERENCES chats(chat_id),
  sender_open_id    TEXT NOT NULL DEFAULT '',
  sender_id_type    TEXT,
  sender_type       TEXT,
  sender_tenant_key TEXT,
  sender_name       TEXT NOT NULL DEFAULT '',
  msg_type          TEXT NOT NULL DEFAULT 'text',
  text              TEXT NOT NULL DEFAULT '',
  mentions          TEXT NOT NULL DEFAULT '[]',
  thread_id         TEXT,
  thread_message_position INTEGER,
  message_position  INTEGER,
  create_time       INTEGER NOT NULL DEFAULT 0,
  updated           INTEGER NOT NULL DEFAULT 0,
  deleted           INTEGER NOT NULL DEFAULT 0,
  raw               TEXT,
  collected_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, create_time DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_open_id, create_time DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, thread_message_position) WHERE thread_id IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  message_id UNINDEXED,
  chat_id UNINDEXED,
  content=messages,
  content_rowid=rowid,
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, message_id, chat_id) VALUES (new.rowid, new.text, new.message_id, new.chat_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, message_id, chat_id) VALUES ('delete', old.rowid, old.text, old.message_id, old.chat_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, message_id, chat_id) VALUES ('delete', old.rowid, old.text, old.message_id, old.chat_id);
  INSERT INTO messages_fts(rowid, text, message_id, chat_id) VALUES (new.rowid, new.text, new.message_id, new.chat_id);
END;

CREATE TABLE IF NOT EXISTS profiles (
  open_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  pt_balance INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS pt_ledger (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_open_id   TEXT NOT NULL REFERENCES profiles(open_id),
  delta          INTEGER NOT NULL,
  reason         TEXT NOT NULL DEFAULT '',
  ref_message_id TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON pt_ledger(user_open_id, created_at);

CREATE TABLE IF NOT EXISTS badges (
  badge_id    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS user_badges (
  user_open_id TEXT NOT NULL REFERENCES profiles(open_id),
  badge_id     TEXT NOT NULL REFERENCES badges(badge_id),
  awarded_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  ref          TEXT,
  PRIMARY KEY (user_open_id, badge_id)
);

CREATE TABLE IF NOT EXISTS activities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT NOT NULL,
  actor_open_id  TEXT,
  chat_id        TEXT,
  ref_message_id TEXT,
  payload        TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_activities_actor ON activities(actor_open_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type, created_at);
`;

const SCHEMA_V2 = `
ALTER TABLE profiles ADD COLUMN level INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_messages_sender_time ON messages(sender_open_id, create_time DESC);
CREATE INDEX IF NOT EXISTS idx_activities_actor_type ON activities(actor_open_id, type, created_at DESC);
INSERT OR IGNORE INTO badges(badge_id, name, description, emoji) VALUES ('first_contact', '初次见面', '第一次和我互动', '👋');
`;

const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS checkins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_open_id TEXT NOT NULL REFERENCES profiles(open_id),
  checkin_date TEXT NOT NULL,
  pt_awarded   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_open_id, checkin_date)
);
CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_open_id, checkin_date DESC);
`;

// Error ledger: every kimi/agent failure is recorded here (classification, exit metadata, whether
// self-heal kicked in). Powers the background janitor's threshold alerts and `agent doctor`.
const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  corr_id     TEXT,
  soul        TEXT,
  chat_id     TEXT,
  source      TEXT,
  kind        TEXT NOT NULL DEFAULT 'unknown',
  summary     TEXT NOT NULL DEFAULT '',
  exit_code   INTEGER,
  signal      TEXT,
  duration_ms INTEGER,
  attempt     INTEGER NOT NULL DEFAULT 1,
  healed      INTEGER NOT NULL DEFAULT 0,
  postmortem  TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_errors_time ON errors(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_chat_time ON errors(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_kind_time ON errors(kind, created_at DESC);
`;

// In-flight LLM replies, persisted so a worker restart (hot-reload / crash) that interrupts a reply
// can recover: clear the orphaned "thinking" reaction, refund the charged LP, and re-run the answer.
// A row exists only while a reply is being generated; it is deleted the moment the reply is sent
// (success OR handled error), so on startup any leftover rows are exactly the interrupted ones.
const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS pending_replies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id       TEXT NOT NULL,
  channel        TEXT NOT NULL,
  chat_id        TEXT NOT NULL,
  message_id     TEXT,
  session_key    TEXT NOT NULL DEFAULT '',
  sender_open_id TEXT,
  text           TEXT NOT NULL DEFAULT '',
  reaction_id    TEXT,
  pt_spent       INTEGER NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_pending_agent ON pending_replies(agent_id, channel);
`;

// Event system (management-game events): an event = a base image + overlaid text + markdown caption,
// sent to a group (global) or a person (personal / P2P). Each fire is recorded with its send status
// and the resulting feishu message_id, so a later feature can tally reactions on it.
//   event_types      — event definitions (base image + overlay/render config + markdown templates)
//   event_dispatches — one row per fire: payload, status (pending/sent/failed), message_id
//   event_reactions  — reserved: reactions harvested on a dispatched message (filled by a later sync)
const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS event_types (
  event_type_id  TEXT PRIMARY KEY,
  title          TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',
  scope          TEXT NOT NULL DEFAULT 'global',
  target_chat_id TEXT,
  base_image     TEXT,
  render_config  TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS event_dispatches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type_id  TEXT NOT NULL,
  trigger_reason TEXT NOT NULL DEFAULT '',
  scope          TEXT NOT NULL DEFAULT 'global',
  actor_open_id  TEXT,
  target         TEXT,
  rendered_image TEXT,
  payload        TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  message_id     TEXT,
  error_msg      TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_event_dispatches_type ON event_dispatches(event_type_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_dispatches_actor ON event_dispatches(actor_open_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_dispatches_status ON event_dispatches(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_dispatches_message ON event_dispatches(message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_reactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id     INTEGER NOT NULL,
  message_id      TEXT NOT NULL,
  reactor_open_id TEXT NOT NULL,
  emoji_type      TEXT NOT NULL,
  reacted_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(dispatch_id, reactor_open_id, emoji_type)
);
CREATE INDEX IF NOT EXISTS idx_event_reactions_dispatch ON event_reactions(dispatch_id);
`;

// Per-event scheduling state for the timed+random trigger engine. One row per scheduled event,
// tracking when it was last *rolled* (so a weekly cadence doesn't re-roll daily) and when it last
// actually *fired*. last_outcome is 'fired' / 'missed' (dice failed) / 'skipped' (prepare aborted).
const SCHEMA_V7 = `
CREATE TABLE IF NOT EXISTS event_schedule_state (
  event_type_id TEXT PRIMARY KEY,
  last_eval_at  INTEGER,
  last_fire_at  INTEGER,
  last_outcome  TEXT
);
`;

// next_fire_at: a planned within-window fire time (unix seconds) that's been scheduled for the
// current logical day but hasn't rolled yet. Persisted so a supervisor restart re-arms the same
// instant instead of re-randomising or double-firing. Cleared (NULL) once the roll resolves.
const SCHEMA_V8 = `
ALTER TABLE event_schedule_state ADD COLUMN next_fire_at INTEGER;
`;

// Member directory: every person seen in a monitored chat's roster (internal AND external), captured
// even if they never sent a message. Kept SEPARATE from profiles on purpose — profiles is the
// gamification table (the daily LP floor reset tops every profile up), so dumping the whole community
// roster there would hand LP to non-participants. `present` flags current membership; rows are never
// deleted (a member who leaves is kept with present=0 in case they return).
const SCHEMA_V9 = `
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id    TEXT NOT NULL,
  open_id    TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  present    INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chat_id, open_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_open ON chat_members(open_id);
`;

// Operational time-series of the periodic (≈5-min) member roster sync. One row per sync round,
// aggregated across all monitored chats: the in-group head-count (present_total, summed per chat so
// a member in N chats counts N times — mirrors the "在群合计" log line), this round's joined/left/
// renamed deltas, the cumulative distinct roster size (roster_total = directoryStats().distinct), and
// the (open_id, name) detail of each joiner/leaver/renamer as a "(ou, name),(ou, name)" string.
// Powers ops analytics. Historical rounds are backfilled from logs (counts only; per-person detail is
// left empty for those). synced_at is UNIQUE so backfill is idempotent and never double-records a round.
const SCHEMA_V10 = `
CREATE TABLE IF NOT EXISTS member_sync_rounds (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at      INTEGER NOT NULL,
  chat_count     INTEGER NOT NULL DEFAULT 0,
  present_total  INTEGER NOT NULL DEFAULT 0,
  joined_count   INTEGER NOT NULL DEFAULT 0,
  left_count     INTEGER NOT NULL DEFAULT 0,
  renamed_count  INTEGER NOT NULL DEFAULT 0,
  roster_total   INTEGER NOT NULL DEFAULT 0,
  joined_detail  TEXT NOT NULL DEFAULT '',
  left_detail    TEXT NOT NULL DEFAULT '',
  renamed_detail TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT 'live',
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_sync_rounds_at ON member_sync_rounds(synced_at);
`;

// Deduped current head-counts (distinct open_ids present RIGHT NOW; a member in N chats counts once),
// as opposed to present_total which sums per-chat rosters, and roster_total which counts distinct
// EVER-seen (including leavers). All three are recorded for live rounds and left 0 for backfilled
// rounds (the historical logs never carried them):
//   present_distinct — distinct present across ALL monitored chats
//   present_internal — distinct present in INTERNAL chats (chats.external = 0)
//   present_external — distinct present in EXTERNAL chats (chats.external = 1)
// internal + external can exceed present_distinct: someone in both an internal and an external chat
// is counted once in each category but once overall.
const SCHEMA_V11 = `
ALTER TABLE member_sync_rounds ADD COLUMN present_distinct INTEGER NOT NULL DEFAULT 0;
ALTER TABLE member_sync_rounds ADD COLUMN present_internal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE member_sync_rounds ADD COLUMN present_external INTEGER NOT NULL DEFAULT 0;
`;

// dissolved_at: stamped (unix seconds) when we mark a monitored chat INACTIVE — either dissolved
// (Feishu 232009) or sustained-inaccessible (we were kicked / lost permission). NULL = active. Once set,
// the poll loop stops, the member sync skips it, and rediscovery won't blindly re-listen — so a vanished
// or inaccessible group stops spamming errors on every poll/sync. (Name kept for migration stability;
// inactive_reason below says which case it is.)
const SCHEMA_V12 = `
ALTER TABLE chats ADD COLUMN dissolved_at INTEGER;
`;

// inactive_reason: why a chat was marked inactive — 'dissolved' (232009, permanent) or 'inaccessible'
// (kicked out / no permission, possibly recoverable). Drives both reporting (agent doctor) and resume:
// an 'inaccessible' chat that reappears in live discovery (we were re-added) is reactivated, while a
// 'dissolved' one stays skipped. NULL when the chat is active.
const SCHEMA_V13 = `
ALTER TABLE chats ADD COLUMN inactive_reason TEXT;
`;

// RSVP signup-count time-series for upcoming Feishu calendar events. Symmetric to member_sync_rounds:
// one row per (poll-round, event), idempotent via UNIQUE(synced_at, event_id). accepted is the headline
// signup count (rsvp_status='accept'); declined/tentative/needs_action are stored separately so callers
// can compose their own aggregates. signup_total = all non-removed attendees (reference only, not the
// headline). calendar_id stores the actual organizer_calendar_id from +agenda (not the literal 'primary').
// start_time/end_time are redundantly stored as unix seconds to avoid re-fetching on every chart query.
const SCHEMA_V14 = `
CREATE TABLE IF NOT EXISTS calendar_event_rsvp_rounds (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at      INTEGER NOT NULL,        -- unix seconds, part of the idempotency key
  event_id       TEXT NOT NULL,           -- Feishu calendar event id (UUID + recurrence-instance suffix)
  calendar_id    TEXT NOT NULL DEFAULT '',-- organizer_calendar_id the event lives on
  title          TEXT NOT NULL DEFAULT '',
  start_time     INTEGER NOT NULL DEFAULT 0, -- event start, unix seconds
  end_time       INTEGER NOT NULL DEFAULT 0, -- event end, unix seconds
  accepted       INTEGER NOT NULL DEFAULT 0, -- rsvp_status=accept; the headline signup count
  declined       INTEGER NOT NULL DEFAULT 0, -- rsvp_status=decline
  tentative      INTEGER NOT NULL DEFAULT 0, -- rsvp_status=tentative
  needs_action   INTEGER NOT NULL DEFAULT 0, -- rsvp_status=needs_action
  signup_total   INTEGER NOT NULL DEFAULT 0, -- all non-removed attendees, reference only
  source         TEXT NOT NULL DEFAULT 'live',
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_event_rsvp_rounds_at_event
  ON calendar_event_rsvp_rounds(synced_at, event_id);
CREATE INDEX IF NOT EXISTS idx_calendar_event_rsvp_rounds_event
  ON calendar_event_rsvp_rounds(event_id, synced_at DESC);
`;

// Append-only log of knowledge-base document view records. The Feishu access-record API is per-file
// and returns one entry per distinct viewer carrying that viewer's most-recent view time, so a
// UNIQUE(file_token, viewer_id, last_view_time) key with INSERT OR IGNORE turns repeated polling into
// change detection: a view already recorded is ignored, while a new viewer or an advanced view time
// inserts a fresh row. Each row therefore marks one observed view at the polled granularity, not a
// running snapshot. source records where the document was discovered ('wiki' space vs the user's
// 'drive'); space_id and title are denormalized so queries need not re-walk the document tree.
const SCHEMA_V15 = `
CREATE TABLE IF NOT EXISTS doc_view_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  file_token     TEXT NOT NULL,
  file_type      TEXT NOT NULL DEFAULT '',  -- docx/sheet/bitable/mindnote/file/doc
  source         TEXT NOT NULL DEFAULT '',  -- 'wiki' | 'drive'
  space_id       TEXT NOT NULL DEFAULT '',  -- wiki space id when source='wiki', else empty
  title          TEXT NOT NULL DEFAULT '',
  viewer_id      TEXT NOT NULL,             -- viewer open_id
  viewer_name    TEXT NOT NULL DEFAULT '',
  last_view_time INTEGER NOT NULL DEFAULT 0, -- viewer's most-recent view, unix seconds
  recorded_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_view_events_unique
  ON doc_view_events(file_token, viewer_id, last_view_time);
CREATE INDEX IF NOT EXISTS idx_doc_view_events_file
  ON doc_view_events(file_token, last_view_time DESC);
CREATE INDEX IF NOT EXISTS idx_doc_view_events_recorded
  ON doc_view_events(recorded_at DESC);
`;

// De-duplication ledger for user-token expiry reminders. One row per (authorization grant, day-before
// threshold) marks that a reminder for that threshold has already been pushed, so each threshold fires
// at most once. grant_key embeds the grant's identity (profile + grant timestamp), so re-authorizing —
// which starts a new grant and moves the deadline out — yields a fresh key and a clean reminder cycle.
const SCHEMA_V16 = `
CREATE TABLE IF NOT EXISTS token_expiry_alerts (
  grant_key  TEXT NOT NULL,           -- profile + authorization grant timestamp
  threshold  INTEGER NOT NULL,        -- days-before-expiry mark (3/2/1/0)
  sent_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (grant_key, threshold)
);
`;

// Badge metadata expansion: adds rich semantic fields to the badges table (headline, file, type,
// role, endorser, duration, category, event) and award provenance to user_badges (awarded_by, note).
// All new columns are nullable TEXT with empty-string defaults so existing rows are untouched.
const SCHEMA_V17 = `
ALTER TABLE badges ADD COLUMN headline  TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN file      TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN title     TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN type      TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN role      TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN endorser  TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN duration  TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN category  TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN event     TEXT NOT NULL DEFAULT '';
ALTER TABLE user_badges ADD COLUMN awarded_by TEXT;
ALTER TABLE user_badges ADD COLUMN note TEXT;
`;

// Long-term memory store: scoped by namespace for per-user, per-group, and cross-group isolation.
// namespace encodes the access scope: 'global' | 'group:{chat_id}' | 'user:{open_id}' |
// 'group_user:{chat_id}:{open_id}'. Visibility controls who can read a row beyond namespace
// membership. Sensitivity is advisory (affects log redaction, not LLM access). source distinguishes
// manually written entries from automatically generated summaries.
const SCHEMA_V18 = `
CREATE TABLE IF NOT EXISTS memory_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace    TEXT NOT NULL,
  key          TEXT,
  content      TEXT NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'private',
  sensitivity  TEXT NOT NULL DEFAULT 'normal',
  source       TEXT NOT NULL DEFAULT 'manual',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_items(namespace, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_visibility ON memory_items(visibility, namespace);
`;

/**
 * LP rename: databases created before this change named the gamification points table and columns
 * `ap_*` (the legacy "AP" terminology). The live schema now uses `pt_*` (LP / 生命点). This brings an
 * existing DB up to the new shape by renaming in place, so the rows survive as the same data under the
 * new names. On a fresh DB the schema is already `pt_*`, so every guard is false and this is a no-op.
 * The `ap_*` names below are the legacy ones being migrated away; they appear nowhere else.
 */
function migrateLpRename(db: Db): void {
  const columns = (table: string): Set<string> =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
  const tableExists = (name: string): boolean =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

  const profiles = columns('profiles');
  if (profiles.has('ap_balance') && !profiles.has('pt_balance')) {
    db.exec('ALTER TABLE profiles RENAME COLUMN ap_balance TO pt_balance');
  }
  const checkins = columns('checkins');
  if (checkins.has('ap_awarded') && !checkins.has('pt_awarded')) {
    db.exec('ALTER TABLE checkins RENAME COLUMN ap_awarded TO pt_awarded');
  }
  const pending = columns('pending_replies');
  if (pending.has('ap_spent') && !pending.has('pt_spent')) {
    db.exec('ALTER TABLE pending_replies RENAME COLUMN ap_spent TO pt_spent');
  }
  if (tableExists('ap_ledger') && !tableExists('pt_ledger')) {
    db.exec('ALTER TABLE ap_ledger RENAME TO pt_ledger'); // the idx_ledger_user index follows the rename
  }
}

// Identity links: alias multiple per-app open_ids of the same human to one canonical LP identity, so a
// member's points/badges follow them across agents (each Feishu app gives a person a different open_id).
// Lives in the shared LP database; the LP layer resolves open_id → canonical_id before every read/write.
const SCHEMA_V20 = `
CREATE TABLE IF NOT EXISTS identity_links (
  open_id      TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_identity_links_canonical ON identity_links(canonical_id);
`;

// Chat reaction harvest: one row per (message, reactor, emoji) reaction observed by the reaction-sync
// poll on non-work groups. Deduped by the composite PK so re-seeing the same reaction on later polls is
// a no-op (INSERT OR IGNORE). Each row keeps the reaction's action_time so a member's like count within a
// logical week (a windowed COUNT(*) by reactor) can drive the like-maniac milestone. Lives in the per-soul
// db (like chat_members / doc_view_events); the shared LP db gets the (empty, unused) table too since both
// dbs share one migration set.
const SCHEMA_V21 = `
CREATE TABLE IF NOT EXISTS chat_reactions (
  message_id      TEXT NOT NULL,
  chat_id         TEXT NOT NULL,
  reactor_open_id TEXT NOT NULL,
  emoji_type      TEXT NOT NULL,
  action_time     INTEGER NOT NULL DEFAULT 0,
  first_seen      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (message_id, reactor_open_id, emoji_type)
);
CREATE INDEX IF NOT EXISTS idx_chat_reactions_reactor ON chat_reactions(reactor_open_id);
`;

// Pinned messages: one row per message the reaction poll has auto-pinned (once a message drew reactions
// from >= a chat's autoPinMinReactors distinct people). The PK makes the pin idempotent — a message
// already recorded here is never re-pinned, so the poll doesn't hammer the pin API on every round.
const SCHEMA_V22 = `
CREATE TABLE IF NOT EXISTS pinned_messages (
  message_id    TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  reactor_count INTEGER NOT NULL DEFAULT 0,
  pinned_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

// Activity meetups: one row per Feishu calendar event managed by the activity module. lark_event_id
// stores the recurring-series UUID (bare, without the _<ts> occurrence suffix) so queries span the
// whole series. status 'cancelled' is a soft-delete that preserves history while hiding the event
// from upcoming-digest and wiki queries. meetup_url and app_link are captured at creation time from
// the Feishu events.create response so the bot never needs to re-fetch calendar data.
const SCHEMA_V23 = `
CREATE TABLE IF NOT EXISTS activity_meetups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  lark_event_id  TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',
  recurrence     TEXT NOT NULL DEFAULT '',
  start_time     INTEGER NOT NULL DEFAULT 0,
  end_time       INTEGER NOT NULL DEFAULT 0,
  meetup_url    TEXT NOT NULL DEFAULT '',
  app_link       TEXT NOT NULL DEFAULT '',
  calendar_id    TEXT NOT NULL DEFAULT '',
  created_by     TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'confirmed',
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_activity_meetups_start ON activity_meetups(start_time);
CREATE INDEX IF NOT EXISTS idx_activity_meetups_status ON activity_meetups(status);

CREATE TABLE IF NOT EXISTS activity_meetup_tags (
  meetup_id INTEGER NOT NULL REFERENCES activity_meetups(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  PRIMARY KEY (meetup_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_activity_meetup_tags_tag ON activity_meetup_tags(tag);
`;

// Meetup tag subscriptions: one row per (user, tag) pair. A subscriber receives an @-mention in the
// daily 08:00 group digest when any confirmed meetup carrying that tag is scheduled for that day.
const SCHEMA_V24 = `
CREATE TABLE IF NOT EXISTS meetup_subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_open_id TEXT NOT NULL,
  tag          TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_open_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_meetup_subscriptions_tag  ON meetup_subscriptions(tag);
CREATE INDEX IF NOT EXISTS idx_meetup_subscriptions_user ON meetup_subscriptions(user_open_id);
`;

// Public calendar share link (feishu.cn/calendar/share?token=...) captured at creation time,
// surfaced in bot replies and the wiki calendar page so members can open and subscribe to the event.
const SCHEMA_V25 = `
ALTER TABLE activity_meetups ADD COLUMN share_link TEXT NOT NULL DEFAULT '';
`;

// Visitor-count milestones: one frozen row per (chat, hundred) recording who the milestone-th visitor
// was (present-member arrival order). Serves as the persistent, restart-proof idempotency ledger for
// the visitor-num-notify announcement so a milestone is announced exactly once, ever.
const SCHEMA_V26 = `
CREATE TABLE IF NOT EXISTS visitor_milestones (
  chat_id    TEXT NOT NULL,
  milestone  INTEGER NOT NULL,
  open_id    TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  reached_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chat_id, milestone)
);
`;

// Self-service display-name overrides: one row per open_id a member has renamed themselves to via the
// "@我 改名 <名字>" command. Lives in the shared LP database (like identity_links) so a member's chosen
// name follows them across every agent. Applied at render time by name-overrides.ts on top of the raw
// captured Feishu name — which the 5-minute roster sync keeps overwriting — so the rename actually
// sticks. The operator-curated configs/name-overrides.json still takes precedence over this self-service
// layer. Keyed by open_id (not name) on purpose: display resolves by identity, so a later rename is free.
const SCHEMA_V27 = `
CREATE TABLE IF NOT EXISTS name_overrides (
  open_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

// Like-maniac weekly announcement ledger: one row per (logical week, member) the like-maniac milestone
// has already fired for. week_start is the epoch-second start of the logical week (Monday 05:00 local).
// The PK makes the announcement fire at most once per member per week — a restart-proof gate (same
// pattern as visitor_milestones), so the weekly 66-reaction milestone never re-fires after a restart or
// on a later poll in the same week. Lives in the per-soul db alongside chat_reactions.
const SCHEMA_V28 = `
CREATE TABLE IF NOT EXISTS like_maniac_weeks (
  week_start     INTEGER NOT NULL,
  open_id        TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  reaction_count INTEGER NOT NULL DEFAULT 0,
  reached_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (week_start, open_id)
);
`;

// TC (Temperature Check) module — per-soul db tables.
// v29: proposal counter + proposal metadata; v30: individual bet records.
// LP ledger operations (debit/credit/refund) use the shared pt_ledger in shared.db — no new table needed there.

// Atomic proposal counter (single row, id=1 enforced by CHECK) for monotonically increasing TC numbers.
// Proposal table stores the full lifecycle: active → settled | cancelled.
// settled_option TEXT accommodates discrete winners as a JSON array (single or tie), since REAL cannot store strings.
const SCHEMA_V29 = `
CREATE TABLE IF NOT EXISTS tc_counter (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  next_num INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO tc_counter(id, next_num) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS tc_proposals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  num             INTEGER NOT NULL UNIQUE,
  title           TEXT    NOT NULL DEFAULT '',
  option_type     TEXT    NOT NULL DEFAULT 'discrete',
  options         TEXT    NOT NULL DEFAULT '[]',
  end_time        INTEGER NOT NULL,
  min_bet_lp      REAL    NOT NULL DEFAULT 1.0,
  max_bet_lp      REAL    NOT NULL DEFAULT 10.0,
  status          TEXT    NOT NULL DEFAULT 'active',
  created_by      TEXT    NOT NULL DEFAULT '',
  chat_id         TEXT    NOT NULL DEFAULT '',
  top_message_id  TEXT    NOT NULL DEFAULT '',
  thread_id       TEXT,
  settled_value   REAL,
  settled_option  TEXT,
  settled_at      INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_tc_proposals_num
  ON tc_proposals(num);
CREATE INDEX IF NOT EXISTS idx_tc_proposals_status
  ON tc_proposals(status);
CREATE INDEX IF NOT EXISTS idx_tc_proposals_end_time
  ON tc_proposals(end_time);
CREATE INDEX IF NOT EXISTS idx_tc_proposals_thread
  ON tc_proposals(thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tc_proposals_top_msg
  ON tc_proposals(top_message_id);
`;

// Bet records: no UNIQUE(proposal_id, user_open_id) — each user may bet multiple times on different options,
// and each bet on the same option accumulates toward the per-user max_bet_lp ceiling.
const SCHEMA_V30 = `
CREATE TABLE IF NOT EXISTS tc_bets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id   INTEGER NOT NULL REFERENCES tc_proposals(id),
  user_open_id  TEXT    NOT NULL,
  option_value  TEXT    NOT NULL,
  lp_amount     REAL    NOT NULL,
  message_id    TEXT    NOT NULL DEFAULT '',
  is_refunded   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_tc_bets_proposal
  ON tc_bets(proposal_id);
CREATE INDEX IF NOT EXISTS idx_tc_bets_user
  ON tc_bets(user_open_id, proposal_id);
CREATE INDEX IF NOT EXISTS idx_tc_bets_refund
  ON tc_bets(proposal_id, is_refunded);
`;

// The module was originally shipped under the name CVP (cvp_* tables). It was renamed to TC
// (Temperature Check). This migration drops the disposable legacy tables and ensures the tc_* tables
// exist, so a database created before the rename converges on the new schema. Bets drop first because
// they reference the proposals table.
const SCHEMA_V31 = `
DROP TABLE IF EXISTS cvp_bets;
DROP TABLE IF EXISTS cvp_proposals;
DROP TABLE IF EXISTS cvp_counter;
` + SCHEMA_V29 + SCHEMA_V30;

// SeeDAO community history "memory fragments": short (~15-30 char) trivia lines harvested from the SeeDAO
// Notion history pages, drawn at random to greet or educate members. Written and read through the shared
// LP database (getLpDb) because this is cross-agent, cross-module community knowledge — closer to
// badges/profiles than to per-soul operational data. content_norm (whitespace/punctuation-stripped and
// lowercased) carries a UNIQUE index so INSERT OR IGNORE dedupes near-identical wording. status supports
// soft-archiving instead of deletion. rating_count/rating_sum are reserved aggregate caches for a future
// rating feature (a detail table would keep them in sync, mirroring pt_ledger → profiles.pt_balance);
// nothing reads or writes them yet.
const SCHEMA_V32 = `
CREATE TABLE IF NOT EXISTS memory_fragments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  content       TEXT    NOT NULL,
  content_norm  TEXT    NOT NULL,
  source_url    TEXT    NOT NULL DEFAULT '',
  source_note   TEXT    NOT NULL DEFAULT '',
  category      TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'active',
  added_by      TEXT    NOT NULL DEFAULT '',
  rating_count  INTEGER NOT NULL DEFAULT 0,
  rating_sum    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_fragments_norm ON memory_fragments(content_norm);
CREATE INDEX IF NOT EXISTS idx_memory_fragments_status ON memory_fragments(status);
CREATE INDEX IF NOT EXISTS idx_memory_fragments_category ON memory_fragments(category);
`;

// Pending newcomer-welcome queue (per-soul db). The 5-minute roster sync enqueues each genuinely new
// member of the visitor group here instead of welcoming immediately; a scheduled digest (08:30/14:30/
// 20:30) drains the queue and sends ONE batched welcome that @-mentions everyone who joined since the
// last digest. PK (chat_id, open_id) + INSERT OR IGNORE dedupes a member queued more than once before a
// digest runs. Rows are deleted wholesale after each digest, so the queue only ever holds the current
// window's arrivals.
const SCHEMA_V33 = `
CREATE TABLE IF NOT EXISTS pending_welcome (
  chat_id   TEXT NOT NULL,
  open_id   TEXT NOT NULL,
  name      TEXT NOT NULL DEFAULT '',
  queued_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chat_id, open_id)
);
`;

// Community Prediction module (predict_*) — per-soul db tables, discrete-option-only. Unlike TC,
// there is no automatic settlement: a proposal is closed by a "predict_judge" badge holder manually
// announcing the winning option (announced_by records who did it). end_time only gates bet acceptance
// (no scheduler polls it), so the table carries no settled_value / thread_id columns TC needed.
const SCHEMA_V34 = `
CREATE TABLE IF NOT EXISTS predict_counter (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  next_num INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO predict_counter(id, next_num) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS predict_proposals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  num             INTEGER NOT NULL UNIQUE,
  title           TEXT    NOT NULL DEFAULT '',
  option_type     TEXT    NOT NULL DEFAULT 'discrete' CHECK (option_type = 'discrete'),
  options         TEXT    NOT NULL DEFAULT '[]',
  end_time        INTEGER NOT NULL,
  min_bet_lp      REAL    NOT NULL DEFAULT 1.0,
  max_bet_lp      REAL    NOT NULL DEFAULT 10.0,
  status          TEXT    NOT NULL DEFAULT 'active',
  created_by      TEXT    NOT NULL DEFAULT '',
  chat_id         TEXT    NOT NULL DEFAULT '',
  top_message_id  TEXT    NOT NULL DEFAULT '',
  announced_by    TEXT    NOT NULL DEFAULT '',
  settled_option  TEXT,
  settled_at      INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_predict_proposals_num
  ON predict_proposals(num);
CREATE INDEX IF NOT EXISTS idx_predict_proposals_status
  ON predict_proposals(status);
CREATE INDEX IF NOT EXISTS idx_predict_proposals_chat
  ON predict_proposals(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_predict_proposals_top_msg
  ON predict_proposals(top_message_id);
`;

// Bet records: same shape as tc_bets — no UNIQUE(proposal_id, user_open_id), since a user may bet
// multiple times across options, accumulating toward the per-user max_bet_lp ceiling.
const SCHEMA_V35 = `
CREATE TABLE IF NOT EXISTS predict_bets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id   INTEGER NOT NULL REFERENCES predict_proposals(id),
  user_open_id  TEXT    NOT NULL,
  option_value  TEXT    NOT NULL,
  lp_amount     REAL    NOT NULL,
  message_id    TEXT    NOT NULL DEFAULT '',
  is_refunded   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_predict_bets_proposal
  ON predict_bets(proposal_id);
CREATE INDEX IF NOT EXISTS idx_predict_bets_user
  ON predict_bets(user_open_id, proposal_id);
CREATE INDEX IF NOT EXISTS idx_predict_bets_refund
  ON predict_bets(proposal_id, is_refunded);
`;

// Treasure chests: owned virtual LP accounts. Balance lives in the shared pt_ledger/profiles under
// chest_id as the account key (an opaque string, same as any open_id); this table only records
// ownership metadata. is_public flags the one "公益宝箱" instance that automatically receives a
// contribution on every community-prediction settlement (see predict-settlement.ts). Lives in the
// shared LP database, alongside profiles/badges.
const SCHEMA_V36 = `
CREATE TABLE IF NOT EXISTS chests (
  chest_id      TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_open_id TEXT NOT NULL,
  is_public     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_chests_owner ON chests(owner_open_id);
`;

// Index for per-turn LP aggregation lookups: SUM(delta) WHERE ref_message_id = ? AND
// user_open_id = ?, run once per LLM reply (see netPtChangeForRef in store/gamification.ts).
// Partial index — most ledger rows outside a ref'd flow (TC/predict/chest/LLM turns) have no
// ref_message_id at all, so indexing only the non-null rows keeps it small.
const SCHEMA_V37 = `
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON pt_ledger(ref_message_id) WHERE ref_message_id IS NOT NULL;
`;

// Reply linkage. A Feishu reply carries reply_to (the message being replied to) and root_id (the
// first message of the reply chain) on the event envelope; both were previously kept only inside
// the raw JSON blob, so nothing could join on them and a reply's referent was unrecoverable.
// Note there is no parent_id on this envelope shape — reply_to is the direct parent.
// Backfilled from raw for rows captured before the columns existed.
const SCHEMA_V38 = `
ALTER TABLE messages ADD COLUMN reply_to_id TEXT;
ALTER TABLE messages ADD COLUMN root_id TEXT;
UPDATE messages
   SET reply_to_id = json_extract(raw, '$.reply_to'),
       root_id     = json_extract(raw, '$.root_id')
 WHERE raw IS NOT NULL AND raw <> '' AND json_valid(raw);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;
`;

// Records which inbound @-mention messages the bot has already acted on, keyed by the Feishu
// message_id. The in-memory event_id dedupe (feishu-bot's `seen` Set) is per-process and cannot tell
// the post-reconnect / post-restart backfill scan which messages were already answered — without this
// table the backfill would re-answer everything recent every time it runs. Written once the message
// passes the intake gates; checked by both the live handler (cross-restart redelivery) and the
// backfill (skip-already-handled).
const SCHEMA_V39 = `
CREATE TABLE IF NOT EXISTS handled_messages (
  message_id TEXT PRIMARY KEY,
  handled_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

/** Apply ordered, idempotent schema migrations tracked in schema_migrations. */
function runMigrations(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  const applied = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version)
  );
  const migrations: Array<{ version: number; description: string; sql?: string; run?: (db: Db) => void }> = [
    { version: 1, description: 'core schema', sql: SCHEMA_V1 },
    { version: 2, description: 'level, lookup indexes, seed badges', sql: SCHEMA_V2 },
    { version: 3, description: 'daily checkin records', sql: SCHEMA_V3 },
    { version: 4, description: 'agent error ledger', sql: SCHEMA_V4 },
    { version: 5, description: 'pending replies for restart recovery', sql: SCHEMA_V5 },
    { version: 6, description: 'event system (types/dispatches/reactions)', sql: SCHEMA_V6 },
    { version: 7, description: 'event schedule state (timed+random triggers)', sql: SCHEMA_V7 },
    { version: 8, description: 'event schedule planned fire time (within-window)', sql: SCHEMA_V8 },
    { version: 9, description: 'chat member directory (roster sync, internal+external)', sql: SCHEMA_V9 },
    { version: 10, description: 'member sync round time-series (ops analytics)', sql: SCHEMA_V10 },
    { version: 11, description: 'member sync round deduped present counts (all/internal/external)', sql: SCHEMA_V11 },
    { version: 12, description: 'chats.dissolved_at (stop polling dissolved chats)', sql: SCHEMA_V12 },
    { version: 13, description: 'chats.inactive_reason (dissolved vs inaccessible)', sql: SCHEMA_V13 },
    { version: 14, description: 'calendar event RSVP time-series (upcoming-event signup polling)', sql: SCHEMA_V14 },
    { version: 15, description: 'document view-record events (knowledge-base access polling)', sql: SCHEMA_V15 },
    { version: 16, description: 'token expiry reminder dedup ledger', sql: SCHEMA_V16 },
    { version: 17, description: 'badge rich metadata + award provenance', sql: SCHEMA_V17 },
    { version: 18, description: 'long-term memory store (memory_items, namespace/visibility/sensitivity)', sql: SCHEMA_V18 },
    { version: 19, description: 'rename gamification points AP->LP (ap_* tables/columns -> pt_*)', run: migrateLpRename },
    { version: 20, description: 'identity links (alias per-app open_ids to one canonical LP identity)', sql: SCHEMA_V20 },
    { version: 21, description: 'chat reaction harvest (per-member cumulative like count for milestones)', sql: SCHEMA_V21 },
    { version: 22, description: 'pinned messages (auto-pin popular messages, idempotent)', sql: SCHEMA_V22 },
    { version: 23, description: 'activity meetups + tags (tudigong activity module)', sql: SCHEMA_V23 },
    { version: 24, description: 'meetup tag subscriptions (activity module digest mentions)', sql: SCHEMA_V24 },
    { version: 25, description: 'activity_meetups.share_link (public calendar share link)', sql: SCHEMA_V25 },
    { version: 26, description: 'visitor_milestones (restart-proof visitor-count announcement ledger)', sql: SCHEMA_V26 },
    { version: 27, description: 'self-service display-name overrides (改名 command, keyed by open_id)', sql: SCHEMA_V27 },
    { version: 28, description: 'like_maniac_weeks (per-week like-maniac announcement ledger, weekly 66-reaction milestone)', sql: SCHEMA_V28 },
    { version: 29, description: 'tc_counter + tc_proposals (intention-survey proposals)', sql: SCHEMA_V29 },
    { version: 30, description: 'tc_bets (intention-survey bet records)', sql: SCHEMA_V30 },
    { version: 31, description: 'rename CVP module to TC: drop legacy cvp_* tables, ensure tc_* exist', sql: SCHEMA_V31 },
    { version: 32, description: 'memory_fragments (SeeDAO history trivia store, shared db, dedup by content_norm)', sql: SCHEMA_V32 },
    { version: 33, description: 'pending_welcome (batched newcomer-welcome queue drained by the 08:30/14:30/20:30 digest)', sql: SCHEMA_V33 },
    { version: 34, description: 'predict_counter + predict_proposals (community prediction, discrete-only, judge-announced settlement)', sql: SCHEMA_V34 },
    { version: 35, description: 'predict_bets (community prediction bet records)', sql: SCHEMA_V35 },
    { version: 36, description: 'chests (owned virtual LP accounts, e.g. 公益宝箱)', sql: SCHEMA_V36 },
    { version: 37, description: 'index pt_ledger.ref_message_id (per-turn LP aggregation lookups)', sql: SCHEMA_V37 },
    { version: 38, description: 'messages.reply_to_id / root_id (reply linkage, backfilled from raw)', sql: SCHEMA_V38 },
    { version: 39, description: 'handled_messages (dedupe backfilled/redelivered @-mentions across restarts)', sql: SCHEMA_V39 },
  ];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    if (m.run) m.run(db);
    else if (m.sql) db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations(version, description) VALUES (?, ?)').run(m.version, m.description);
  }
}
