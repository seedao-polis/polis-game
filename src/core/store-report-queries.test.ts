import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Isolated, freshly-migrated DB (must be set before store/db import).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-report-q-test-'));
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

const store = await import('./store.js');
const { closeDb } = await import('./db.js');

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function msg(
  id: string,
  chatId: string,
  createTime: number,
  opts: { text?: string; sender?: string; name?: string; deleted?: boolean } = {},
) {
  return {
    messageId: id,
    chatId,
    senderOpenId: opts.sender ?? 'ou_a',
    senderName: opts.name ?? 'Alice',
    msgType: 'text',
    text: opts.text ?? 'hi',
    mentions: [] as string[],
    // messages.create_time is stored in MILLISECONDS; callers below pass second-scale values.
    createTime: createTime * 1000,
    deleted: opts.deleted ?? false,
  };
}

test('messagesBetween returns only rows in the half-open [from,to) window, oldest→newest', () => {
  store.upsertChat({ chatId: 'oc_win', name: '围观群', external: true });
  store.insertMessage(msg('m1', 'oc_win', 1000));
  store.insertMessage(msg('m3', 'oc_win', 3000));
  store.insertMessage(msg('m2', 'oc_win', 2000));

  // 2000 included (>= from), 3000 excluded (< to).
  const mid = store.messagesBetween(2000, 3000).filter((m) => m.chatId === 'oc_win');
  assert.deepEqual(mid.map((m) => m.messageId), ['m2']);

  // Full window returns oldest→newest by create_time.
  const all = store.messagesBetween(1000, 3001).filter((m) => m.chatId === 'oc_win');
  assert.deepEqual(all.map((m) => m.messageId), ['m1', 'm2', 'm3']);
});

test('messagesBetween excludes deleted messages', () => {
  store.upsertChat({ chatId: 'oc_del', name: 'x' });
  store.insertMessage(msg('d1', 'oc_del', 5000, { deleted: true }));
  store.insertMessage(msg('d2', 'oc_del', 5001));
  const got = store.messagesBetween(4000, 6000).filter((m) => m.chatId === 'oc_del');
  assert.deepEqual(got.map((m) => m.messageId), ['d2']);
});

test('getChatMeta returns name + external flag, and null for an unknown chat', () => {
  store.upsertChat({ chatId: 'oc_meta', name: '运营小天地', external: true, chatMode: 'group' });
  const meta = store.getChatMeta('oc_meta');
  assert.equal(meta?.name, '运营小天地');
  assert.equal(meta?.external, true);
  assert.equal(meta?.chatMode, 'group');
  assert.equal(store.getChatMeta('oc_missing'), null);
});
