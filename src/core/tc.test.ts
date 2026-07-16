import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Point the per-soul DB at a temp file before any module imports touch the real DB.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tc-test-'));
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

// computeTcSettlement is a pure function — import the settlement module directly.
const { computeTcSettlement } = await import('./tc-settlement.js');
// parseLpAmount is exported from commands.
const { parseLpAmount } = await import('./commands.js');
// TC store functions for counter/insert tests.
const { insertTcProposal, getTcByNum, getTcBets, nextTcNumUnsafe } = await import('./store/tc.js');
const { insertTcBet, getUnrefundedBets } = await import('./store/tc.js');
const { tryParseTcBet } = await import('./tc-bet-parser.js');
const { cancelTcWithRefund, tryHandleTcCommand } = await import('./tc-command.js');
const { closeDb, tx } = await import('./db.js');

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── parseLpAmount tests ───────────────────────────────────────

describe('parseLpAmount', () => {
  it('parses bare number', () => assert.equal(parseLpAmount(['5']), 5));
  it('parses glued 5LP', () => assert.equal(parseLpAmount(['5LP']), 5));
  it('parses glued 5lp lowercase', () => assert.equal(parseLpAmount(['5lp']), 5));
  it('parses split "5 LP"', () => assert.equal(parseLpAmount(['5', 'LP']), 5));
  it('parses split "5 lp"', () => assert.equal(parseLpAmount(['5', 'lp']), 5));
  it('parses decimal 5.5LP', () => assert.equal(parseLpAmount(['5.5LP']), 5.5));
  it('returns null for empty', () => assert.equal(parseLpAmount(['']), null));
  it('returns null for zero', () => assert.equal(parseLpAmount(['0LP']), null));
  it('returns null for negative token', () => assert.equal(parseLpAmount(['-1LP']), null));
  it('returns null for text-only', () => assert.equal(parseLpAmount(['abc']), null));
});

// ── TC command / bet-parser regression: "tc cancel" must not be a bet ──

function makeDiscreteProposal(createdBy = 'U1') {
  const { num } = insertTcProposal({
    title: '西班牙还是法国',
    optionType: 'discrete',
    options: ['法国', '西班牙'],
    endTime: Math.floor(Date.now() / 1000) + 86400,
    maxBetLp: 10,
    createdBy,
    chatId: 'oc_test',
  });
  return getTcByNum(num)!;
}

describe('tryParseTcBet — non-bet messages fall through', () => {
  it('"tc cancel 51" is NOT parsed as a bet', () => {
    const p = makeDiscreteProposal();
    assert.equal(tryParseTcBet('@城邦土地神 tc cancel 51', p, 'U9', 'm1'), false);
  });
  it('chatter ending in a bare number is NOT a bet', () => {
    const p = makeDiscreteProposal();
    assert.equal(tryParseTcBet('@城邦土地神 我觉得 8', p, 'U9', 'm2'), false);
  });
  it('an invalid option WITH an lp marker still reports an error', () => {
    const p = makeDiscreteProposal();
    const r = tryParseTcBet('@城邦土地神 法國 5lp', p, 'U9', 'm3');
    assert.notEqual(r, false);
    assert.match((r as { reply: string }).reply, /不是有效选项/);
  });
});

describe('tryHandleTcCommand — cancel', () => {
  it('a non-tc message returns false (not a command)', () => {
    assert.equal(tryHandleTcCommand('@城邦土地神 法国 5lp', 'U1'), false);
  });
  it('an unknown TC number replies not-found', () => {
    const r = tryHandleTcCommand('@城邦土地神 tc cancel 999999', 'U1');
    assert.notEqual(r, false);
    assert.match((r as { reply: string }).reply, /找不到/);
  });
  it('a non-creator, non-admin is rejected and the proposal stays active', () => {
    const p = makeDiscreteProposal('creator1');
    const r = tryHandleTcCommand(`@城邦土地神 tc cancel ${p.num}`, 'someone-else');
    assert.notEqual(r, false);
    assert.match((r as { reply: string }).reply, /只有发起人或管理员/);
    assert.equal(getTcByNum(p.num)!.status, 'active');
  });
});

