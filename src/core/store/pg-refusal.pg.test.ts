import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// Phase 1 (LP economy refusal) integration coverage: once the shared LP pool's circuit breaker is
// open, every LP-mutating/reading call must refuse immediately with PgUnavailableError — never write
// locally, never fall back to SQLite (full LP failover was evaluated and explicitly rejected) — and
// every named command/bet-parser boundary must translate that into the quiet refusal reply text.
//
// Soul stays on SQLite (a throwaway temp file) throughout this file: only the shared/LP pool is ever
// pointed at the unreachable address, so TC/predict bet fixtures can be set up freely without needing
// a second PostgreSQL schema.
// Requires a local test PostgreSQL instance: `pnpm test:pg:up` before running, `pnpm test:pg:down` after.

const PG_TEST_URL = process.env.AGENT_PG_TEST_URL || 'postgres://test:test@localhost:15432/tudigong_test';
// Schema name deliberately does NOT start with "pg_" — PostgreSQL reserves that prefix for its own
// system schemas and rejects any CREATE SCHEMA attempting to use it.
const SCHEMA = `lp_refusal_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const UNREACHABLE_URL = 'postgres://test:test@127.0.0.1:1/tudigong_test';

// AGENT_SOUL deliberately not 'tudigong': soulUsesPg() then stays false regardless of AGENT_PG_URL,
// so every soul-db call (TC/predict proposals + bets) below runs against the isolated SQLite file,
// letting this whole file force ONLY the shared/LP pool's breaker open.
process.env.AGENT_SOUL = 'pg-refusal-test-soul';
process.env.AGENT_PG_SHARED_SCHEMA = SCHEMA;
process.env.AGENT_DB_PATH = `/tmp/agent-pg-refusal-test-${SCHEMA}.db`;
process.env.AGENT_PG_CIRCUIT_FAIL_THRESHOLD = '2';
process.env.AGENT_PG_CIRCUIT_PROBE_MS = '60000'; // effectively "does not recover mid-test"
process.env.AGENT_PG_CONNECT_TIMEOUT_MS = '600';
process.env.AGENT_PG_STATEMENT_TIMEOUT_MS = '0';
process.env.AGENT_PG_IDLE_TIMEOUT_MS = '0';
process.env.AGENT_PG_SLOW_QUERY_MS = '2000';

const { SHARED_MIGRATIONS, runPgMigrations } = await import('../db-pg-schema.js');
const { closeDb, lpCircuit, isPgUnavailableError, PgUnavailableError } = await import('../db.js');
const store = await import('./gamification.js');
const { insertTcProposal, getTcById, getTcBets } = await import('./tc.js');
const { insertPredictProposal, getPredictById, getPredictBets } = await import('./predict.js');
const { tryParseTcBet } = await import('../tc-bet-parser.js');
const { tryParsePredictBet } = await import('../predict-bet-parser.js');
const { dispatchCommand } = await import('../commands.js');

before(async () => {
  process.env.AGENT_PG_URL = PG_TEST_URL;
  const pool = new pg.Pool({ connectionString: PG_TEST_URL, options: `-c search_path=${SCHEMA}` });
  await runPgMigrations(pool, SCHEMA, SHARED_MIGRATIONS);
  await pool.end();

  // Seed a real profile with a healthy balance WHILE the breaker is still closed (against the real
  // test PG), so the bet-parser tests below reach spendPt at all instead of being turned away earlier
  // by an insufficient-balance check that would otherwise also need PG.
  await store.grantPt(SEEDED_USER, 100, 'seed');

  // Force the breaker open: point AGENT_PG_URL at an unreachable address and trip it with
  // AGENT_PG_CIRCUIT_FAIL_THRESHOLD (2) consecutive connection-layer failures.
  process.env.AGENT_PG_URL = UNREACHABLE_URL;
  await closeDb();
  lpCircuit.reset();
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => store.getProfile(SEEDED_USER));
  }
  assert.equal(lpCircuit.state, 'open', 'precondition: the breaker must be open for every test below');
});

after(async () => {
  process.env.AGENT_PG_URL = PG_TEST_URL;
  await closeDb();
  const pool = new pg.Pool({ connectionString: PG_TEST_URL });
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
  try {
    (await import('node:fs')).rmSync(process.env.AGENT_DB_PATH!, { force: true });
  } catch {
    /* best-effort */
  }
});

const SEEDED_USER = 'ou_pgrefusal_seeded';

test('spendPt/checkIn/grantPt all throw PgUnavailableError while the breaker is open, and refuse FAST (no real connection attempt)', async () => {
  const t0 = Date.now();
  await assert.rejects(() => store.spendPt(SEEDED_USER, 1, 'unit_test'), (e) => isPgUnavailableError(e));
  await assert.rejects(() => store.checkIn(SEEDED_USER), (e) => isPgUnavailableError(e));
  await assert.rejects(() => store.grantPt(SEEDED_USER, 1, 'unit_test'), (e) => isPgUnavailableError(e));
  await assert.rejects(() => store.getProfile(SEEDED_USER), (e) => isPgUnavailableError(e));
  await assert.rejects(() => store.leaderboard(10), (e) => isPgUnavailableError(e));
  const elapsed = Date.now() - t0;
  assert.ok(
    elapsed < 500,
    `5 refused LP calls must return near-instantly (no wasted connection attempt), took ${elapsed}ms`,
  );
});

test('commands.ts sign command replies with the quiet refusal text, not a stack trace or generic error', async () => {
  const result = await dispatchCommand('sign', { agentName: 'test-agent', source: 'cli', senderOpenId: SEEDED_USER });
  assert.equal(result.handled, true);
  assert.equal(result.reply, 'LP 系统维护中，请稍后再试。');
});

test('tc-bet-parser: a bet during the LP outage is refused quietly and writes NOTHING locally', async () => {
  const { id } = await insertTcProposal({
    title: '断路器测试提案',
    optionType: 'discrete',
    options: ['A', 'B'],
    endTime: Math.floor(Date.now() / 1000) + 3600,
    maxBetLp: 100,
    createdBy: SEEDED_USER,
    chatId: 'oc_test',
  });
  const proposal = await getTcById(id);
  assert.ok(proposal);

  const result = await tryParseTcBet('@bot A 5LP', proposal!, SEEDED_USER, 'om_test_tc_bet', undefined);
  assert.notEqual(result, false);
  assert.equal((result as { reply: string }).reply, 'LP 系统维护中，请稍后再试。');

  const bets = await getTcBets(id);
  assert.equal(bets.length, 0, 'no tc_bets row must be written when the bet is refused');
});

test('predict-bet-parser: a bet during the LP outage is refused quietly and writes NOTHING locally', async () => {
  const { id } = await insertPredictProposal({
    title: '断路器测试提案（预测）',
    options: ['A', 'B'],
    endTime: Math.floor(Date.now() / 1000) + 3600,
    maxBetLp: 100,
    createdBy: SEEDED_USER,
    chatId: 'oc_test',
  });
  const proposal = await getPredictById(id);
  assert.ok(proposal);

  const result = await tryParsePredictBet('@bot A 5LP', proposal!, SEEDED_USER, 'om_test_predict_bet', undefined);
  assert.notEqual(result, false);
  assert.equal((result as { reply: string }).reply, 'LP 系统维护中，请稍后再试。');

  const bets = await getPredictBets(id);
  assert.equal(bets.length, 0, 'no predict_bets row must be written when the bet is refused');
});

test('PgUnavailableError is distinguishable from a plain "insufficient balance" business rejection', async () => {
  // spendPt's normal insufficient-balance path returns false; it does NOT throw. The only way to see a
  // thrown error at all is the circuit-breaker refusal — asserting the type here pins that these two
  // outcomes can never be confused by a caller that only checks truthiness.
  await assert.rejects(() => store.spendPt(SEEDED_USER, 1, 'unit_test'), (e) => {
    assert.ok(e instanceof PgUnavailableError);
    assert.doesNotMatch((e as Error).message, /余额不足|insufficient/i);
    return true;
  });
});
