import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-store-clusters-'));
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

const store = await import('./store.js');
const { closeDb } = await import('./db.js');

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── event dispatch lifecycle ──────────────────────────────────
test('event dispatch: insert pending → mark sent → fire-once guard + message lookup', async () => {
  await store.upsertEventType({ eventTypeId: 'evt_test', title: 't', scope: 'personal' });
  const actor = 'ou_actor_1';
  assert.equal(await store.hasSuccessfulDispatch('evt_test', actor), false);

  const id = await store.insertEventDispatch({ eventTypeId: 'evt_test', actorOpenId: actor, scope: 'personal' });
  assert.ok(id > 0, 'insert returns a row id');
  assert.equal(await store.hasSuccessfulDispatch('evt_test', actor), false, 'pending is not yet successful');

  await store.updateEventDispatch(id, { status: 'sent', messageId: 'om_msg_99' });
  assert.equal(await store.hasSuccessfulDispatch('evt_test', actor), true, 'sent counts as a successful dispatch');

  const found = await store.getEventDispatchByMessageId('om_msg_99');
  assert.equal(found?.id, id);
  assert.equal(found?.eventTypeId, 'evt_test');
  assert.equal(await store.getEventDispatchByMessageId('om_missing'), null);
});

// ── schedule state ────────────────────────────────────────────
test('schedule state: default is all-null, plan sets next/eval, roll records outcome', async () => {
  const e = 'evt_sched';
  assert.deepEqual(await store.getScheduleState(e), {
    lastEvalAt: null,
    lastFireAt: null,
    lastOutcome: null,
    nextFireAt: null,
  });

  await store.planScheduleFire(e, 1_700_000_000, 1_699_000_000);
  let s = await store.getScheduleState(e);
  assert.equal(s.nextFireAt, 1_700_000_000);
  assert.equal(s.lastEvalAt, 1_699_000_000);
  assert.equal(s.lastFireAt, null);

  await store.resolveScheduleRoll(e, 'fired');
  s = await store.getScheduleState(e);
  assert.equal(s.lastOutcome, 'fired');
  assert.equal(s.nextFireAt, null, 'roll clears the planned fire');
  assert.ok((s.lastFireAt ?? 0) > 0, 'a fired roll stamps last_fire_at');
});

// ── error ledger ──────────────────────────────────────────────
test('error ledger: recordError feeds recentErrorCount and recentErrors', async () => {
  const chat = 'oc_err_chat';
  assert.equal(await store.recentErrorCount(chat, 60_000), 0);
  await store.recordError({ kind: 'timeout', summary: 'kimi timed out', chatId: chat });
  await store.recordError({ kind: 'transient', summary: 'blip', chatId: chat });
  assert.equal(await store.recentErrorCount(chat, 60_000), 2);

  const recent = await store.recentErrors(10);
  assert.ok(recent.some((r) => r.summary === 'blip' && r.chat_id === chat));
});

// ── pending replies (restart recovery) ────────────────────────
test('pending replies: add → list → update → remove round-trip', async () => {
  const base = {
    agentId: 'tudigong-bot',
    channel: 'feishu-bot',
    chatId: 'oc_pending',
    messageId: 'om_p1',
    sessionKey: 'tudigong-bot-oc_pending',
    senderOpenId: 'ou_p',
    text: 'hello',
    reactionId: null,
    ptSpent: 0,
    attempts: 0,
  };
  const id = await store.addPendingReply(base);
  assert.ok(id > 0);

  let pending = await store.listPendingReplies('tudigong-bot', 'feishu-bot');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].messageId, 'om_p1');
  assert.equal(pending[0].attempts, 0);

  await store.updatePendingReply(id, { attempts: 2, reactionId: 'rk_1' });
  pending = await store.listPendingReplies('tudigong-bot', 'feishu-bot');
  assert.equal(pending[0].attempts, 2);
  assert.equal(pending[0].reactionId, 'rk_1');

  await store.removePendingReply(id);
  assert.equal((await store.listPendingReplies('tudigong-bot', 'feishu-bot')).length, 0);
});

// ── chat member directory ─────────────────────────────────────
test('member directory: record members, look up names, count presence and stats', async () => {
  const chat = 'oc_dir';
  await store.upsertChat({ chatId: chat, name: '测试群', external: true });
  await store.recordChatMember(chat, 'ou_m1', '张三');
  await store.recordChatMember(chat, 'ou_m2', '李四');

  assert.equal(await store.memberName('ou_m1'), '张三');
  assert.equal(await store.chatName(chat), '测试群');
  assert.equal(await store.presentMemberCount(chat), 2);

  const stats = await store.directoryStats();
  assert.ok(stats.present >= 2);
  assert.ok(stats.presentExternal >= 2, 'members of an external chat count as external');
});