describe('cancelTcWithRefund', () => {
  it('cancels a proposal with no bets', () => {
    const p = makeDiscreteProposal();
    const res = cancelTcWithRefund(p);
    assert.equal(res.refunded, 0);
    assert.equal(getTcByNum(p.num)!.status, 'cancelled');
  });
  it('refunds outstanding bets and marks the proposal cancelled', () => {
    const p = makeDiscreteProposal('creator2');
    insertTcBet({ proposalId: p.id, userOpenId: 'bettor', optionValue: '法国', lpAmount: 4, messageId: 'b1' });
    assert.equal(getUnrefundedBets(p.id).length, 1);
    const res = cancelTcWithRefund(p);
    assert.equal(res.refunded, 1);
    assert.equal(res.refundedLp, 4);
    assert.equal(getTcByNum(p.num)!.status, 'cancelled');
    assert.equal(getUnrefundedBets(p.id).length, 0);
  });
});

// ── computeTcSettlement — continuous type ────────────────────

describe('computeTcSettlement — continuous', () => {
  it('basic: A wins nearest to weighted average', () => {
    // weighted avg = (67*5 + 10*2) / 7 = 375/7 ≈ 53.5714; A dist≈13.43, B dist≈43.57 → A wins
    const result = computeTcSettlement('continuous', [0, 100], [
      { userOpenId: 'A', optionValue: '67', lpAmount: 5 },
      { userOpenId: 'B', optionValue: '10', lpAmount: 2 },
    ]);
    assert.equal(result.winners.length, 1);
    assert.equal(result.winners[0]!.userOpenId, 'A');
    assert.ok(result.winners[0]!.payout > 0);
    assert.ok(result.dust >= 0);
    // pool = 7 * 1.05 = 7.35; payout must be ≤ pool
    assert.ok(result.winners[0]!.payout <= 7.35);
  });

  it('tie: two options equidistant from average — two winner groups', () => {
    // avg of 5LP@50 and 5LP@52 = 51; both distances = 1
    const result = computeTcSettlement('continuous', [0, 100], [
      { userOpenId: 'A', optionValue: '50', lpAmount: 5 },
      { userOpenId: 'B', optionValue: '52', lpAmount: 5 },
    ]);
    // Two winner groups: pool/2 each
    assert.equal(result.winners.length, 2);
    const pool = 10 * 1.05; // 10.5
    const groupShare = pool / 2; // 5.25
    for (const w of result.winners) {
      // payout = floor(5.25 * 10) / 10 = 5.2
      assert.equal(w.payout, Math.floor(groupShare * 10) / 10);
    }
    assert.ok(result.dust >= 0);
  });

  it('single bet: winner takes most of pool (5% bonus from system)', () => {
    const result = computeTcSettlement('continuous', [0, 100], [
      { userOpenId: 'A', optionValue: '50', lpAmount: 5 },
    ]);
    // avg=50; A is the only bet → winner; pool=5.25; payout=floor(5.25*10)/10=5.2; dust=5.25-5.2
    assert.equal(result.winners.length, 1);
    assert.equal(result.winners[0]!.payout, 5.2);
    assert.equal(result.dust, 0.05);
  });

  it('no bets → empty result', () => {
    const result = computeTcSettlement('continuous', [0, 100], []);
    assert.equal(result.winners.length, 0);
    assert.equal(result.totalPool, 0);
    assert.equal(result.dust, 0);
  });

  it('no-loser noBonusWhenNoLoser=true → only principal returned', () => {
    // All bets on same value → no losers; with flag true, effectivePool = totalAllLp
    const result = computeTcSettlement('continuous', [0, 100], [
      { userOpenId: 'A', optionValue: '67', lpAmount: 5 },
      { userOpenId: 'B', optionValue: '67', lpAmount: 3 },
    ], true);
    // effectivePool = 8 (not 8.4); A gets 5 * 8/8 = 5, B gets 3
    assert.equal(result.totalPool, 8);
    const aWin = result.winners.find(w => w.userOpenId === 'A');
    const bWin = result.winners.find(w => w.userOpenId === 'B');
    assert.ok(aWin);
    assert.ok(bWin);
    // floor(5*10)/10 = 5.0; floor(3*10)/10 = 3.0
    assert.equal(aWin!.payout, 5.0);
    assert.equal(bWin!.payout, 3.0);
  });

  it('no-loser noBonusWhenNoLoser=false (default) → 5% bonus applies', () => {
    const result = computeTcSettlement('continuous', [0, 100], [
      { userOpenId: 'A', optionValue: '67', lpAmount: 5 },
      { userOpenId: 'B', optionValue: '67', lpAmount: 3 },
    ], false);
    // effectivePool = 8.4; A gets 5/8 * 8.4 = 5.25 → floor = 5.2; B gets 3/8 * 8.4 = 3.15 → floor = 3.1
    assert.equal(result.totalPool, 8.4);
    const aWin = result.winners.find(w => w.userOpenId === 'A');
    const bWin = result.winners.find(w => w.userOpenId === 'B');
    assert.ok(aWin);
    assert.ok(bWin);
    assert.equal(aWin!.payout, 5.2);
    assert.equal(bWin!.payout, 3.1);
  });
});

