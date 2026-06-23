import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR } from './paths.js';

// ── kimi-code session repair ──────────────────────────────────
// kimi-code persists each chat's conversation as an event log under
//   $KIMI_CODE_HOME/sessions/wd_<name>_<hash>/session_<uuid>/agents/main/wire.jsonl
// and indexes every session by its workDir (cwd) in $KIMI_CODE_HOME/session_index.jsonl.
// `kimi --continue` resumes the newest session for the cwd by replaying that wire to the model.
//
// Failure mode we heal here: if a turn is interrupted (our timeout SIGTERMs kimi, or the network
// dies) after a tool.call event was written but before its tool.result, the wire is left with an
// orphan tool call. Every later --continue replays it and the provider rejects the request with
// HTTP 400 ("tool_call_ids did not have response messages") — permanently, for that chat.
//
// We reset rather than surgically repair: quarantine the broken session dir (reversible, nothing
// deleted) and drop its index line, so the next call starts a clean session. The chat loses its
// short-term memory; long-term memory (workspaces/<soul>/memory) is untouched.

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const KIMI_HOME = process.env.KIMI_CODE_HOME || (HOME ? path.join(HOME, '.kimi-code') : '.kimi-code');
const SESSIONS_DIR = path.join(KIMI_HOME, 'sessions');
const INDEX_FILE = path.join(KIMI_HOME, 'session_index.jsonl');
// Quarantine lives OUTSIDE sessions/ on purpose: kimi-code's `--continue` resolves the session by
// *scanning* sessions/wd_<hash>/ (not just the index), so a renamed-in-place folder is still
// discovered and then fails with "Session not found". Moving it out of sessions/ is the only way to
// make --continue start clean.
const QUARANTINE_DIR = path.join(KIMI_HOME, 'quarantine');

export interface SessionRef {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

export interface SessionValidation {
  ok: boolean;
  /** tool.call ids that never received a tool.result (the corruption signature). */
  orphans: string[];
  calls: number;
  results: number;
}

function normPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Read every session entry from session_index.jsonl (best-effort; skips malformed lines). */
function readIndex(): SessionRef[] {
  let raw: string;
  try {
    raw = fs.readFileSync(INDEX_FILE, 'utf8');
  } catch {
    return [];
  }
  const refs: SessionRef[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    try {
      const o = JSON.parse(s) as Partial<SessionRef>;
      if (o.sessionId && o.sessionDir && o.workDir) {
        refs.push({ sessionId: o.sessionId, sessionDir: o.sessionDir, workDir: o.workDir });
      }
    } catch {
      /* skip malformed line */
    }
  }
  return refs;
}

/** Resolve the newest session directory bound to a given workDir, or null if none. */
export function resolveSessionDir(workDir: string): string | null {
  const want = normPath(workDir);
  let found: string | null = null;
  // The index is append-ordered; the last match is the newest session for the workDir.
  for (const ref of readIndex()) {
    if (normPath(ref.workDir) === want && fs.existsSync(ref.sessionDir)) {
      found = ref.sessionDir;
    }
  }
  return found;
}

/** Locate the wire event log inside a session directory (agents/<id>/wire.jsonl). */
function wirePath(sessionDir: string): string | null {
  const agentsDir = path.join(sessionDir, 'agents');
  let agentIds: string[];
  try {
    agentIds = fs.readdirSync(agentsDir);
  } catch {
    return null;
  }
  // Prefer the 'main' agent; fall back to the first agent that has a wire.
  const candidates = ['main', ...agentIds.filter((a) => a !== 'main')];
  for (const a of candidates) {
    const w = path.join(agentsDir, a, 'wire.jsonl');
    if (fs.existsSync(w)) return w;
  }
  return null;
}

/**
 * Validate a session: pair every tool.call with its tool.result. A session is corrupt when any
 * tool.call id has no matching tool.result (the provider will reject the replayed history).
 */
export function validateSession(sessionDir: string): SessionValidation {
  const wire = wirePath(sessionDir);
  if (!wire) return { ok: true, orphans: [], calls: 0, results: 0 };
  let raw: string;
  try {
    raw = fs.readFileSync(wire, 'utf8');
  } catch {
    return { ok: true, orphans: [], calls: 0, results: 0 };
  }
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let o: { type?: string; event?: { type?: string; toolCallId?: string } };
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    const ev = o.event;
    if (o.type !== 'context.append_loop_event' || !ev || !ev.toolCallId) continue;
    if (ev.type === 'tool.call') calls.add(ev.toolCallId);
    else if (ev.type === 'tool.result') results.add(ev.toolCallId);
  }
  const orphans = [...calls].filter((id) => !results.has(id));
  return { ok: orphans.length === 0, orphans, calls: calls.size, results: results.size };
}

