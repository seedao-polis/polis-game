import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprintSkills, skillsDirsForSoul } from './skills.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
}

test('fingerprintSkills is stable for identical content and changes on edit / add / remove', () => {
  const root = mkTmp();
  const skill = path.join(root, 'alpha');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'hello');

  const fp1 = fingerprintSkills([root]);
  // Deterministic: same files → same fingerprint.
  assert.equal(fingerprintSkills([root]), fp1);

  // Editing content changes the fingerprint.
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'hello world');
  const fp2 = fingerprintSkills([root]);
  assert.notEqual(fp2, fp1);

  // Adding a file changes the fingerprint.
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'scripts', 'run.sh'), '#!/bin/bash\n');
  const fp3 = fingerprintSkills([root]);
  assert.notEqual(fp3, fp2);

  // Removing it returns to the previous fingerprint.
  fs.rmSync(path.join(skill, 'scripts'), { recursive: true, force: true });
  assert.equal(fingerprintSkills([root]), fp2);

  fs.rmSync(root, { recursive: true, force: true });
});

test('fingerprintSkills depends on content only, not mtime', () => {
  const root = mkTmp();
  fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  const file = path.join(root, 'a', 'SKILL.md');
  fs.writeFileSync(file, 'same');
  const fp1 = fingerprintSkills([root]);
  // Bump mtime without touching content — fingerprint must not move (so a checkout never spuriously resets).
  const future = new Date(Date.now() + 1_000_000);
  fs.utimesSync(file, future, future);
  assert.equal(fingerprintSkills([root]), fp1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('fingerprintSkills treats a missing root like an empty one', () => {
  const empty = fingerprintSkills([]);
  assert.equal(typeof empty, 'string');
  assert.ok(empty.length > 0);
  assert.equal(fingerprintSkills([path.join(os.tmpdir(), 'no-such-skills-dir-xyz')]), empty);
});

test('skillsDirsForSoul returns existing roots with the shared layer first', () => {
  const dirs = skillsDirsForSoul('tudigong');
  // Only existing dirs are returned; the shared layer (when present) precedes the soul-specific one.
  for (const d of dirs) assert.ok(fs.existsSync(d), `${d} should exist`);
  const sharedIdx = dirs.findIndex((d) => d.includes(`${path.sep}_shared${path.sep}`));
  const soulIdx = dirs.findIndex((d) => d.includes(`${path.sep}tudigong${path.sep}`));
  if (sharedIdx !== -1 && soulIdx !== -1) assert.ok(sharedIdx < soulIdx);
});
