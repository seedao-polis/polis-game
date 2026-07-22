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

test('grantPt creates the profile and accumulates the balance', async () => {
  const u = uid();
  assert.equal(await store.getProfile(u), null);
  assert.equal(await store.grantPt(u, 50, 'unit_test'), 50);
  assert.equal(await store.grantPt(u, 25, 'unit_test'), 75);
  assert.equal(await store.grantPt(u, -10, 'unit_test'), 65);
  assert.equal((await store.getProfile(u))?.ptBalance, 65);
});

test('spendPt debits when affordable and refuses when not', async () => {
  const u = uid();
  await store.grantPt(u, 30, 'seed');
  assert.equal(await store.spendPt(u, 100, 'too_much'), false, 'insufficient balance must not spend');
  assert.equal((await store.getProfile(u))?.ptBalance, 30, 'balance unchanged after a refused spend');
  assert.equal(await store.spendPt(u, 20, 'ok'), true);
  assert.equal((await store.getProfile(u))?.ptBalance, 10);
});

test('ensureProfile seeds a new user with the first-contact grant exactly once', async () => {
  const u = uid();
  const created = await store.ensureProfile(u, 'Alice');
  assert.equal(created.ptBalance, 120, 'first contact grants 120 LP');
  assert.equal(created.name, 'Alice');
  // A second ensure must not re-grant.
  const again = await store.ensureProfile(u);
  assert.equal(again.ptBalance, 120);
});

test('recordInteraction reports isNew only on first contact', async () => {
  const u = uid();
  const first = await store.recordInteraction(u, 'Bob', 'oc_chat', 'om_msg1');
  assert.deepEqual(first, { isNew: true, ptGranted: 120 });
  const second = await store.recordInteraction(u, 'Bob', 'oc_chat', 'om_msg2');
  assert.deepEqual(second, { isNew: false, ptGranted: 0 });
  // A falsy openId is a no-op.
  assert.deepEqual(await store.recordInteraction('', 'x', 'oc', 'om'), { isNew: false, ptGranted: 0 });
});

test('checkIn awards once per day then becomes a no-op', async () => {
  const u = uid();
  const balanceBefore = (await store.ensureProfile(u)).ptBalance;
  const first = await store.checkIn(u);
  assert.equal(first.firstToday, true);
  assert.equal(first.awarded, 3);
  assert.equal(first.balance, balanceBefore + 3);
  const second = await store.checkIn(u);
  assert.equal(second.firstToday, false);
  assert.equal(second.awarded, 0);
  assert.equal(second.balance, balanceBefore + 3);
});

test('badges: upsert, award-once, list and lookup by id or name', async () => {
  const u = uid();
  await store.upsertBadge({ badgeId: 'tester', name: '测试徽章', emoji: '🧪', description: 'for tests' });

  assert.equal(await store.awardBadge(u, 'tester'), true, 'first award succeeds');
  assert.equal(await store.awardBadge(u, 'tester'), false, 'duplicate award is ignored');

  const earned = await store.listBadges(u);
  assert.ok(earned.some((b) => b.badgeId === 'tester'), 'earned list contains the awarded badge');

  assert.equal((await store.getBadge('tester'))?.name, '测试徽章');
  assert.equal((await store.getBadge('测试徽章'))?.badgeId, 'tester', 'lookup by name resolves to the id');
  assert.equal(await store.getBadge('no_such_badge'), undefined);
});

test('upsertBadge overwrites fields on conflict', async () => {
  await store.upsertBadge({ badgeId: 'mut', name: 'v1', emoji: '1️⃣' });
  await store.upsertBadge({ badgeId: 'mut', name: 'v2', emoji: '2️⃣' });
  assert.equal((await store.getBadge('mut'))?.name, 'v2');
  assert.equal((await store.getBadge('mut'))?.emoji, '2️⃣');
});

test('leaderboard ranks users by LP descending', async () => {
  const a = uid();
  const b = uid();
  const c = uid();
  await store.grantPt(a, 1000, 'seed');
  await store.grantPt(b, 5000, 'seed');
  await store.grantPt(c, 3000, 'seed');
  const top = (await store.leaderboard(50)).map((r) => r.openId);
  assert.ok(top.indexOf(b) < top.indexOf(c), 'b (5000) outranks c (3000)');
  assert.ok(top.indexOf(c) < top.indexOf(a), 'c (3000) outranks a (1000)');
});