/**
 * Quarantine a corrupt session: MOVE its directory out of sessions/ into KIMI_HOME/quarantine/
 * (fully reversible, nothing deleted) and drop its line from session_index.jsonl, so the next
 * --continue — which discovers sessions by scanning sessions/wd_<hash>/ — starts clean.
 * Returns true if the directory was moved.
 */
export function quarantineSession(sessionDir: string): boolean {
  if (!fs.existsSync(sessionDir)) return false;
  const wdName = path.basename(path.dirname(sessionDir)); // wd_<name>_<hash>
  const base = path.basename(sessionDir); // session_<uuid>
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\..+$/, '');
  const dest = path.join(QUARANTINE_DIR, `${wdName}__${base}-${stamp}`);

  // Drop the matching index line(s) first (so a missing dir is never referenced).
  try {
    const raw = fs.readFileSync(INDEX_FILE, 'utf8');
    const want = normPath(sessionDir);
    const kept = raw
      .split(/\r?\n/)
      .filter((line) => {
        const s = line.trim();
        if (!s) return false;
        try {
          const o = JSON.parse(s) as Partial<SessionRef>;
          return o.sessionDir ? normPath(o.sessionDir) !== want : true;
        } catch {
          return true; // keep anything we cannot parse
        }
      });
    fs.writeFileSync(INDEX_FILE, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
  } catch {
    /* index missing/unreadable — proceed to move the dir anyway */
  }

  try {
    fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
    fs.renameSync(sessionDir, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the session bound to a workDir and quarantine it if corrupt.
 * Returns the orphan count if it healed something, otherwise 0.
 */
export function healSessionFor(workDir: string): number {
  const sdir = resolveSessionDir(workDir);
  if (!sdir) return 0;
  const v = validateSession(sdir);
  if (v.ok) return 0;
  return quarantineSession(sdir) ? v.orphans.length : 0;
}

export interface CorruptSession {
  sessionDir: string;
  workDir: string;
  orphans: number;
}

/**
 * Scan all kimi sessions and return the corrupt ones. By default only sessions whose workDir lives
 * under our runtime directory (.agent/) are considered, so the developer's own kimi/coding sessions
 * are never touched. Pass onlyOurs=false to scan everything.
 */
export function scanCorruptSessions(onlyOurs = true): CorruptSession[] {
  const ours = normPath(RUNTIME_DIR);
  const out: CorruptSession[] = [];
  let wdDirs: string[];
  try {
    wdDirs = fs.readdirSync(SESSIONS_DIR).filter((d) => d.startsWith('wd_'));
  } catch {
    return out;
  }
  // Map sessionDir -> workDir via the index (the dir name's hash is not reversible).
  const indexByDir = new Map<string, string>();
  for (const ref of readIndex()) indexByDir.set(normPath(ref.sessionDir), ref.workDir);

  for (const wd of wdDirs) {
    const wdPath = path.join(SESSIONS_DIR, wd);
    let sessions: string[];
    try {
      sessions = fs.readdirSync(wdPath).filter((s) => s.startsWith('session_'));
    } catch {
      continue;
    }
    for (const s of sessions) {
      const sessionDir = path.join(wdPath, s);
      const workDir = indexByDir.get(normPath(sessionDir)) ?? '';
      if (onlyOurs) {
        const wdn = workDir ? normPath(workDir) : '';
        if (!wdn || !(wdn === ours || wdn.startsWith(ours + path.sep))) continue;
      }
      const v = validateSession(sessionDir);
      if (!v.ok) out.push({ sessionDir, workDir, orphans: v.orphans.length });
    }
  }
  return out;
}

/**
 * List every session directory whose workDir lives under .agent/<soul>/ — all of one soul's kimi
 * sessions, regardless of health. Used to reset a soul's sessions when its skills change so each
 * chat rebuilds a session that loads the new skills.
 */
export function listSoulSessionDirs(soul: string): string[] {
  const soulRoot = normPath(path.join(RUNTIME_DIR, soul));
  const out: string[] = [];
  let wdDirs: string[];
  try {
    wdDirs = fs.readdirSync(SESSIONS_DIR).filter((d) => d.startsWith('wd_'));
  } catch {
    return out;
  }
  // The dir name's hash is not reversible, so map sessionDir -> workDir via the index.
  const indexByDir = new Map<string, string>();
  for (const ref of readIndex()) indexByDir.set(normPath(ref.sessionDir), ref.workDir);

  for (const wd of wdDirs) {
    const wdPath = path.join(SESSIONS_DIR, wd);
    let sessions: string[];
    try {
      sessions = fs.readdirSync(wdPath).filter((s) => s.startsWith('session_'));
    } catch {
      continue;
    }
    for (const s of sessions) {
      const sessionDir = path.join(wdPath, s);
      const workDir = indexByDir.get(normPath(sessionDir));
      if (!workDir) continue;
      const wdn = normPath(workDir);
      if (wdn === soulRoot || wdn.startsWith(soulRoot + path.sep)) out.push(sessionDir);
    }
  }
  return out;
}