// ── computeTcSettlement — discrete type ─────────────────────

describe('computeTcSettlement — discrete', () => {
  it('single winner option by LP total', () => {
    const result = computeTcSettlement('discrete', ['选项A', '选项B'], [
      { userOpenId: 'A', optionValue: '选项A', lpAmount: 3 },
      { userOpenId: 'B', optionValue: '选项B', lpAmount: 2 },
    ]);
    // 选项A wins (3 LP > 2 LP); pool = 5 * 1.05 = 5.25
    // payout = floor(5.25*10)/10 = 5.2; dust = 5.25 - 5.2
    assert.equal(result.winners.length, 1);
    assert.equal(result.winners[0]!.userOpenId, 'A');
    assert.equal(result.winners[0]!.payout, 5.2);
    assert.equal(result.dust, 0.05);
    assert.equal(result.settledOption, '["选项A"]');
  });

  it('tie: two options with equal LP — two winner groups', () => {
    const result = computeTcSettlement('discrete', ['选项A', '选项B'], [
      { userOpenId: 'A', optionValue: '选项A', lpAmount: 3 },
      { userOpenId: 'B', optionValue: '选项B', lpAmount: 3 },
    ]);
    // pool = 6 * 1.05 = 6.3; groupShare = 3.15 each; payout = floor(3.15*10)/10 = 3.1
    assert.equal(result.winners.length, 2);
    for (const w of result.winners) assert.equal(w.payout, 3.1);
    // dust = 6.3 - (3.1 + 3.1) = 0.1
    assert.ok(result.dust >= 0);
    // settledOption should contain both options
    const parsed = JSON.parse(result.settledOption!);
    assert.ok(parsed.includes('选项A'));
    assert.ok(parsed.includes('选项B'));
  });

  it('multi-bet same option: intra-group LP proportional split', () => {
    // A:3LP@选项A, C:7LP@选项A, B:5LP@选项B; 选项A total=10 > 选项B total=5 → 选项A wins
    // pool = 15 * 1.05 = 15.75; single group; A gets 3/10 * 15.75 = 4.725 → floor=4.7; C gets 7/10*15.75=11.025→11.0
    const result = computeTcSettlement('discrete', ['选项A', '选项B'], [
      { userOpenId: 'A', optionValue: '选项A', lpAmount: 3 },
      { userOpenId: 'C', optionValue: '选项A', lpAmount: 7 },
      { userOpenId: 'B', optionValue: '选项B', lpAmount: 5 },
    ]);
    assert.equal(result.winners.length, 2);
    const aWin = result.winners.find(w => w.userOpenId === 'A');
    const cWin = result.winners.find(w => w.userOpenId === 'C');
    assert.ok(aWin);
    assert.ok(cWin);
    assert.equal(aWin!.payout, 4.7);
    assert.equal(cWin!.payout, 11.0);
  });

  it('dust precision: pool=7.35 single winner → payout=7.3, dust is the exact 0.05 remainder', () => {
    // 7LP total * 1.05 = 7.35; X (4LP) wins over Y (3LP)
    const result = computeTcSettlement('discrete', ['A', 'B'], [
      { userOpenId: 'X', optionValue: 'A', lpAmount: 4 },
      { userOpenId: 'Y', optionValue: 'B', lpAmount: 3 },
    ]);
    // payout = floor(7.35*10)/10 = 7.3, so the pool keeps a 0.05 remainder. Dust is reported at a
    // precision finer than the 0.1 flooring step — quantising it at 0.1 would report 0 or 0.1 here.
    assert.equal(result.winners[0]!.payout, 7.3);
    assert.equal(result.dust, 0.05);
  });

  it('dust never goes negative and never exceeds the pool, across ragged stake splits', () => {
    // Guards the clamp: float noise must not surface as a tiny negative remainder, and dust is
    // always exactly pool-minus-payouts, so it stays under one 0.1 step per winner.
    for (const stakes of [[1, 2], [3, 7], [9, 8, 3, 3], [5.5, 2.5], [1, 1, 1, 1, 1, 1, 1]]) {
      const bets = stakes.map((lp, i) => ({ userOpenId: `u${i}`, optionValue: 'A', lpAmount: lp }));
      const result = computeTcSettlement('discrete', ['A', 'B'], bets);
      const paid = result.winners.reduce((s, w) => s + w.payout, 0);
      assert.ok(result.dust >= 0, `dust ${result.dust} went negative for stakes ${stakes}`);
      assert.ok(result.dust < 0.1 * stakes.length, `dust ${result.dust} too large for stakes ${stakes}`);
      assert.ok(
        Math.abs(result.totalPool - paid - result.dust) < 1e-6,
        `pool ${result.totalPool} != paid ${paid} + dust ${result.dust} for stakes ${stakes}`,
      );
    }
  });
});

