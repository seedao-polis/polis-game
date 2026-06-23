import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKimiError, KimiError, buildArgs, type KimiErrorKind, type KimiFailureContext } from './kimi.js';

const CLEAN: KimiFailureContext = { exitCode: 1, signal: null, killed: false, sysCode: null };

test('classifyKimiError detects a corrupt session from an orphaned tool_call', () => {
  assert.equal(
    classifyKimiError('error: tool_call_id has no matching tool result', CLEAN),
    'corrupt-session',
  );
  assert.equal(
    classifyKimiError('assistant message did not have response messages', CLEAN),
    'corrupt-session',
  );
  assert.equal(
    classifyKimiError('an assistant message with "tool_calls" must be followed by tool messages', CLEAN),
    'corrupt-session',
  );
});

test('classifyKimiError detects a missing session for --continue', () => {
  assert.equal(classifyKimiError('No sessions to continue', CLEAN), 'session-missing');
  assert.equal(classifyKimiError('session abc was not found', CLEAN), 'session-missing');
});

test('classifyKimiError flags missing binary / auth as non-healable config errors', () => {
  assert.equal(classifyKimiError('', { ...CLEAN, sysCode: 'ENOENT' }), 'config');
  assert.equal(classifyKimiError('command not found', CLEAN), 'config');
  assert.equal(classifyKimiError('Invalid API key provided', CLEAN), 'config');
  assert.equal(classifyKimiError('HTTP 401 Unauthorized', CLEAN), 'config');
});

test('classifyKimiError flags our own timeout (ETIMEDOUT or SIGTERM kill)', () => {
  assert.equal(classifyKimiError('', { ...CLEAN, sysCode: 'ETIMEDOUT' }), 'timeout');
  assert.equal(
    classifyKimiError('', { exitCode: null, signal: 'SIGTERM', killed: true, sysCode: null }),
    'timeout',
  );
});

test('classifyKimiError flags network/upstream blips as transient', () => {
  assert.equal(classifyKimiError('HTTP 503 from upstream', CLEAN), 'transient');
  assert.equal(classifyKimiError('ECONNRESET socket hang up', CLEAN), 'transient');
  assert.equal(classifyKimiError('rate limit exceeded, try again', CLEAN), 'transient');
});

test('classifyKimiError returns unknown for unclassified failures', () => {
  assert.equal(classifyKimiError('some unexpected message', CLEAN), 'unknown');
});

test('KimiError.retryable is true only for self-healable kinds', () => {
  const mk = (kind: KimiErrorKind) =>
    new KimiError(kind, 'x', { exitCode: 1, signal: null, killed: false, sysCode: null, durationMs: 1, workDir: '/tmp' });
  assert.equal(mk('corrupt-session').retryable, true);
  assert.equal(mk('session-missing').retryable, true);
  assert.equal(mk('transient').retryable, true);
  assert.equal(mk('empty-output').retryable, true);
  assert.equal(mk('config').retryable, false);
  assert.equal(mk('timeout').retryable, false);
  assert.equal(mk('unknown').retryable, false);
});

test('buildArgs injects --skills-dir flags after --continue and before extraArgs', () => {
  const argv = buildArgs({
    prompt: 'hello',
    workDir: '/work',
    continueSession: true,
    skillsDirs: ['/a', '/b'],
    extraArgs: ['--extra-flag'],
  });
  // --continue must appear before any --skills-dir
  const continueIdx = argv.indexOf('--continue');
  const firstSkillsIdx = argv.indexOf('--skills-dir');
  assert.ok(continueIdx !== -1, '--continue must be present');
  assert.ok(firstSkillsIdx !== -1, '--skills-dir must be present');
  assert.ok(continueIdx < firstSkillsIdx, '--continue must precede --skills-dir');

  // both dirs present in order
  const allSkillsFlags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skills-dir') allSkillsFlags.push(argv[i + 1]);
  }
  assert.deepEqual(allSkillsFlags, ['/a', '/b'], '--skills-dir values must appear in order');

  // --skills-dir flags must appear before extraArgs
  const extraFlagIdx = argv.indexOf('--extra-flag');
  const lastSkillsDirValueIdx = argv.lastIndexOf('/b');
  assert.ok(extraFlagIdx !== -1, '--extra-flag must be present');
  assert.ok(lastSkillsDirValueIdx < extraFlagIdx, '--skills-dir flags must precede extraArgs');

  // -p prompt must be last (before its value)
  const promptIdx = argv.indexOf('-p');
  assert.equal(argv[promptIdx + 1], 'hello', '-p must be followed by the prompt');
  assert.ok(extraFlagIdx < promptIdx, 'extraArgs must precede -p');
});

test('buildArgs emits no --skills-dir flag when skillsDirs is absent or empty', () => {
  const withoutField = buildArgs({ prompt: 'hi', workDir: '/w' });
  assert.ok(!withoutField.includes('--skills-dir'), '--skills-dir must be absent when skillsDirs not provided');

  const withEmpty = buildArgs({ prompt: 'hi', workDir: '/w', skillsDirs: [] });
  assert.ok(!withEmpty.includes('--skills-dir'), '--skills-dir must be absent when skillsDirs is empty');
});
