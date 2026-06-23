import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFlag, hasFlag } from './argv.js';

test('getFlag reads the value after --name', () => {
  assert.equal(getFlag(['--profile', 'alice', 'rest'], 'profile'), 'alice');
  assert.equal(getFlag(['cmd', '--date', '2026-06-20'], 'date'), '2026-06-20');
});

test('getFlag reads the --name=value form', () => {
  assert.equal(getFlag(['--profile=alice'], 'profile'), 'alice');
  assert.equal(getFlag(['--date=2026-06-20', 'x'], 'date'), '2026-06-20');
});

test('getFlag returns undefined when the flag is absent', () => {
  assert.equal(getFlag(['cmd', 'arg'], 'profile'), undefined);
});

test('getFlag returns undefined for a trailing flag with no value', () => {
  assert.equal(getFlag(['cmd', '--profile'], 'profile'), undefined);
});

test('getFlag matches the first occurrence', () => {
  assert.equal(getFlag(['--to', 'first', '--to', 'second'], 'to'), 'first');
});

test('getFlag does not confuse prefixes', () => {
  // `--lark-user` must not be matched by a request for `--lark`
  assert.equal(getFlag(['--lark-user', 'ou_x'], 'lark'), undefined);
  assert.equal(getFlag(['--lark-user', 'ou_x'], 'lark-user'), 'ou_x');
});

test('hasFlag detects bare boolean flags only', () => {
  assert.equal(hasFlag(['--dry-run'], 'dry-run'), true);
  assert.equal(hasFlag(['--test', 'x'], 'test'), true);
  assert.equal(hasFlag(['cmd'], 'dry-run'), false);
  // a `--name=value` form is not a bare boolean flag
  assert.equal(hasFlag(['--dry-run=1'], 'dry-run'), false);
});

