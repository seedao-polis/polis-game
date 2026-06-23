import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SOULS_DIR, RUNTIME_DIR } from './paths.js';
import { listSoulSessionDirs, quarantineSession } from './kimi-session.js';
import { log } from './log.js';

// ── per-soul Kimi Agent Skills ────────────────────────────────
// A soul loads two skill layers, handed to kimi as repeated --skills-dir flags in this order:
//   workspaces/_shared/skills/   shared by every soul
//   workspaces/<soul>/skills/    the soul's own
// Each skill is a folder holding a SKILL.md (plus optional scripts/ references/ assets/).
//
// kimi freezes a session's skill set+content at session-creation time and never re-reads it on
// --continue. A changed skill therefore only reaches a chat once that chat's session is rebuilt.
// reloadSkillsIfChanged() bridges that: it fingerprints the skill files and, when they change,
// quarantines the soul's live sessions so each chat's next message starts a fresh session that
// loads the new skills.

const SHARED_SOUL = '_shared';
const SKILLS_SUBDIR = 'skills';
/** Where the last-seen skill fingerprint is recorded, one file per soul. */
const STATE_DIR = path.join(RUNTIME_DIR, 'skill-state');

/** The skill roots for a soul — shared layer then soul-specific layer; non-existent roots are dropped. */
export function skillsDirsForSoul(soul: string): string[] {
  const dirs: string[] = [];
  const sharedDir = path.join(SOULS_DIR, SHARED_SOUL, SKILLS_SUBDIR);
  const soulDir = path.join(SOULS_DIR, soul, SKILLS_SUBDIR);
  if (fs.existsSync(sharedDir)) dirs.push(sharedDir);
  if (fs.existsSync(soulDir)) dirs.push(soulDir);
  return dirs;
}

/** Every file beneath a root as [relativePath, absolutePath] pairs (recursive; missing root → empty). */
function walkFiles(root: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) visit(abs);
      else if (e.isFile()) out.push([path.relative(root, abs), abs]);
    }
  };
  visit(root);
  return out;
}

/**
 * Content fingerprint of every file under the given skill roots. Stable across runs and independent
 * of file ordering and mtime, so it changes exactly when a skill's path or content changes
 * (add / remove / edit) and NOT when a checkout merely rewrites timestamps.
 */
export function fingerprintSkills(dirs: string[]): string {
  const parts: string[] = [];
  for (const root of dirs) {
    for (const [rel, abs] of walkFiles(root)) {
      let content: Buffer;
      try {
        content = fs.readFileSync(abs);
      } catch {
        continue;
      }
      const h = createHash('sha1').update(content).digest('hex');
      // Tag each entry with its root so identical relative paths across layers stay distinct.
      parts.push(`${root}\u0000${rel}\u0000${h}`);
    }
  }
  parts.sort();
  return createHash('sha1').update(parts.join('\n')).digest('hex');
}

function stateFile(soul: string): string {
  return path.join(STATE_DIR, `${soul}.txt`);
}

function readStoredFingerprint(soul: string): string | null {
  try {
    return fs.readFileSync(stateFile(soul), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeStoredFingerprint(soul: string, fingerprint: string): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(stateFile(soul), fingerprint + '\n', 'utf8');
  } catch (e) {
    log.warn('skill 指纹写入失败：', (e as Error).message);
  }
}

export interface SkillReloadResult {
  /** No baseline existed yet: the fingerprint was recorded without resetting any session. */
  firstRun: boolean;
  /** The fingerprint differed from a recorded baseline (skills were added / removed / edited). */
  changed: boolean;
  /** How many of the soul's kimi sessions were quarantined so they rebuild with the new skills. */
  quarantined: number;
}

/**
 * Reconcile a soul's live kimi sessions with its current skill files. When the skills changed since
 * the last run, quarantine the soul's sessions so each chat's next message starts fresh and loads
 * the new skills; the chats keep their long-term memory (workspaces/<soul>/memory), only short-term
 * session context is dropped. The first run with no recorded baseline only records the fingerprint —
 * a fresh deploy never mass-resets live chats. A no-op when nothing changed.
 */
export function reloadSkillsIfChanged(soul: string): SkillReloadResult {
  const fingerprint = fingerprintSkills(skillsDirsForSoul(soul));
  const prev = readStoredFingerprint(soul);
  if (prev === null) {
    writeStoredFingerprint(soul, fingerprint);
    return { firstRun: true, changed: false, quarantined: 0 };
  }
  if (prev === fingerprint) {
    return { firstRun: false, changed: false, quarantined: 0 };
  }
  let quarantined = 0;
  for (const sessionDir of listSoulSessionDirs(soul)) {
    if (quarantineSession(sessionDir)) quarantined += 1;
  }
  writeStoredFingerprint(soul, fingerprint);
  return { firstRun: false, changed: true, quarantined };
}
