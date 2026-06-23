import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFileSync, runFileAsync, normalizeExecError } from './subprocess.js';

const NODE = process.execPath;

test('runFileSync captures stdout on success', () => {
  const r = runFileSync(NODE, ['-e', 'process.stdout.write("hello")']);
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'hello');
  assert.equal(r.error, undefined);
});

test('runFileSync reports a non-zero exit without throwing', () => {
  const r = runFileSync(NODE, ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(3)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error?.exitCode, 3);
  assert.equal(r.stdout, 'out');
  assert.equal(r.stderr, 'err');
  assert.equal(r.combined, 'outerr');
});

test('runFileSync surfaces a missing binary as a system code', () => {
  const r = runFileSync('definitely-not-a-real-binary-xyz', ['--version']);
  assert.equal(r.ok, false);
  assert.equal(r.error?.sysCode, 'ENOENT');
  assert.equal(r.error?.exitCode, null);
});

test('runFileSync surfaces a timeout as ETIMEDOUT with a terminating signal', () => {
  // The sync API reports a timeout via sysCode ETIMEDOUT + signal SIGTERM (it does not set `killed`),
  // which is exactly what the kimi classifier keys on.
  const r = runFileSync(NODE, ['-e', 'setTimeout(()=>{}, 10000)'], { timeout: 100, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(r.ok, false);
  assert.equal(r.error?.sysCode, 'ETIMEDOUT');
  assert.equal(r.error?.signal, 'SIGTERM');
});

test('runFileAsync captures stdout and stderr on success', async () => {
  const r = await runFileAsync(NODE, ['-e', 'process.stdout.write("a");process.stderr.write("b")']);
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'a');
  assert.equal(r.stderr, 'b');
});

test('runFileAsync reports a non-zero exit without rejecting', async () => {
  const r = await runFileAsync(NODE, ['-e', 'process.stderr.write("boom");process.exit(2)']);
  assert.equal(r.ok, false);
  assert.equal(r.error?.exitCode, 2);
  assert.equal(r.stderr, 'boom');
});

test('normalizeExecError reads the sync error shape (exit code on .status)', () => {
  // execFileSync puts the exit code on .status and the system code on .code
  const err = normalizeExecError({ status: 7, code: 'ETIMEDOUT', signal: 'SIGTERM', killed: true, stdout: 'o', stderr: 'e' });
  assert.equal(err.exitCode, 7);
  assert.equal(err.sysCode, 'ETIMEDOUT');
  assert.equal(err.signal, 'SIGTERM');
  assert.equal(err.killed, true);
  assert.equal(err.stdout, 'o');
  assert.equal(err.stderr, 'e');
});

test('normalizeExecError reads the async error shape (exit code on numeric .code)', () => {
  // promisified execFile puts a numeric exit code on .code
  const err = normalizeExecError({ code: 5, message: 'Command failed' });
  assert.equal(err.exitCode, 5);
  assert.equal(err.sysCode, null);
  assert.equal(err.message, 'Command failed');
});

test('normalizeExecError treats a string .code as a system code, not an exit code', () => {
  const err = normalizeExecError({ code: 'ENOENT', message: 'spawn ENOENT' });
  assert.equal(err.exitCode, null);
  assert.equal(err.sysCode, 'ENOENT');
});
