import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLarkProfileName } from './configs.js';
import type { RawAgentConfig, DefaultsConfig, LarkProfile } from './configs.js';

// Build a profiles map keyed by name; the contents are irrelevant to resolution.
function profiles(...names: string[]): Record<string, LarkProfile> {
  const meta: LarkProfile = {
    larkProfile: 'x',
    appId: 'x',
    tenantKey: 'x',
    userOpenId: 'x',
    botOpenId: 'x',
    botName: 'x',
  };
  return Object.fromEntries(names.map((n) => [n, { ...meta, larkProfile: n }]));
}

const agent = (over: Partial<RawAgentConfig>): RawAgentConfig => ({
  soul: 'tudigong',
  identity: 'bot',
  listen: 'all',
  ...over,
});
const defaults = (over: Partial<DefaultsConfig> = {}): DefaultsConfig => ({
  kimi: 'default',
  pollIntervalMs: 0,
  contextSize: 0,
  ...over,
});

test('explicit agent lark override wins over everything', () => {
  const name = resolveLarkProfileName(
    agent({ lark: 'custom' }),
    defaults({ lark: 'house' }),
    profiles('custom', 'tudigong', 'house', 'default')
  );
  assert.equal(name, 'custom');
});

test('a profile named after the soul is used (per-soul credentials)', () => {
  const name = resolveLarkProfileName(
    agent({ soul: 'polis' }),
    defaults(),
    profiles('polis', 'default')
  );
  assert.equal(name, 'polis');
});

test('falls back to defaults.lark when no soul-named profile exists', () => {
  const name = resolveLarkProfileName(agent({}), defaults({ lark: 'house' }), profiles('house', 'default'));
  assert.equal(name, 'house');
});

test('falls back to the built-in default profile when nothing else matches', () => {
  const name = resolveLarkProfileName(agent({}), defaults(), profiles('default'));
  assert.equal(name, 'default');
});

test('an explicit lark that does not exist still falls back to default', () => {
  const name = resolveLarkProfileName(agent({ lark: 'missing' }), defaults(), profiles('default'));
  assert.equal(name, 'default');
});

test('throws a helpful error when not even a default profile exists', () => {
  assert.throws(
    () => resolveLarkProfileName(agent({}), defaults(), profiles('something-else')),
    /default/
  );
});