test('chat reactions: dedupe by (message, reactor, emoji) and count per reactor', async () => {
  const a = uid();
  const b = uid();
  // Six distinct reactions by a → count 6; one by b.
  for (let i = 0; i < 6; i++) {
    assert.equal(
      await store.recordChatReaction({ messageId: `om_${i}`, chatId: 'oc_r', reactorOpenId: a, emojiType: 'PARTY', actionTime: i }),
      true,
      'a new reaction is newly inserted'
    );
  }
  assert.equal(await store.recordChatReaction({ messageId: 'om_b', chatId: 'oc_r', reactorOpenId: b, emojiType: 'THUMBSUP' }), true);

  // Re-seeing the same (message, reactor, emoji) is a no-op, even with a different action_time.
  assert.equal(
    await store.recordChatReaction({ messageId: 'om_0', chatId: 'oc_r', reactorOpenId: a, emojiType: 'PARTY', actionTime: 999 }),
    false,
    'a duplicate reaction is ignored'
  );
  // A different emoji on the same message by the same reactor is a distinct reaction.
  assert.equal(await store.recordChatReaction({ messageId: 'om_0', chatId: 'oc_r', reactorOpenId: a, emojiType: 'HEART' }), true);

  assert.equal(await store.memberReactionCount(a), 7, 'a has 6 PARTY + 1 HEART');
  assert.equal(await store.memberReactionCount(b), 1);
  assert.equal(await store.memberReactionCount(uid()), 0, 'an unknown reactor has no reactions');

  // Blank fields are rejected without inserting.
  assert.equal(await store.recordChatReaction({ messageId: '', chatId: 'oc_r', reactorOpenId: a, emojiType: 'PARTY' }), false);
  assert.equal(await store.recordChatReaction({ messageId: 'om_x', chatId: 'oc_r', reactorOpenId: '', emojiType: 'PARTY' }), false);
});

test('weeklyMemberReactionCount counts only reactions whose action_time is inside the window', async () => {
  const a = uid();
  const weekStart = 1_000_000; // arbitrary epoch-second window [1_000_000, 1_000_000 + 7d)
  const weekEnd = weekStart + 7 * 24 * 3600;
  // Three reactions inside the week, one before it, one after it, one with unknown time (0).
  await store.recordChatReaction({ messageId: 'om_w1', chatId: 'oc_w', reactorOpenId: a, emojiType: 'PARTY', actionTime: weekStart });
  await store.recordChatReaction({ messageId: 'om_w2', chatId: 'oc_w', reactorOpenId: a, emojiType: 'PARTY', actionTime: weekStart + 100 });
  await store.recordChatReaction({ messageId: 'om_w3', chatId: 'oc_w', reactorOpenId: a, emojiType: 'PARTY', actionTime: weekEnd - 1 });
  await store.recordChatReaction({ messageId: 'om_before', chatId: 'oc_w', reactorOpenId: a, emojiType: 'PARTY', actionTime: weekStart - 1 });
  await store.recordChatReaction({ messageId: 'om_after', chatId: 'oc_w', reactorOpenId: a, emojiType: 'PARTY', actionTime: weekEnd });
  await store.recordChatReaction({ messageId: 'om_unknown', chatId: 'oc_w', reactorOpenId: a, emojiType: 'PARTY', actionTime: 0 });

  assert.equal(await store.weeklyMemberReactionCount(a, weekStart, weekEnd), 3, 'only the 3 in-window reactions count');
  assert.equal(await store.weeklyMemberReactionCount(uid(), weekStart, weekEnd), 0, 'unknown reactor has none');
});

test('like-maniac weekly ledger fires once per member per week (idempotent, week-scoped)', async () => {
  const a = uid();
  const wk = 2_000_000;
  assert.equal(await store.isLikeManiacWeekRecorded(wk, a), false, 'not recorded yet');
  assert.equal(await store.recordLikeManiacWeek(wk, a, 'A', 66), true, 'first record for the week is newly inserted');
  assert.equal(await store.isLikeManiacWeekRecorded(wk, a), true, 'now reported as recorded');
  assert.equal(await store.recordLikeManiacWeek(wk, a, 'A', 80), false, 'a second record for the same week is ignored');
  // A different week for the same member is a distinct milestone.
  const nextWk = wk + 7 * 24 * 3600;
  assert.equal(await store.isLikeManiacWeekRecorded(nextWk, a), false, 'the next week starts fresh');
  assert.equal(await store.recordLikeManiacWeek(nextWk, a, 'A', 66), true, 'the next week fires again');
  // Blank open_id is rejected.
  assert.equal(await store.recordLikeManiacWeek(wk, '', 'X', 66), false);
});

