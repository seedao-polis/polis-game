import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// End-to-end Phase 2 coverage against a REAL PostgreSQL instance: with soulCircuit forced open (via
// an unreachable AGENT_PG_URL, same technique as db-circuit.pg.test.ts), the actual store-layer entry
// points (insertMessage, recordActivity, recordMemberSyncRound, recordChatReactions,
// markMessageHandled, recordError) must divert to the local outbox instead of attempting PostgreSQL —
// then, once pointed back at the real database, replayOutbox() must land every one of them, and
// replaying twice must never duplicate a row for any table that carries a natural/unique key.
// Requires a local test PostgreSQL instance: `pnpm test:pg:up` before running, `pnpm test:pg:down` after.

const PG_TEST_URL = process.env.AGENT_PG_TEST_URL || 'postgres://test:test@localhost:15432/tudigong_test';
const SCHEMA = `outbox_pg_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const UNREACHABLE_URL = 'postgres://test:test@127.0.0.1:1/tudigong_test';
const OUTBOX_DB_PATH = `/tmp/agent-pg-outbox-pg-test-${SCHEMA}.db`;

process.env.AGENT_SOUL = 'tudigong';
process.env.AGENT_PG_SOUL_SCHEMA = SCHEMA;
process.env.AGENT_PG_OUTBOX_PATH = OUTBOX_DB_PATH;
process.env.AGENT_PG_POOL_MAX = '2';
process.env.AGENT_PG_CIRCUIT_FAIL_THRESHOLD = '2';
process.env.AGENT_PG_CIRCUIT_PROBE_MS = '60000'; // does not need to recover on its own — the test switches the URL back explicitly
process.env.AGENT_PG_CONNECT_TIMEOUT_MS = '600';
process.env.AGENT_PG_STATEMENT_TIMEOUT_MS = '0';
process.env.AGENT_PG_IDLE_TIMEOUT_MS = '0';

const { SOUL_TUDIGONG_MIGRATIONS, runPgMigrations } = await import('./db-pg-schema.js');
const { closeDb, soulCircuit } = await import('./db.js');
const { outboxBacklogCount, replayOutbox, closeOutboxDb } = await import('./pg-outbox.js');
const { insertMessage } = await import('./store/messages.js');
const { recordActivity } = await import('./store/gamification.js');
const { recordMemberSyncRound } = await import('./store/members.js');
const { recordChatReactions } = await import('./store/reactions.js');
const { markMessageHandled } = await import('./store/messages.js');
const { recordError } = await import('./store/ops.js');

before(async () => {
  process.env.AGENT_PG_URL = PG_TEST_URL;
  const pool = new pg.Pool({ connectionString: PG_TEST_URL, options: `-c search_path=${SCHEMA}` });
  await runPgMigrations(pool, SCHEMA, SOUL_TUDIGONG_MIGRATIONS);
  await pool.end();
});

after(async () => {
  process.env.AGENT_PG_URL = PG_TEST_URL;
  await closeDb();
  closeOutboxDb();
  const pool = new pg.Pool({ connectionString: PG_TEST_URL });
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
  const fs = await import('node:fs');
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(OUTBOX_DB_PATH + suffix, { force: true });
    } catch {
      /* best-effort */
    }
  }
});

const MSG_ID = 'om_outbox_pg_test_1';
const CHAT_ID = 'oc_outbox_pg_test';

test('with soulCircuit forced open, every Phase 2 write path diverts to the outbox instead of attempting PostgreSQL', async () => {
  process.env.AGENT_PG_URL = UNREACHABLE_URL;
  await closeDb();
  soulCircuit.reset();
  for (let i = 0; i < 2; i++) {
    await assert.rejects(async () => {
      const { getDb } = await import('./db.js');
      const db = await getDb();
      await db.query('SELECT 1');
    });
  }
  assert.equal(soulCircuit.state, 'open', 'precondition: the breaker must be open for the rest of this test');

  const t0 = Date.now();
  await insertMessage({
    messageId: MSG_ID, chatId: CHAT_ID, senderOpenId: 'ou_outbox_test', senderName: '测试',
    msgType: 'text', text: '降级队列集成测试消息', mentions: [], createTime: Math.floor(Date.now() / 1000),
  });
  await recordActivity('mention', 'ou_outbox_test', CHAT_ID, MSG_ID);
  await recordMemberSyncRound({
    syncedAt: Math.floor(Date.now() / 1000), chatCount: 1, presentTotal: 1,
    joinedCount: 0, leftCount: 0, renamedCount: 0, rosterTotal: 1,
  });
  await recordChatReactions([{ messageId: MSG_ID, chatId: CHAT_ID, reactorOpenId: 'ou_reactor', emojiType: 'THUMBSUP', actionTime: Math.floor(Date.now() / 1000) }]);
  await markMessageHandled(MSG_ID);
  await recordError({ kind: 'unit_test', summary: '降级队列集成测试错误' });
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 1000, `all 6 diverted writes together must be fast (no real connection attempts), took ${elapsed}ms`);
  assert.equal(outboxBacklogCount(), 6, 'every one of the 6 writes above must have been queued, not attempted');
});

test('replayOutbox() lands every queued row in real PostgreSQL once it is reachable again', async () => {
  process.env.AGENT_PG_URL = PG_TEST_URL;
  await closeDb();

  const result = await replayOutbox();
  assert.equal(result.attempted, 6);
  assert.equal(result.replayed, 6);
  assert.equal(result.failed, 0);
  assert.equal(outboxBacklogCount(), 0);

  const { getDb } = await import('./db.js');
  const db = await getDb();
  const msg = await db.query<{ text: string }>('SELECT text FROM messages WHERE message_id = $1', [MSG_ID]);
  assert.equal(msg.rows[0]?.text, '降级队列集成测试消息');
  const chat = await db.query('SELECT 1 FROM chats WHERE chat_id = $1', [CHAT_ID]);
  assert.equal(chat.rows.length, 1, 'the FK-satisfying chats row must have been derived and inserted at replay time');
  const activity = await db.query('SELECT 1 FROM activities WHERE ref_message_id = $1', [MSG_ID]);
  assert.equal(activity.rows.length, 1);
  const round = await db.query('SELECT 1 FROM member_sync_rounds WHERE chat_count = 1');
  assert.equal(round.rows.length, 1);
  const reaction = await db.query('SELECT 1 FROM chat_reactions WHERE message_id = $1', [MSG_ID]);
  assert.equal(reaction.rows.length, 1);
  const handled = await db.query('SELECT 1 FROM handled_messages WHERE message_id = $1', [MSG_ID]);
  assert.equal(handled.rows.length, 1);
  const err = await db.query("SELECT 1 FROM errors WHERE kind = 'unit_test'");
  assert.equal(err.rows.length, 1);
});

test('replaying an already-fully-replayed backlog is a no-op, and re-running the whole replay never duplicates rows with a natural/unique key', async () => {
  const before = await replayOutbox();
  assert.deepEqual(before, { attempted: 0, replayed: 0, failed: 0 }, 'nothing pending after the previous test');

  // Directly re-run the same logical inserts a second time through the outbox to prove ON CONFLICT DO
  // NOTHING protects every unique-keyed table on a genuine duplicate replay (not just "nothing pending").
  const { enqueueOutboxWrite } = await import('./pg-outbox.js');
  await enqueueOutboxWrite('messages', ['message_id', 'chat_id', 'sender_open_id', 'sender_name', 'msg_type', 'text', 'create_time'], [
    MSG_ID, CHAT_ID, 'ou_outbox_test', '测试', 'text', '重复回放不应产生第二行', Math.floor(Date.now() / 1000),
  ]);
  await enqueueOutboxWrite('handled_messages', ['message_id'], [MSG_ID]);
  await enqueueOutboxWrite('chat_reactions', ['message_id', 'chat_id', 'reactor_open_id', 'emoji_type', 'action_time'], [
    MSG_ID, CHAT_ID, 'ou_reactor', 'THUMBSUP', Math.floor(Date.now() / 1000),
  ]);

  const result = await replayOutbox();
  assert.equal(result.attempted, 3);
  assert.equal(result.replayed, 3, 'ON CONFLICT DO NOTHING makes the remote insert itself succeed-as-no-op, still counted as replayed');

  const { getDb } = await import('./db.js');
  const db = await getDb();
  const messages = await db.query('SELECT message_id FROM messages WHERE message_id = $1', [MSG_ID]);
  assert.equal(messages.rows.length, 1, 'must still be exactly one row, not duplicated');
  const handled = await db.query('SELECT message_id FROM handled_messages WHERE message_id = $1', [MSG_ID]);
  assert.equal(handled.rows.length, 1);
  const reactions = await db.query('SELECT 1 FROM chat_reactions WHERE message_id = $1', [MSG_ID]);
  assert.equal(reactions.rows.length, 1);
});
