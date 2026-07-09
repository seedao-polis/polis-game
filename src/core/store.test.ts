import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Point the DB at a throwaway file BEFORE store/db are imported, so every test runs against an
// isolated, freshly-migrated database instead of the real .agent/tudigong.db.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-store-test-'));
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

const store = await import('./store.js');
const { closeDb } = await import('./db.js');

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const uid = (() => {
  let n = 0;
  return () => `ou_test_${n++}`;
})();

test('grantPt creates the profile and accumulates the balance', () => {
  const u = uid();
  assert.equal(store.getProfile(u), null);
  assert.equal(store.grantPt(u, 50, 'unit_test'), 50);
  assert.equal(store.grantPt(u, 25, 'unit_test'), 75);
  assert.equal(store.grantPt(u, -10, 'unit_test'), 65);
  assert.equal(store.getProfile(u)?.ptBalance, 65);
});

test('spendPt debits when affordable and refuses when not', () => {
  const u = uid();
  store.grantPt(u, 30, 'seed');
  assert.equal(store.spendPt(u, 100, 'too_much'), false, 'insufficient balance must not spend');
  assert.equal(store.getProfile(u)?.ptBalance, 30, 'balance unchanged after a refused spend');
  assert.equal(store.spendPt(u, 20, 'ok'), true);
  assert.equal(store.getProfile(u)?.ptBalance, 10);
});

test('ensureProfile seeds a new user with the first-contact grant exactly once', () => {
  const u = uid();
  const created = store.ensureProfile(u, 'Alice');
  assert.equal(created.ptBalance, 120, 'first contact grants 120 LP');
  assert.equal(created.name, 'Alice');
  // A second ensure must not re-grant.
  const again = store.ensureProfile(u);
  assert.equal(again.ptBalance, 120);
});

test('recordInteraction reports isNew only on first contact', () => {
  const u = uid();
  const first = store.recordInteraction(u, 'Bob', 'oc_chat', 'om_msg1');
  assert.deepEqual(first, { isNew: true, ptGranted: 120 });
  const second = store.recordInteraction(u, 'Bob', 'oc_chat', 'om_msg2');
  assert.deepEqual(second, { isNew: false, ptGranted: 0 });
  // A falsy openId is a no-op.
  assert.deepEqual(store.recordInteraction('', 'x', 'oc', 'om'), { isNew: false, ptGranted: 0 });
});

test('checkIn awards once per day then becomes a no-op', () => {
  const u = uid();
  const balanceBefore = store.ensureProfile(u).ptBalance;
  const first = store.checkIn(u);
  assert.equal(first.firstToday, true);
  assert.equal(first.awarded, 3);
  assert.equal(first.balance, balanceBefore + 3);
  const second = store.checkIn(u);
  assert.equal(second.firstToday, false);
  assert.equal(second.awarded, 0);
  assert.equal(second.balance, balanceBefore + 3);
});

test('badges: upsert, award-once, list and lookup by id or name', () => {
  const u = uid();
  store.upsertBadge({ badgeId: 'tester', name: '测试徽章', emoji: '🧪', description: 'for tests' });

  assert.equal(store.awardBadge(u, 'tester'), true, 'first award succeeds');
  assert.equal(store.awardBadge(u, 'tester'), false, 'duplicate award is ignored');

  const earned = store.listBadges(u);
  assert.ok(earned.some((b) => b.badgeId === 'tester'), 'earned list contains the awarded badge');

  assert.equal(store.getBadge('tester')?.name, '测试徽章');
  assert.equal(store.getBadge('测试徽章')?.badgeId, 'tester', 'lookup by name resolves to the id');
  assert.equal(store.getBadge('no_such_badge'), undefined);
});

test('upsertBadge overwrites fields on conflict', () => {
  store.upsertBadge({ badgeId: 'mut', name: 'v1', emoji: '1️⃣' });
  store.upsertBadge({ badgeId: 'mut', name: 'v2', emoji: '2️⃣' });
  assert.equal(store.getBadge('mut')?.name, 'v2');
  assert.equal(store.getBadge('mut')?.emoji, '2️⃣');
});