// ── analytics time-series (calendar RSVP + doc views) ─────────
test('calendar RSVP rounds are idempotent per (synced_at, event_id) and read back latest', async () => {
  const round = {
    syncedAt: 1_700_000_000,
    eventId: 'evt_uuid_1',
    calendarId: 'cal_1',
    title: '共学活动',
    startTime: 1_700_100_000,
    endTime: 1_700_103_600,
    accepted: 12,
    declined: 1,
    tentative: 3,
    needsAction: 4,
    signupTotal: 20,
  };
  assert.equal(await store.recordCalendarEventRsvpRound(round), true, 'first insert');
  assert.equal(await store.recordCalendarEventRsvpRound(round), false, 'duplicate instant+event ignored');

  const latest = await store.latestCalendarEventRsvpRound('evt_uuid_1');
  assert.equal(latest?.accepted, 12);
  assert.equal(latest?.title, '共学活动');
  assert.equal(await store.latestCalendarEventRsvpRound('evt_missing'), null);
});

test('doc view events are idempotent per (file_token, viewer, time) and read back newest-first', async () => {
  const view = {
    fileToken: 'doc_token_1',
    fileType: 'docx',
    source: 'wiki',
    spaceId: 'space_1',
    title: '白皮书',
    viewerId: 'ou_viewer',
    viewerName: '王五',
    lastViewTime: 1_700_000_500,
  };
  assert.equal(await store.recordDocViewEvent(view), true, 'first insert');
  assert.equal(await store.recordDocViewEvent(view), false, 'duplicate view ignored');

  const recent = await store.recentDocViewEvents(10);
  assert.ok(recent.some((r) => r.fileToken === 'doc_token_1' && r.viewerName === '王五'));
});

// The batched writers under the SQLite fallback. Their PostgreSQL behaviour is covered in
// store/batch-writes.pg.test.ts; what only this suite can reach is sqliteExecutor's handling of a
// multi-row statement — every `$N` has to be expanded to its own positional `?` in order (a batch of
// 3 rows × 8 columns carries $1..$24, far past anything the single-row statements exercised), and the
// statement has to be recognised as row-returning from its RETURNING clause so `.all()` runs instead
// of `.run()`. Get either wrong and the rows still land while the caller is told nothing was new.

test('batched doc view writes report the new rows under the SQLite fallback', async () => {
  const view = (viewer: string, at: number) => ({
    fileToken: 'doc_batch_1', fileType: 'docx', source: 'wiki', spaceId: 'space_1', title: '批量',
    viewerId: viewer, viewerName: `名字-${viewer}`, lastViewTime: at,
  });

  const first = await store.recordDocViewEvents([view('ou_1', 100), view('ou_2', 100), view('ou_3', 100)]);
  assert.deepEqual(first.map((e) => e.viewerId), ['ou_1', 'ou_2', 'ou_3'], 'all new, in input order');

  const replay = await store.recordDocViewEvents([view('ou_1', 100), view('ou_2', 100), view('ou_4', 100)]);
  assert.deepEqual(replay.map((e) => e.viewerId), ['ou_4'], 'only the genuinely new view is reported');

  const later = await store.recordDocViewEvents([view('ou_1', 100), view('ou_1', 200)]);
  assert.deepEqual(later.map((e) => e.lastViewTime), [200], 'a later view time is a new row');

  const recent = await store.recentDocViewEvents(50);
  assert.equal(
    recent.filter((r) => r.fileToken === 'doc_batch_1').length, 5,
    'the writes actually landed: ou_1@100, ou_2, ou_3, ou_4, ou_1@200',
  );
});

test('batched reaction writes report the new rows under the SQLite fallback', async () => {
  const rx = (who: string, emoji: string) => ({
    messageId: 'om_batch_1', chatId: 'oc_batch', reactorOpenId: who, emojiType: emoji, actionTime: 7,
  });

  const first = await store.recordChatReactions([rx('ou_a', 'THUMBSUP'), rx('ou_b', 'HEART')]);
  assert.deepEqual(first.map((r) => r.reactorOpenId), ['ou_a', 'ou_b']);

  const second = await store.recordChatReactions([rx('ou_a', 'THUMBSUP'), rx('ou_a', 'HEART')]);
  assert.deepEqual(
    second.map((r) => `${r.reactorOpenId}/${r.emojiType}`), ['ou_a/HEART'],
    'same reactor with a different emoji is a different key',
  );

  assert.equal(await store.memberReactionCount('ou_a'), 2, 'both of ou_a’s reactions landed');
});
