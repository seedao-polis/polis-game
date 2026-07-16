import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as Db } from 'node:sqlite';
import { RUNTIME_DIR } from './paths.js';

// SQLite engine for the agent: a single embedded database file under the runtime
// directory, opened in WAL mode with foreign keys enforced. All access is synchronous.

// The node:sqlite builtin emits an ExperimentalWarning the first time it is loaded.
// This filter drops only that one notice (keeping stderr — the MCP JSON-RPC server's
// log channel — clean) and is installed before the module is loaded below.
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : (warning as { message?: string })?.message ?? '';
  const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string })?.type;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(msg)) return;
  return (_emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

// Load node:sqlite lazily via a synchronous require so the warning filter above is
// in place before the builtin is first evaluated (a static import would hoist ahead of it).
const _require = createRequire(import.meta.url);
function loadSqlite(): typeof import('node:sqlite') {
  return _require('node:sqlite') as typeof import('node:sqlite');
}

let _db: Db | null = null;
let _lpDb: Db | null = null;

/**
 * Name of the active soul, used to name its DB file. Each agent gets its own database:
 * workspaces/<soul>/ ⇒ .agent/<soul>.db. AGENT_SOUL is set by every entry point (serve worker,
 * supervisor, cli/ask/run) and forwarded to the MCP server's own process (Agent.buildMcpConfig),
 * so all processes serving one soul open the same file. Sanitized so it can never escape RUNTIME_DIR.
 */
function dbName(): string {
  const raw = process.env.AGENT_SOUL || 'tudigong'; // mirrors DEFAULT_SOUL in bin/agent.ts
  return raw.replace(/[^A-Za-z0-9._-]/g, '_') || 'tudigong';
}

/** Filesystem path of the database file. AGENT_DB_PATH overrides the whole path (tests use it for isolation). */
function dbPath(): string {
  return process.env.AGENT_DB_PATH || path.join(RUNTIME_DIR, `${dbName()}.db`);
}

/** Open (once) and return the shared database handle, running pending migrations. */
export function getDb(): Db {
  if (_db) return _db;
  const { DatabaseSync } = loadSqlite();
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  runMigrations(db);
  _db = db;
  return db;
}

/** Close the open handles and drop the singletons so the next getDb()/getLpDb() reopens. Mainly for tests. */
export function closeDb(): void {
  for (const h of [_db, _lpDb]) {
    if (!h) continue;
    try { h.close(); } catch { /* ignore close errors */ }
  }
  _db = null;
  _lpDb = null;
}

// All agents share ONE gamification/LP economy (points, ledger, check-ins, badges) kept in a single
// database, so a member's LP and badges are global rather than per-agent. Per-person conversational
// memory and messages stay in each agent's own <soul>.db. AGENT_LP_DB_PATH overrides the file.
function lpDbPath(): string {
  if (process.env.AGENT_DB_PATH) return process.env.AGENT_DB_PATH; // tests pin everything to one file
  return process.env.AGENT_LP_DB_PATH || path.join(RUNTIME_DIR, 'shared.db');
}

/** Open (once) and return the shared LP database handle. Reuses the per-agent handle when they are the same file. */
export function getLpDb(): Db {
  if (lpDbPath() === dbPath()) return getDb(); // same file → one handle (tests / AGENT_SOUL pinned to the LP file)
  if (_lpDb) return _lpDb;
  const { DatabaseSync } = loadSqlite();
  const file = lpDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000'); // several agent processes may write LP to this one file concurrently
  runMigrations(db);
  _lpDb = db;
  return db;
}

/** Run a function inside a single atomic transaction on the shared LP database. */
export function lpTx<T>(fn: () => T): T {
  if (lpDbPath() === dbPath()) return tx(fn); // same file → reuse the per-agent transaction
  const db = getLpDb();
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore secondary rollback failure */ }
    throw e;
  }
}

/** Run a function inside a single atomic transaction; rolls back on any error. */
export function tx<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore secondary rollback failure */ }
    throw e;
  }
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS chats (
  chat_id      TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  chat_type    TEXT,
  chat_mode    TEXT,
  external     INTEGER NOT NULL DEFAULT 0,
  tenant_key   TEXT,
  lark_profile TEXT,
  first_seen   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS messages (
  message_id        TEXT PRIMARY KEY,
  chat_id           TEXT NOT NULL REFERENCES chats(chat_id),
  sender_open_id    TEXT NOT NULL DEFAULT '',
  sender_id_type    TEXT,
  sender_type       TEXT,
  sender_tenant_key TEXT,
  sender_name       TEXT NOT NULL DEFAULT '',
  msg_type          TEXT NOT NULL DEFAULT 'text',
  text              TEXT NOT NULL DEFAULT '',
  mentions          TEXT NOT NULL DEFAULT '[]',
  thread_id         TEXT,
  thread_message_position INTEGER,
  message_position  INTEGER,
  create_time       INTEGER NOT NULL DEFAULT 0,
  updated           INTEGER NOT NULL DEFAULT 0,
  deleted           INTEGER NOT NULL DEFAULT 0,
  raw               TEXT,
  collected_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, create_time DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_open_id, create_time DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, thread_message_position) WHERE thread_id IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  message_id UNINDEXED,
  chat_id UNINDEXED,
  content=messages,
  content_rowid=rowid,
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, message_id, chat_id) VALUES (new.rowid, new.text, new.message_id, new.chat_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, message_id, chat_id) VALUES ('delete', old.rowid, old.text, old.message_id, old.chat_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, message_id, chat_id) VALUES ('delete', old.rowid, old.text, old.message_id, old.chat_id);
  INSERT INTO messages_fts(rowid, text, message_id, chat_id) VALUES (new.rowid, new.text, new.message_id, new.chat_id);
