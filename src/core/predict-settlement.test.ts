import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Point the per-soul DB (and, since AGENT_DB_PATH pins both, the shared LP db too) at a temp file
// before any module imports touch the real DB — same isolation pattern as tc.test.ts.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-predict-settlement-test-'));
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

const { distributePool } = await import('./tc-settlement.js');
const { buildPredictSettledPost } = await import('./predict-post.js');
const { insertPredictProposal, getPredictByNum, insertPredictBet } = await import('./store/predict.js');
type PredictProposal = import('./store/predict.js').PredictProposal;
type PredictBet = import('./store/predict.js').PredictBet;
const { settlePredict } = await import('./predict-settlement.js');
const { recentPtLedger, awardBadge, hasBadge, upsertBadge } = await import('./store/gamification.js');
const { tryHandlePredictCommand } = await import('./predict-command.js');
const { closeDb } = await import('./db.js');

// Production registers this badge definition once via `agent badge import` (see the community
// prediction research doc's "施工起点状态"); a fresh test DB starts empty, so the definition must be
// registered here before awardBadge() can satisfy user_badges' FK on badges.badge_id.
upsertBadge({ badgeId: 'predict_judge', name: '社区预测裁判', description: '拥有宣布社区预测结果的权限', emoji: '⚖️', role: '社区预测裁判', type: 'role' });

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function makeDiscreteProposal(options: string[], createdBy = 'creator') {
  const { num } = insertPredictProposal({
    title: '测试社区预测',
    options,
    endTime: Math.floor(Date.now() / 1000) + 3600,
    maxBetLp: 100,
    createdBy,
    chatId: 'oc_test_predict_settlement',
  });
  return getPredictByNum(num)!;
}

// ── distributePool — pure-function boundary cases ──────────────

describe('distributePool — boundary cases', () => {
  it('empty winnerGroups map: no winners, the entire pool becomes dust', () => {
    const { winners, dust } = distributePool(new Map(), 10);
    assert.deepEqual(winners, []);
    assert.equal(dust, 10);
  });

  it('a winner group with zero bets (announced option nobody backed): no winners, dust = full pool', () => {
    const groups = new Map([['A', []]]);
    const { winners, dust } = distributePool(groups, 10.5);
    assert.deepEqual(winners, []);
    assert.equal(dust, 10.5);
  });

  it('a single winner group takes the entire pool, split proportional to stake', () => {
    const groups = new Map([[
      'A',
      [
        { userOpenId: 'u1', optionValue: 'A', lpAmount: 3 },
        { userOpenId: 'u2', optionValue: 'A', lpAmount: 7 },
      ],
    ]]);
    const { winners, dust } = distributePool(groups, 10.5);
    // groupShare = 10.5 (G=1); u1: 10.5*3/10=3.15 -> floor 3.1; u2: 10.5*7/10=7.35 -> floor 7.3
    assert.equal(winners.length, 2);
    assert.equal(winners.find(w => w.userOpenId === 'u1')!.payout, 3.1);
    assert.equal(winners.find(w => w.userOpenId === 'u2')!.payout, 7.3);
    assert.ok(dust >= 0);
  });
});

// ── buildPredictSettledPost — the two mint rates must both be legible ──

