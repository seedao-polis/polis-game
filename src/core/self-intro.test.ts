import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Point the per-soul DB at a temp file before any module import touches the real DB (self-intro.ts
// pulls in the store, whose db.ts resolves this env var on first use).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-selfintro-test-'));
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

const { isRecordSelfIntroCommand, buildNewcomerWelcomePost, SELF_INTRO_REWARD_PT } = await import('./self-intro.js');
const { enqueuePendingWelcome, listPendingWelcome, clearPendingWelcome } = await import('./store/members.js');
const { closeDb } = await import('./db.js');

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// Flatten a post's paragraphs into a single element list for assertions.
const flat = (post: { content: any[][] }) => post.content.flat();
const texts = (post: { content: any[][] }) =>
  flat(post).filter((e: any) => e.tag === 'text').map((e: any) => e.text).join('\n');
const ats = (post: { content: any[][] }) => flat(post).filter((e: any) => e.tag === 'at');

describe('isRecordSelfIntroCommand', () => {
  it('matches the bare command, with or without a leading @mention / prefix', () => {
    assert.equal(isRecordSelfIntroCommand('收录自介'), true);
    assert.equal(isRecordSelfIntroCommand('@城邦土地神 收录自介'), true);
    assert.equal(isRecordSelfIntroCommand('@_user_1 收录自介 很棒的介绍'), true);
    assert.equal(isRecordSelfIntroCommand('/收录自介'), true);
  });

  it('rejects non-commands and partial / substring matches', () => {
    assert.equal(isRecordSelfIntroCommand('收录自介绍'), false); // 收录自介 must be a whole token
    assert.equal(isRecordSelfIntroCommand('帮我收录自介'), false); // not at the start
    assert.equal(isRecordSelfIntroCommand('自我介绍'), false);
    assert.equal(isRecordSelfIntroCommand(''), false);
  });
});

describe('buildNewcomerWelcomePost', () => {
  it('returns null when there is nobody with an open_id to welcome', () => {
    assert.equal(buildNewcomerWelcomePost([]), null);
    assert.equal(buildNewcomerWelcomePost([{ openId: '', name: 'x' }]), null);
  });

  it('@-mentions each valid joiner and includes the self-intro + reward copy', () => {
    const post = buildNewcomerWelcomePost([
      { openId: 'ou_a', name: '阿尔法' },
      { openId: 'ou_b', name: '贝塔' },
      { openId: '', name: 'skip-me' },
    ]);
    assert.ok(post);
    assert.deepEqual(ats(post!).map((e: any) => e.user_id), ['ou_a', 'ou_b']);
    const allText = texts(post!);
    assert.match(allText, new RegExp(`${SELF_INTRO_REWARD_PT} LP`));
    assert.match(allText, /自我介绍/);
    assert.match(allText, /怎么来到 SeeDAO/);
  });

  it('caps @-mentions at the default (12) and summarizes the overflow count', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ openId: `ou_${i}`, name: `n${i}` }));
    const post = buildNewcomerWelcomePost(many);
    assert.ok(post);
    assert.equal(ats(post!).length, 12);
    assert.match(texts(post!), /等 15 位新朋友/);
  });

  it('honors a custom maxMentions (digest passes a higher cap)', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ openId: `ou_${i}`, name: `n${i}` }));
    const post = buildNewcomerWelcomePost(many, 50);
    assert.ok(post);
    assert.equal(ats(post!).length, 15); // all 15 tagged, no overflow summary
    assert.doesNotMatch(texts(post!), /等 \d+ 位新朋友/);
  });
});

describe('pending_welcome queue', () => {
  const CHAT = 'oc_test_welcome';

  it('enqueues, lists (deduped, oldest-first), and clears', async () => {
    await clearPendingWelcome(CHAT);
    await enqueuePendingWelcome(CHAT, [{ openId: 'ou_a', name: '阿尔法' }, { openId: 'ou_b', name: '贝塔' }]);
    // Re-enqueueing ou_a is ignored (INSERT OR IGNORE keeps the first); '' open_id is skipped.
    await enqueuePendingWelcome(CHAT, [{ openId: 'ou_a', name: '阿尔法(改名)' }, { openId: '', name: 'skip' }, { openId: 'ou_c', name: '' }]);

    const listed = await listPendingWelcome(CHAT);
    assert.deepEqual(listed.map((m) => m.openId), ['ou_a', 'ou_b', 'ou_c']);

    await clearPendingWelcome(CHAT);
    assert.deepEqual(await listPendingWelcome(CHAT), []);
  });

  it('scopes by chat and no-ops on empty input', async () => {
    await clearPendingWelcome(CHAT);
    await clearPendingWelcome('oc_other');
    await enqueuePendingWelcome(CHAT, []); // no-op
    await enqueuePendingWelcome(CHAT, [{ openId: 'ou_x', name: 'X' }]);
    assert.deepEqual(await listPendingWelcome('oc_other'), []); // different chat unaffected
    assert.equal((await listPendingWelcome(CHAT)).length, 1);
    await clearPendingWelcome(CHAT);
  });
});