test('pinned messages: record once (idempotent) and query', async () => {
  const m = 'om_pin_1';
  assert.equal(await store.isMessagePinned(m), false, 'unknown message is not pinned');
  assert.equal(await store.recordPinnedMessage(m, 'oc_r', 3), true, 'first record is newly inserted');
  assert.equal(await store.isMessagePinned(m), true, 'now reported as pinned');
  assert.equal(await store.recordPinnedMessage(m, 'oc_r', 5), false, 'a second record for the same message is ignored');
  // Blank ids are rejected.
  assert.equal(await store.recordPinnedMessage('', 'oc_r', 3), false);
  assert.equal(await store.recordPinnedMessage('om_pin_2', '', 3), false);
});

test('pinned messages: cap eviction returns oldest beyond the cap, per chat', async () => {
  const chat = 'oc_cap';
  // Record 7 pins in quick succession — pinned_at (second resolution) commonly ties across all of
  // them within a single test run. A tie is broken arbitrarily (no cross-backend surrogate ordering
  // column exists to order by), so this only asserts the evicted COUNT and self-consistency, not
  // which specific two of the seven tied messages come out "oldest".
  for (let i = 1; i <= 7; i++) {
    assert.equal(await store.recordPinnedMessage(`om_c${i}`, chat, 3), true);
  }
  // A pin in another chat must not be affected by this chat's cap.
  await store.recordPinnedMessage('om_other', 'oc_zzz', 3);

  // Cap 5 → exactly the two oldest-beyond-cap pins are returned (which two is unspecified on a tie).
  const evicted = await store.pinnedMessagesOldestBeyond(chat, 5);
  assert.equal(evicted.length, 2, 'exactly 2 of the 7 pins are beyond a cap of 5');
  assert.equal(new Set(evicted).size, 2, 'the two evicted ids are distinct');
  for (const id of evicted) assert.match(id, /^om_c[1-7]$/, "evicted ids come from this chat's own pins");
  // Cap >= count → nothing to evict.
  assert.deepEqual(await store.pinnedMessagesOldestBeyond(chat, 7), []);
  assert.deepEqual(await store.pinnedMessagesOldestBeyond(chat, 10), []);

  // Evicting the returned ids brings the chat back under the cap.
  for (const id of evicted) await store.removePinnedMessage(id);
  assert.deepEqual(await store.pinnedMessagesOldestBeyond(chat, 5), []);
  assert.equal(await store.isMessagePinned(evicted[0]), false, 'evicted message is no longer tracked');
  assert.equal(await store.isMessagePinned('om_other'), true, 'other chat pin untouched');
});

test('resetDailyPtFloor lifts only below-floor balances', async () => {
  const low = uid();
  const high = uid();
  await store.grantPt(low, 2, 'seed');
  await store.grantPt(high, 999, 'seed');
  await store.resetDailyPtFloor(10);
  assert.equal((await store.getProfile(low))?.ptBalance, 10, 'below-floor user lifted to the floor');
  assert.equal((await store.getProfile(high))?.ptBalance, 999, 'above-floor user untouched');
});

