import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// PostgreSQL-backed regression tests for the shared LP economy, covering the risks specific to the
// PostgreSQL backend that the SQLite-fallback test suite (store.test.ts et al.) cannot exercise:
//   - node-postgres parses NUMERIC/BIGINT columns as strings by default (see db.ts's setTypeParser
//     registration) — a regression here would not fail to compile, only silently return the wrong
//     JS type at runtime, so an explicit typeof assertion is the only guard.
//   - spendPt()'s guarded UPDATE must stay atomic under real concurrent connections from a pool —
//     SQLite's single-file lock served this for free, so this needs an actual concurrency test.
// Requires a local test PostgreSQL instance: `pnpm test:pg:up` before running, `pnpm test:pg:down` after.
// Points AGENT_PG_URL at it with a schema unique to this test file (AGENT_PG_SHARED_SCHEMA), mirroring
// how the SQLite-backed test files isolate themselves via a per-file AGENT_DB_PATH temp file.

const PG_TEST_URL = process.env.AGENT_PG_TEST_URL || 'postgres://test:test@localhost:15432/tudigong_test';
const SCHEMA = `gamification_pg_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

process.env.AGENT_PG_URL = PG_TEST_URL;
process.env.AGENT_PG_SHARED_SCHEMA = SCHEMA;
// This file never sets AGENT_DB_PATH: getDb()/tx() (soul-scoped) stay on their normal SQLite path,
// pinned to a throwaway file so a stray write never touches .agent/tudigong.db during a test run.
process.env.AGENT_DB_PATH = `/tmp/agent-gamification-pg-test-${SCHEMA}.db`;

const { SHARED_MIGRATIONS, runPgMigrations } = await import('../db-pg-schema.js');
const store = await import('./gamification.js');
const { closeDb } = await import('../db.js');

before(async () => {
  const pool = new pg.Pool({ connectionString: PG_TEST_URL, options: `-c search_path=${SCHEMA}` });
  await runPgMigrations(pool, SCHEMA, SHARED_MIGRATIONS);
  await pool.end();
});

after(async () => {
  await closeDb();
  const pool = new pg.Pool({ connectionString: PG_TEST_URL });
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
  try { (await import('node:fs')).rmSync(process.env.AGENT_DB_PATH!, { force: true }); } catch { /* best-effort */ }
});

const uid = (() => {
  let n = 0;
  return () => `ou_pgtest_${n++}`;
})();

test('grantPt + getProfile round-trip: pt_balance and first_seen come back as JS number, not string', async () => {
  const u = uid();
  const balance = await store.grantPt(u, 42.5, 'unit_test');
  assert.equal(typeof balance, 'number', 'grantPt must resolve the new balance as a number');
  assert.equal(balance, 42.5);

  const profile = await store.getProfile(u);
  assert.ok(profile);
  assert.equal(typeof profile!.ptBalance, 'number', 'pt_balance (NUMERIC) must be parsed back to number');
  assert.equal(typeof profile!.firstSeen, 'number', 'first_seen (BIGINT) must be parsed back to number');
  assert.equal(typeof profile!.lastSeen, 'number', 'last_seen (BIGINT) must be parsed back to number');
  assert.equal(profile!.ptBalance, 42.5);
});

test('spendPt is atomic under real concurrency: exactly one of two simultaneous overlapping spends succeeds', async () => {
  const u = uid();
  await store.grantPt(u, 100, 'seed');

  // Two concurrent spends of 60 against a balance of 100: only one can succeed (100 - 60 = 40, but a
  // second 60 would go negative). This is exactly the check-then-act race spendPt's guarded
  // `UPDATE ... WHERE pt_balance >= $1 RETURNING` was rewritten to close under PostgreSQL's MVCC,
  // where two connections no longer serialize for free the way SQLite's single-file lock did.
  const [a, b] = await Promise.all([
    store.spendPt(u, 60, 'concurrent_test_a'),
    store.spendPt(u, 60, 'concurrent_test_b'),
  ]);
  const succeeded = [a, b].filter(Boolean).length;
  assert.equal(succeeded, 1, `expected exactly one of two concurrent 60-LP spends to succeed, got ${succeeded}`);

  const profile = await store.getProfile(u);
  assert.equal(profile!.ptBalance, 40, 'balance must reflect exactly one successful 60 LP debit, never negative or double-spent');
});

test('leaderboard returns rows with numeric ptBalance and applies name overrides via the batch-preloaded map', async () => {
  const a = uid();
  const b = uid();
  await store.grantPt(a, 10, 'seed');
  await store.grantPt(b, 20, 'seed');
  await store.setPreferredName(b, 'PG测试昵称');

  const rows = await store.leaderboard(50);
  const bRow = rows.find((r) => r.openId === b);
  assert.ok(bRow);
  assert.equal(typeof bRow!.ptBalance, 'number');
  assert.equal(bRow!.name, 'PG测试昵称', 'self-service override must apply via the batch-preloaded map');
});

test('insertFragment RETURNING id works against real PostgreSQL and dedupes on content_norm', async () => {
  const { insertFragment } = await import('./fragments.js');
  const first = await insertFragment({ content: 'PG 迁移测试碎片 一二三', category: 'pg-test' });
  assert.equal(first.inserted, true);
  assert.ok(first.id > 0, 'RETURNING id must resolve to a real positive id, not undefined/NaN');

  const dup = await insertFragment({ content: ' pg 迁移测试碎片 一二三 ' });
  assert.equal(dup.inserted, false, 'a normalized-content duplicate must be rejected, not inserted twice');
  assert.equal(dup.id, first.id);
});

test('searchFragments ILIKE search is case-insensitive against real PostgreSQL', async () => {
  const { insertFragment, searchFragments } = await import('./fragments.js');
  await insertFragment({ content: 'CaseSensitiveNeedle for ILIKE test', category: 'pg-test' });
  const hits = await searchFragments('casesensitiveneedle');
  assert.ok(hits.some((f) => f.content.includes('CaseSensitiveNeedle')), 'ILIKE must match regardless of case');
});
