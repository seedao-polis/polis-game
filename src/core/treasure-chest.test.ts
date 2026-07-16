import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Isolated temp DB — same pattern as tc.test.ts / predict-settlement.test.ts.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-treasure-chest-test-'));
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

const {
  createChest, getChestByName, chestBalance, chestDeposit, chestWithdraw,
  transferPt, ensurePublicWelfareChest, tryHandleChestCommand,
  PUBLIC_WELFARE_CHEST_ID, PUBLIC_WELFARE_CHEST_OWNER, CHEST_KEEPER_BADGE_ID,
} = await import('./treasure-chest.js');
const { grantPt, getProfile, hasFirstContact, upsertBadge, awardBadge } = await import('./store/gamification.js');
const { closeDb } = await import('./db.js');

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('createChest', () => {
  it('creates a chest owned by the creator', () => {
    const { chest, created } = createChest({ chestId: 'chest:test-a', name: '测试宝箱A', ownerOpenId: 'owner1' });
    assert.equal(created, true);
    assert.equal(chest.ownerOpenId, 'owner1');
    assert.equal(chest.name, '测试宝箱A');
    assert.equal(chestBalance('chest:test-a'), 0);
  });

  it('does not reassign ownership on a second creation attempt (no hijack)', () => {
    createChest({ chestId: 'chest:test-b', name: '测试宝箱B', ownerOpenId: 'owner1' });
    const { chest, created } = createChest({ chestId: 'chest:test-b', name: '改名尝试', ownerOpenId: 'attacker' });
    assert.equal(created, false);
    assert.equal(chest.ownerOpenId, 'owner1'); // unchanged
    assert.equal(chest.name, '测试宝箱B'); // unchanged
  });

  it('creating a chest account does NOT trigger the 120 LP first-contact gift', () => {
    createChest({ chestId: 'chest:test-c', name: '测试宝箱C', ownerOpenId: 'owner1' });
    assert.equal(chestBalance('chest:test-c'), 0);
    assert.equal(hasFirstContact('chest:test-c'), false);
  });
});

describe('chestDeposit / chestWithdraw — owner-only', () => {
  it('the owner can deposit from their own balance into the chest', () => {
    createChest({ chestId: 'chest:deposit-test', name: '存入测试', ownerOpenId: 'depositor' });
    grantPt('depositor', 20, 'test_fund');
    const result = chestDeposit('chest:deposit-test', 'depositor', 5);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.balance, 5);
    assert.equal(getProfile('depositor')!.ptBalance, 15);
  });

  it('a non-owner is rejected from depositing (chest and sender balance both untouched)', () => {
    createChest({ chestId: 'chest:deposit-guard', name: '存入守卫', ownerOpenId: 'owner-x' });
    grantPt('intruder', 20, 'test_fund');
    const result = chestDeposit('chest:deposit-guard', 'intruder', 5);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, 'not_owner');
    assert.equal(chestBalance('chest:deposit-guard'), 0);
    assert.equal(getProfile('intruder')!.ptBalance, 20);
  });

  it('the owner can withdraw from the chest to a target account', () => {
    createChest({ chestId: 'chest:withdraw-test', name: '转出测试', ownerOpenId: 'owner-y' });
    grantPt('owner-y', 20, 'test_fund');
    chestDeposit('chest:withdraw-test', 'owner-y', 10);
    const result = chestWithdraw('chest:withdraw-test', 'owner-y', 'recipient1', 4);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.balance, 6);
    assert.equal(getProfile('recipient1')!.ptBalance, 4);
  });

  it('a non-owner is rejected from withdrawing (chest balance untouched)', () => {
    createChest({ chestId: 'chest:withdraw-guard', name: '转出守卫', ownerOpenId: 'owner-z' });
    grantPt('owner-z', 20, 'test_fund');
    chestDeposit('chest:withdraw-guard', 'owner-z', 10);
    const result = chestWithdraw('chest:withdraw-guard', 'intruder2', 'recipient2', 4);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, 'not_owner');
    assert.equal(chestBalance('chest:withdraw-guard'), 10);
  });
});

