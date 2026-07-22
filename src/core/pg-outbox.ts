// Append-only outbox for the soul database's telemetry tables while soulCircuit is open. A single,
// path-fixed local SQLite file — every process on this machine (supervisor, worker, and each
// short-lived MCP tool subprocess) writes to the SAME file, so a short-lived subprocess can safely
// append an "intent" and exit without waiting for anything: replay is owned exclusively by the
// long-running supervisor, the only process that outlives any single degradation window.
//
// Scope is deliberately narrow: append-only rows with no check-then-act dependency and (for every
// table actually written today) a natural or explicit uniqueness constraint that makes a replayed
// duplicate a no-op. The LP ledger and TC/predict proposals/bets are explicitly OUT of scope — see
// circuit-breaker.ts's PgUnavailableError (LP) and the research report's split-brain analysis
// (stateful tables). `chats` is included even though the research report did not name it: messages.ts
// satisfies a foreign key with a same-process placeholder chats insert immediately before every
// message insert, and without a safe place to put that write too, every queued message would still
// block on a real (broken) connection attempt just to satisfy the FK.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as Db } from 'node:sqlite';
import { RUNTIME_DIR } from './paths.js';
import { getDb } from './db.js';
import { log } from './log.js';

const _require = createRequire(import.meta.url);
function loadSqlite(): typeof import('node:sqlite') {
  return _require('node:sqlite') as typeof import('node:sqlite');
}

/** Tables whose writes may be diverted into the outbox while the soul PG pool's breaker is open. */
export const OUTBOX_TABLES = [
  'chats',
  'messages',
  'activities',
  'member_sync_rounds',
  'calendar_event_rsvp_rounds',
  'doc_view_events',
  'chat_reactions',
  'handled_messages',
  'errors',
] as const;
export type OutboxTable = (typeof OUTBOX_TABLES)[number];

function outboxDbPath(): string {
  return process.env.AGENT_PG_OUTBOX_PATH || path.join(RUNTIME_DIR, 'pg-outbox.db');
}

let _outboxDb: Db | null = null;

function outboxDb(): Db {
  if (_outboxDb) return _outboxDb;
  const { DatabaseSync } = loadSqlite();
  const file = outboxDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000'); // several processes may append concurrently, mirrors getLpDbSqliteRaw()
  db.exec(`
    CREATE TABLE IF NOT EXISTS pg_outbox (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name   TEXT NOT NULL,
      columns_json TEXT NOT NULL,
      values_json  TEXT NOT NULL,
      enqueued_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      replayed_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pg_outbox_pending ON pg_outbox(replayed_at) WHERE replayed_at IS NULL;

    CREATE TABLE IF NOT EXISTS pg_outbox_replay_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      attempted   INTEGER NOT NULL DEFAULT 0,
      replayed    INTEGER NOT NULL DEFAULT 0,
      failed      INTEGER NOT NULL DEFAULT 0
    );
  `);
  _outboxDb = db;
  return db;
}

/** Test-only: drop the cached handle so the next call reopens (mirrors db.ts's closeDb pattern). */
export function closeOutboxDb(): void {
  if (_outboxDb) {
    try {
      _outboxDb.close();
    } catch {
      /* ignore close errors */
    }
    _outboxDb = null;
  }
}

/**
 * Record one deferred write's intent (table + column list + positional values, in the exact order
 * the caller would have passed to db.query's `$N` placeholders). Safe to call from a short-lived
 * subprocess: it appends and returns immediately, never waiting on replay.
 */
export async function enqueueOutboxWrite(table: OutboxTable, columns: string[], values: unknown[]): Promise<void> {
  const db = outboxDb();
  db.prepare('INSERT INTO pg_outbox(table_name, columns_json, values_json) VALUES (?, ?, ?)').run(
    table,
    JSON.stringify(columns),
    JSON.stringify(values),
  );
}