END;

CREATE TABLE IF NOT EXISTS profiles (
  open_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  pt_balance INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS pt_ledger (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_open_id   TEXT NOT NULL REFERENCES profiles(open_id),
  delta          INTEGER NOT NULL,
  reason         TEXT NOT NULL DEFAULT '',
  ref_message_id TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON pt_ledger(user_open_id, created_at);

CREATE TABLE IF NOT EXISTS badges (
  badge_id    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS user_badges (
  user_open_id TEXT NOT NULL REFERENCES profiles(open_id),
  badge_id     TEXT NOT NULL REFERENCES badges(badge_id),
  awarded_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  ref          TEXT,
  PRIMARY KEY (user_open_id, badge_id)
);

CREATE TABLE IF NOT EXISTS activities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT NOT NULL,
  actor_open_id  TEXT,
  chat_id        TEXT,
  ref_message_id TEXT,
  payload        TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_activities_actor ON activities(actor_open_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type, created_at);
`;

const SCHEMA_V2 = `
ALTER TABLE profiles ADD COLUMN level INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_messages_sender_time ON messages(sender_open_id, create_time DESC);
CREATE INDEX IF NOT EXISTS idx_activities_actor_type ON activities(actor_open_id, type, created_at DESC);
INSERT OR IGNORE INTO badges(badge_id, name, description, emoji) VALUES ('first_contact', '初次见面', '第一次和我互动', '👋');
`;

const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS checkins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_open_id TEXT NOT NULL REFERENCES profiles(open_id),
  checkin_date TEXT NOT NULL,
  pt_awarded   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_open_id, checkin_date)
);
CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_open_id, checkin_date DESC);
`;

// Error ledger: every kimi/agent failure is recorded here (classification, exit metadata, whether
// self-heal kicked in). Powers the background janitor's threshold alerts and `agent doctor`.
const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  corr_id     TEXT,
  soul        TEXT,
  chat_id     TEXT,
  source      TEXT,
  kind        TEXT NOT NULL DEFAULT 'unknown',
  summary     TEXT NOT NULL DEFAULT '',
  exit_code   INTEGER,
  signal      TEXT,
  duration_ms INTEGER,
  attempt     INTEGER NOT NULL DEFAULT 1,
  healed      INTEGER NOT NULL DEFAULT 0,
  postmortem  TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_errors_time ON errors(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_chat_time ON errors(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_kind_time ON errors(kind, created_at DESC);
`;

// In-flight LLM replies, persisted so a worker restart (hot-reload / crash) that interrupts a reply
// can recover: clear the orphaned "thinking" reaction, refund the charged LP, and re-run the answer.
// A row exists only while a reply is being generated; it is deleted the moment the reply is sent
// (success OR handled error), so on startup any leftover rows are exactly the interrupted ones.
const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS pending_replies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id       TEXT NOT NULL,
  channel        TEXT NOT NULL,
  chat_id        TEXT NOT NULL,
  message_id     TEXT,
  session_key    TEXT NOT NULL DEFAULT '',
  sender_open_id TEXT,
  text           TEXT NOT NULL DEFAULT '',
  reaction_id    TEXT,
  pt_spent       INTEGER NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_pending_agent ON pending_replies(agent_id, channel);
`;

// Event system (management-game events): an event = a base image + overlaid text + markdown caption,
// sent to a group (global) or a person (personal / P2P). Each fire is recorded with its send status
// and the resulting feishu message_id, so a later feature can tally reactions on it.
//   event_types      — event definitions (base image + overlay/render config + markdown templates)
//   event_dispatches — one row per fire: payload, status (pending/sent/failed), message_id
//   event_reactions  — reserved: reactions harvested on a dispatched message (filled by a later sync)
const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS event_types (
  event_type_id  TEXT PRIMARY KEY,
  title          TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',
  scope          TEXT NOT NULL DEFAULT 'global',
  target_chat_id TEXT,
  base_image     TEXT,
  render_config  TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS event_dispatches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type_id  TEXT NOT NULL,
  trigger_reason TEXT NOT NULL DEFAULT '',
  scope          TEXT NOT NULL DEFAULT 'global',
  actor_open_id  TEXT,
  target         TEXT,
  rendered_image TEXT,
  payload        TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  message_id     TEXT,
  error_msg      TEXT,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_event_dispatches_type ON event_dispatches(event_type_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_dispatches_actor ON event_dispatches(actor_open_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_dispatches_status ON event_dispatches(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_dispatches_message ON event_dispatches(message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_reactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id     INTEGER NOT NULL,
  message_id      TEXT NOT NULL,
  reactor_open_id TEXT NOT NULL,
  emoji_type      TEXT NOT NULL,
  reacted_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(dispatch_id, reactor_open_id, emoji_type)
);
CREATE INDEX IF NOT EXISTS idx_event_reactions_dispatch ON event_reactions(dispatch_id);
`;

// Per-event scheduling state for the timed+random trigger engine. One row per scheduled event,
// tracking when it was last *rolled* (so a weekly cadence doesn't re-roll daily) and when it last
// actually *fired*. last_outcome is 'fired' / 'missed' (dice failed) / 'skipped' (prepare aborted).
const SCHEMA_V7 = `
CREATE TABLE IF NOT EXISTS event_schedule_state (
  event_type_id TEXT PRIMARY KEY,
  last_eval_at  INTEGER,
  last_fire_at  INTEGER,
  last_outcome  TEXT
);
`;

// next_fire_at: a planned within-window fire time (unix seconds) that's been scheduled for the
// current logical day but hasn't rolled yet. Persisted so a supervisor restart re-arms the same
// instant instead of re-randomising or double-firing. Cleared (NULL) once the roll resolves.
const SCHEMA_V8 = `
ALTER TABLE event_schedule_state ADD COLUMN next_fire_at INTEGER;
`;

// Member directory: every person seen in a monitored chat's roster (internal AND external), captured
// even if they never sent a message. Kept SEPARATE from profiles on purpose — profiles is the
// gamification table (the daily LP floor reset tops every profile up), so dumping the whole community
// roster there would hand LP to non-participants. `present` flags current membership; rows are never
// deleted (a member who leaves is kept with present=0 in case they return).
const SCHEMA_V9 = `
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id    TEXT NOT NULL,
  open_id    TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  present    INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chat_id, open_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_open ON chat_members(open_id);
`;

// Operational time-series of the periodic (≈5-min) member roster sync. One row per sync round,
// aggregated across all monitored chats: the in-group head-count (present_total, summed per chat so
// a member in N chats counts N times — mirrors the "在群合计" log line), this round's joined/left/
// renamed deltas, the cumulative distinct roster size (roster_total = directoryStats().distinct), and
// the (open_id, name) detail of each joiner/leaver/renamer as a "(ou, name),(ou, name)" string.
// Powers ops analytics. Historical rounds are backfilled from logs (counts only; per-person detail is
// left empty for those). synced_at is UNIQUE so backfill is idempotent and never double-records a round.
const SCHEMA_V10 = `
CREATE TABLE IF NOT EXISTS member_sync_rounds (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at      INTEGER NOT NULL,
  chat_count     INTEGER NOT NULL DEFAULT 0,
  present_total  INTEGER NOT NULL DEFAULT 0,
  joined_count   INTEGER NOT NULL DEFAULT 0,
  left_count     INTEGER NOT NULL DEFAULT 0,
  renamed_count  INTEGER NOT NULL DEFAULT 0,
  roster_total   INTEGER NOT NULL DEFAULT 0,
  joined_detail  TEXT NOT NULL DEFAULT '',
  left_detail    TEXT NOT NULL DEFAULT '',
  renamed_detail TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT 'live',
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_sync_rounds_at ON member_sync_rounds(synced_at);
`;

// Deduped current head-counts (distinct open_ids present RIGHT NOW; a member in N chats counts once),
// as opposed to present_total which sums per-chat rosters, and roster_total which counts distinct
// EVER-seen (including leavers). All three are recorded for live rounds and left 0 for backfilled
// rounds (the historical logs never carried them):
//   present_distinct — distinct present across ALL monitored chats
//   present_internal — distinct present in INTERNAL chats (chats.external = 0)
//   present_external — distinct present in EXTERNAL chats (chats.external = 1)
// internal + external can exceed present_distinct: someone in both an internal and an external chat
// is counted once in each category but once overall.
const SCHEMA_V11 = `
ALTER TABLE member_sync_rounds ADD COLUMN present_distinct INTEGER NOT NULL DEFAULT 0;
ALTER TABLE member_sync_rounds ADD COLUMN present_internal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE member_sync_rounds ADD COLUMN present_external INTEGER NOT NULL DEFAULT 0;
`;

// dissolved_at: stamped (unix seconds) when we mark a monitored chat INACTIVE — either dissolved
// (Feishu 232009) or sustained-inaccessible (we were kicked / lost permission). NULL = active. Once set,
// the poll loop stops, the member sync skips it, and rediscovery won't blindly re-listen — so a vanished
// or inaccessible group stops spamming errors on every poll/sync. (Name kept for migration stability;
// inactive_reason below says which case it is.)
const SCHEMA_V12 = `
ALTER TABLE chats ADD COLUMN dissolved_at INTEGER;
`;

// inactive_reason: why a chat was marked inactive — 'dissolved' (232009, permanent) or 'inaccessible'
// (kicked out / no permission, possibly recoverable). Drives both reporting (agent doctor) and resume:
// an 'inaccessible' chat that reappears in live discovery (we were re-added) is reactivated, while a
// 'dissolved' one stays skipped. NULL when the chat is active.
const SCHEMA_V13 = `
ALTER TABLE chats ADD COLUMN inactive_reason TEXT;
`;

// RSVP signup-count time-series for upcoming Feishu calendar events. Symmetric to member_sync_rounds:
// one row per (poll-round, event), idempotent via UNIQUE(synced_at, event_id). accepted is the headline
// signup count (rsvp_status='accept'); declined/tentative/needs_action are stored separately so callers
// can compose their own aggregates. signup_total = all non-removed attendees (reference only, not the
// headline). calendar_id stores the actual organizer_calendar_id from +agenda (not the literal 'primary').
// start_time/end_time are redundantly stored as unix seconds to avoid re-fetching on every chart query.
const SCHEMA_V14 = `
CREATE TABLE IF NOT EXISTS calendar_event_rsvp_rounds (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at      INTEGER NOT NULL,        -- unix seconds, part of the idempotency key
  event_id       TEXT NOT NULL,           -- Feishu calendar event id (UUID + recurrence-instance suffix)
  calendar_id    TEXT NOT NULL DEFAULT '',-- organizer_calendar_id the event lives on
  title          TEXT NOT NULL DEFAULT '',
  start_time     INTEGER NOT NULL DEFAULT 0, -- event start, unix seconds
  end_time       INTEGER NOT NULL DEFAULT 0, -- event end, unix seconds
  accepted       INTEGER NOT NULL DEFAULT 0, -- rsvp_status=accept; the headline signup count
  declined       INTEGER NOT NULL DEFAULT 0, -- rsvp_status=decline
  tentative      INTEGER NOT NULL DEFAULT 0, -- rsvp_status=tentative
  needs_action   INTEGER NOT NULL DEFAULT 0, -- rsvp_status=needs_action
  signup_total   INTEGER NOT NULL DEFAULT 0, -- all non-removed attendees, reference only
  source         TEXT NOT NULL DEFAULT 'live',
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_event_rsvp_rounds_at_event
  ON calendar_event_rsvp_rounds(synced_at, event_id);
CREATE INDEX IF NOT EXISTS idx_calendar_event_rsvp_rounds_event
  ON calendar_event_rsvp_rounds(event_id, synced_at DESC);
`;

// Append-only log of knowledge-base document view records. The Feishu access-record API is per-file
// and returns one entry per distinct viewer carrying that viewer's most-recent view time, so a
// UNIQUE(file_token, viewer_id, last_view_time) key with INSERT OR IGNORE turns repeated polling into
// change detection: a view already recorded is ignored, while a new viewer or an advanced view time
// inserts a fresh row. Each row therefore marks one observed view at the polled granularity, not a
// running snapshot. source records where the document was discovered ('wiki' space vs the user's
// 'drive'); space_id and title are denormalized so queries need not re-walk the document tree.
const SCHEMA_V15 = `
CREATE TABLE IF NOT EXISTS doc_view_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  file_token     TEXT NOT NULL,
  file_type      TEXT NOT NULL DEFAULT '',  -- docx/sheet/bitable/mindnote/file/doc
  source         TEXT NOT NULL DEFAULT '',  -- 'wiki' | 'drive'
  space_id       TEXT NOT NULL DEFAULT '',  -- wiki space id when source='wiki', else empty
  title          TEXT NOT NULL DEFAULT '',
  viewer_id      TEXT NOT NULL,             -- viewer open_id
  viewer_name    TEXT NOT NULL DEFAULT '',
  last_view_time INTEGER NOT NULL DEFAULT 0, -- viewer's most-recent view, unix seconds
  recorded_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_view_events_unique
  ON doc_view_events(file_token, viewer_id, last_view_time);
CREATE INDEX IF NOT EXISTS idx_doc_view_events_file
  ON doc_view_events(file_token, last_view_time DESC);
CREATE INDEX IF NOT EXISTS idx_doc_view_events_recorded
  ON doc_view_events(recorded_at DESC);
`;

// De-duplication ledger for user-token expiry reminders. One row per (authorization grant, day-before
// threshold) marks that a reminder for that threshold has already been pushed, so each threshold fires
// at most once. grant_key embeds the grant's identity (profile + grant timestamp), so re-authorizing —
// which starts a new grant and moves the deadline out — yields a fresh key and a clean reminder cycle.
const SCHEMA_V16 = `
CREATE TABLE IF NOT EXISTS token_expiry_alerts (
  grant_key  TEXT NOT NULL,           -- profile + authorization grant timestamp
  threshold  INTEGER NOT NULL,        -- days-before-expiry mark (3/2/1/0)
  sent_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (grant_key, threshold)
);
`;

// Badge metadata expansion: adds rich semantic fields to the badges table (headline, file, type,
// role, endorser, duration, category, event) and award provenance to user_badges (awarded_by, note).
// All new columns are nullable TEXT with empty-string defaults so existing rows are untouched.
const SCHEMA_V17 = `
ALTER TABLE badges ADD COLUMN headline  TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN file      TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN title     TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN type      TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN role      TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN endorser  TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN duration  TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN category  TEXT NOT NULL DEFAULT '';
ALTER TABLE badges ADD COLUMN event     TEXT NOT NULL DEFAULT '';
ALTER TABLE user_badges ADD COLUMN awarded_by TEXT;
ALTER TABLE user_badges ADD COLUMN note TEXT;
`;

// Long-term memory store: scoped by namespace for per-user, per-group, and cross-group isolation.
// namespace encodes the access scope: 'global' | 'group:{chat_id}' | 'user:{open_id}' |
// 'group_user:{chat_id}:{open_id}'. Visibility controls who can read a row beyond namespace
// membership. Sensitivity is advisory (affects log redaction, not LLM access). source distinguishes
// manually written entries from automatically generated summaries.
const SCHEMA_V18 = `
CREATE TABLE IF NOT EXISTS memory_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace    TEXT NOT NULL,
  key          TEXT,
  content      TEXT NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'private',
  sensitivity  TEXT NOT NULL DEFAULT 'normal',
  source       TEXT NOT NULL DEFAULT 'manual',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_items(namespace, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_visibility ON memory_items(visibility, namespace);
`;

/**
 * LP rename: databases created before this change named the gamification points table and columns
 * `ap_*` (the legacy "AP" terminology). The live schema now uses `pt_*` (LP / 生命点). This brings an
 * existing DB up to the new shape by renaming in place, so the rows survive as the same data under the
 * new names. On a fresh DB the schema is already `pt_*`, so every guard is false and this is a no-op.
 * The `ap_*` names below are the legacy ones being migrated away; they appear nowhere else.
 */
function migrateLpRename(db: Db): void {
  const columns = (table: string): Set<string> =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
  const tableExists = (name: string): boolean =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

  const profiles = columns('profiles');
  if (profiles.has('ap_balance') && !profiles.has('pt_balance')) {
    db.exec('ALTER TABLE profiles RENAME COLUMN ap_balance TO pt_balance');
  }
  const checkins = columns('checkins');
  if (checkins.has('ap_awarded') && !checkins.has('pt_awarded')) {
    db.exec('ALTER TABLE checkins RENAME COLUMN ap_awarded TO pt_awarded');
  }
  const pending = columns('pending_replies');
  if (pending.has('ap_spent') && !pending.has('pt_spent')) {
    db.exec('ALTER TABLE pending_replies RENAME COLUMN ap_spent TO pt_spent');
  }
  if (tableExists('ap_ledger') && !tableExists('pt_ledger')) {
    db.exec('ALTER TABLE ap_ledger RENAME TO pt_ledger'); // the idx_ledger_user index follows the rename
  }
}

// Identity links: alias multiple per-app open_ids of the same human to one canonical LP identity, so a
// member's points/badges follow them across agents (each Feishu app gives a person a different open_id).
// Lives in the shared LP database; the LP layer resolves open_id → canonical_id before every read/write.
const SCHEMA_V20 = `
CREATE TABLE IF NOT EXISTS identity_links (
  open_id      TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_identity_links_canonical ON identity_links(canonical_id);
`;

// Chat reaction harvest: one row per (message, reactor, emoji) reaction observed by the reaction-sync
// poll on non-work groups. Deduped by the composite PK so re-seeing the same reaction on later polls is
// a no-op (INSERT OR IGNORE). Each row keeps the reaction's action_time so a member's like count within a
// logical week (a windowed COUNT(*) by reactor) can drive the like-maniac milestone. Lives in the per-soul
// db (like chat_members / doc_view_events); the shared LP db gets the (empty, unused) table too since both
// dbs share one migration set.
const SCHEMA_V21 = `
CREATE TABLE IF NOT EXISTS chat_reactions (
  message_id      TEXT NOT NULL,
  chat_id         TEXT NOT NULL,
  reactor_open_id TEXT NOT NULL,
  emoji_type      TEXT NOT NULL,
  action_time     INTEGER NOT NULL DEFAULT 0,
  first_seen      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (message_id, reactor_open_id, emoji_type)
);
CREATE INDEX IF NOT EXISTS idx_chat_reactions_reactor ON chat_reactions(reactor_open_id);
`;

// Pinned messages: one row per message the reaction poll has auto-pinned (once a message drew reactions
// from >= a chat's autoPinMinReactors distinct people). The PK makes the pin idempotent — a message
// already recorded here is never re-pinned, so the poll doesn't hammer the pin API on every round.
const SCHEMA_V22 = `
CREATE TABLE IF NOT EXISTS pinned_messages (
  message_id    TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  reactor_count INTEGER NOT NULL DEFAULT 0,
  pinned_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

// Activity meetups: one row per Feishu calendar event managed by the activity module. lark_event_id
// stores the recurring-series UUID (bare, without the _<ts> occurrence suffix) so queries span the
// whole series. status 'cancelled' is a soft-delete that preserves history while hiding the event
// from upcoming-digest and wiki queries. meetup_url and app_link are captured at creation time from
// the Feishu events.create response so the bot never needs to re-fetch calendar data.
const SCHEMA_V23 = `
CREATE TABLE IF NOT EXISTS activity_meetups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  lark_event_id  TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',
  recurrence     TEXT NOT NULL DEFAULT '',
  start_time     INTEGER NOT NULL DEFAULT 0,
  end_time       INTEGER NOT NULL DEFAULT 0,
  meetup_url    TEXT NOT NULL DEFAULT '',
  app_link       TEXT NOT NULL DEFAULT '',
  calendar_id    TEXT NOT NULL DEFAULT '',
  created_by     TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'confirmed',
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_activity_meetups_start ON activity_meetups(start_time);
CREATE INDEX IF NOT EXISTS idx_activity_meetups_status ON activity_meetups(status);

CREATE TABLE IF NOT EXISTS activity_meetup_tags (
  meetup_id INTEGER NOT NULL REFERENCES activity_meetups(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  PRIMARY KEY (meetup_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_activity_meetup_tags_tag ON activity_meetup_tags(tag);
`;

// Meetup tag subscriptions: one row per (user, tag) pair. A subscriber receives an @-mention in the
// daily 08:00 group digest when any confirmed meetup carrying that tag is scheduled for that day.
const SCHEMA_V24 = `
CREATE TABLE IF NOT EXISTS meetup_subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_open_id TEXT NOT NULL,
  tag          TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(user_open_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_meetup_subscriptions_tag  ON meetup_subscriptions(tag);
CREATE INDEX IF NOT EXISTS idx_meetup_subscriptions_user ON meetup_subscriptions(user_open_id);
`;

// Public calendar share link (feishu.cn/calendar/share?token=...) captured at creation time,
// surfaced in bot replies and the wiki calendar page so members can open and subscribe to the event.
const SCHEMA_V25 = `
ALTER TABLE activity_meetups ADD COLUMN share_link TEXT NOT NULL DEFAULT '';
`;

// Visitor-count milestones: one frozen row per (chat, hundred) recording who the milestone-th visitor
// was (present-member arrival order). Serves as the persistent, restart-proof idempotency ledger for
// the visitor-num-notify announcement so a milestone is announced exactly once, ever.
const SCHEMA_V26 = `
CREATE TABLE IF NOT EXISTS visitor_milestones (
  chat_id    TEXT NOT NULL,
  milestone  INTEGER NOT NULL,
  open_id    TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  reached_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chat_id, milestone)
);
`;

// Self-service display-name overrides: one row per open_id a member has renamed themselves to via the
// "@我 改名 <名字>" command. Lives in the shared LP database (like identity_links) so a member's chosen
// name follows them across every agent. Applied at render time by name-overrides.ts on top of the raw
// captured Feishu name — which the 5-minute roster sync keeps overwriting — so the rename actually
// sticks. The operator-curated configs/name-overrides.json still takes precedence over this self-service
// layer. Keyed by open_id (not name) on purpose: display resolves by identity, so a later rename is free.
const SCHEMA_V27 = `
CREATE TABLE IF NOT EXISTS name_overrides (
  open_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

// Like-maniac weekly announcement ledger: one row per (logical week, member) the like-maniac milestone
// has already fired for. week_start is the epoch-second start of the logical week (Monday 05:00 local).
// The PK makes the announcement fire at most once per member per week — a restart-proof gate (same
// pattern as visitor_milestones), so the weekly 66-reaction milestone never re-fires after a restart or
// on a later poll in the same week. Lives in the per-soul db alongside chat_reactions.
const SCHEMA_V28 = `
CREATE TABLE IF NOT EXISTS like_maniac_weeks (
  week_start     INTEGER NOT NULL,
  open_id        TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  reaction_count INTEGER NOT NULL DEFAULT 0,
  reached_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (week_start, open_id)
);
`;

// TC (Temperature Check) module — per-soul db tables.
// v29: proposal counter + proposal metadata; v30: individual bet records.
// LP ledger operations (debit/credit/refund) use the shared pt_ledger in shared.db — no new table needed there.

// Atomic proposal counter (single row, id=1 enforced by CHECK) for monotonically increasing TC numbers.
// Proposal table stores the full lifecycle: active → settled | cancelled.
// settled_option TEXT accommodates discrete winners as a JSON array (single or tie), since REAL cannot store strings.
const SCHEMA_V29 = `
CREATE TABLE IF NOT EXISTS tc_counter (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  next_num INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO tc_counter(id, next_num) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS tc_proposals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  num             INTEGER NOT NULL UNIQUE,
  title           TEXT    NOT NULL DEFAULT '',
  option_type     TEXT    NOT NULL DEFAULT 'discrete',
  options         TEXT    NOT NULL DEFAULT '[]',
  end_time        INTEGER NOT NULL,
  min_bet_lp      REAL    NOT NULL DEFAULT 1.0,
  max_bet_lp      REAL    NOT NULL DEFAULT 10.0,
  status          TEXT    NOT NULL DEFAULT 'active',
  created_by      TEXT    NOT NULL DEFAULT '',
  chat_id         TEXT    NOT NULL DEFAULT '',
  top_message_id  TEXT    NOT NULL DEFAULT '',
  thread_id       TEXT,
  settled_value   REAL,
  settled_option  TEXT,
  settled_at      INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_tc_proposals_num
  ON tc_proposals(num);
CREATE INDEX IF NOT EXISTS idx_tc_proposals_status
  ON tc_proposals(status);
CREATE INDEX IF NOT EXISTS idx_tc_proposals_end_time
  ON tc_proposals(end_time);
CREATE INDEX IF NOT EXISTS idx_tc_proposals_thread
  ON tc_proposals(thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tc_proposals_top_msg
  ON tc_proposals(top_message_id);
`;

// Bet records: no UNIQUE(proposal_id, user_open_id) — each user may bet multiple times on different options,
// and each bet on the same option accumulates toward the per-user max_bet_lp ceiling.
const SCHEMA_V30 = `
CREATE TABLE IF NOT EXISTS tc_bets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id   INTEGER NOT NULL REFERENCES tc_proposals(id),
  user_open_id  TEXT    NOT NULL,
  option_value  TEXT    NOT NULL,
  lp_amount     REAL    NOT NULL,
  message_id    TEXT    NOT NULL DEFAULT '',
  is_refunded   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_tc_bets_proposal
  ON tc_bets(proposal_id);
CREATE INDEX IF NOT EXISTS idx_tc_bets_user
  ON tc_bets(user_open_id, proposal_id);
CREATE INDEX IF NOT EXISTS idx_tc_bets_refund
  ON tc_bets(proposal_id, is_refunded);
`;

// The module was originally shipped under the name CVP (cvp_* tables). It was renamed to TC
// (Temperature Check). This migration drops the disposable legacy tables and ensures the tc_* tables
// exist, so a database created before the rename converges on the new schema. Bets drop first because
// they reference the proposals table.
const SCHEMA_V31 = `
DROP TABLE IF EXISTS cvp_bets;
DROP TABLE IF EXISTS cvp_proposals;
DROP TABLE IF EXISTS cvp_counter;
` + SCHEMA_V29 + SCHEMA_V30;

// SeeDAO community history "memory fragments": short (~15-30 char) trivia lines harvested from the SeeDAO
// Notion history pages, drawn at random to greet or educate members. Written and read through the shared
// LP database (getLpDb) because this is cross-agent, cross-module community knowledge — closer to
// badges/profiles than to per-soul operational data. content_norm (whitespace/punctuation-stripped and
// lowercased) carries a UNIQUE index so INSERT OR IGNORE dedupes near-identical wording. status supports
// soft-archiving instead of deletion. rating_count/rating_sum are reserved aggregate caches for a future
// rating feature (a detail table would keep them in sync, mirroring pt_ledger → profiles.pt_balance);
// nothing reads or writes them yet.
const SCHEMA_V32 = `
CREATE TABLE IF NOT EXISTS memory_fragments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  content       TEXT    NOT NULL,
  content_norm  TEXT    NOT NULL,
  source_url    TEXT    NOT NULL DEFAULT '',
  source_note   TEXT    NOT NULL DEFAULT '',
  category      TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'active',
  added_by      TEXT    NOT NULL DEFAULT '',
  rating_count  INTEGER NOT NULL DEFAULT 0,
  rating_sum    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_fragments_norm ON memory_fragments(content_norm);
CREATE INDEX IF NOT EXISTS idx_memory_fragments_status ON memory_fragments(status);
CREATE INDEX IF NOT EXISTS idx_memory_fragments_category ON memory_fragments(category);
`;

// Pending newcomer-welcome queue (per-soul db). The 5-minute roster sync enqueues each genuinely new
// member of the visitor group here instead of welcoming immediately; a scheduled digest (08:30/14:30/
// 20:30) drains the queue and sends ONE batched welcome that @-mentions everyone who joined since the
// last digest. PK (chat_id, open_id) + INSERT OR IGNORE dedupes a member queued more than once before a
// digest runs. Rows are deleted wholesale after each digest, so the queue only ever holds the current
// window's arrivals.
const SCHEMA_V33 = `
CREATE TABLE IF NOT EXISTS pending_welcome (
  chat_id   TEXT NOT NULL,
  open_id   TEXT NOT NULL,
  name      TEXT NOT NULL DEFAULT '',
  queued_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chat_id, open_id)
);
`;

// Community Prediction module (predict_*) — per-soul db tables, discrete-option-only. Unlike TC,
// there is no automatic settlement: a proposal is closed by a "predict_judge" badge holder manually
// announcing the winning option (announced_by records who did it). end_time only gates bet acceptance
// (no scheduler polls it), so the table carries no settled_value / thread_id columns TC needed.
const SCHEMA_V34 = `
CREATE TABLE IF NOT EXISTS predict_counter (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  next_num INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO predict_counter(id, next_num) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS predict_proposals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  num             INTEGER NOT NULL UNIQUE,
  title           TEXT    NOT NULL DEFAULT '',
  option_type     TEXT    NOT NULL DEFAULT 'discrete' CHECK (option_type = 'discrete'),
  options         TEXT    NOT NULL DEFAULT '[]',
  end_time        INTEGER NOT NULL,
  min_bet_lp      REAL    NOT NULL DEFAULT 1.0,
  max_bet_lp      REAL    NOT NULL DEFAULT 10.0,
  status          TEXT    NOT NULL DEFAULT 'active',
  created_by      TEXT    NOT NULL DEFAULT '',
  chat_id         TEXT    NOT NULL DEFAULT '',
  top_message_id  TEXT    NOT NULL DEFAULT '',
  announced_by    TEXT    NOT NULL DEFAULT '',
  settled_option  TEXT,
  settled_at      INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_predict_proposals_num
  ON predict_proposals(num);
CREATE INDEX IF NOT EXISTS idx_predict_proposals_status
  ON predict_proposals(status);
CREATE INDEX IF NOT EXISTS idx_predict_proposals_chat
  ON predict_proposals(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_predict_proposals_top_msg
  ON predict_proposals(top_message_id);
`;

// Bet records: same shape as tc_bets — no UNIQUE(proposal_id, user_open_id), since a user may bet
// multiple times across options, accumulating toward the per-user max_bet_lp ceiling.
const SCHEMA_V35 = `
CREATE TABLE IF NOT EXISTS predict_bets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id   INTEGER NOT NULL REFERENCES predict_proposals(id),
  user_open_id  TEXT    NOT NULL,
  option_value  TEXT    NOT NULL,
  lp_amount     REAL    NOT NULL,
  message_id    TEXT    NOT NULL DEFAULT '',
  is_refunded   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_predict_bets_proposal
  ON predict_bets(proposal_id);
CREATE INDEX IF NOT EXISTS idx_predict_bets_user
  ON predict_bets(user_open_id, proposal_id);
CREATE INDEX IF NOT EXISTS idx_predict_bets_refund
  ON predict_bets(proposal_id, is_refunded);
`;

// Treasure chests: owned virtual LP accounts. Balance lives in the shared pt_ledger/profiles under
// chest_id as the account key (an opaque string, same as any open_id); this table only records
// ownership metadata. is_public flags the one "公益宝箱" instance that automatically receives a
// contribution on every community-prediction settlement (see predict-settlement.ts). Lives in the
// shared LP database, alongside profiles/badges.
const SCHEMA_V36 = `
CREATE TABLE IF NOT EXISTS chests (
  chest_id      TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_open_id TEXT NOT NULL,
  is_public     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_chests_owner ON chests(owner_open_id);
`;

/** Apply ordered, idempotent schema migrations tracked in schema_migrations. */
function runMigrations(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  const applied = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version)
  );
  const migrations: Array<{ version: number; description: string; sql?: string; run?: (db: Db) => void }> = [
    { version: 1, description: 'core schema', sql: SCHEMA_V1 },
    { version: 2, description: 'level, lookup indexes, seed badges', sql: SCHEMA_V2 },
    { version: 3, description: 'daily checkin records', sql: SCHEMA_V3 },
    { version: 4, description: 'agent error ledger', sql: SCHEMA_V4 },
    { version: 5, description: 'pending replies for restart recovery', sql: SCHEMA_V5 },
    { version: 6, description: 'event system (types/dispatches/reactions)', sql: SCHEMA_V6 },
    { version: 7, description: 'event schedule state (timed+random triggers)', sql: SCHEMA_V7 },
    { version: 8, description: 'event schedule planned fire time (within-window)', sql: SCHEMA_V8 },
    { version: 9, description: 'chat member directory (roster sync, internal+external)', sql: SCHEMA_V9 },
    { version: 10, description: 'member sync round time-series (ops analytics)', sql: SCHEMA_V10 },
    { version: 11, description: 'member sync round deduped present counts (all/internal/external)', sql: SCHEMA_V11 },
    { version: 12, description: 'chats.dissolved_at (stop polling dissolved chats)', sql: SCHEMA_V12 },
    { version: 13, description: 'chats.inactive_reason (dissolved vs inaccessible)', sql: SCHEMA_V13 },
    { version: 14, description: 'calendar event RSVP time-series (upcoming-event signup polling)', sql: SCHEMA_V14 },
    { version: 15, description: 'document view-record events (knowledge-base access polling)', sql: SCHEMA_V15 },
    { version: 16, description: 'token expiry reminder dedup ledger', sql: SCHEMA_V16 },
    { version: 17, description: 'badge rich metadata + award provenance', sql: SCHEMA_V17 },
    { version: 18, description: 'long-term memory store (memory_items, namespace/visibility/sensitivity)', sql: SCHEMA_V18 },
    { version: 19, description: 'rename gamification points AP->LP (ap_* tables/columns -> pt_*)', run: migrateLpRename },
    { version: 20, description: 'identity links (alias per-app open_ids to one canonical LP identity)', sql: SCHEMA_V20 },
    { version: 21, description: 'chat reaction harvest (per-member cumulative like count for milestones)', sql: SCHEMA_V21 },
    { version: 22, description: 'pinned messages (auto-pin popular messages, idempotent)', sql: SCHEMA_V22 },
    { version: 23, description: 'activity meetups + tags (tudigong activity module)', sql: SCHEMA_V23 },
    { version: 24, description: 'meetup tag subscriptions (activity module digest mentions)', sql: SCHEMA_V24 },
    { version: 25, description: 'activity_meetups.share_link (public calendar share link)', sql: SCHEMA_V25 },
    { version: 26, description: 'visitor_milestones (restart-proof visitor-count announcement ledger)', sql: SCHEMA_V26 },
    { version: 27, description: 'self-service display-name overrides (改名 command, keyed by open_id)', sql: SCHEMA_V27 },
    { version: 28, description: 'like_maniac_weeks (per-week like-maniac announcement ledger, weekly 66-reaction milestone)', sql: SCHEMA_V28 },
    { version: 29, description: 'tc_counter + tc_proposals (intention-survey proposals)', sql: SCHEMA_V29 },
    { version: 30, description: 'tc_bets (intention-survey bet records)', sql: SCHEMA_V30 },
    { version: 31, description: 'rename CVP module to TC: drop legacy cvp_* tables, ensure tc_* exist', sql: SCHEMA_V31 },
    { version: 32, description: 'memory_fragments (SeeDAO history trivia store, shared db, dedup by content_norm)', sql: SCHEMA_V32 },
    { version: 33, description: 'pending_welcome (batched newcomer-welcome queue drained by the 08:30/14:30/20:30 digest)', sql: SCHEMA_V33 },
    { version: 34, description: 'predict_counter + predict_proposals (community prediction, discrete-only, judge-announced settlement)', sql: SCHEMA_V34 },
    { version: 35, description: 'predict_bets (community prediction bet records)', sql: SCHEMA_V35 },
    { version: 36, description: 'chests (owned virtual LP accounts, e.g. 公益宝箱)', sql: SCHEMA_V36 },
  ];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    if (m.run) m.run(db);
    else if (m.sql) db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations(version, description) VALUES (?, ?)').run(m.version, m.description);
  }
}
