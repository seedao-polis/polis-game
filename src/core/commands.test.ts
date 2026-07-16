import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Pin the DB at a throwaway file BEFORE store/db are imported (the rename command writes to it).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-commands-test-'));
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

const { dispatchCommand, isFuzzyCheckIn, isFuzzyLpQuery, parseRename } = await import('./commands.js');
const store = await import('./store.js');
const { closeDb } = await import('./db.js');

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const ctx = (senderOpenId?: string) => ({ agentName: '城邦土地神', source: 'feishu-bot', chatId: 'oc_x', senderOpenId });

// ── fuzzy check-in ────────────────────────────────────────────

test('isFuzzyCheckIn matches short messages ending in 签 / 签到', () => {
  assert.equal(isFuzzyCheckIn('每日签到'), true);
  assert.equal(isFuzzyCheckIn('8/12 签'), true);
  assert.equal(isFuzzyCheckIn('@城邦土地神 每日签到'), true); // leading mention stripped
  assert.equal(isFuzzyCheckIn('打卡签到'), true);
});

test('isFuzzyCheckIn rejects non-matching or over-long messages', () => {
  assert.equal(isFuzzyCheckIn('今天天气不错'), false); // does not end in 签/签到
  assert.equal(isFuzzyCheckIn('签个字'), false); // ends in 字, not 签/签到
  assert.equal(isFuzzyCheckIn('这是一条很长的消息你看到这里应该已经超过十五个字了吧签'), false); // >= 15 chars
  assert.equal(isFuzzyCheckIn(''), false);
});

test('the exact 签 / 签到 aliases still check in', () => {
  const u = 'ou_sign_exact';
  const r = dispatchCommand('签到', ctx(u));
  assert.equal(r.handled, true);
  assert.equal(r.command, 'sign');
  assert.match(r.reply ?? '', /签到/);
});

test('a fuzzy check-in routes to the sign command and awards LP once per day', () => {
  const u = 'ou_sign_fuzzy';
  const first = dispatchCommand('每日签到', ctx(u));
  assert.equal(first.handled, true);
  assert.equal(first.command, 'sign');
  assert.match(first.reply ?? '', /签到/);
  // Second fuzzy check-in the same day is a no-op award (already checked in).
  const again = dispatchCommand('8/12 签', ctx(u));
  assert.equal(again.command, 'sign');
  assert.match(again.reply ?? '', /已在 SeeDAO 数字城邦签到/);
});

// ── fuzzy LP-balance query ────────────────────────────────────

test('isFuzzyLpQuery matches short self-referential balance checks', () => {
  assert.equal(isFuzzyLpQuery('我现在有多少 LP'), true);
  assert.equal(isFuzzyLpQuery('查一下我的积分'), true);
  assert.equal(isFuzzyLpQuery('我还有多少生命点'), true);
  assert.equal(isFuzzyLpQuery('@城邦土地神 我的 LP 还剩多少'), true); // leading mention stripped
});

test('isFuzzyLpQuery rejects bet-status questions that merely mention LP', () => {
  // A member asking about a wager they placed — the LP is a bet amount, not the balance.
  assert.equal(isFuzzyLpQuery('我西班牙的 押注 LP呢'), false);
  assert.equal(isFuzzyLpQuery('我投注的 LP 什么时候结算'), false);
  assert.equal(isFuzzyLpQuery('我押 5LP 中了没'), false);
  assert.equal(isFuzzyLpQuery('LP是什么'), false); // mechanism question, no self/query signal
});

test('a bet-status question is not swallowed by the lp command (falls through to the LLM)', () => {
  const r = dispatchCommand('@城邦土地神 我西班牙的 押注 LP呢', ctx('ou_bet_asker'));
  assert.equal(r.handled, false); // not handled as a command → handed to the agent to answer
});

// ── rename ────────────────────────────────────────────────────

test('parseRename extracts the name (glued, spaced, full-width, with @mention)', () => {
  assert.equal(parseRename('改名Vicky'), 'Vicky');
  assert.equal(parseRename('改名 Vicky Huang'), 'Vicky Huang');
  assert.equal(parseRename('改名　Vicky'), 'Vicky'); // full-width space after 改名
  assert.equal(parseRename('@城邦土地神 改名 Vicky Huang '), 'Vicky Huang'); // trailing space trimmed
  assert.equal(parseRename('改名'), ''); // bare 改名 → empty name (usage)
  assert.equal(parseRename('签到'), null); // not a rename
  assert.equal(parseRename('改名怎么操作？'), null); // a question is not a rename → falls to the LLM
});

test('dispatchCommand renames the sender and the new name resolves everywhere', () => {
  const u = 'ou_rename_me';
  store.ensureProfile(u, '用户560770'); // seed a profile with the raw captured name
  const r = dispatchCommand('@城邦土地神 改名 Vicky Huang', ctx(u));
  assert.equal(r.handled, true);
  assert.equal(r.command, 'rename');
  assert.match(r.reply ?? '', /Vicky Huang/);
  // Display surfaces resolve the new name by open_id.
  assert.equal(store.getProfile(u)?.name, 'Vicky Huang');
  store.recordChatMember('oc_x', u, '用户560770'); // roster still holds the raw Feishu name
  assert.equal(store.memberName(u), 'Vicky Huang'); // memberName applies the override
});

test('a bare 改名 with no name replies with usage and does not change the name', () => {
  const u = 'ou_rename_bare';
  store.ensureProfile(u, '张三');
  const r = dispatchCommand('改名', ctx(u));
  assert.equal(r.handled, true);
  assert.equal(r.command, 'rename');
  assert.match(r.reply ?? '', /改名用法/);
  assert.equal(store.getProfile(u)?.name, '张三');
});

test('rename without a sender open_id is refused (handled, not sent to the LLM)', () => {
  const r = dispatchCommand('改名 Vicky', ctx(undefined));
  assert.equal(r.handled, true);
  assert.match(r.reply ?? '', /无法确认你的身份/);
});