/** Count of not-yet-replayed rows — the "backlog" `agent doctor` reports. */
export function outboxBacklogCount(): number {
  const row = outboxDb().prepare('SELECT COUNT(*) AS n FROM pg_outbox WHERE replayed_at IS NULL').get() as { n: number };
  return row.n;
}

export interface OutboxReplayResult {
  attempted: number;
  replayed: number;
  failed: number;
}

/**
 * Batch-replay every pending outbox row into PostgreSQL, oldest first, marking each row's
 * replayed_at IMMEDIATELY after its own insert succeeds — so a crash mid-replay leaves already-marked
 * rows untouched and a re-run only ever retries what genuinely never landed. Every table here has
 * either a natural key or an explicit UNIQUE constraint (see OUTBOX_TABLES' doc comment) EXCEPT
 * activities/errors, so `ON CONFLICT DO NOTHING` makes re-replaying an already-landed row a no-op for
 * every table but those two — a rare, low-severity edge case (a duplicate log line) given the tiny
 * window between a row's remote INSERT succeeding and its local replayed_at mark.
 *
 * Only called once the soul breaker has actually closed (supervisor's responsibility), so getDb()
 * here resolves to the real PostgreSQL executor, not another diversion.
 */
export async function replayOutbox(): Promise<OutboxReplayResult> {
  const db = outboxDb();
  const startedAt = Math.floor(Date.now() / 1000);
  const pending = db
    .prepare('SELECT id, table_name, columns_json, values_json FROM pg_outbox WHERE replayed_at IS NULL ORDER BY id ASC')
    .all() as Array<{ id: number; table_name: string; columns_json: string; values_json: string }>;

  let replayed = 0;
  let failed = 0;
  if (pending.length > 0) {
    const target = await getDb();
    for (const row of pending) {
      try {
        const cols: string[] = JSON.parse(row.columns_json);
        const vals: unknown[] = JSON.parse(row.values_json);
        // messages.chat_id carries a FK to chats(chat_id); the live insertMessage() path satisfies it
        // with the same placeholder insert immediately beforehand, so replay mirrors that here rather
        // than requiring every queued message to also have a queued chats row.
        if (row.table_name === 'messages') {
          const chatIdx = cols.indexOf('chat_id');
          if (chatIdx >= 0 && vals[chatIdx]) {
            await target.query('INSERT INTO chats(chat_id) VALUES ($1) ON CONFLICT DO NOTHING', [vals[chatIdx]]);
          }
        }
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
        await target.query(
          `INSERT INTO ${row.table_name}(${cols.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          vals,
        );
        db.prepare('UPDATE pg_outbox SET replayed_at = unixepoch() WHERE id = ?').run(row.id);
        replayed++;
      } catch (e) {
        failed++;
        log.error(`PG 降级队列回放失败（id=${row.id}, table=${row.table_name}）：${(e as Error).message}`);
      }
    }
  }

  db.prepare(
    `INSERT INTO pg_outbox_replay_log(started_at, finished_at, attempted, replayed, failed) VALUES (?, unixepoch(), ?, ?, ?)`,
  ).run(startedAt, pending.length, replayed, failed);

  if (pending.length > 0) {
    log.info(`PG 降级队列回放完成：尝试 ${pending.length} 条，成功 ${replayed} 条，失败 ${failed} 条`);
  }
  return { attempted: pending.length, replayed, failed };
}

export interface OutboxReplayLogRow {
  startedAt: number;
  finishedAt: number | null;
  attempted: number;
  replayed: number;
  failed: number;
}

/** Most recent replay attempt's summary — what `agent doctor` shows as "最近一次回补". */
export function lastReplayLog(): OutboxReplayLogRow | null {
  const row = outboxDb()
    .prepare('SELECT started_at, finished_at, attempted, replayed, failed FROM pg_outbox_replay_log ORDER BY id DESC LIMIT 1')
    .get() as { started_at: number; finished_at: number | null; attempted: number; replayed: number; failed: number } | undefined;
  if (!row) return null;
  return {
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    attempted: row.attempted,
    replayed: row.replayed,
    failed: row.failed,
  };
}
