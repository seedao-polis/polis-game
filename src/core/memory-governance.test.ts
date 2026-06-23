import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Point the DB at a throwaway file before any store/db imports so every test
// runs against an isolated, freshly-migrated database.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-governance-test-'));
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

const PUBLIC_CHAT = 'oc_example_public_group'; // tier=public
const WORK_CHAT = 'oc_example_ops_group';      // tier=work
const ADMIN_OPEN_ID = 'ou_example_operator';   // seeded as admin below
const NON_ADMIN_OPEN_ID = 'ou_regular_nonexistent_user_xyz';

// Seed an isolated configs dir (AGENT_CONFIGS_DIR) so these tests are self-contained and
// deterministic — they don't depend on the operator's private configs/*.json being present.
const CONFIGS_TMP = path.join(TMP, 'configs');
fs.mkdirSync(CONFIGS_TMP, { recursive: true });
fs.writeFileSync(
  path.join(CONFIGS_TMP, 'chat-policies.json'),
  JSON.stringify({
    version: 2,
    defaultTier: 'public',
    chatPolicies: {
      [PUBLIC_CHAT]: { name: 'public test group', tier: 'public' },
      [WORK_CHAT]: { name: 'work test group', tier: 'work' },
    },
  })
);
fs.writeFileSync(
  path.join(CONFIGS_TMP, 'admins.json'),
  JSON.stringify({ version: 1, admins: [ADMIN_OPEN_ID] })
);
process.env.AGENT_CONFIGS_DIR = CONFIGS_TMP;

const { allowedNamespaces, filterByPolicy, resolveWriteScope } = await import('./memory-policy.js');
const {
  insertMemory,
  purgeExpiredMemories,
  getFilteredMemories,
} = await import('./store/memory.js');
const { isAdmin } = await import('./configs.js');
const { tokenize, topTokens, aggregateGroupTopics } = await import('./group-intel.js');
const { insertMessage } = await import('./store/messages.js');
const { closeDb } = await import('./db.js');

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── purgeExpiredMemories ──────────────────────────────────────────────────────

test('purgeExpiredMemories only removes expired entries', () => {
  const pastTs = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
  const futureTs = Math.floor(Date.now() / 1000) + 7200; // 2 hours from now

  insertMemory({ namespace: 'global', content: 'purge-expired-A', expiresAt: pastTs, visibility: 'public' });
  insertMemory({ namespace: 'global', content: 'purge-expired-B', expiresAt: pastTs, visibility: 'public' });
  insertMemory({ namespace: 'global', content: 'purge-future', expiresAt: futureTs, visibility: 'public' });
  insertMemory({ namespace: 'global', content: 'purge-permanent', visibility: 'public' });

  const deleted = purgeExpiredMemories();
  assert.ok(deleted >= 2, `should delete at least 2 expired rows, deleted=${deleted}`);

  // Verify the non-expired entries survive.
  const ctx = { chatId: 'oc_unused', userOpenId: 'ou_unused' };
  const remaining = getFilteredMemories(ctx, { namespaces: ['global'] });
  const contents = remaining.map((m) => m.content);
  assert.ok(contents.includes('purge-future'), 'future-expiry entry must survive');
  assert.ok(contents.includes('purge-permanent'), 'no-expiry entry must survive');
  assert.ok(!contents.includes('purge-expired-A'), 'expired A must be removed');
  assert.ok(!contents.includes('purge-expired-B'), 'expired B must be removed');
});

test('purgeExpiredMemories does not remove entries with NULL expires_at', () => {
  insertMemory({ namespace: 'global', content: 'purge-null-expiry-test', visibility: 'public' });
  purgeExpiredMemories();
  const ctx = { chatId: 'oc_x', userOpenId: 'ou_x' };
  const mems = getFilteredMemories(ctx, { namespaces: ['global'] });
  const contents = mems.map((m) => m.content);
  assert.ok(contents.includes('purge-null-expiry-test'), 'permanent entries must survive purge');
});

