import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Point the config dir at a throwaway folder BEFORE importing the module, so the test is
// self-contained and does not depend on the operator's private configs/name-overrides.json.
// Also pin the DB at a throwaway file (the resolver reads the shared name_overrides table).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-name-overrides-test-'));
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(
  path.join(TMP, 'name-overrides.json'),
  JSON.stringify({
    version: 1,
    overrides: {
      ou_fivea: 'Fivea',
      ou_blank: '   ',
    },
  })
);
process.env.AGENT_CONFIGS_DIR = TMP;
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

const { preferredName, applyNameOverride } = await import('./name-overrides.js');
const store = await import('./store.js');
const { closeDb } = await import('./db.js');

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('preferredName returns the configured override', async () => {
  assert.equal(await preferredName('ou_fivea'), 'Fivea');
});

test('preferredName returns undefined for unmapped or blank ids', async () => {
  assert.equal(await preferredName('ou_unknown'), undefined);
  assert.equal(await preferredName('ou_blank'), undefined); // whitespace-only override is ignored
  assert.equal(await preferredName(''), undefined);
});

test('applyNameOverride prefers the override over the raw captured name', async () => {
  assert.equal(await applyNameOverride('ou_fivea', '李'), 'Fivea');
  assert.equal(await applyNameOverride('ou_fivea', ''), 'Fivea'); // override wins even with an empty raw name
});

test('applyNameOverride falls back to the raw name when there is no override', async () => {
  assert.equal(await applyNameOverride('ou_unknown', '张三'), '张三');
  assert.equal(await applyNameOverride('ou_unknown', ''), '');
});

test('a self-service rename (name_overrides table) overrides the raw captured name', async () => {
  await store.setPreferredName('ou_self', 'Vicky Huang');
  assert.equal(await preferredName('ou_self'), 'Vicky Huang');
  assert.equal(await applyNameOverride('ou_self', '用户560770'), 'Vicky Huang');
});

test('operator config takes precedence over a self-service rename', async () => {
  await store.setPreferredName('ou_fivea', 'NotFivea');
  assert.equal(await applyNameOverride('ou_fivea', '李'), 'Fivea'); // config still wins
});