test('leaderboard ranks users by LP descending', () => {
  const a = uid();
  const b = uid();
  const c = uid();
  store.grantPt(a, 1000, 'seed');
  store.grantPt(b, 5000, 'seed');
  store.grantPt(c, 3000, 'seed');
  const top = store.leaderboard(50).map((r) => r.openId);
  assert.ok(top.indexOf(b) < top.indexOf(c), 'b (5000) outranks c (3000)');
  assert.ok(top.indexOf(c) < top.indexOf(a), 'c (3000) outranks a (1000)');
});

test('chat reactions: dedupe by (message, reactor, emoji) and count per reactor', () => {
  const a = uid();
  const b = uid();
  // Six distinct reactions by a → count 6; one by b.
  for (let i = 0; i < 6; i++) {
    assert.equal(
      store.recordChatReaction({ messageId: `om_${i}`, chatId: 'oc_r', reactorOpenId: a, emojiType: 'PARTY', actionTime: i }),
      true,
      'a new reaction is newly inserted'
    );
  }
  assert.equal(store.recordChatReaction({ messageId: 'om_b', chatId: 'oc_r', reactorOpenId: b, emojiType: 'THUMBSUP' }), true);

  // Re-seeing the same (message, reactor, emoji) is a no-op, even with a different action_time.
  assert.equal(
    store.recordChatReaction({ messageId: 'om_0', chatId: 'oc_r', reactorOpenId: a, emojiType: 'PARTY', actionTime: 999 }),
    false,
    'a duplicate reaction is ignored'
  );
  // A different emoji on the same message by the same reactor is a distinct reaction.
  assert.equal(store.recordChatReaction({ messageId: 'om_0', chatId: 'oc_r', reactorOpenId: a, emojiType: 'HEART' }), true);

  assert.equal(store.memberReactionCount(a), 7, 'a has 6 PARTY + 1 HEART');
  assert.equal(store.memberReactionCount(b), 1);
  assert.equal(store.memberReactionCount(uid()), 0, 'an unknown reactor has no reactions');

  // Blank fields are rejected without inserting.
  assert.equal(store.recordChatReaction({ messageId: '', chatId: 'oc_r', reactorOpenId: a, emojiType: 'PARTY' }), false);
  assert.equal(store.recordChatReaction({ messageId: 'om_x', chatId: 'oc_r', reactorOpenId: '', emojiType: 'PARTY' }), false);
});

test('weeklyMemberReactionCount counts only reactions whose action_time is inside the window', () => {
  const a = uid();
  const weekStart = 1_000_000; // arbitrary epoch-second window [1_000_000, 1_000_000 + 7d)
  const weekEnd = weekStart + 7 * 24 * 3600;
  // Three reactions inside the week, one before it, one after it, one with unknown time (0).
  store.recordChatReaction({ messageId: 'om_w1', chatId: 'oc_w', reactorOpenId: a, emojiType: 'PARTY', actionTime: weekStart });
  store.recordChatReaction({ messageId: 'om_w2', chatId: 'oc_w', reactorOpenId: a, emojiType: 'PARTY', actionTime: weekStart + 100 });
  store.recordChatReaction({ messageId: 'om_w3', chatId: 'oc_w', reactorOpenId: a, emojiType: 'PARTY', actionTime: weekEnd - 1 });
  store.recordChatReaction({ messageId: 'om_before', chatId: 'oc_w', reactorOpenId: a, emojiType: 'PARTY', actionTime: weekStart - 1 });
  store.recordChatReaction({ messageId: 'om_after', chatId: 'oc_w', reactorOpenId: a, emojiType: 'PARTY', actionTime: weekEnd });
  store.recordChatReaction({ messageId: 'om_unknown', chatId: 'oc_w', reactorOpenId: a, emojiType: 'PARTY', actionTime: 0 });

  assert.equal(store.weeklyMemberReactionCount(a, weekStart, weekEnd), 3, 'only the 3 in-window reactions count');
  assert.equal(store.weeklyMemberReactionCount(uid(), weekStart, weekEnd), 0, 'unknown reactor has none');
});

