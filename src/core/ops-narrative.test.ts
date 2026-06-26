import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Isolated, freshly-migrated DB (must be set before store/db import).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-narrative-test-'));
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

const store = await import('./store.js');
const { closeDb } = await import('./db.js');
const { loadConfigs } = await import('./configs.js');
const { gatherDayData, parseMemberRefs, hardTruncate } = await import('./ops-narrative.js');

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function msg(id: string, chatId: string, t: number, text: string, sender = 'ou_u1', name = 'Alice') {
  store.insertMessage({
    messageId: id,
    chatId,
    senderOpenId: sender,
    senderName: name,
    msgType: 'text',
    text,
    mentions: [],
    // messages.create_time is MILLISECONDS; tests pass second-scale t and the window in seconds.
    createTime: t * 1000,
  });
}

test('hardTruncate caps length and prefers a sentence boundary', () => {
  const short = '今天社区很活跃。';
  assert.equal(hardTruncate(short, 500), short, 'under the cap is returned unchanged');

  const long = '第一句话结束。' + '第二句也结束。' + '第三句很长没有标点继续写下去一直到超过上限为止';
  const out = hardTruncate(long, 16);
  assert.ok([...out].length <= 16 + 1, 'result (plus the … marker) stays within the cap');
  assert.ok(out.endsWith('…'), 'truncated text is marked with an ellipsis');

  // Chinese chars count as single code points, not UTF-16 length.
  assert.equal([...hardTruncate('字'.repeat(600), 500)].length, 501); // 500 + '…'
});

test('parseMemberRefs round-trips formatMemberRefs', () => {
  const refs = [
    { openId: 'ou_1', name: 'Alice' },
    { openId: 'ou_2', name: 'Bob Lee' },
  ];
  assert.deepEqual(parseMemberRefs(store.formatMemberRefs(refs)), refs);
  assert.deepEqual(parseMemberRefs(''), []);
});

test('gatherDayData summarizes public/member content but only counts work-group metrics', () => {
  store.upsertChat({ chatId: 'oc_pub', name: '围观群', external: true });
  store.upsertChat({ chatId: 'oc_work', name: '工作群', external: false });

  // Public chat: 2 senders, 3 messages → content should be summarized.
  msg('p1', 'oc_pub', 1100, '今天有什么活动', 'ou_a', 'Amy');
  msg('p2', 'oc_pub', 1200, '欢迎新朋友', 'ou_b', 'Ben');
  msg('p3', 'oc_pub', 1300, '请问怎么加入', 'ou_a', 'Amy');

  // Work chat: real discussion that must NOT be summarized, only counted.
  msg('w1', 'oc_work', 1150, '内部预算讨论', 'ou_c', 'Cara');
  msg('w2', 'oc_work', 1250, '下周排期', 'ou_c', 'Cara');

  const data = gatherDayData(
    { from: 1000, to: 2000 },
    { tierOf: (id) => (id === 'oc_work' ? 'work' : 'public') },
  );

  assert.equal(data.totalMessages, 5);

  const pub = data.chats.find((c) => c.chatId === 'oc_pub')!;
  assert.equal(pub.messageCount, 3);
  assert.equal(pub.activeMembers, 2);
  assert.equal(pub.contentIncluded, true);
  assert.equal(pub.lines.length, 3, 'public chat content is summarized');
  assert.ok(pub.lines.some((l) => l.text === '请问怎么加入'));

  const work = data.chats.find((c) => c.chatId === 'oc_work')!;
  assert.equal(work.messageCount, 2, 'work chat still counted in metrics');
  assert.equal(work.activeMembers, 1);
  assert.equal(work.contentIncluded, false);
  assert.equal(work.lines.length, 0, 'work chat content is NEVER summarized');

  // Sorted by message volume: public (3) before work (2).
  assert.equal(data.chats[0]!.chatId, 'oc_pub');
});

test('gatherDayData excludes the bot’s own messages from activity', () => {
  // The default profile bot open_id (from configs/lark.json); fall back is harmless if absent.
  const botId = loadConfigs().lark.profiles.default?.botOpenId ?? 'ou_bot_fallback';
  store.upsertChat({ chatId: 'oc_bot', name: '测试群', external: true });
  msg('b1', 'oc_bot', 1400, '人类发言', 'ou_human', '路人');
  msg('b2', 'oc_bot', 1450, '机器人自动回复', botId, '城邦土地神');

  const data = gatherDayData({ from: 1000, to: 2000 }, { tierOf: () => 'public' });
  const c = data.chats.find((x) => x.chatId === 'oc_bot')!;
  assert.equal(c.messageCount, 1, 'bot message excluded from count');
  assert.equal(c.activeMembers, 1);
  assert.ok(!c.lines.some((l) => l.text.includes('机器人')), 'bot content not summarized');
});

test('gatherDayData aggregates member joins/leaves from sync rounds', () => {
  store.recordMemberSyncRound({
    syncedAt: 1100,
    chatCount: 1,
    presentTotal: 100,
    presentExternal: 100,
    joinedCount: 1,
    leftCount: 0,
    renamedCount: 1,
    rosterTotal: 100,
    joinedDetail: '(ou_new1, 新人甲)',
    leftDetail: '',
    renamedDetail: '(ou_x, 改名乙)',
  });
  store.recordMemberSyncRound({
    syncedAt: 1500,
    chatCount: 1,
    presentTotal: 102,
    presentExternal: 102,
    joinedCount: 1,
    leftCount: 1,
    renamedCount: 0,
    rosterTotal: 101,
    joinedDetail: '(ou_new2, 新人丙)',
    leftDetail: '(ou_gone, 离开丁)',
    renamedDetail: '',
  });

  const data = gatherDayData({ from: 1000, to: 2000 }, { tierOf: () => 'public' });
  assert.deepEqual(
    data.members.joined.map((j) => j.name).sort(),
    ['新人丙', '新人甲'],
  );
  assert.deepEqual(data.members.left.map((l) => l.name), ['离开丁']);
  assert.equal(data.members.renamed, 1);
  assert.equal(data.members.presentExternal, 102);
  assert.equal(data.members.presentExternalDelta, 2);
});