test('resetAllPtTo sets every balance to the exact target, raising and lowering', async () => {
  const low = uid();
  const high = uid();
  await store.grantPt(low, 5, 'seed');
  await store.grantPt(high, 999, 'seed');
  const res = await store.resetAllPtTo(120);
  assert.equal(res.target, 120);
  assert.ok(res.affected >= 2, 'both seeded users moved');
  assert.equal((await store.getProfile(low))?.ptBalance, 120, 'below-target user lifted to target');
  assert.equal((await store.getProfile(high))?.ptBalance, 120, 'above-target user lowered to target');
  // A user already at the target is not counted as affected on a second run.
  const again = await store.resetAllPtTo(120);
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

test('buildStatusFooter: delta=0, no label → balance only, no arrow, no parens', async () => {
  const u = uid();
  await store.grantPt(u, 120, 'seed');
  const footer = await store.buildStatusFooter(u, 0);
  assert.ok(footer.includes('🌱 LP : 120.0'), 'should show balance');
  assert.ok(!footer.includes('→'), 'no arrow when delta=0');
  assert.ok(!footer.includes('('), 'no parens when delta=0 and no label');
});

test('buildStatusFooter: delta=0, label="访谈中" → balance + (访谈中), no arrow', async () => {
  const u = uid();
  await store.grantPt(u, 120, 'seed');
  const footer = await store.buildStatusFooter(u, 0, '访谈中');
  assert.ok(footer.includes('🌱 LP : 120.0'), 'should show balance');
  assert.ok(footer.includes('(访谈中)'), 'should show label in parens');
  assert.ok(!footer.includes('→'), 'no arrow when delta=0');
});

test('buildStatusFooter: delta=+0.3, label="画重点" → before→after (画重点, +0.3)', async () => {
  const u = uid();
  await store.grantPt(u, 120, 'seed');
  // Simulate: spend 0.1 then grant 0.4 → balance is now 120.3; net delta passed = +0.3
  await store.spendPt(u, 0.1, 'llm_reply');
  await store.grantPt(u, 0.4, 'judge_seedao');
  // balance is now 120.3; before = 120.3 - 0.3 = 120.0
  const footer = await store.buildStatusFooter(u, 0.3, '画重点');
  assert.ok(footer.includes('→'), 'arrow present when delta≠0');
  assert.ok(footer.includes('120.0 →'), 'before shown as 120.0');
  assert.ok(footer.includes('→ 120.3'), 'after shown as 120.3');
  assert.ok(footer.includes('画重点'), 'label present');
  assert.ok(footer.includes('+0.3'), 'positive delta shown');
  assert.ok(footer.includes('(画重点, +0.3)'), 'label and delta in correct order');
});

test('buildStatusFooter: delta=-0.1, no label → before→after (-0.1), no label', async () => {
  const u = uid();
  await store.grantPt(u, 120, 'seed');
  await store.spendPt(u, 0.1, 'llm_reply');
  // balance is now 119.9; before = 119.9 - (-0.1) = 120.0
  const footer = await store.buildStatusFooter(u, -0.1);
  assert.ok(footer.includes('→'), 'arrow present when delta≠0');
  assert.ok(footer.includes('120.0 →'), 'before shown');
  assert.ok(footer.includes('→ 119.9'), 'after shown');
  assert.ok(footer.includes('(-0.1)'), 'negative delta in parens');
  // No extra label content (label was not passed)
  assert.ok(!footer.includes('访谈中'), 'no label text');
  assert.ok(!footer.includes('画重点'), 'no label text');
});

// ── netPtChangeForRef (per-turn LP aggregation) ─────────────────────────────

test('netPtChangeForRef excludes the first_contact welcome grant tagged under the same ref', async () => {
  const u = uid();
  const ref = 'om_first_turn';
  // Mirrors production: recordInteraction() seeds the +120 first_contact grant under this turn's
  // own message id (feishu-bot.ts:670 / feishu-user.ts:970 call it with the triggering messageId).
  await store.recordInteraction(u, 'Newcomer', 'oc_chat', ref);
  assert.equal((await store.getProfile(u))?.ptBalance, 120, 'sanity: first-contact grant landed');
  // Framework's own cost debit for this same turn, same ref.
  await store.spendPt(u, 0.1, 'llm_reply', ref);
  // The turn's net change must be -0.1 (the cost only), NOT +119.9 (which would fold in the
  // welcome gift) — this is the regression this test pins down.
  assert.equal(await store.netPtChangeForRef(ref, u), -0.1);
});

test('netPtChangeForRef sums every entry under one ref, including mid-turn pt_grant calls', async () => {
  const u = uid();
  const ref = 'om_turn_2';
  await store.grantPt(u, 120, 'seed'); // baseline balance, no ref — must not be counted
  await store.spendPt(u, 0.1, 'llm_reply', ref);       // framework cost
  await store.grantPt(u, 0.1, 'judge_interview', ref); // framework judge grant
  await store.grantPt(u, 5, 'pt_grant', ref);          // LLM-driven pt_grant mid-turn (a credit)
  await store.grantPt(u, -2, 'pt_grant', ref);         // another pt_grant, this time a debit
  // Net = -0.1 + 0.1 + 5 - 2 = 3.0
  assert.equal(await store.netPtChangeForRef(ref, u), 3);
});

test('netPtChangeForRef scopes strictly to the given ref and user', async () => {
  const u = uid();
  const other = uid();
  await store.grantPt(u, 10, 'reward', 'om_a');
  await store.grantPt(u, 999, 'reward', 'om_b');      // different ref — must not leak in
  await store.grantPt(other, 999, 'reward', 'om_a');  // same ref, different user — must not leak in
  assert.equal(await store.netPtChangeForRef('om_a', u), 10);
});

test('netPtChangeForRef returns 0 for an empty ref or a ref with no matching rows', async () => {
  const u = uid();
  assert.equal(await store.netPtChangeForRef('', u), 0);
  assert.equal(await store.netPtChangeForRef('om_nonexistent', u), 0);
});

// ── syncChatMembers (batched roster reconcile) ───────────────────────────────

test('syncChatMembers reports joined/left/renamed increments and flips presence', async () => {
  const chat = 'oc_sync_members_1';
  const a = uid();
  const b = uid();
  const c = uid();

  // First sync: everyone is a joiner; nobody left or was renamed.
  const r1 = await store.syncChatMembers(chat, new Map([[a, 'Alice'], [b, 'Bob']]));
  assert.equal(r1.added, 2);
  assert.equal(r1.total, 2);
  assert.equal(r1.left, 0);
  assert.equal(r1.renamed, 0);
  assert.deepEqual(
    r1.joinedMembers.map((m) => m.openId).sort(),
    [a, b].sort(),
  );
  assert.equal(await store.presentMemberCount(chat), 2);

  // Second sync: b renamed, a gone, c new. Increments must reflect exactly that.
  const r2 = await store.syncChatMembers(chat, new Map([[b, 'Bobby'], [c, 'Carol']]));
  assert.equal(r2.added, 1);
  assert.equal(r2.total, 2);
  assert.equal(r2.left, 1);
  assert.equal(r2.renamed, 1);
  assert.deepEqual(r2.joinedMembers, [{ openId: c, name: 'Carol' }]);
  assert.deepEqual(r2.leftMembers, [{ openId: a, name: 'Alice' }], 'leaver carries the last-known name');
  assert.deepEqual(r2.renamedMembers, [{ openId: b, name: 'Bobby' }], 'renamer carries the NEW name');
  assert.equal(await store.presentMemberCount(chat), 2, 'a flipped absent, c present');
  assert.equal(await store.memberName(b), 'Bobby', 'directory name refreshed on rename');

  // Third sync: a returns (row was kept). A returning member is NOT a joiner (the directory already
  // knows them); presence flips back to 1.
  const r3 = await store.syncChatMembers(chat, new Map([[a, 'Alice'], [b, 'Bobby'], [c, 'Carol']]));
  assert.equal(r3.added, 0, 'a re-joining is not counted as joined');
  assert.equal(r3.left, 0);
  assert.equal(r3.renamed, 0);
  assert.equal(await store.presentMemberCount(chat), 3);
});

test('syncChatMembers keeps the old directory name when the roster name is empty', async () => {
  const chat = 'oc_sync_members_2';
  const u = uid();
  await store.syncChatMembers(chat, new Map([[u, 'Named']]));
  // An empty roster name must neither count as a rename nor blank the stored name.
  const r = await store.syncChatMembers(chat, new Map([[u, '']]));
  assert.equal(r.renamed, 0);
  assert.equal(await store.memberName(u), 'Named');
});

test('syncChatMembers refreshes an EXISTING profile name on rename but never creates profiles', async () => {
  const chat = 'oc_sync_members_3';
  const interactor = uid();
  const lurker = uid();
  await store.ensureProfile(interactor, 'OldName');

  await store.syncChatMembers(chat, new Map([[interactor, 'NewName'], [lurker, 'Lurker']]));
  assert.equal((await store.getProfile(interactor))?.name, 'NewName', 'existing profile name freshened');
  assert.equal(await store.getProfile(lurker), null, 'no profile is created for a non-interactor');
});

test('syncChatMembers with an empty roster marks everyone left', async () => {
  const chat = 'oc_sync_members_4';
  const u = uid();
  await store.syncChatMembers(chat, new Map([[u, 'Solo']]));
  const r = await store.syncChatMembers(chat, new Map());
  assert.equal(r.total, 0);
  assert.equal(r.left, 1);
  assert.deepEqual(r.leftMembers, [{ openId: u, name: 'Solo' }]);
  assert.equal(await store.presentMemberCount(chat), 0);
});