// ── Counter and insert tests ──────────────────────────────────

describe('nextTcNumUnsafe and insertTcProposal', () => {
  it('assigns monotonically increasing num values', () => {
    const endTime = Math.floor(Date.now() / 1000) + 3600;
    const r1 = insertTcProposal({ title: '测试1', optionType: 'discrete', options: ['A', 'B'], endTime });
    const r2 = insertTcProposal({ title: '测试2', optionType: 'discrete', options: ['A', 'B'], endTime });
    const r3 = insertTcProposal({ title: '测试3', optionType: 'continuous', options: [0, 100], endTime });
    assert.ok(r1.num < r2.num);
    assert.ok(r2.num < r3.num);
    assert.equal(r2.num, r1.num + 1);
    assert.equal(r3.num, r2.num + 1);
  });

  it('getTcByNum returns correct proposal', () => {
    const endTime = Math.floor(Date.now() / 1000) + 7200;
    const { num } = insertTcProposal({ title: '查询测试', optionType: 'discrete', options: ['是', '否'], endTime, maxBetLp: 20, createdBy: 'ou_test' });
    const p = getTcByNum(num);
    assert.ok(p);
    assert.equal(p!.title, '查询测试');
    assert.equal(p!.maxBetLp, 20);
    assert.equal(p!.status, 'active');
    assert.deepEqual(p!.options, ['是', '否']);
  });

  it('getTcBets returns empty array for new proposal', () => {
    const endTime = Math.floor(Date.now() / 1000) + 7200;
    const { id } = insertTcProposal({ title: '空投注测试', optionType: 'discrete', options: ['A'], endTime });
    const bets = getTcBets(id);
    assert.equal(bets.length, 0);
  });
});

const { aggregateWinners } = await import('./tc-post.js');

