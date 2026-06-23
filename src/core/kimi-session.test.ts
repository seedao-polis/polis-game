import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point kimi-code's home at a throwaway dir BEFORE importing the module (it reads KIMI_CODE_HOME at load).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kimi-session-test-'));
process.env.KIMI_CODE_HOME = TMP;
const SESSIONS = path.join(TMP, 'sessions');
const INDEX = path.join(TMP, 'session_index.jsonl');

const { quarantineCorruptSessionsFor, validateSession } = await import('./kimi-session.js');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** Write a session dir with a wire.jsonl pairing the given tool.call / tool.result ids. */
function writeSession(wdDir: string, sessionId: string, calls: string[], results: string[]): string {
  const sdir = path.join(SESSIONS, wdDir, sessionId);
  fs.mkdirSync(path.join(sdir, 'agents', 'main'), { recursive: true });
  const lines = [
    ...calls.map((id) => JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: id } })),
    ...results.map((id) => JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: id } })),
  ];
  fs.writeFileSync(path.join(sdir, 'agents', 'main', 'wire.jsonl'), lines.join('\n') + '\n');
  return sdir;
}
function indexLine(sessionDir: string, workDir: string): void {
  fs.appendFileSync(INDEX, JSON.stringify({ sessionId: path.basename(sessionDir), sessionDir, workDir }) + '\n');
}

test('heals an UNINDEXED corrupt sibling that index-only lookup would miss, leaving the healthy one', () => {
  const workDir = '/repo/.agent/tudigong/chats/chatA';
  const wd = 'wd_chatA_hash';
  // Healthy session — indexed.
  const healthy = writeSession(wd, 'session_ok', ['c1'], ['c1']);
  indexLine(healthy, workDir);
  // Corrupt session in the SAME wd dir, but NOT indexed (the bug: an interrupted turn never wrote its
  // index line, so resolveSessionDir / scanCorruptSessions would never see it).
  const corrupt = writeSession(wd, 'session_bad', ['c2'], []); // orphan c2
  assert.equal(validateSession(corrupt).ok, false, 'precondition: the sibling is corrupt');

  const n = quarantineCorruptSessionsFor(workDir);
  assert.equal(n, 1, 'quarantines exactly the one corrupt sibling');
  assert.equal(fs.existsSync(corrupt), false, 'corrupt session moved out of sessions/');
  assert.equal(fs.existsSync(healthy), true, 'healthy session left intact');
});

test("does not touch another chat's corrupt session", () => {
  const workA = '/repo/.agent/tudigong/chats/A';
  const workB = '/repo/.agent/tudigong/chats/B';
  const a = writeSession('wd_A_hash', 'session_a', ['x'], []); // corrupt
  indexLine(a, workA);
  const b = writeSession('wd_B_hash', 'session_b', ['y'], []); // corrupt
  indexLine(b, workB);

  assert.equal(quarantineCorruptSessionsFor(workA), 1);
  assert.equal(fs.existsSync(a), false, 'A healed');
  assert.equal(fs.existsSync(b), true, "B untouched");
});
