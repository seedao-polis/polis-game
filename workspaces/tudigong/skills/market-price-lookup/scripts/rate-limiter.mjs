// Cross-process rate limiter for East Money endpoints.
//
// Every skill invocation is a separate `node` process, so an in-process throttle
// cannot stop many concurrent lookups from collectively tripping East Money's
// per-IP ban. This limiter persists a sliding window of *reserved* send times to
// a machine-global state file (guarded by a lockdir), so independent processes
// serialize on the lock, each claim a distinct future slot, then sleep until it.
//
// Scope is per-machine (East Money bans by IP), not per-soul/per-skill.
// Defaults sit well under the ban thresholds; override via env if needed.

import { mkdirSync, rmdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function intEnv(key, def) {
  const n = parseInt(process.env[key] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const DIR = process.env.EM_RATELIMIT_DIR || join(tmpdir(), 'eastmoney-ratelimit');
const STATE = join(DIR, 'reservations.json');
const LOCK = join(DIR, 'lock'); // a lockdir: mkdir is atomic across processes

const MIN_INTERVAL_MS = intEnv('EM_MIN_INTERVAL_MS', 1200); // ban is >5/s
const WINDOWS = [
  { ms: 60_000, cap: intEnv('EM_CAP_PER_MIN', 30) }, // ban is >=200/min
  { ms: 300_000, cap: intEnv('EM_CAP_PER_5MIN', 120) }, // ban is >=300/5min
];
const PRUNE_MS = 305_000;
const LOCK_STALE_MS = 10_000; // reclaim a lock left by a crashed process
const LOCK_MAX_WAIT_MS = 20_000; // fail-open after this so a stuck lock can't hang lookups

const _sab = new Int32Array(new SharedArrayBuffer(4));
function syncSleep(ms) {
  // Blocking sleep with no busy-wait; used only for brief lock backoff.
  Atomics.wait(_sab, 0, 0, ms);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function acquireLock() {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(DIR, { recursive: true });
      mkdirSync(LOCK); // throws if held by another process
      return true;
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(LOCK);
          continue;
        }
      } catch {
        // lock vanished between check and stat — retry
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) return false;
      syncSleep(40 + Math.floor(Math.random() * 60));
    }
  }
}

function releaseLock() {
  try {
    rmdirSync(LOCK);
  } catch {
    // already released
  }
}

function readReservations() {
  try {
    const a = JSON.parse(readFileSync(STATE, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function writeReservations(a) {
  try {
    writeFileSync(STATE, JSON.stringify(a));
  } catch {
    // best effort; a lost write only means slightly weaker spacing
  }
}

// Claim the next allowed send time under the interval + sliding-window caps, then
// sleep until it. Returns the reserved timestamp.
export async function reserveSlot() {
  const locked = acquireLock();
  let target;
  if (locked) {
    try {
      const now = Date.now();
      const res = readReservations().filter((t) => typeof t === 'number' && now - t < PRUNE_MS);
      const last = res.length ? Math.max(...res) : 0;
      target = Math.max(now, last + MIN_INTERVAL_MS);
      for (let guard = 0; guard < 1000; guard++) {
        let bumped = false;
        for (const w of WINDOWS) {
          const inWin = res.filter((t) => target - t >= 0 && target - t < w.ms);
          if (inWin.length >= w.cap) {
            target = Math.max(target, Math.min(...inWin) + w.ms + 1);
            bumped = true;
          }
        }
        if (!bumped) break;
      }
      res.push(target);
      writeReservations(res);
    } finally {
      releaseLock();
    }
  } else {
    // Fail-open: never hang a lookup on a stuck lock; still add a minimal delay.
    target = Date.now() + MIN_INTERVAL_MS;
  }
  const wait = target - Date.now();
  if (wait > 0) await sleep(wait);
  return target;
}