describe('buildPredictSettledPost — pool and chest are stated as distinct amounts', () => {
  // Reproduces the real BET-2 figures: 33 LP staked, 23 LP of it on the announced winner 阿根廷.
  // Settlement mints at two rates (+5% into the pool, a further 10% of the pool into the chest) and
  // an earlier template printed only "总投注：33.0 LP （+5% 参与激励）" — the raw stake annotated with
  // one rate, with neither the resulting pool nor the chest transfer shown. That left a reader
  // unable to reconcile a 34.5 LP winner list against any number on the post, and made the design's
  // other rate look like a wrong constant. These assertions keep both amounts on the post.
  function bet(userOpenId: string, optionValue: string, lpAmount: number, id: number): PredictBet {
    return { id, proposalId: 1, userOpenId, optionValue, lpAmount, messageId: `m${id}`, isRefunded: false, createdAt: 0 };
  }
  const proposal: PredictProposal = {
    id: 1, num: 2, title: '今晚世界杯半决赛谁能胜出？', optionType: 'discrete',
    options: ['阿根廷', '英格兰'], endTime: 0, minBetLp: 1, maxBetLp: 10, status: 'settled',
    createdBy: 'creator', chatId: 'oc_test', topMessageId: 'om_test',
    settledOption: '阿根廷', announcedBy: 'judge1', settledAt: 0, createdAt: 0, updatedAt: 0,
  };
  const bets = [
    bet('u_ricky', '阿根廷', 9, 1), bet('u_889581', '阿根廷', 8, 2),
    bet('u_zhaizi', '阿根廷', 3, 3), bet('u_dajuan', '阿根廷', 3, 4),
    bet('u_dajuan', '英格兰', 7, 5), bet('u_other', '英格兰', 3, 6),
  ];
  const winners = [
    { userOpenId: 'u_ricky', userName: 'Ricky Wang', amount: 13.5 },
    { userOpenId: 'u_889581', userName: '用户889581', amount: 12.0 },
    { userOpenId: 'u_zhaizi', userName: '宅子', amount: 4.5 },
    { userOpenId: 'u_dajuan', userName: '大卷-棒棒', amount: 4.5 },
  ];
  const flatten = (content: any[][]) => content.map(line => line.map((e: any) => e.text ?? '').join('')).join('\n');

  it('states the raw stake and the +5% pool as separate lines, and the pool covers the payouts', () => {
    const text = flatten(buildPredictSettledPost(proposal, bets, winners, 'Ricky Wang', 3.47).content);
    assert.match(text, /🔸总投注：33\.0 LP/);
    assert.match(text, /🔸激励：34\.65 LP （含 \+5% 额外奖励）/);
    // The stated pool must be an upper bound on what the winner list adds up to — the payouts are
    // floored to 0.1 LP each, so they may sum to less, never more.
    const paid = winners.reduce((s, w) => s + w.amount, 0);
    assert.ok(paid <= 33 * 1.05, `winner list ${paid} exceeds the stated pool`);
  });

  it('reports the chest contribution as its own 10% line, not folded into the pool', () => {
    const text = flatten(buildPredictSettledPost(proposal, bets, winners, 'Ricky Wang', 3.47).content);
    assert.match(text, /🔸公益宝箱：\+3\.47 LP （10% 奖励）/);
  });

  it('omits the chest line entirely when nothing was contributed (a proposal with no bets)', () => {
    const text = flatten(buildPredictSettledPost(proposal, [], [], 'Ricky Wang', 0).content);
    assert.ok(!text.includes('公益宝箱'), '零投注的结算帖不应出现公益宝箱行');
    assert.match(text, /（无人押中该选项）/);
  });
});

// ── settlePredict — manual judge-announced settlement (end to end) ──

describe('settlePredict — manual winner announcement', () => {
  it('winner-option bettors split the pool by LP stake; losers get nothing; chest gets totalPool*0.10', async () => {
    const p = makeDiscreteProposal(['法国', '巴西']);
    insertPredictBet({ proposalId: p.id, userOpenId: 'u1', optionValue: '法国', lpAmount: 3, messageId: 'b1' });
    insertPredictBet({ proposalId: p.id, userOpenId: 'u2', optionValue: '法国', lpAmount: 7, messageId: 'b2' });
    insertPredictBet({ proposalId: p.id, userOpenId: 'u3', optionValue: '巴西', lpAmount: 5, messageId: 'b3' });

    const result = await settlePredict(p, '法国', 'judge1');
    assert.equal(result.ok, true);
    // totalAllLp = 15 (ALL bets, winners AND losers); totalPool = 15 * 1.05 = 15.75
    assert.equal(result.totalPool, 15.75);
    assert.equal(result.winners.length, 2);
    assert.equal(result.winners.find(w => w.userOpenId === 'u1')!.payout, 4.7);
    assert.equal(result.winners.find(w => w.userOpenId === 'u2')!.payout, 11.0);
    assert.equal(result.winners.find(w => w.userOpenId === 'u3'), undefined);
    // chest = totalPool * 0.10, rounded to 2 decimal places to absorb float noise
    assert.equal(result.chestContribution, 1.58);

    // Ledger reflects the grants under the predict-specific reason codes.
    const u1Ledger = recentPtLedger('u1', 5);
    assert.ok(u1Ledger.some(e => e.reason === 'predict_reward' && e.delta === 4.7));
    const chestLedger = recentPtLedger('chest:public-welfare', 5);
    assert.ok(chestLedger.some(e => e.reason === 'predict_chest_contribute' && e.delta === 1.58));

    // Proposal transitioned to settled with the announced option and announcer recorded.
    const settled = getPredictByNum(p.num)!;
    assert.equal(settled.status, 'settled');
    assert.equal(settled.settledOption, '法国');
    assert.equal(settled.announcedBy, 'judge1');
  });

  it('everyone bets the announced winning option (no losers) — chest still gets funded', async () => {
    const p = makeDiscreteProposal(['A', 'B']);
    insertPredictBet({ proposalId: p.id, userOpenId: 'u1', optionValue: 'A', lpAmount: 5, messageId: 'b1' });
    insertPredictBet({ proposalId: p.id, userOpenId: 'u2', optionValue: 'A', lpAmount: 5, messageId: 'b2' });

    const result = await settlePredict(p, 'A', 'judge1');
    assert.equal(result.ok, true);
    assert.equal(result.totalPool, 10.5);
    assert.equal(result.winners.length, 2);
    // tie: equal stakes -> equal payouts (10.5 * 5/10 = 5.25 -> floor 5.2 each)
    for (const w of result.winners) assert.equal(w.payout, 5.2);
    // no-loser has NO bearing on the chest contribution (decoupled from noBonusWhenNoLoser) — still 10%.
    assert.equal(result.chestContribution, 1.05);
  });

  it('zero bets — settles cleanly with no winners and no chest contribution', async () => {
    const p = makeDiscreteProposal(['A', 'B']);
    const result = await settlePredict(p, 'A', 'judge1');
    assert.equal(result.ok, true);
    assert.deepEqual(result.winners, []);
    assert.equal(result.totalPool, 0);
    assert.equal(result.chestContribution, 0);
    assert.equal(result.dust, 0);
    assert.equal(getPredictByNum(p.num)!.status, 'settled');
  });

  it('rejects an option that is not one of the proposal\'s options', async () => {
    const p = makeDiscreteProposal(['A', 'B']);
    const result = await settlePredict(p, 'C', 'judge1');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_option');
    assert.equal(getPredictByNum(p.num)!.status, 'active'); // untouched
  });

  it('idempotent: a second announcement on an already-settled proposal grants nothing further', async () => {
    const p = makeDiscreteProposal(['A', 'B']);
    // Unique user id (not reused from earlier tests in this file) so recentPtLedger below reflects
    // only this proposal's grant, not accumulated predict_reward entries from other proposals.
    insertPredictBet({ proposalId: p.id, userOpenId: 'idem-user', optionValue: 'A', lpAmount: 4, messageId: 'b1' });

    const first = await settlePredict(p, 'A', 'judge1');
    assert.equal(first.ok, true);
    const ledgerAfterFirst = recentPtLedger('idem-user', 10).filter(e => e.reason === 'predict_reward').length;
    assert.equal(ledgerAfterFirst, 1);

    // Replay (duplicate Feishu event / judge double-tap) — must be a no-op.
    const second = await settlePredict(getPredictByNum(p.num)!, 'A', 'judge1');
    assert.equal(second.ok, false);
    assert.equal(second.error, 'already_settled');
    const ledgerAfterSecond = recentPtLedger('idem-user', 10).filter(e => e.reason === 'predict_reward').length;
    assert.equal(ledgerAfterSecond, 1); // unchanged — no double grant
  });
});