// ── aggregateGroupTopics ──────────────────────────────────────────────────────

test('tokenize splits English runs and CJK unigrams/bigrams', () => {
  const tokens = tokenize('Hello 社区 world');
  assert.ok(tokens.includes('hello'), 'English word must be lowercased');
  assert.ok(tokens.includes('world'), 'second English word');
  assert.ok(tokens.includes('社'), 'CJK unigram');
  assert.ok(tokens.includes('区'), 'CJK unigram 2');
  assert.ok(tokens.includes('社区'), 'CJK bigram');
});

test('topTokens returns the most frequent non-stop tokens', () => {
  const texts = [
    'SeeDAO 社区 治理 提案',
    'SeeDAO 社区 讨论 提案',
    'SeeDAO 社区 治理',
  ];
  const top = topTokens(texts, 3);
  // 'seedao' appears 3 times; '社区' appears 3 times.
  const hasMostFrequent = top.includes('seedao') || top.includes('社区');
  assert.ok(hasMostFrequent, 'most frequent term must appear in top results');
  assert.equal(top.length, 3, 'should return exactly topN tokens');
});

test('aggregateGroupTopics produces a non-empty deterministic summary from seeded messages', () => {
  const chatId = 'oc_group_intel_test';
  const msgs = [
    '大家好，今天讨论 SeeDAO 治理提案',
    'SeeDAO 社区最近活动很多',
    '治理投票结果出来了',
    'SeeDAO 的治理真的很重要',
    '社区发展讨论中',
  ];
  for (let i = 0; i < msgs.length; i++) {
    insertMessage({
      messageId: `msg_git_${i}`,
      chatId,
      senderOpenId: 'ou_tester',
      senderName: '测试者',
      msgType: 'text',
      text: msgs[i]!,
      mentions: [],
      createTime: Math.floor(Date.now() / 1000) + i,
    });
  }

  const summary = aggregateGroupTopics(chatId);
  assert.ok(summary.length > 0, 'summary must not be empty');
  assert.ok(summary.includes('话题热词'), 'summary must contain expected header phrase');
  const hasSeeDao = summary.toLowerCase().includes('seedao');
  const hasGovernance = summary.includes('治理');
  const hasCommunity = summary.includes('社区');
  assert.ok(hasSeeDao || hasGovernance || hasCommunity, 'summary must include a frequent term');
});

// ── Personal memories are always injected regardless of chat tier ─────────────

test('allowedNamespaces always includes user:{openId} for any chat (public tier)', () => {
  const ctx = { chatId: PUBLIC_CHAT, userOpenId: 'ou_visitor' };
  const ns = allowedNamespaces(ctx);
  assert.ok(ns.includes('user:ou_visitor'), 'public-tier chat must include user: namespace');
  assert.ok(ns.includes('global'), 'global must be allowed');
  assert.ok(ns.includes(`group:${PUBLIC_CHAT}`), 'group namespace must be allowed');
  assert.ok(ns.includes(`group_user:${PUBLIC_CHAT}:ou_visitor`), 'group_user namespace must be allowed');
  assert.equal(ns.length, 4, 'all four namespaces must be present');
});

test('allowedNamespaces always includes user:{openId} for any chat (work tier)', () => {
  const ctx = { chatId: WORK_CHAT, userOpenId: 'ou_member' };
  const ns = allowedNamespaces(ctx);
  assert.ok(ns.includes('user:ou_member'), 'work-tier chat must include user: namespace');
  assert.equal(ns.length, 4, 'all four namespaces must be present');
});

test('allowedNamespaces always includes user:{openId} for unlisted chats', () => {
  const ctx = { chatId: 'oc_unknown_chat_xyz', userOpenId: 'ou_somebody' };
  const ns = allowedNamespaces(ctx);
  assert.ok(ns.includes('user:ou_somebody'), 'unlisted chat must include user: namespace');
  assert.equal(ns.length, 4, 'all four namespaces must be present');
});

// ── resolveWriteScope always targets user: namespace ─────────────────────────

