import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Point the config dir at a throwaway folder BEFORE importing the module, so the test is
// self-contained and does not depend on the operator's private configs/name-overrides.json.
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

const { preferredName, applyNameOverride } = await import('./name-overrides.js');

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('preferredName returns the configured override', () => {
  assert.equal(preferredName('ou_fivea'), 'Fivea');
});

test('preferredName returns undefined for unmapped or blank ids', () => {
  assert.equal(preferredName('ou_unknown'), undefined);
  assert.equal(preferredName('ou_blank'), undefined); // whitespace-only override is ignored
  assert.equal(preferredName(''), undefined);
});

test('applyNameOverride prefers the override over the raw captured name', () => {
  assert.equal(applyNameOverride('ou_fivea', '李'), 'Fivea');
  assert.equal(applyNameOverride('ou_fivea', ''), 'Fivea'); // override wins even with an empty raw name
});

test('applyNameOverride falls back to the raw name when there is no override', () => {
  assert.equal(applyNameOverride('ou_unknown', '张三'), '张三');
  assert.equal(applyNameOverride('ou_unknown', ''), '');
});
