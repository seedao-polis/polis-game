import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Pure coverage for the outbox mechanics (enqueue, backlog count, replay, mark-after-replay,
// resume-safety) — no PostgreSQL required. AGENT_PG_URL is deliberately left UNSET, so
// soulUsesPg() is false and replayOutbox()'s getDb() resolves to the ordinary SQLite executor; this
// exercises the exact same replay code path real production would use against PostgreSQL, just
// against a throwaway SQLite file instead. The PG-backed replay path itself (against a real
// PostgreSQL instance, with the OUTBOX_TABLES' actual PG schema) is covered by pg-outbox.pg.test.ts.

const RUN_ID = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const SOUL_DB_PATH = `/tmp/agent-pg-outbox-test-soul-${RUN_ID}.db`;
const OUTBOX_DB_PATH = `/tmp/agent-pg-outbox-test-outbox-${RUN_ID}.db`;

process.env.AGENT_DB_PATH = SOUL_DB_PATH;
process.env.AGENT_PG_OUTBOX_PATH = OUTBOX_DB_PATH;
delete process.env.AGENT_PG_URL;

const { enqueueOutboxWrite, outboxBacklogCount, replayOutbox, lastReplayLog, closeOutboxDb } = await import('./pg-outbox.js');
const { getDb, closeDb } = await import('./db.js');

after(async () => {
  await closeDb();
  closeOutboxDb();
  for (const f of [SOUL_DB_PATH, OUTBOX_DB_PATH]) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(f + suffix, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
});

test('enqueueOutboxWrite + outboxBacklogCount: appends are visible immediately, before any replay', async () => {
  assert.equal(outboxBacklogCount(), 0);
  await enqueueOutboxWrite('chats', ['chat_id'], ['oc_outbox_test']);
  await enqueueOutboxWrite('messages', ['message_id', 'chat_id', 'text', 'create_time'], [
    'om_outbox_test_1', 'oc_outbox_test', '队列测试消息', 1_700_000_000,
  ]);
  await enqueueOutboxWrite('activities', ['type', 'actor_open_id', 'chat_id', 'ref_message_id'], [
    'mention', 'ou_outbox_test', 'oc_outbox_test', 'om_outbox_test_1',
  ]);
  assert.equal(outboxBacklogCount(), 3);
});

test('replayOutbox: replays every pending row in enqueue order, marks each replayed, and the FK-satisfying chats insert happens automatically for messages', async () => {
  const result = await replayOutbox();
  assert.equal(result.attempted, 3);
  assert.equal(result.replayed, 3);
  assert.equal(result.failed, 0);
  assert.equal(outboxBacklogCount(), 0, 'every row must be marked replayed');

  const db = await getDb();
  const chat = await db.query<{ chat_id: string }>('SELECT chat_id FROM chats WHERE chat_id = $1', ['oc_outbox_test']);
  assert.equal(chat.rows.length, 1, 'the queued chats row must have landed');
  const msg = await db.query<{ text: string }>('SELECT text FROM messages WHERE message_id = $1', ['om_outbox_test_1']);
  assert.equal(msg.rows[0]?.text, '队列测试消息');
  const act = await db.query<{ type: string }>("SELECT type FROM activities WHERE ref_message_id = $1", ['om_outbox_test_1']);
  assert.equal(act.rows[0]?.type, 'mention');

  const log = lastReplayLog();
  assert.ok(log);
  assert.equal(log!.attempted, 3);
  assert.equal(log!.replayed, 3);
  assert.equal(log!.failed, 0);
});

test('replaying again with nothing pending is a safe no-op', async () => {
  const result = await replayOutbox();
  assert.deepEqual(result, { attempted: 0, replayed: 0, failed: 0 });
});

test('resume-after-interruption: a row that fails to replay is left unmarked and retried; already-replayed rows are never re-attempted', async () => {
  // A well-formed row that will replay cleanly...
  await enqueueOutboxWrite('handled_messages', ['message_id'], ['om_outbox_test_2']);
  // ...and a deliberately malformed one (references a table pg-outbox.ts's OUTBOX_TABLES would never
  // actually enqueue in production, but replayOutbox() itself does not re-validate table_name — this
  // simulates "the remote insert failed for some reason" without needing to actually break PostgreSQL).
  await enqueueOutboxWrite(
    // @ts-expect-error deliberately invalid table name to force a replay failure
    'this_table_does_not_exist',
    ['col'],
    ['x'],
  );

  const first = await replayOutbox();
  assert.equal(first.attempted, 2);
  assert.equal(first.replayed, 1, 'the well-formed row must succeed');
  assert.equal(first.failed, 1, 'the malformed row must fail, not throw out of replayOutbox()');
  assert.equal(outboxBacklogCount(), 1, 'only the failed row remains pending');

  const db = await getDb();
  const handled = await db.query('SELECT 1 FROM handled_messages WHERE message_id = $1', ['om_outbox_test_2']);
  assert.equal(handled.rows.length, 1, 'the succeeded row landed for real, not just marked');

  // Simulate a second supervisor run picking up where the first left off: it must retry only the
  // still-pending row, never re-touch the one already marked replayed_at.
  const second = await replayOutbox();
  assert.equal(second.attempted, 1, 'must retry only the still-pending row');
  assert.equal(second.replayed, 0);
  assert.equal(second.failed, 1);
  assert.equal(outboxBacklogCount(), 1, 'the permanently-broken row stays pending rather than being silently dropped');
});