describe('transferPt', () => {
  it('fails with insufficient_balance and never touches the recipient when the source lacks funds', () => {
    // Amount deliberately exceeds the 120 LP first-contact gift that spendPt's ensureProfileRaw would
    // otherwise seed a brand-new sender with, so this genuinely exercises the insufficient-balance path.
    const result = transferPt('poor-user', 'never-touched', 200, 'test_transfer');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, 'insufficient_balance');
    assert.equal(getProfile('never-touched'), null);
  });
});

describe('ensurePublicWelfareChest', () => {
  it('creates the fixed public-welfare chest owned by Ricky, idempotently, with no first-contact gift', () => {
    const first = ensurePublicWelfareChest();
    assert.equal(first.chestId, PUBLIC_WELFARE_CHEST_ID);
    assert.equal(first.ownerOpenId, PUBLIC_WELFARE_CHEST_OWNER);
    assert.equal(first.isPublic, true);
    assert.equal(chestBalance(PUBLIC_WELFARE_CHEST_ID), 0);
    assert.equal(hasFirstContact(PUBLIC_WELFARE_CHEST_ID), false);

    const second = ensurePublicWelfareChest();
    assert.deepEqual(second, first); // idempotent — same row, no duplicate / no side effects
  });
});

describe('tryHandleChestCommand — deterministic in-group commands', () => {
  before(() => {
    // Chest creation is gated on the 宝箱怪的朋友 badge. Register it in the temp DB (user_badges has a
    // FK to badges), seed each creator's profile, then award the badge so these tests can create chests.
    upsertBadge({ badgeId: CHEST_KEEPER_BADGE_ID, name: '宝箱怪的朋友', emoji: '🧰' });
    for (const o of ['chat-owner', 'query-owner', 'deposit-owner']) {
      grantPt(o, 0, 'test_seed_profile');
      awardBadge(o, CHEST_KEEPER_BADGE_ID);
    }
  });

  it('creation requires the 宝箱怪的朋友 badge', () => {
    const rejected = tryHandleChestCommand('@城邦土地神 宝箱 创建 无证宝箱', 'no-badge-user');
    assert.notEqual(rejected, false);
    assert.match((rejected as { reply: string }).reply, /宝箱怪的朋友/);
    assert.equal(getChestByName('无证宝箱'), null); // nothing created
  });

  it('creating a chest via chat command makes the sender the owner', () => {
    const r = tryHandleChestCommand('@城邦土地神 宝箱 创建 聊天创建宝箱', 'chat-owner');
    assert.notEqual(r, false);
    assert.match((r as { reply: string }).reply, /已创建/);
    const chest = getChestByName('聊天创建宝箱');
    assert.ok(chest);
    assert.equal(chest!.ownerOpenId, 'chat-owner');
  });

  it('bare "宝箱 <名称>" queries balance, open to anyone', () => {
    tryHandleChestCommand('@城邦土地神 宝箱 创建 查询测试宝箱', 'query-owner');
    const r = tryHandleChestCommand('@城邦土地神 宝箱 查询测试宝箱', 'anyone');
    assert.notEqual(r, false);
    assert.match((r as { reply: string }).reply, /当前余额/);
  });

  it('deposit via chat command is owner-only', () => {
    tryHandleChestCommand('@城邦土地神 宝箱 创建 存入聊天宝箱', 'deposit-owner');
    grantPt('deposit-owner', 20, 'test_fund');
    const ok = tryHandleChestCommand('@城邦土地神 宝箱 存入聊天宝箱 存入 5', 'deposit-owner');
    assert.notEqual(ok, false);
    assert.match((ok as { reply: string }).reply, /已向宝箱/);

    const rejected = tryHandleChestCommand('@城邦土地神 宝箱 存入聊天宝箱 存入 5', 'not-the-owner');
    assert.notEqual(rejected, false);
    assert.match((rejected as { reply: string }).reply, /只有宝箱.*的拥有者才能存入/);
  });

  it('an unrelated message is not treated as a chest command', () => {
    assert.equal(tryHandleChestCommand('@城邦土地神 你好呀', 'someone'), false);
  });
});