describe('aggregateWinners', () => {
  it('collapses multiple winning bets by the same person into one summed row', () => {
    const rows = aggregateWinners([
      { userOpenId: 'ou_a', userName: 'Ricky', amount: 1.0 },
      { userOpenId: 'ou_a', userName: 'Ricky', amount: 1.0 },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.userName, 'Ricky');
    assert.equal(rows[0]!.amount, 2.0);
  });

  it('orders winners from highest total payout to lowest', () => {
    const rows = aggregateWinners([
      { userOpenId: 'ou_a', userName: 'A', amount: 1.0 },
      { userOpenId: 'ou_b', userName: 'B', amount: 5.0 },
      { userOpenId: 'ou_a', userName: 'A', amount: 1.0 },
      { userOpenId: 'ou_c', userName: 'C', amount: 3.0 },
    ]);
    assert.deepEqual(rows.map(r => [r.userName, r.amount]), [['B', 5.0], ['C', 3.0], ['A', 2.0]]);
  });

  it('returns an empty list when there are no winners', () => {
    assert.deepEqual(aggregateWinners([]), []);
  });
});

const { parseTcBetInput } = await import('./tc-bet-parser.js');

// parseTcBetInput only reads optionType/options, so a minimal proposal-shaped object suffices.
const discreteProp = (options: string[]): any => ({ optionType: 'discrete', options });
const continuousProp = (min: number, max: number): any => ({ optionType: 'continuous', options: [min, max] });

describe('parseTcBetInput — glued discrete option (no whitespace)', () => {
  const p = discreteProp(['法国', '摩洛哥', '西班牙', '阿根廷']);
  it('splits "法国3lp"', () =>
    assert.deepEqual(parseTcBetInput('@城邦土地神 法国3lp', p), { optionValue: '法国', lpAmount: 3 }));
  it('splits uppercase "法国3LP"', () =>
    assert.deepEqual(parseTcBetInput('@城邦土地神 法国3LP', p), { optionValue: '法国', lpAmount: 3 }));
  it('splits decimal "阿根廷2.5lp"', () =>
    assert.deepEqual(parseTcBetInput('@城邦土地神 阿根廷2.5lp', p), { optionValue: '阿根廷', lpAmount: 2.5 }));
  it('splits with a leading TC token "TC-3 法国3lp"', () =>
    assert.deepEqual(parseTcBetInput('@城邦土地神 TC-3 法国3lp', p), { optionValue: '法国', lpAmount: 3 }));
  it('tolerates inner spacing "法国3 lp"', () =>
    assert.deepEqual(parseTcBetInput('@城邦土地神 法国3 lp', p), { optionValue: '法国', lpAmount: 3 }));
  it('glued invalid option "巴西3lp" → null (falls to LLM)', () =>
    assert.equal(parseTcBetInput('@城邦土地神 巴西3lp', p), null));
  it('bare "法国3" without lp suffix → null (glued path is lp-gated)', () =>
    assert.equal(parseTcBetInput('@城邦土地神 法国3', p), null));
  it('longest option prefix wins ("法国" over "法")', () =>
    assert.deepEqual(parseTcBetInput('@城邦土地神 法国3lp', discreteProp(['法', '法国'])), { optionValue: '法国', lpAmount: 3 }));
});

describe('parseTcBetInput — whitespace-separated (strategy A)', () => {
  const p = discreteProp(['法国', '阿根廷']);
  it('spaced "法国 3lp"', () =>
    assert.deepEqual(parseTcBetInput('@城邦土地神 法国 3lp', p), { optionValue: '法国', lpAmount: 3 }));
  it('spaced "法国 3 LP"', () =>
    assert.deepEqual(parseTcBetInput('@城邦土地神 法国 3 LP', p), { optionValue: '法国', lpAmount: 3 }));
  it('bare "法国 5"', () =>
    assert.deepEqual(parseTcBetInput('@城邦土地神 法国 5', p), { optionValue: '法国', lpAmount: 5 }));
  it('non-bet greeting → null', () =>
    assert.equal(parseTcBetInput('@城邦土地神 大家好呀', p), null));
});

describe('parseTcBetInput — continuous', () => {
  const p = continuousProp(1, 500);
  it('spaced "67 5lp"', () =>
    assert.deepEqual(parseTcBetInput('@城邦土地神 67 5lp', p), { optionValue: '67', lpAmount: 5 }));
  it('glued numeric "675lp" is ambiguous → null (not split)', () =>
    assert.equal(parseTcBetInput('@城邦土地神 675lp', p), null));
});
