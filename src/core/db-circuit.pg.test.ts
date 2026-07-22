import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// Integration coverage for db.ts's own circuit-breaker wiring (as opposed to circuit-breaker.test.ts's
// pure state-machine tests): does getDb()/tx() actually feed soulCircuit real connection-layer
// failures, and does it recover once PostgreSQL becomes reachable again?
//
// The "failure" side points AGENT_PG_URL at an address nothing listens on (fast, deterministic
// ECONNREFUSED/ECONNTIMEDOUT) rather than stopping the shared docker-compose.test.yml container —
// stopping that container would affect every other *.pg.test.ts file that may be running against it.
// Requires a local test PostgreSQL instance: `pnpm test:pg:up` before running, `pnpm test:pg:down` after.

const PG_TEST_URL = process.env.AGENT_PG_TEST_URL || 'postgres://test:test@localhost:15432/tudigong_test';
const SCHEMA = `db_circuit_pg_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
// Port 1 is a reserved/unassigned TCP port; nothing listens there, so connections fail fast with
// ECONNREFUSED instead of timing out slowly.
const UNREACHABLE_URL = 'postgres://test:test@127.0.0.1:1/tudigong_test';

process.env.AGENT_SOUL = 'tudigong';
process.env.AGENT_PG_SOUL_SCHEMA = SCHEMA;
process.env.AGENT_PG_POOL_MAX = '2';
process.env.AGENT_PG_CIRCUIT_FAIL_THRESHOLD = '3';
process.env.AGENT_PG_CIRCUIT_PROBE_MS = '300';
process.env.AGENT_PG_CONNECT_TIMEOUT_MS = '600';
process.env.AGENT_PG_STATEMENT_TIMEOUT_MS = '0';
process.env.AGENT_PG_IDLE_TIMEOUT_MS = '0';
process.env.AGENT_PG_SLOW_QUERY_MS = '2000'; // keep the classifier's default threshold

const { SOUL_TUDIGONG_MIGRATIONS, runPgMigrations } = await import('./db-pg-schema.js');
const { getDb, closeDb, soulCircuit } = await import('./db.js');

before(async () => {
  process.env.AGENT_PG_URL = PG_TEST_URL;
  const pool = new pg.Pool({ connectionString: PG_TEST_URL, options: `-c search_path=${SCHEMA}` });
  await runPgMigrations(pool, SCHEMA, SOUL_TUDIGONG_MIGRATIONS);
  await pool.end();
});

after(async () => {
  process.env.AGENT_PG_URL = PG_TEST_URL;
  await closeDb();
  const pool = new pg.Pool({ connectionString: PG_TEST_URL });
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
});

test('soulCircuit opens after 3 consecutive connection-layer failures against an unreachable PostgreSQL', async () => {
  soulCircuit.reset();
  process.env.AGENT_PG_URL = UNREACHABLE_URL;
  await closeDb(); // drop the pool pointed at the real test PG; the next getDb() rebuilds against UNREACHABLE_URL

  for (let i = 0; i < 3; i++) {
    await assert.rejects(async () => {
      const db = await getDb();
      await db.query('SELECT 1');
    });
  }
  assert.equal(soulCircuit.state, 'open', 'must open after 3 consecutive connection-layer failures');
});

test('soulCircuit closes again once a probe against real PostgreSQL succeeds', async () => {
  // Continues from the prior test's opened state (same process, same singleton — mirrors db-pool.pg.test.ts's
  // pattern of mutating shared module state across tests within one file).
  assert.equal(soulCircuit.state, 'open', 'precondition: the previous test must have opened it');

  process.env.AGENT_PG_URL = PG_TEST_URL;
  await closeDb(); // rebuild the pool against the real, reachable test database
  await new Promise((r) => setTimeout(r, 350)); // let AGENT_PG_CIRCUIT_PROBE_MS (300ms) elapse

  const db = await getDb();
  await db.query('SELECT 1'); // this is the throttled half-open probe; its success must close the breaker
  assert.equal(soulCircuit.state, 'closed');
});

test('once closed, the breaker is fully transparent again: ordinary queries succeed with no special handling', async () => {
  assert.equal(soulCircuit.state, 'closed');
  const db = await getDb();
  const { rows } = await db.query<{ n: number }>('SELECT 2 + 2 AS n');
  assert.equal(rows[0]!.n, 4);
  assert.equal(soulCircuit.state, 'closed');
});
