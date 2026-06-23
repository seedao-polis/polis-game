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