test('like-maniac weekly ledger fires once per member per week (idempotent, week-scoped)', () => {
  const a = uid();
  const wk = 2_000_000;
  assert.equal(store.isLikeManiacWeekRecorded(wk, a), false, 'not recorded yet');
  assert.equal(store.recordLikeManiacWeek(wk, a, 'A', 66), true, 'first record for the week is newly inserted');
  assert.equal(store.isLikeManiacWeekRecorded(wk, a), true, 'now reported as recorded');
  assert.equal(store.recordLikeManiacWeek(wk, a, 'A', 80), false, 'a second record for the same week is ignored');
  // A different week for the same member is a distinct milestone.
  const nextWk = wk + 7 * 24 * 3600;
  assert.equal(store.isLikeManiacWeekRecorded(nextWk, a), false, 'the next week starts fresh');
  assert.equal(store.recordLikeManiacWeek(nextWk, a, 'A', 66), true, 'the next week fires again');
  // Blank open_id is rejected.
  assert.equal(store.recordLikeManiacWeek(wk, '', 'X', 66), false);
});

test('pinned messages: record once (idempotent) and query', () => {
  const m = 'om_pin_1';
  assert.equal(store.isMessagePinned(m), false, 'unknown message is not pinned');
  assert.equal(store.recordPinnedMessage(m, 'oc_r', 3), true, 'first record is newly inserted');
  assert.equal(store.isMessagePinned(m), true, 'now reported as pinned');
  assert.equal(store.recordPinnedMessage(m, 'oc_r', 5), false, 'a second record for the same message is ignored');
  // Blank ids are rejected.
  assert.equal(store.recordPinnedMessage('', 'oc_r', 3), false);
  assert.equal(store.recordPinnedMessage('om_pin_2', '', 3), false);
});

test('pinned messages: cap eviction returns oldest beyond the cap, per chat', () => {
  const chat = 'oc_cap';
  // Record 7 pins in order; insertion order (rowid) breaks ties on equal pinned_at, so c1 is oldest.
  for (let i = 1; i <= 7; i++) {
    assert.equal(store.recordPinnedMessage(`om_c${i}`, chat, 3), true);
  }
  // A pin in another chat must not be affected by this chat's cap.
  store.recordPinnedMessage('om_other', 'oc_zzz', 3);

  // Cap 5 → the two oldest (c1, c2) are beyond the cap, returned oldest-first.
  assert.deepEqual(store.pinnedMessagesOldestBeyond(chat, 5), ['om_c1', 'om_c2']);
  // Cap >= count → nothing to evict.
  assert.deepEqual(store.pinnedMessagesOldestBeyond(chat, 7), []);
  assert.deepEqual(store.pinnedMessagesOldestBeyond(chat, 10), []);

  // Evicting the oldest brings it back under the cap.
  store.removePinnedMessage('om_c1');
  store.removePinnedMessage('om_c2');
  assert.deepEqual(store.pinnedMessagesOldestBeyond(chat, 5), []);
  assert.equal(store.isMessagePinned('om_c1'), false, 'evicted message is no longer tracked');
  assert.equal(store.isMessagePinned('om_other'), true, 'other chat pin untouched');
});

test('resetDailyPtFloor lifts only below-floor balances', () => {
  const low = uid();
  const high = uid();
  store.grantPt(low, 2, 'seed');
  store.grantPt(high, 999, 'seed');
  store.resetDailyPtFloor(10);
  assert.equal(store.getProfile(low)?.ptBalance, 10, 'below-floor user lifted to the floor');
  assert.equal(store.getProfile(high)?.ptBalance, 999, 'above-floor user untouched');
});

test('resetAllPtTo sets every balance to the exact target, raising and lowering', () => {
  const low = uid();
  const high = uid();
  store.grantPt(low, 5, 'seed');
  store.grantPt(high, 999, 'seed');
  const res = store.resetAllPtTo(120);
  assert.equal(res.target, 120);
  assert.ok(res.affected >= 2, 'both seeded users moved');
  assert.equal(store.getProfile(low)?.ptBalance, 120, 'below-target user lifted to target');
  assert.equal(store.getProfile(high)?.ptBalance, 120, 'above-target user lowered to target');
  // A user already at the target is not counted as affected on a second run.
  const again = store.resetAllPtTo(120);
  assert.equal(again.affected, 0, 'no-op when everyone already at target');
});