// ── hasBadge permission gate on the announce command ────────────

describe('tryHandlePredictCommand — announce is gated on the predict_judge badge', () => {
  it('a sender without the badge is rejected, and the proposal stays active', () => {
    const p = makeDiscreteProposal(['A', 'B'], 'creator3');
    assert.equal(hasBadge('no-badge-user', 'predict_judge'), false);
    const r = tryHandlePredictCommand(`@城邦土地神 预测 宣布 ${p.num} A`, 'no-badge-user');
    assert.notEqual(r, false);
    assert.match((r as { reply: string }).reply, /只有社区预测裁判/);
    assert.equal(getPredictByNum(p.num)!.status, 'active');
  });

  it('a sender holding the predict_judge badge may announce a result', () => {
    const p = makeDiscreteProposal(['A', 'B'], 'creator4');
    awardBadge('judge-user', 'predict_judge', 'test-grant');
    assert.equal(hasBadge('judge-user', 'predict_judge'), true);
    const r = tryHandlePredictCommand(`@城邦土地神 预测 宣布 ${p.num} A`, 'judge-user');
    assert.notEqual(r, false);
    assert.match((r as { reply: string }).reply, /已宣布/);
  });

  it('accepts a "BET-N" token as the proposal number (the abbreviation members actually type)', () => {
    const p = makeDiscreteProposal(['A', 'B'], 'creator-bet');
    awardBadge('judge-bet', 'predict_judge', 'test-grant');
    // "BET-<num>" must resolve to the same proposal as the bare integer — guards parsePredictNum after
    // the PREDICT→BET abbreviation rename.
    const r = tryHandlePredictCommand(`@城邦土地神 预测 宣布 BET-${p.num} A`, 'judge-bet');
    assert.notEqual(r, false);
    assert.match((r as { reply: string }).reply, /已宣布/);
  });

  it('"预测 宣布 <num> <option>" is never misread as a bet by the regression it guards against', () => {
    const p = makeDiscreteProposal(['A', 'B'], 'creator5');
    // Not a predict command at all -> false, falls through (mirrors tc.test.ts's analogous regression).
    assert.equal(tryHandlePredictCommand('@城邦土地神 A 5lp', 'someone'), false);
    // A predict command ending in a discrete option token IS handled here (never reaches the bet parser).
    const r = tryHandlePredictCommand(`@城邦土地神 预测 宣布 ${p.num} A`, 'someone-without-badge');
    assert.notEqual(r, false);
  });
});
