import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Isolated, freshly-migrated DB (must be set before store/db import).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reply-context-test-'));
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

const store = await import('./store.js');
const { closeDb } = await import('./db.js');
const { buildReplyContext, renderContext, renderReplyQuote, MAX_QUOTE_CHARS } = await import('./reply-context.js');

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const CHAT = 'oc_reply_ctx';
const names: Record<string, string> = { ou_ajian: '阿坚', ou_baiyu: '白鱼', ou_liqin: '李沁' };
const resolveName = (openId: string): string => names[openId] ?? '';

function msg(o: {
  id: string;
  sender: string;
  text: string;
  t: number;
  msgType?: string;
  replyToId?: string;
  rootId?: string;
}) {
  store.insertMessage({
    messageId: o.id,
    chatId: CHAT,
    senderOpenId: o.sender,
    senderName: '',
    msgType: o.msgType ?? 'text',
    text: o.text,
    mentions: [],
    replyToId: o.replyToId,
    rootId: o.rootId,
    createTime: o.t,
  });
}

// The real 2026-07-17 incident, reproduced from the production envelope and timeline: 阿坚 posts an
// opinion at 13:05; eleven messages and 3.5h later 白鱼 replies TO THAT MESSAGE asking "你怎么看这个
// 发言". The bot answered about 李沁's self-intro, because the 8-row window held nothing else and the
// reply linkage was dropped at the event entry (the envelope names it reply_to, the code read
// parent_id). These tests pin both halves of that failure.
const AJIAN_POST = '个人观点：ai刚开始出现的时候，是作为工具，去辅助人类去完成某些工作…对待工具和对待生命是不一样的。';
// Real length matters here: the production pair was 627 and 632 chars. A short stub would sit inside
// the dedupe prefix and make the double-send test pass or fail for the wrong reason.
const SELF_INTRO =
  '大家好~我是这次第二届数字游民生活周的共创人之一Gloria，我正在策划生活周的共创活动，为了得到一些灵感，' +
  '就翻看了SeeDAO的历史推文，看到了这个飞书二维码就加入进来了哈哈！我刚参加完南塘DAO的艺术共创营，' +
  '重新找回了对画画的热情，最近就是在大画特画丙烯画，同时也在了解艺术创作+乡村振兴+民众学院的项目。';

test('setup: the incident timeline', () => {
  msg({ id: 'om_ajian', sender: 'ou_ajian', text: AJIAN_POST, t: 1784264700000, msgType: 'post' });
  for (let i = 0; i < 5; i++) {
    msg({ id: `om_filler${i}`, sender: 'ou_liqin', text: `闲聊 ${i}`, t: 1784266000000 + i * 1000 });
  }
  msg({ id: 'om_join1', sender: '', text: '谢子骞 joined the group via a link shared by 白鱼.', t: 1784269000000, msgType: 'system' });
  msg({ id: 'om_join2', sender: '', text: '李沁 joined the group via a QR Code shared by 白鱼.', t: 1784269100000, msgType: 'system' });
  // NOT byte-identical: the real double-send was 632 vs 627 chars (edited between the two sends).
  // An exact-string dedupe passes a test built from identical strings and then does nothing in
  // production — which is exactly what happened before this test was written from the real data.
  msg({ id: 'om_intro1', sender: 'ou_liqin', text: SELF_INTRO, t: 1784271060000, msgType: 'post' });
  msg({ id: 'om_intro2', sender: 'ou_liqin', text: `${SELF_INTRO}（已编辑，多了一句尾巴）`, t: 1784271061000, msgType: 'post' });
  msg({ id: 'om_cmd1', sender: 'ou_op', text: '@城邦土地神 收录自介', t: 1784271120000 });
  msg({ id: 'om_cmd2', sender: 'ou_op', text: '@城邦土地神 收录自介', t: 1784271180000 });
  msg({
    id: 'om_baiyu', sender: 'ou_baiyu', text: '@阿坚 @城邦土地神 你怎么看这个发言',
    t: 1784277594633, replyToId: 'om_ajian', rootId: 'om_ajian',
  });
});

test('reply linkage survives the round-trip through the DB', () => {
  const row = store.getMessageRow('om_baiyu');
  assert.equal(row?.replyToId, 'om_ajian');
  assert.equal(row?.rootId, 'om_ajian');
});

test('the recent window alone does NOT reach the replied-to message (the bug)', () => {
  const rows = store.getRecentChatMessages(CHAT, { limit: 8, excludeMessageId: 'om_baiyu' });
  const window = renderContext(rows, resolveName);
  // This is the condition that made the model answer about the self-intro.
  assert.ok(!window.includes('个人观点'), '阿坚的发言本就不该在 8 条窗口内（若在，本测试失去意义）');
  assert.ok(window.includes('Gloria'), '自介确实占据了窗口');
});

