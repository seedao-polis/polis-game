import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// What a slow-query WARN line SAYS about the pool, under a real pool that is genuinely starved.
// classifySlowQuery covers the arithmetic in isolation (db-slow-query.test.ts); this file covers the
// half that only a live pool can show — the pool counters have to describe the wait being explained.
// They used to be read after the query finished, i.e. after it had already released its connection, so
// every starvation line reported a pool with a free connection and an empty queue: the numbers said
// "the pool was fine" on the exact lines whose whole point was that it was not.
//
// Shape of the run: pool max 1, one query holding the only connection in pg_sleep, two trivial queries
// behind it. The sleeper is slow on its own merits ('db'); the two behind it execute instantly and are
// slow purely from waiting ('pool'). One run, both causes, distinguishable.
// Requires a local test PostgreSQL instance: `pnpm test:pg:up` before running, `pnpm test:pg:down` after.

const PG_TEST_URL = process.env.AGENT_PG_TEST_URL || 'postgres://test:test@localhost:15432/tudigong_test';
const SCHEMA = `db_pool_pg_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

process.env.AGENT_SOUL = 'tudigong';
process.env.AGENT_PG_URL = PG_TEST_URL;
process.env.AGENT_PG_SOUL_SCHEMA = SCHEMA;
process.env.AGENT_PG_POOL_MAX = '1';      // one connection ⇒ any concurrency is starvation
process.env.AGENT_PG_SLOW_QUERY_MS = '300'; // keep the run short; the sleeper below is 800ms

const { SOUL_TUDIGONG_MIGRATIONS, runPgMigrations } = await import('./db-pg-schema.js');
const { getDb, closeDb } = await import('./db.js');

before(async () => {
  const pool = new pg.Pool({ connectionString: PG_TEST_URL, options: `-c search_path=${SCHEMA}` });
  await runPgMigrations(pool, SCHEMA, SOUL_TUDIGONG_MIGRATIONS);
  await pool.end();
});

after(async () => {
  await closeDb();
  const pool = new pg.Pool({ connectionString: PG_TEST_URL });
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
});

/** Run `fn` with stderr captured, returning every log line it emitted. */
async function captureLogLines(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    lines.push(String(chunk));
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return lines.join('').split('\n').filter(Boolean);
}

test('waiting on a starved pool is blamed on the pool, executing slowly is blamed on the database', async () => {
  const db = await getDb();
  const lines = await captureLogLines(() => Promise.all([
    db.query('SELECT pg_sleep(0.8)'),
    db.query('SELECT 1'),
    db.query('SELECT 1'),
  ]));

  const starved = lines.filter((l) => l.includes('PG 池饥饿'));
  assert.equal(starved.length, 2, `both trivial queries waited on the pool, got:\n${lines.join('\n')}`);
  for (const line of starved) {
    assert.match(line, /执行 \d{1,2}ms/, `a starvation line's execution must be trivially fast: ${line}`);
    assert.match(line, /取连接前池 总1\/闲0/, `the pool was at max with nothing free: ${line}`);
  }

  // The sleeper was slow for an entirely different reason, and must be labelled differently — the
  // whole point of the three causes is that an operator can tell these two apart at a glance.
  const slow = lines.filter((l) => l.includes('PG 慢查询'));
  assert.equal(slow.length, 1, `exactly the sleeper is a slow query, got:\n${lines.join('\n')}`);
  assert.match(slow[0], /pg_sleep/);
});

test('pool counters describe the moment of queuing, not the moment of completion', async () => {
  // Two connections, both held by sleepers, and a third query behind them. It queues while the pool is
  // full (总2/闲0) — but by the time it has run and reports, its sibling has finished and handed a
  // connection back, so the pool it is reported next to is no longer full. Sampling the counters at
  // report time therefore prints an idle pool on a line whose entire subject is a wait for a
  // connection. Only the pre-wait sample answers the question the line is asking.
  await closeDb();                        // drop the max=1 pool so the next getDb() rebuilds it
  process.env.AGENT_PG_POOL_MAX = '2';
  const db = await getDb();

  const lines = await captureLogLines(() => Promise.all([
    db.query('SELECT pg_sleep(0.8)'),
    db.query('SELECT pg_sleep(0.8)'),
    db.query('SELECT pg_sleep(0.1)'),     // waits ~0.8s, then runs well under the 300ms threshold
  ]));

  const starved = lines.filter((l) => l.includes('PG 池饥饿'));
  assert.equal(starved.length, 1, `only the third query waited, got:\n${lines.join('\n')}`);
  assert.match(
    starved[0], /取连接前池 总2\/闲0/,
    `the pool was full when this query queued; report-time counters would show a free connection: ${starved[0]}`,
  );
});