test('stripStatusFooter removes model-echoed LP/AP footers but keeps prose', () => {
  // The exact case observed in production: kimi echoed its own (wrong) footer line into the reply.
  const echoed = '一些分析正文。\n\n🌱 LP : 119.9→119.8 (-0.1)';
  assert.equal(store.stripStatusFooter(echoed), '一些分析正文。');
  // With a [name] prefix and the spaced arrow form.
  assert.equal(store.stripStatusFooter('正文\n[操作者] 🌱 LP : 120.0 → 119.9 (-0.1)'), '正文');
  // Legacy 🍎 AP form (older replies still in conversation context).
  assert.equal(store.stripStatusFooter('正文\n🍎 AP : 100 → 99 (-1)'), '正文');
  // Prose that merely mentions LP must NOT be stripped (no footer marker line).
  const prose = '你现在的 LP 还很充足，放心用。';
  assert.equal(store.stripStatusFooter(prose), prose);
});

test('splitStatusFooter separates the model answer from the appended footer', () => {
  const reply = 'kimi 的回答正文。\n\n[操作者] 🌱 LP : 120.0 → 119.9 (-0.1)';
  const { body, footer } = store.splitStatusFooter(reply);
  assert.equal(body, 'kimi 的回答正文。');
  assert.equal(footer, '[操作者] 🌱 LP : 120.0 → 119.9 (-0.1)');
  // No footer (gating / error reply) → body unchanged, footer empty.
  const noFooter = store.splitStatusFooter('你的 LP 不足，明天 05:00 会自动补到 10。');
  assert.equal(noFooter.footer, '');
  assert.equal(noFooter.body, '你的 LP 不足，明天 05:00 会自动补到 10。');
});

// ── buildStatusFooter (new optional label parameter) ─────────────────────────

test('buildStatusFooter: delta=0, no label → balance only, no arrow, no parens', () => {
  const u = uid();
  store.grantPt(u, 120, 'seed');
  const footer = store.buildStatusFooter(u, 0);
  assert.ok(footer.includes('🌱 LP : 120.0'), 'should show balance');
  assert.ok(!footer.includes('→'), 'no arrow when delta=0');
  assert.ok(!footer.includes('('), 'no parens when delta=0 and no label');
});

test('buildStatusFooter: delta=0, label="访谈中" → balance + (访谈中), no arrow', () => {
  const u = uid();
  store.grantPt(u, 120, 'seed');
  const footer = store.buildStatusFooter(u, 0, '访谈中');
  assert.ok(footer.includes('🌱 LP : 120.0'), 'should show balance');
  assert.ok(footer.includes('(访谈中)'), 'should show label in parens');
  assert.ok(!footer.includes('→'), 'no arrow when delta=0');
});

test('buildStatusFooter: delta=+0.3, label="画重点" → before→after (画重点, +0.3)', () => {
  const u = uid();
  store.grantPt(u, 120, 'seed');
  // Simulate: spend 0.1 then grant 0.4 → balance is now 120.3; net delta passed = +0.3
  store.spendPt(u, 0.1, 'llm_reply');
  store.grantPt(u, 0.4, 'judge_seedao');
  // balance is now 120.3; before = 120.3 - 0.3 = 120.0
  const footer = store.buildStatusFooter(u, 0.3, '画重点');
  assert.ok(footer.includes('→'), 'arrow present when delta≠0');
  assert.ok(footer.includes('120.0 →'), 'before shown as 120.0');
  assert.ok(footer.includes('→ 120.3'), 'after shown as 120.3');
  assert.ok(footer.includes('画重点'), 'label present');
  assert.ok(footer.includes('+0.3'), 'positive delta shown');
  assert.ok(footer.includes('(画重点, +0.3)'), 'label and delta in correct order');
});

test('buildStatusFooter: delta=-0.1, no label → before→after (-0.1), no label', () => {
  const u = uid();
  store.grantPt(u, 120, 'seed');
  store.spendPt(u, 0.1, 'llm_reply');
  // balance is now 119.9; before = 119.9 - (-0.1) = 120.0
  const footer = store.buildStatusFooter(u, -0.1);
  assert.ok(footer.includes('→'), 'arrow present when delta≠0');
  assert.ok(footer.includes('120.0 →'), 'before shown');
  assert.ok(footer.includes('→ 119.9'), 'after shown');
  assert.ok(footer.includes('(-0.1)'), 'negative delta in parens');
  // No extra label content (label was not passed)
  assert.ok(!footer.includes('访谈中'), 'no label text');
  assert.ok(!footer.includes('画重点'), 'no label text');
});