test('resolveWriteScope: public-tier chat -> user namespace and private visibility', () => {
  const scope = resolveWriteScope(PUBLIC_CHAT, 'ou_visitor');
  assert.equal(scope.namespace, 'user:ou_visitor');
  assert.equal(scope.visibility, 'private');
});

test('resolveWriteScope: work-tier chat -> user namespace and private visibility', () => {
  const scope = resolveWriteScope(WORK_CHAT, 'ou_member');
  assert.equal(scope.namespace, 'user:ou_member');
  assert.equal(scope.visibility, 'private');
});

test('resolveWriteScope: chat with no policy entry -> user namespace and private visibility', () => {
  const scope = resolveWriteScope('oc_unknown_chat_xyz', 'ou_somebody');
  assert.equal(scope.namespace, 'user:ou_somebody');
  assert.equal(scope.visibility, 'private');
});

// ── Tier prompt policy injected into soul system prompt ───────────────────────

test('assembleSoul with public-tier chat id includes public policy text and not work policy text', async () => {
  const { assembleSoul } = await import('./soul.js');
  const { BUILTIN_TIER_POLICY } = await import('./configs.js');
  const assembled = assembleSoul('tudigong', { chatId: PUBLIC_CHAT });
  assert.ok(
    assembled.systemPrompt.includes(BUILTIN_TIER_POLICY.public),
    'public-tier chat must include public tier policy'
  );
  assert.ok(
    !assembled.systemPrompt.includes(BUILTIN_TIER_POLICY.work),
    'public-tier chat must not include work tier policy'
  );
});

test('assembleSoul with work-tier chat id includes work policy text', async () => {
  const { assembleSoul } = await import('./soul.js');
  const { BUILTIN_TIER_POLICY } = await import('./configs.js');
  const assembled = assembleSoul('tudigong', { chatId: WORK_CHAT });
  assert.ok(
    assembled.systemPrompt.includes(BUILTIN_TIER_POLICY.work),
    'work-tier chat must include work tier policy'
  );
});

// ── Admin visibility gate ─────────────────────────────────────────────────────

test('isAdmin returns true for a configured admin open_id', () => {
  assert.equal(isAdmin(ADMIN_OPEN_ID), true, 'seeded admin must be recognized');
});

test('isAdmin returns false for a non-admin open_id', () => {
  assert.equal(isAdmin(NON_ADMIN_OPEN_ID), false, 'non-admin must not be recognized');
});

function makeAdminOnlyItem(id: number): import('./store/memory.js').MemoryItem {
  return {
    id,
    namespace: 'global',
    key: null,
    content: 'admin-only content',
    visibility: 'admin_only',
    sensitivity: 'normal',
    source: 'manual',
    createdAt: 0,
    updatedAt: 0,
    expiresAt: null,
  };
}

test('admin can read admin_only memories when isAdmin=true', () => {
  const ctx = { chatId: WORK_CHAT, userOpenId: ADMIN_OPEN_ID, isAdmin: true };
  const result = filterByPolicy([makeAdminOnlyItem(99)], ctx);
  assert.equal(result.length, 1, 'admin must see admin_only memories');
});

test('non-admin cannot read admin_only memories when isAdmin=false', () => {
  const ctx = { chatId: WORK_CHAT, userOpenId: NON_ADMIN_OPEN_ID, isAdmin: false };
  const result = filterByPolicy([makeAdminOnlyItem(100)], ctx);
  assert.equal(result.length, 0, 'non-admin must not see admin_only memories');
});

test('caller without isAdmin flag cannot read admin_only (defaults to non-admin)', () => {
  // ctx without isAdmin property — callers that omit this flag default to non-admin.
  const ctx = { chatId: WORK_CHAT, userOpenId: ADMIN_OPEN_ID };
  const result = filterByPolicy([makeAdminOnlyItem(101)], ctx);
  assert.equal(result.length, 0, 'omitting isAdmin must default to blocked (backward-compatible)');
});