test('the replied-to message is pinned into the context even though it is outside the window', () => {
  const rows = store.getRecentChatMessages(CHAT, { limit: 8, excludeMessageId: 'om_baiyu' });
  const target = store.getMessageRow('om_ajian');
  const context = buildReplyContext(rows, target, '白鱼', resolveName);

  assert.ok(context.includes('个人观点'), '被回复的原文必须进上下文——这正是本次事故的死因');
  assert.ok(context.includes('白鱼 正在回复 阿坚'), '必须明确标出回复关系，而不是让模型去猜');
  // The quote leads: it is the referent, the window is only backstory.
  assert.ok(context.indexOf('个人观点') < context.indexOf('Gloria'), '引用块必须排在窗口之前');
});

test('system join notices are dropped', () => {
  const rows = store.getRecentChatMessages(CHAT, { limit: 8, excludeMessageId: 'om_baiyu' });
  const window = renderContext(rows, resolveName);
  assert.ok(!window.includes('joined the group'), '入群系统通知不是对话，不该占窗口');
});

test('a near-identical double-send from the same author collapses to one', () => {
  const rows = store.getRecentChatMessages(CHAT, { limit: 8, excludeMessageId: 'om_baiyu' });
  const window = renderContext(rows, resolveName);
  assert.equal(window.split('第二届数字游民生活周').length - 1, 1, '连发的重复自介（内容略有差异）只应保留一条');
});

test('two different messages from the same author are NOT collapsed', () => {
  const solo = 'oc_dedupe_guard';
  store.insertMessage({ messageId: 'om_s1', chatId: solo, senderOpenId: 'ou_ajian', senderName: '', msgType: 'text', text: '第一句话，讲的是这件事', mentions: [], createTime: 1000 });
  store.insertMessage({ messageId: 'om_s2', chatId: solo, senderOpenId: 'ou_ajian', senderName: '', msgType: 'text', text: '第二句话，讲的是另一件事', mentions: [], createTime: 2000 });
  const window = renderContext(store.getRecentChatMessages(solo, { limit: 8 }), resolveName);
  assert.ok(window.includes('第一句话'), '同一人的不同发言不能被去重误杀');
  assert.ok(window.includes('第二句话'));
});

test('a long quote is truncated rather than allowed to eat the prompt', () => {
  const long = 'あ'.repeat(MAX_QUOTE_CHARS + 500);
  const quote = renderReplyQuote(
    { messageId: 'x', chatId: CHAT, senderOpenId: 'ou_ajian', senderName: '', msgType: 'text', text: long, mentions: [], createTime: 1 },
    '白鱼',
    resolveName
  );
  assert.ok(quote.includes('已截断'));
  assert.ok(quote.length < MAX_QUOTE_CHARS + 200);
});

test('an uncaptured reply target degrades to the window instead of throwing', () => {
  const rows = store.getRecentChatMessages(CHAT, { limit: 8, excludeMessageId: 'om_baiyu' });
  const context = buildReplyContext(rows, store.getMessageRow('om_does_not_exist'), '白鱼', resolveName);
  assert.ok(context.length > 0);
  assert.ok(!context.includes('正在回复'));
});

// Measured on live data: 4 of 11 chats had their last 8 messages spanning >72h, one 17 days — all of
// which the prompt labels "最近的对话上下文". sinceMs is absolute (anchored on the trigger message's own
// timestamp), so this test asserts a pure query and never depends on wall-clock now.
test('the chat window drops messages older than the cutoff', () => {
  const trigger = 1784277594633;
  const dayBefore = trigger - 24 * 60 * 60 * 1000;
  const fresh = store.getRecentChatMessages(CHAT, { limit: 8, excludeMessageId: 'om_baiyu', sinceMs: dayBefore });
  assert.ok(fresh.length > 0, '24h 内的消息应该留下');

  const cutoffAfterEverything = store.getRecentChatMessages(CHAT, { limit: 8, excludeMessageId: 'om_baiyu', sinceMs: trigger });
  assert.equal(cutoffAfterEverything.length, 0, '截止时间晚于所有消息时应为空，而不是照样端出陈年旧账');
});

test('a stale window yields empty context rather than passing off old messages as recent', () => {
  const rows = store.getRecentChatMessages(CHAT, { limit: 8, excludeMessageId: 'om_baiyu', sinceMs: 1784277594633 });
  const target = store.getMessageRow('om_ajian');
  // The pinned quote still carries the referent even when the window is empty — the fix does not
  // depend on the window at all.
  const context = buildReplyContext(rows, target, '白鱼', resolveName);
  assert.ok(context.includes('个人观点'));
  assert.ok(!context.includes('Gloria'));
});

test('an original post (no reply linkage) is unaffected', () => {
  const rows = store.getRecentChatMessages(CHAT, { limit: 8, excludeMessageId: 'om_baiyu' });
  const context = buildReplyContext(rows, null, '白鱼', resolveName);
  assert.equal(context, renderContext(rows, resolveName));
});
