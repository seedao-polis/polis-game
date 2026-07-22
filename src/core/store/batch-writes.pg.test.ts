import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// PostgreSQL-backed regression tests for the batched idempotent writers (recordDocViewEvents,
// recordChatReactions). Both collapse what used to be one round trip per observed row into one
// multi-row `INSERT … ON CONFLICT DO NOTHING RETURNING …`, and both report "what was genuinely new"
// by matching RETURNING back against their inputs. The risks are specific to that shape and cannot be
// reached from the SQLite suite alone:
//   - RETURNING under ON CONFLICT DO NOTHING must yield ONLY the rows actually inserted; if it ever
//     yielded all attempted rows, every sweep would re-announce views/reactions it recorded hours ago.
//   - the match-back key has to survive a round trip through a BIGINT column (last_view_time), where
//     the value the caller sent and the value RETURNING hands back are produced by different code
//     paths. A mismatch reports "nothing new" forever — the rows land, the caller never hears about it.
//   - chunking must stay correct across the batch-size boundary, including on replay.
// Requires a local test PostgreSQL instance: `pnpm test:pg:up` before running, `pnpm test:pg:down` after.

const PG_TEST_URL = process.env.AGENT_PG_TEST_URL || 'postgres://test:test@localhost:15432/tudigong_test';
const SCHEMA = `batch_writes_pg_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

process.env.AGENT_SOUL = 'tudigong';
process.env.AGENT_PG_URL = PG_TEST_URL;
process.env.AGENT_PG_SOUL_SCHEMA = SCHEMA;

const { SOUL_TUDIGONG_MIGRATIONS, runPgMigrations } = await import('../db-pg-schema.js');
const analytics = await import('./analytics.js');
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

/** One observed view of document `doc`, by `viewer`, at unix second `at`. */
function view(doc: string, viewer: string, at: number) {
  return {
    fileToken: doc, fileType: 'docx', source: 'wiki', spaceId: 'space_1', title: '白皮书',
    viewerId: viewer, viewerName: `名字-${viewer}`, lastViewTime: at,
  };
}

test('recordDocViewEvents returns every row of an all-new batch, in input order', async () => {
  const fresh = await analytics.recordDocViewEvents([
    view('d1', 'ou_a', 100), view('d1', 'ou_b', 100), view('d1', 'ou_c', 100),
  ]);
  assert.deepEqual(fresh.map((e) => e.viewerId), ['ou_a', 'ou_b', 'ou_c']);
});

test('recordDocViewEvents reports only the new rows when a batch replays', async () => {
  await analytics.recordDocViewEvents([view('d2', 'ou_a', 100), view('d2', 'ou_b', 100)]);
  const fresh = await analytics.recordDocViewEvents([
    view('d2', 'ou_a', 100), view('d2', 'ou_b', 100), view('d2', 'ou_new', 100),
  ]);
  assert.deepEqual(fresh.map((e) => e.viewerId), ['ou_new'], 'already-recorded views must not re-announce');
});

test('recordDocViewEvents collapses duplicates inside one batch to a single new row', async () => {
  // ON CONFLICT skips the repeat, so it is absent from RETURNING. Without the pre-dedupe the repeat
  // would be matched back as "already recorded" — the same row both announced and suppressed.
  const fresh = await analytics.recordDocViewEvents([
    view('d3', 'ou_dup', 100), view('d3', 'ou_dup', 100), view('d3', 'ou_dup', 100),
  ]);
  assert.deepEqual(fresh.map((e) => e.viewerId), ['ou_dup']);
});

test('recordDocViewEvents treats a later view time on the same document+viewer as a new row', async () => {
  // The third component of the unique key is a BIGINT, so this is also where the match-back is at its
  // most fragile — it compares a value RETURNING produced against the JS number originally sent.
  // (docViewKey runs both through Math.trunc, which is why a string BIGINT would still match; what
  // this pins is the business rule and the round trip, not the driver's type coercion.)
  await analytics.recordDocViewEvents([view('d4', 'ou_a', 100)]);
  const fresh = await analytics.recordDocViewEvents([view('d4', 'ou_a', 100), view('d4', 'ou_a', 200)]);
  assert.deepEqual(fresh.map((e) => `${e.viewerId}@${e.lastViewTime}`), ['ou_a@200']);
});

test('recordDocViewEvents chunks past the batch-size boundary and replays as fully known', async () => {
  const many = Array.from({ length: 450 }, (_, i) => view('d5', `ou_bulk${i}`, 300));
  assert.equal((await analytics.recordDocViewEvents(many)).length, 450, 'every row of a 3-chunk batch is new');
  assert.equal((await analytics.recordDocViewEvents(many)).length, 0, 'replaying the whole batch reports nothing');
});

test('recordDocViewEvents on an empty input touches nothing', async () => {
  assert.deepEqual(await analytics.recordDocViewEvents([]), []);
});

test('recordDocViewEvent (single-row wrapper) keeps its true/false contract', async () => {
  assert.equal(await analytics.recordDocViewEvent(view('d6', 'ou_z', 900)), true, 'first insert');
  assert.equal(await analytics.recordDocViewEvent(view('d6', 'ou_z', 900)), false, 'duplicate view ignored');
});

/** One reaction on message `msg` by `who` with `emoji`. */
function reaction(msg: string, who: string, emoji: string) {
  return { messageId: msg, chatId: 'oc_1', reactorOpenId: who, emojiType: emoji, actionTime: 7 };
}

test('recordChatReactions reports only new rows against its composite primary key', async () => {
  const first = await reactions.recordChatReactions([
    reaction('m1', 'ou_u1', 'THUMBSUP'), reaction('m1', 'ou_u2', 'HEART'),
  ]);
  assert.deepEqual(first.map((r) => r.reactorOpenId), ['ou_u1', 'ou_u2']);

  // Same reactor, different emoji = a different key, so it IS new; the replayed one is not.
  const second = await reactions.recordChatReactions([
    reaction('m1', 'ou_u1', 'THUMBSUP'), reaction('m1', 'ou_u1', 'HEART'),
  ]);
  assert.deepEqual(second.map((r) => `${r.reactorOpenId}/${r.emojiType}`), ['ou_u1/HEART']);
});

test('recordChatReactions drops rows missing a key field without failing the batch', async () => {
  const fresh = await reactions.recordChatReactions([
    { messageId: '', chatId: 'oc_1', reactorOpenId: 'ou_x', emojiType: 'SMILE' },
    reaction('m2', 'ou_valid', 'SMILE'),
  ]);
  assert.deepEqual(fresh.map((r) => r.reactorOpenId), ['ou_valid'], 'the valid row still lands');
});

test('recordChatReaction (single-row wrapper) keeps its true/false contract', async () => {
  assert.equal(await reactions.recordChatReaction(reaction('m3', 'ou_w', 'OK')), true);
  assert.equal(await reactions.recordChatReaction(reaction('m3', 'ou_w', 'OK')), false);
});
