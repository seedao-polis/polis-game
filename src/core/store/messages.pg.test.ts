import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// PostgreSQL-backed regression tests for tudigong's own soul-scoped store (getDb()/tx()), covering the
// risks specific to the PostgreSQL backend that the SQLite-fallback test suite (store.test.ts et al.)
// cannot exercise:
//   - a repeated `$N` placeholder (e.g. `($2 IS NULL OR message_id <> $2)`) must resolve its type from
//     whichever occurrence gives PostgreSQL a typed comparison, with no explicit `::type` cast (a cast
//     would work here but breaks the SQLite fallback executor, which does not understand `::` syntax).
//   - node-postgres parses BIGINT columns (create_time, lp_amount's NUMERIC) as strings by default (see
//     db.ts's setTypeParser registration) — a regression would not fail to compile, only silently return
//     the wrong JS type at runtime.
//   - the sentinel `LIMIT 1000000000` standing in for SQLite's `LIMIT -1` must behave as "no limit"
//     under real PostgreSQL, not just in the sqliteExecutor's textual passthrough.
// Requires a local test PostgreSQL instance: `pnpm test:pg:up` before running, `pnpm test:pg:down` after.
// Points AGENT_PG_URL at it with a schema unique to this file (AGENT_PG_SOUL_SCHEMA) and AGENT_SOUL set
// to tudigong (soulUsesPg() only routes getDb()/tx() to PostgreSQL for that soul).

const PG_TEST_URL = process.env.AGENT_PG_TEST_URL || 'postgres://test:test@localhost:15432/tudigong_test';
const SCHEMA = `messages_pg_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

process.env.AGENT_SOUL = 'tudigong';
process.env.AGENT_PG_URL = PG_TEST_URL;
process.env.AGENT_PG_SOUL_SCHEMA = SCHEMA;
// This file never touches the shared LP economy, so AGENT_PG_SHARED_SCHEMA is left unset — none of the
// functions exercised below call getLpDb().

const { SOUL_TUDIGONG_MIGRATIONS, runPgMigrations } = await import('../db-pg-schema.js');
const messages = await import('./messages.js');
const reactions = await import('./reactions.js');
const { closeDb } = await import('../db.js');

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

const mid = (() => {
  let n = 0;
  return () => `om_pgtest_${n++}`;
})();

test('insertMessage + getMessageRow round-trip: create_time (BIGINT) comes back as JS number, not string', async () => {
  const chatId = 'oc_pgtest';
  await messages.upsertChat({ chatId });
  const id = mid();
  const inserted = await messages.insertMessage({
    messageId: id,
    chatId,
    senderOpenId: 'ou_pgtest',
    senderName: '测试用户',
    msgType: 'text',
    text: 'PG 迁移测试消息',
    mentions: [],
    createTime: 1_700_000_000_123,
  });
  assert.equal(inserted, true);

  const row = await messages.getMessageRow(id);
  assert.ok(row);
  assert.equal(typeof row!.createTime, 'number', 'create_time (BIGINT) must be parsed back to number');
  assert.equal(row!.createTime, 1_700_000_000_123);
});

test('searchMessages ILIKE search is case-insensitive against real PostgreSQL', async () => {
  const chatId = 'oc_pgtest';
  await messages.upsertChat({ chatId });
  await messages.insertMessage({
    messageId: mid(),
    chatId,
    senderOpenId: 'ou_pgtest',
    senderName: '测试用户',
    msgType: 'text',
    text: 'CaseSensitiveNeedle for ILIKE test',
    mentions: [],
    createTime: Date.now(),
  });
  const hits = await messages.searchMessages('casesensitiveneedle');
  assert.ok(hits.some((m) => m.text.includes('CaseSensitiveNeedle')), 'ILIKE must match regardless of case');
});

test('getThreadContext: a reused $N placeholder ($2 IS NULL OR message_id <> $2) resolves its type from PostgreSQL without an explicit cast', async () => {
  const chatId = 'oc_pgtest_thread';
  const threadId = 'omt_pgtest_thread';
  await messages.upsertChat({ chatId });
  const first = mid();
  const second = mid();
  await messages.insertMessage({
    messageId: first, chatId, senderOpenId: 'ou_a', senderName: 'A', msgType: 'text',
    text: 'first in thread', mentions: [], createTime: 1000, threadId,
  });
  await messages.insertMessage({
    messageId: second, chatId, senderOpenId: 'ou_b', senderName: 'B', msgType: 'text',
    text: 'second in thread', mentions: [], createTime: 2000, threadId,
  });

  // No exclusion: both rows come back, oldest→newest.
  const both = await messages.getThreadContext(threadId);
  assert.deepEqual(both.map((m) => m.messageId), [first, second]);

  // excludeMessageId set: the $2 placeholder is bound twice (IS NULL check + inequality) and must
  // still resolve correctly against a real PostgreSQL connection (no ::text cast is present in the SQL).
  const excluded = await messages.getThreadContext(threadId, { excludeMessageId: second });
  assert.deepEqual(excluded.map((m) => m.messageId), [first]);
});

test('getRecentChatMessages: two independently-reused $N placeholders (exclude + sinceMs) both resolve types correctly', async () => {
  const chatId = 'oc_pgtest_recent';
  await messages.upsertChat({ chatId });
  const old = mid();
  const recent = mid();
  await messages.insertMessage({
    messageId: old, chatId, senderOpenId: 'ou_a', senderName: 'A', msgType: 'text',
    text: 'old message', mentions: [], createTime: 1000,
  });
  await messages.insertMessage({
    messageId: recent, chatId, senderOpenId: 'ou_b', senderName: 'B', msgType: 'text',
    text: 'recent message', mentions: [], createTime: 5000,
  });

  const sinceFiltered = await messages.getRecentChatMessages(chatId, { sinceMs: 3000 });
  assert.deepEqual(sinceFiltered.map((m) => m.messageId), [recent], 'sinceMs excludes the older message');

  const excludeFiltered = await messages.getRecentChatMessages(chatId, { excludeMessageId: recent });
  assert.deepEqual(excludeFiltered.map((m) => m.messageId), [old], 'excludeMessageId drops the current message');
});

test('pinnedMessagesOldestBeyond: the LIMIT 1000000000 sentinel behaves as "no limit" under real PostgreSQL', async () => {
  const chat = 'oc_pgtest_pins';
  for (let i = 1; i <= 5; i++) {
    assert.equal(await reactions.recordPinnedMessage(`ompin_${i}`, chat, 3), true);
  }
  // cap=0 forces every pin through the OFFSET, exercising the large-sentinel LIMIT end-to-end.
  const evicted = await reactions.pinnedMessagesOldestBeyond(chat, 0);
  assert.equal(evicted.length, 5, 'the sentinel LIMIT must not truncate the result below the true row count');
});
