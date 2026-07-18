import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Isolated, freshly-migrated DB (must be set before store/db import).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-backfill-test-'));
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

const store = await import('./store.js');
const { closeDb } = await import('./db.js');

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const BOT = 'ou_bot';
const CHAT = 'oc_backfill';

// A thread @-mention the poll path could never capture (raw NULL, no thread linkage in DB) is exactly
// the miss the backfill exists to recover; a top-level @-mention the poll DID capture (raw NULL) is the
// cheap DB-only case. These tests pin the queries that select and dedupe those candidates.
function insert(o: {
  id: string; t: number; text: string; mentions?: string[]; raw?: string;
  threadId?: string; rootId?: string; senderType?: string;
}) {
  store.insertMessage({
    messageId: o.id,
    chatId: CHAT,
    senderOpenId: 'ou_someone',
    senderName: '',
    senderType: o.senderType,
    msgType: 'text',
    text: o.text,
    mentions: o.mentions ?? [],
    threadId: o.threadId,
    rootId: o.rootId,
    raw: o.raw,
    createTime: o.t,
  });
}

const T0 = 1_784_000_000_000;

test('setup rows', () => {
  // poll-captured top-level @-mention the event stream missed (raw NULL) — a backfill candidate.
  insert({ id: 'om_missed_top', t: T0 + 1000, text: '@bot follow X', mentions: [BOT] });
  // event-captured message (raw present) — already handled, NOT a poll candidate.
  insert({ id: 'om_event', t: T0 + 2000, text: '@bot hi', mentions: [BOT], raw: '{"x":1}' });
  // poll-captured but does not mention the bot — not a candidate.
  insert({ id: 'om_nomention', t: T0 + 3000, text: 'hello world', mentions: [] });
  // poll-captured @-mention but already handled — excluded once marked.
  insert({ id: 'om_done', t: T0 + 4000, text: '@bot done', mentions: [BOT] });
  store.markMessageHandled('om_done');
});

test('unhandledPolledMessagesSince returns only raw-NULL, unhandled rows', () => {
  const rows = store.unhandledPolledMessagesSince(T0);
  const ids = rows.map((r) => r.messageId);
  assert.ok(ids.includes('om_missed_top'), 'the missed poll-captured @-mention must surface');
  assert.ok(!ids.includes('om_event'), 'event-captured (raw set) must be excluded — it was handled');
  assert.ok(!ids.includes('om_done'), 'already-handled must be excluded');
  // caller filters by mention; om_nomention is raw-NULL & unhandled so it IS returned here.
  assert.ok(ids.includes('om_nomention'));
  // mention filter (what the backfill applies) narrows to the real candidate.
  const mentioning = rows.filter((r) => r.mentions.includes(BOT)).map((r) => r.messageId);
  assert.deepEqual(mentioning.sort(), ['om_missed_top']);
});

test('marking handled removes a row from the candidate set', () => {
  assert.equal(store.wasMessageHandled('om_missed_top'), false);
  store.markMessageHandled('om_missed_top');
  assert.equal(store.wasMessageHandled('om_missed_top'), true);
  const ids = store.unhandledPolledMessagesSince(T0).map((r) => r.messageId);
  assert.ok(!ids.includes('om_missed_top'), 'once handled it must not be re-offered (no double reply)');
});

test('markMessageHandled is idempotent', () => {
  store.markMessageHandled('om_missed_top');
  store.markMessageHandled('om_missed_top');
  assert.equal(store.wasMessageHandled('om_missed_top'), true);
});

test('recentThreadScanKeysSince unions thread_id and root_id', () => {
  insert({ id: 'om_thr', t: T0 + 5000, text: 'in thread', threadId: 'omt_aaa', raw: '{"x":1}' });
  insert({ id: 'om_root', t: T0 + 6000, text: 'reply', rootId: 'om_root_msg', raw: '{"x":1}' });
  const keys = store.recentThreadScanKeysSince(T0);
  assert.ok(keys.includes('omt_aaa'), 'thread_id is a scan key');
  assert.ok(keys.includes('om_root_msg'), 'root_id is a scan key (events often carry only this)');
});

test('recentThreadScanKeysSince respects the since floor', () => {
  insert({ id: 'om_old_thread', t: T0 - 10 * 86_400_000, text: 'ancient', threadId: 'omt_ancient', raw: '{"x":1}' });
  const keys = store.recentThreadScanKeysSince(T0);
  assert.ok(!keys.includes('omt_ancient'), 'a thread older than the window is not rescanned');
});

test('backfillEpochMs reflects when the feature (v39) was applied', () => {
  const epoch = store.backfillEpochMs();
  assert.ok(epoch > 0);
  // Anchored on v39's applied_at (seconds→ms), so it is a plausible recent ms timestamp, not 0/NaN.
  assert.ok(Number.isFinite(epoch));
});
