import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Point the DB at a throwaway file before any store/db imports so every test
// runs against an isolated, freshly-migrated database.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-policy-test-'));
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

const { allowedNamespaces, filterByPolicy } = await import('./memory-policy.js');
const { insertMemory, getFilteredMemories } = await import('./store/memory.js');
const { closeDb } = await import('./db.js');

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── allowedNamespaces ────────────────────────────────────────────────────────

test('allowedNamespaces returns exactly the four caller-owned namespaces', () => {
  const ctx = { chatId: 'oc_chat1', userOpenId: 'ou_alice' };
  const ns = allowedNamespaces(ctx);
  assert.deepEqual(ns, [
    'global',
    'group:oc_chat1',
    'user:ou_alice',
    'group_user:oc_chat1:ou_alice',
  ]);
});

test('allowedNamespaces does not include any other user namespace', () => {
  const ctx = { chatId: 'oc_chat1', userOpenId: 'ou_alice' };
  const ns = allowedNamespaces(ctx);
  assert.ok(!ns.includes('user:ou_bob'), 'must not expose a different user');
  assert.ok(!ns.includes('group_user:oc_chat1:ou_bob'), 'must not expose another user in the same group');
});

// ── filterByPolicy ───────────────────────────────────────────────────────────

function makeItem(partial: Partial<import('./store/memory.js').MemoryItem>): import('./store/memory.js').MemoryItem {
  return {
    id: 1,
    namespace: 'global',
    key: null,
    content: 'test content',
    visibility: 'public',
    sensitivity: 'normal',
    source: 'manual',
    createdAt: 0,
    updatedAt: 0,
    expiresAt: null,
    ...partial,
  };
}

test('filterByPolicy passes public global memories', () => {
  const ctx = { chatId: 'oc_chat1', userOpenId: 'ou_alice' };
  const items = [makeItem({ namespace: 'global', visibility: 'public' })];
  assert.equal(filterByPolicy(items, ctx).length, 1);
});

test('filterByPolicy blocks namespaces not in the whitelist', () => {
  const ctx = { chatId: 'oc_chat1', userOpenId: 'ou_alice' };
  const items = [
    makeItem({ namespace: 'user:ou_bob', visibility: 'public' }),
    makeItem({ namespace: 'group_user:oc_chat1:ou_bob', visibility: 'public' }),
    makeItem({ namespace: 'group:oc_other_chat', visibility: 'public' }),
  ];
  // None of these namespaces belong to alice in oc_chat1.
  assert.equal(filterByPolicy(items, ctx).length, 0, 'foreign namespaces must be blocked');
});

test('filterByPolicy blocks admin_only visibility regardless of namespace', () => {
  const ctx = { chatId: 'oc_chat1', userOpenId: 'ou_alice' };
  const items = [
    makeItem({ namespace: 'global', visibility: 'admin_only' }),
    makeItem({ namespace: 'user:ou_alice', visibility: 'admin_only' }),
  ];
  assert.equal(filterByPolicy(items, ctx).length, 0, 'admin_only rows must always be blocked');
});

test('filterByPolicy allows private memories only when namespace matches the caller', () => {
  const ctx = { chatId: 'oc_chat1', userOpenId: 'ou_alice' };
  const items = [
    makeItem({ namespace: 'user:ou_alice', visibility: 'private' }),
    makeItem({ namespace: 'group_user:oc_chat1:ou_alice', visibility: 'private' }),
  ];
  assert.equal(filterByPolicy(items, ctx).length, 2, 'caller private memories must pass');
});

// ── Core isolation invariant: B cannot read A's memories ─────────────────────

test("B cannot read A's private user memory via filterByPolicy", () => {
  const bobCtx = { chatId: 'oc_chat1', userOpenId: 'ou_bob' };

  // Simulate a row from Alice's namespace being handed to Bob's filter (defence-in-depth check).
  const aliceMemory = makeItem({
    namespace: 'user:ou_alice',
    visibility: 'private',
    content: 'alice private secret',
  });

  const visibleToBob = filterByPolicy([aliceMemory], bobCtx);
  assert.equal(visibleToBob.length, 0, "Bob must not see Alice's private memory");
});

test("B cannot read A's group_user memory even in the same chat", () => {
  const bobCtx = { chatId: 'oc_shared', userOpenId: 'ou_bob' };

  const aliceGroupMem = makeItem({
    namespace: 'group_user:oc_shared:ou_alice',
    visibility: 'group',
    content: 'alice group-user context',
  });

  // Alice's group_user namespace is not in Bob's whitelist.
  const visibleToBob = filterByPolicy([aliceGroupMem], bobCtx);
  assert.equal(visibleToBob.length, 0, "Bob must not see Alice's group_user memory");
});

// ── getFilteredMemories integration (DB-backed) ──────────────────────────────

test('getFilteredMemories end-to-end: namespace isolation between two users', () => {
  const chatId  = 'oc_integration_test';
  const aliceId = 'ou_integration_alice';
  const bobId   = 'ou_integration_bob';

  // Insert memories for Alice and Bob in their respective namespaces.
  insertMemory({ namespace: `user:${aliceId}`, content: 'alice secret', visibility: 'private' });
  insertMemory({ namespace: `user:${bobId}`,   content: 'bob secret',   visibility: 'private' });
  insertMemory({ namespace: `group:${chatId}`, content: 'group shared', visibility: 'group' });

  const aliceCtx = { chatId, userOpenId: aliceId };
  const aliceMems = getFilteredMemories(aliceCtx, {
    namespaces: allowedNamespaces(aliceCtx),
  });

  // Alice should see her own private memory and the shared group memory, but NOT Bob's.
  const aliceContents = aliceMems.map((m) => m.content);
  assert.ok(aliceContents.includes('alice secret'), 'Alice can see her own private memory');
  assert.ok(aliceContents.includes('group shared'), 'Alice can see the shared group memory');
  assert.ok(!aliceContents.includes('bob secret'), "Alice must not see Bob's private memory");
});

test('getFilteredMemories end-to-end: expired entries are excluded', () => {
  const chatId = 'oc_expiry_test';
  const userId = 'ou_expiry_user';
  const pastExpiry = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

  insertMemory({
    namespace: `user:${userId}`,
    content: 'expired note',
    visibility: 'private',
    expiresAt: pastExpiry,
  });
  insertMemory({
    namespace: `user:${userId}`,
    content: 'active note',
    visibility: 'private',
  });

  const ctx = { chatId, userOpenId: userId };
  const mems = getFilteredMemories(ctx, { namespaces: allowedNamespaces(ctx) });
  const contents = mems.map((m) => m.content);
  assert.ok(!contents.includes('expired note'), 'expired entries must be excluded');
  assert.ok(contents.includes('active note'),   'non-expired entries must be included');
});
