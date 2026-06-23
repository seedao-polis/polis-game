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
test('event dispatch: insert pending → mark sent → fire-once guard + message lookup', () => {
  store.upsertEventType({ eventTypeId: 'evt_test', title: 't', scope: 'personal' });
  const actor = 'ou_actor_1';
  assert.equal(store.hasSuccessfulDispatch('evt_test', actor), false);

  const id = store.insertEventDispatch({ eventTypeId: 'evt_test', actorOpenId: actor, scope: 'personal' });
  assert.ok(id > 0, 'insert returns a row id');
  assert.equal(store.hasSuccessfulDispatch('evt_test', actor), false, 'pending is not yet successful');

  store.updateEventDispatch(id, { status: 'sent', messageId: 'om_msg_99' });
  assert.equal(store.hasSuccessfulDispatch('evt_test', actor), true, 'sent counts as a successful dispatch');

  const found = store.getEventDispatchByMessageId('om_msg_99');
  assert.equal(found?.id, id);
  assert.equal(found?.eventTypeId, 'evt_test');
  assert.equal(store.getEventDispatchByMessageId('om_missing'), null);
});

// ── schedule state ────────────────────────────────────────────
test('schedule state: default is all-null, plan sets next/eval, roll records outcome', () => {
  const e = 'evt_sched';
  assert.deepEqual(store.getScheduleState(e), {
    lastEvalAt: null,
    lastFireAt: null,
    lastOutcome: null,
    nextFireAt: null,
  });

  store.planScheduleFire(e, 1_700_000_000, 1_699_000_000);
  let s = store.getScheduleState(e);
  assert.equal(s.nextFireAt, 1_700_000_000);
  assert.equal(s.lastEvalAt, 1_699_000_000);
  assert.equal(s.lastFireAt, null);

  store.resolveScheduleRoll(e, 'fired');
  s = store.getScheduleState(e);
  assert.equal(s.lastOutcome, 'fired');
  assert.equal(s.nextFireAt, null, 'roll clears the planned fire');
  assert.ok((s.lastFireAt ?? 0) > 0, 'a fired roll stamps last_fire_at');
});

// ── error ledger ──────────────────────────────────────────────
test('error ledger: recordError feeds recentErrorCount and recentErrors', () => {
  const chat = 'oc_err_chat';
  assert.equal(store.recentErrorCount(chat, 60_000), 0);
  store.recordError({ kind: 'timeout', summary: 'kimi timed out', chatId: chat });
  store.recordError({ kind: 'transient', summary: 'blip', chatId: chat });
  assert.equal(store.recentErrorCount(chat, 60_000), 2);

  const recent = store.recentErrors(10);
  assert.ok(recent.some((r) => r.summary === 'blip' && r.chat_id === chat));
});

// ── pending replies (restart recovery) ────────────────────────
test('pending replies: add → list → update → remove round-trip', () => {
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
  const id = store.addPendingReply(base);
  assert.ok(id > 0);

  let pending = store.listPendingReplies('tudigong-bot', 'feishu-bot');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].messageId, 'om_p1');
  assert.equal(pending[0].attempts, 0);

  store.updatePendingReply(id, { attempts: 2, reactionId: 'rk_1' });
  pending = store.listPendingReplies('tudigong-bot', 'feishu-bot');
  assert.equal(pending[0].attempts, 2);
  assert.equal(pending[0].reactionId, 'rk_1');

  store.removePendingReply(id);
  assert.equal(store.listPendingReplies('tudigong-bot', 'feishu-bot').length, 0);
});

// ── chat member directory ─────────────────────────────────────
test('member directory: record members, look up names, count presence and stats', () => {
  const chat = 'oc_dir';
  store.upsertChat({ chatId: chat, name: '测试群', external: true });
  store.recordChatMember(chat, 'ou_m1', '张三');
  store.recordChatMember(chat, 'ou_m2', '李四');

  assert.equal(store.memberName('ou_m1'), '张三');
  assert.equal(store.chatName(chat), '测试群');
  assert.equal(store.presentMemberCount(chat), 2);

  const stats = store.directoryStats();
  assert.ok(stats.present >= 2);
  assert.ok(stats.presentExternal >= 2, 'members of an external chat count as external');
});

// ── analytics time-series (calendar RSVP + doc views) ─────────
test('calendar RSVP rounds are idempotent per (synced_at, event_id) and read back latest', () => {
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
  assert.equal(store.recordCalendarEventRsvpRound(round), true, 'first insert');
  assert.equal(store.recordCalendarEventRsvpRound(round), false, 'duplicate instant+event ignored');

  const latest = store.latestCalendarEventRsvpRound('evt_uuid_1');
  assert.equal(latest?.accepted, 12);
  assert.equal(latest?.title, '共学活动');
  assert.equal(store.latestCalendarEventRsvpRound('evt_missing'), null);
});

test('doc view events are idempotent per (file_token, viewer, time) and read back newest-first', () => {
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
  assert.equal(store.recordDocViewEvent(view), true, 'first insert');
  assert.equal(store.recordDocViewEvent(view), false, 'duplicate view ignored');

  const recent = store.recentDocViewEvents(10);
  assert.ok(recent.some((r) => r.fileToken === 'doc_token_1' && r.viewerName === '王五'));
});
