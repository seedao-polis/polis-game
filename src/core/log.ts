import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { REPO_ROOT } from './paths.js';
import { pushLogLine } from './telegram.js';

// Minimal logger: includes a timestamp and level, writing to both stderr and a log file under logs/.
// Format: 2026-06-08T20:46:14.953  INFO <message>  (message text itself stays in Simplified Chinese)
// Log file: <repo root>/logs/yyyymmdd_HHMMSS.log (logs/ is created automatically on first write).

const LOG_DIR = path.join(REPO_ROOT, 'logs');
const ERROR_DIR = path.join(LOG_DIR, 'errors');

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Local timestamp with millisecond precision: 2026-06-08T20:46:14.953 */
function ts(d = new Date()): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/** Log file name timestamp: 20260608_204614 */
function fileStamp(d = new Date()): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

let fd: number | null = null;
let fdReady = false;

/**
 * Open the log file under logs/ only when the first write is needed (so commands that produce no logs don't create empty files).
 * Use a synchronous append fd: each line is writeSync'd to disk immediately, so no logs are lost even if process.exit() follows.
 */
function logFd(): number | null {
  if (fdReady) return fd;
  fdReady = true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fd = fs.openSync(path.join(LOG_DIR, `${fileStamp()}.log`), 'a');
  } catch {
    fd = null; // if the file can't be written, just output to the console; operation is unaffected
  }
  return fd;
}

// Level threshold: messages below it are dropped. DEBUG is off by default (so routine, no-op chatter
// like a "nothing changed" sync stays out of the normal log), and turns on with LOG_LEVEL=debug.
type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
const LEVEL_RANK: Record<Level, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const THRESHOLD = LEVEL_RANK[(process.env.LOG_LEVEL || '').toUpperCase() as Level] ?? LEVEL_RANK.INFO;

function emit(level: Level, args: unknown[]): void {
  const line = `${ts()}  ${level} ${util.format(...args)}\n`;
  // The Telegram mirror keeps its own threshold (TELEGRAM_LOG_LEVEL), so push BEFORE the local
  // LOG_LEVEL gate — e.g. debug can go to Telegram while the local console/file stay at info. Wrapped
  // so the sink can never disrupt logging; telegram.ts never calls back into this module.
  try {
    pushLogLine(level, line);
  } catch {
    /* never let the telegram sink affect logging */
  }
  if (LEVEL_RANK[level] < THRESHOLD) return; // below the local threshold → don't write console/file
  process.stderr.write(line);
  const f = logFd();
  if (f !== null) {
    try {
      fs.writeSync(f, line);
    } catch {
      /* a failed file write does not affect operation */
    }
  }
}

export const log = {
  /** Verbose/routine detail; suppressed unless LOG_LEVEL=debug. */
  debug(...args: unknown[]): void {
    emit('DEBUG', args);
  },
  info(...args: unknown[]): void {
    emit('INFO', args);
  },
  warn(...args: unknown[]): void {
    emit('WARN', args);
  },
  error(...args: unknown[]): void {
    emit('ERROR', args);
  },
};

/**
 * Compress a string into a single-line log fragment: collapse all whitespace (including \r, \n) into a single space, and when too long keep only the first and last 10 characters,
 * eliding the middle with …. Used for incoming/outgoing message logs, to avoid printing long, multi-line content.
 */
export function preview(s: string, head = 10, tail = 10): string {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= head + tail) return flat;
  return `${flat.slice(0, head)}…${flat.slice(-tail)}`;
}

// ── correlation ids + error postmortems ───────────────────────
// Each inbound request gets a short corrId so the one-line flow log, the SQLite error ledger and
// the full postmortem file can be cross-referenced. The verbose, possibly huge detail (raw stderr,
// a dumped HTML page) goes only into logs/errors/<ts>-<corrId>.log; the main log keeps a tidy
// one-liner that points at it. User-facing replies never carry any of this.

let _corrSeq = 0;

/** A short, unique-enough correlation id, e.g. "k7f3a2". */
export function newCorrId(): string {
  _corrSeq = (_corrSeq + 1) % 1_000_000;
  const t = Date.now().toString(36).slice(-4);
  const s = _corrSeq.toString(36).padStart(2, '0');
  return `${t}${s}`;
}

/**
 * Write a full failure postmortem to logs/errors/<ts>-<corrId>.log and return its path
 * (or null if it could not be written). Keeps the bulky detail out of the main flow log.
 */
export function writePostmortem(corrId: string, content: string): string | null {
  try {
    fs.mkdirSync(ERROR_DIR, { recursive: true });
    const file = path.join(ERROR_DIR, `${fileStamp()}-${corrId}.log`);
    fs.writeFileSync(file, `${ts()}  corrId=${corrId}\n\n${content}\n`, 'utf8');
    return file;
  } catch {
    return null; // never let logging failure affect the request
  }
}
