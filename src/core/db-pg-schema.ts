// PostgreSQL baseline schema for the tudigong SQLite → PostgreSQL migration.
//
// Two independent schemas live in the same `feishu_biz` database:
//   `shared`        — the cross-soul LP economy (points, ledger, badges, checkins, identity
//                      links, self-service name overrides, community-history trivia, treasure
//                      chests). Mirrors the final shape of .agent/shared.db.
//   `soul_tudigong` — tudigong's own conversational/operational tables (messages, activities,
//                      events, TC/predict betting, meetups, etc). Mirrors the final shape of
//                      .agent/tudigong.db, minus the four LP tables that are historical
//                      pre-split leftovers there (profiles/pt_ledger/badges/user_badges).
//
// Each table below is hand-written from the SQLite migration set's final (post all migrations)
// shape rather than translated migration-by-migration, per the type mapping:
//   - INTEGER PRIMARY KEY AUTOINCREMENT  -> BIGINT GENERATED ALWAYS AS IDENTITY
//   - 0/1 boolean columns                -> SMALLINT (kept as 0/1, not converted to BOOLEAN)
//   - unix-second/millisecond timestamps -> BIGINT, defaulting via the unixepoch() function below
//   - LP/financial amounts               -> NUMERIC(12,1) or NUMERIC(12,4) (never INTEGER/REAL)
//   - JSON-serialized columns            -> TEXT (unchanged; JSON.parse/stringify boundary intact)
// FTS5 full-text search is not replicated (downgraded to ILIKE at the query layer); no
// messages_fts/trigram objects are created here.
//
// Each schema tracks its own independent `schema_migrations` table, decoupled from the SQLite
// side's v1-v39 numbering: this baseline is recorded as version 1 in each schema.

import type { Pool } from 'pg';

/** Mirrors SQLite's `unixepoch()` default-value function so DEFAULT clauses carry over unchanged. */
const UNIXEPOCH_FUNCTION = `
CREATE OR REPLACE FUNCTION unixepoch() RETURNS bigint AS $$
  SELECT extract(epoch FROM now())::bigint
$$ LANGUAGE sql STABLE;
`;

/** The `shared` schema: cross-soul LP economy, 9 tables, created in FK dependency order. */
export const BASELINE_SHARED_DDL = `
CREATE TABLE IF NOT EXISTS badges (
  badge_id    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji       TEXT NOT NULL DEFAULT '',
  created_at  BIGINT NOT NULL DEFAULT unixepoch(),
  headline    TEXT NOT NULL DEFAULT '',
  file        TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT '',
  endorser    TEXT NOT NULL DEFAULT '',
  duration    TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  event       TEXT NOT NULL DEFAULT ''
);
INSERT INTO badges(badge_id, name, description, emoji) VALUES ('first_contact', '初次见面', '第一次和我互动', '👋')
  ON CONFLICT (badge_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS profiles (
  open_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  pt_balance NUMERIC(12,1) NOT NULL DEFAULT 0,
  level      INTEGER NOT NULL DEFAULT 1,
  first_seen BIGINT NOT NULL DEFAULT unixepoch(),
  last_seen  BIGINT NOT NULL DEFAULT unixepoch()
);

CREATE TABLE IF NOT EXISTS pt_ledger (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_open_id   TEXT NOT NULL REFERENCES profiles(open_id),
  delta          NUMERIC(12,1) NOT NULL,
  reason         TEXT NOT NULL DEFAULT '',
  ref_message_id TEXT,
  created_at     BIGINT NOT NULL DEFAULT unixepoch()
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON pt_ledger(user_open_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_ref  ON pt_ledger(ref_message_id) WHERE ref_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS checkins (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_open_id TEXT NOT NULL REFERENCES profiles(open_id),
  checkin_date TEXT NOT NULL,
  pt_awarded   NUMERIC(12,1) NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL DEFAULT unixepoch(),
  UNIQUE(user_open_id, checkin_date)
);
CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_open_id, checkin_date DESC);

CREATE TABLE IF NOT EXISTS user_badges (
  user_open_id TEXT NOT NULL REFERENCES profiles(open_id),
  badge_id     TEXT NOT NULL REFERENCES badges(badge_id),
  awarded_at   BIGINT NOT NULL DEFAULT unixepoch(),
  ref          TEXT,
  awarded_by   TEXT,
  note         TEXT,
  PRIMARY KEY (user_open_id, badge_id)
);

CREATE TABLE IF NOT EXISTS identity_links (
  open_id      TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  created_at   BIGINT NOT NULL DEFAULT unixepoch()
);
CREATE INDEX IF NOT EXISTS idx_identity_links_canonical ON identity_links(canonical_id);

CREATE TABLE IF NOT EXISTS name_overrides (
  open_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL DEFAULT unixepoch()
);

CREATE TABLE IF NOT EXISTS memory_fragments (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  content       TEXT NOT NULL,
  content_norm  TEXT NOT NULL,
  source_url    TEXT NOT NULL DEFAULT '',
  source_note   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',
  added_by      TEXT NOT NULL DEFAULT '',
  rating_count  INTEGER NOT NULL DEFAULT 0,
  rating_sum    INTEGER NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL DEFAULT unixepoch(),
  updated_at    BIGINT NOT NULL DEFAULT unixepoch()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_fragments_norm ON memory_fragments(content_norm);
CREATE INDEX IF NOT EXISTS idx_memory_fragments_status ON memory_fragments(status);
CREATE INDEX IF NOT EXISTS idx_memory_fragments_category ON memory_fragments(category);

CREATE TABLE IF NOT EXISTS chests (
  chest_id      TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_open_id TEXT NOT NULL,
  is_public     SMALLINT NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL DEFAULT unixepoch()
);
CREATE INDEX IF NOT EXISTS idx_chests_owner ON chests(owner_open_id);
`;

/** The `soul_tudigong` schema: per-soul operational tables, 30 tables, created in FK dependency order. */
export const BASELINE_SOUL_TUDIGONG_DDL = `
CREATE TABLE IF NOT EXISTS chats (
  chat_id         TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  chat_type       TEXT,
  chat_mode       TEXT,
  external        SMALLINT NOT NULL DEFAULT 0,
  tenant_key      TEXT,
  lark_profile    TEXT,
  first_seen      BIGINT NOT NULL DEFAULT unixepoch(),
  updated_at      BIGINT NOT NULL DEFAULT unixepoch(),
  dissolved_at    BIGINT,
  inactive_reason TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  message_id              TEXT PRIMARY KEY,
  chat_id                 TEXT NOT NULL REFERENCES chats(chat_id),
  sender_open_id          TEXT NOT NULL DEFAULT '',
  sender_id_type          TEXT,
  sender_type             TEXT,
  sender_tenant_key       TEXT,
  sender_name             TEXT NOT NULL DEFAULT '',
  msg_type                TEXT NOT NULL DEFAULT 'text',
  text                    TEXT NOT NULL DEFAULT '',
  mentions                TEXT NOT NULL DEFAULT '[]',
  thread_id               TEXT,
  thread_message_position INTEGER,
  message_position        INTEGER,
  create_time             BIGINT NOT NULL DEFAULT 0, -- Feishu unit: milliseconds, not seconds (kept as-is)
  updated                 SMALLINT NOT NULL DEFAULT 0,
  deleted                 SMALLINT NOT NULL DEFAULT 0,
  raw                     TEXT,
  collected_at            BIGINT NOT NULL DEFAULT unixepoch(),
  reply_to_id             TEXT,
  root_id                 TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, create_time DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_open_id, create_time DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender_time ON messages(sender_open_id, create_time DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, thread_message_position) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;
-- No messages_fts / trigram virtual table: full-text search is downgraded to ILIKE at the query layer.

CREATE TABLE IF NOT EXISTS activities (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type           TEXT NOT NULL,
  actor_open_id  TEXT,
  chat_id        TEXT,
  ref_message_id TEXT,
  payload        TEXT,
  created_at     BIGINT NOT NULL DEFAULT unixepoch()
);
CREATE INDEX IF NOT EXISTS idx_activities_actor ON activities(actor_open_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type, created_at);
CREATE INDEX IF NOT EXISTS idx_activities_actor_type ON activities(actor_open_id, type, created_at DESC);

CREATE TABLE IF NOT EXISTS errors (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  healed      SMALLINT NOT NULL DEFAULT 0,
  postmortem  TEXT,
  created_at  BIGINT NOT NULL DEFAULT unixepoch()
);
CREATE INDEX IF NOT EXISTS idx_errors_time ON errors(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_chat_time ON errors(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_kind_time ON errors(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS pending_replies (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  channel        TEXT NOT NULL,
  chat_id        TEXT NOT NULL,
  message_id     TEXT,
  session_key    TEXT NOT NULL DEFAULT '',
  sender_open_id TEXT,
  text           TEXT NOT NULL DEFAULT '',
  reaction_id    TEXT,
  pt_spent       NUMERIC(12,1) NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     BIGINT NOT NULL DEFAULT unixepoch()
);
CREATE INDEX IF NOT EXISTS idx_pending_agent ON pending_replies(agent_id, channel);

CREATE TABLE IF NOT EXISTS event_types (
  event_type_id  TEXT PRIMARY KEY,
  title          TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',
  scope          TEXT NOT NULL DEFAULT 'global',
  target_chat_id TEXT,
  base_image     TEXT,
  render_config  TEXT,
  enabled        SMALLINT NOT NULL DEFAULT 1,
  created_at     BIGINT NOT NULL DEFAULT unixepoch(),
  updated_at     BIGINT NOT NULL DEFAULT unixepoch()
);

CREATE TABLE IF NOT EXISTS event_dispatches (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  created_at     BIGINT NOT NULL DEFAULT unixepoch(),
  sent_at        BIGINT
);
CREATE INDEX IF NOT EXISTS idx_event_dispatches_type ON event_dispatches(event_type_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_dispatches_actor ON event_dispatches(actor_open_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_dispatches_status ON event_dispatches(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_dispatches_message ON event_dispatches(message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_reactions (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispatch_id     BIGINT NOT NULL,
  message_id      TEXT NOT NULL,
  reactor_open_id TEXT NOT NULL,
  emoji_type      TEXT NOT NULL,
  reacted_at      BIGINT NOT NULL DEFAULT unixepoch(),
  UNIQUE(dispatch_id, reactor_open_id, emoji_type)
);
CREATE INDEX IF NOT EXISTS idx_event_reactions_dispatch ON event_reactions(dispatch_id);

CREATE TABLE IF NOT EXISTS event_schedule_state (
  event_type_id TEXT PRIMARY KEY,
  last_eval_at  BIGINT,
  last_fire_at  BIGINT,
  last_outcome  TEXT,
  next_fire_at  BIGINT
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id    TEXT NOT NULL,
  open_id    TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  present    SMALLINT NOT NULL DEFAULT 1,
  first_seen BIGINT NOT NULL DEFAULT unixepoch(),
  last_seen  BIGINT NOT NULL DEFAULT unixepoch(),
  PRIMARY KEY (chat_id, open_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_open ON chat_members(open_id);

CREATE TABLE IF NOT EXISTS member_sync_rounds (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  synced_at         BIGINT NOT NULL,
  chat_count        INTEGER NOT NULL DEFAULT 0,
  present_total     INTEGER NOT NULL DEFAULT 0,
  joined_count      INTEGER NOT NULL DEFAULT 0,
  left_count        INTEGER NOT NULL DEFAULT 0,
  renamed_count     INTEGER NOT NULL DEFAULT 0,
  roster_total      INTEGER NOT NULL DEFAULT 0,
  joined_detail     TEXT NOT NULL DEFAULT '',
  left_detail       TEXT NOT NULL DEFAULT '',
  renamed_detail    TEXT NOT NULL DEFAULT '',
  source            TEXT NOT NULL DEFAULT 'live',
  created_at        BIGINT NOT NULL DEFAULT unixepoch(),
  present_distinct  INTEGER NOT NULL DEFAULT 0,
  present_internal  INTEGER NOT NULL DEFAULT 0,
  present_external  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_sync_rounds_at ON member_sync_rounds(synced_at);

CREATE TABLE IF NOT EXISTS calendar_event_rsvp_rounds (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  synced_at      BIGINT NOT NULL,
  event_id       TEXT NOT NULL,
  calendar_id    TEXT NOT NULL DEFAULT '',
  title          TEXT NOT NULL DEFAULT '',
  start_time     BIGINT NOT NULL DEFAULT 0,
  end_time       BIGINT NOT NULL DEFAULT 0,
  accepted       INTEGER NOT NULL DEFAULT 0,
  declined       INTEGER NOT NULL DEFAULT 0,
  tentative      INTEGER NOT NULL DEFAULT 0,
  needs_action   INTEGER NOT NULL DEFAULT 0,
  signup_total   INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT 'live',
  created_at     BIGINT NOT NULL DEFAULT unixepoch()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_event_rsvp_rounds_at_event ON calendar_event_rsvp_rounds(synced_at, event_id);
CREATE INDEX IF NOT EXISTS idx_calendar_event_rsvp_rounds_event ON calendar_event_rsvp_rounds(event_id, synced_at DESC);

CREATE TABLE IF NOT EXISTS doc_view_events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_token     TEXT NOT NULL,
  file_type      TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT '',
  space_id       TEXT NOT NULL DEFAULT '',
  title          TEXT NOT NULL DEFAULT '',
  viewer_id      TEXT NOT NULL,
  viewer_name    TEXT NOT NULL DEFAULT '',
  last_view_time BIGINT NOT NULL DEFAULT 0,
  recorded_at    BIGINT NOT NULL DEFAULT unixepoch()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_view_events_unique ON doc_view_events(file_token, viewer_id, last_view_time);
CREATE INDEX IF NOT EXISTS idx_doc_view_events_file ON doc_view_events(file_token, last_view_time DESC);
CREATE INDEX IF NOT EXISTS idx_doc_view_events_recorded ON doc_view_events(recorded_at DESC);

CREATE TABLE IF NOT EXISTS token_expiry_alerts (
  grant_key  TEXT NOT NULL,
  threshold  INTEGER NOT NULL,
  sent_at    BIGINT NOT NULL DEFAULT unixepoch(),
  PRIMARY KEY (grant_key, threshold)
);

CREATE TABLE IF NOT EXISTS memory_items (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  namespace   TEXT NOT NULL,
  key         TEXT,
  content     TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'private',
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  BIGINT NOT NULL DEFAULT unixepoch(),
  updated_at  BIGINT NOT NULL DEFAULT unixepoch(),
  expires_at  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_items(namespace, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_visibility ON memory_items(visibility, namespace);

CREATE TABLE IF NOT EXISTS chat_reactions (
  message_id      TEXT NOT NULL,
  chat_id         TEXT NOT NULL,
  reactor_open_id TEXT NOT NULL,
  emoji_type      TEXT NOT NULL,
  action_time     BIGINT NOT NULL DEFAULT 0,
  first_seen      BIGINT NOT NULL DEFAULT unixepoch(),
  PRIMARY KEY (message_id, reactor_open_id, emoji_type)
);
CREATE INDEX IF NOT EXISTS idx_chat_reactions_reactor ON chat_reactions(reactor_open_id);

CREATE TABLE IF NOT EXISTS pinned_messages (
  message_id    TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  reactor_count INTEGER NOT NULL DEFAULT 0,
  pinned_at     BIGINT NOT NULL DEFAULT unixepoch()
);

CREATE TABLE IF NOT EXISTS activity_meetups (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lark_event_id TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  recurrence    TEXT NOT NULL DEFAULT '',
  start_time    BIGINT NOT NULL DEFAULT 0,
  end_time      BIGINT NOT NULL DEFAULT 0,
  meetup_url    TEXT NOT NULL DEFAULT '',
  app_link      TEXT NOT NULL DEFAULT '',
  calendar_id   TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'confirmed',
  created_at    BIGINT NOT NULL DEFAULT unixepoch(),
  updated_at    BIGINT NOT NULL DEFAULT unixepoch(),
  share_link    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_activity_meetups_start ON activity_meetups(start_time);
CREATE INDEX IF NOT EXISTS idx_activity_meetups_status ON activity_meetups(status);

CREATE TABLE IF NOT EXISTS activity_meetup_tags (
  meetup_id BIGINT NOT NULL REFERENCES activity_meetups(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (meetup_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_activity_meetup_tags_tag ON activity_meetup_tags(tag);

CREATE TABLE IF NOT EXISTS meetup_subscriptions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_open_id TEXT NOT NULL,
  tag          TEXT NOT NULL,
  created_at   BIGINT NOT NULL DEFAULT unixepoch(),
  UNIQUE(user_open_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_meetup_subscriptions_tag ON meetup_subscriptions(tag);
CREATE INDEX IF NOT EXISTS idx_meetup_subscriptions_user ON meetup_subscriptions(user_open_id);

CREATE TABLE IF NOT EXISTS visitor_milestones (
  chat_id    TEXT NOT NULL,
  milestone  INTEGER NOT NULL,
  open_id    TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  reached_at BIGINT NOT NULL DEFAULT unixepoch(),
  PRIMARY KEY (chat_id, milestone)
);

CREATE TABLE IF NOT EXISTS like_maniac_weeks (
  week_start     BIGINT NOT NULL,
  open_id        TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  reaction_count INTEGER NOT NULL DEFAULT 0,
  reached_at     BIGINT NOT NULL DEFAULT unixepoch(),
  PRIMARY KEY (week_start, open_id)
);

CREATE TABLE IF NOT EXISTS tc_counter (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  next_num INTEGER NOT NULL DEFAULT 1
);
INSERT INTO tc_counter(id, next_num) VALUES (1, 1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tc_proposals (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  num             INTEGER NOT NULL UNIQUE,
  title           TEXT NOT NULL DEFAULT '',
  option_type     TEXT NOT NULL DEFAULT 'discrete',
  options         TEXT NOT NULL DEFAULT '[]',
  end_time        BIGINT NOT NULL,
  min_bet_lp      NUMERIC(12,4) NOT NULL DEFAULT 1.0,
  max_bet_lp      NUMERIC(12,4) NOT NULL DEFAULT 10.0,
  status          TEXT NOT NULL DEFAULT 'active',
  created_by      TEXT NOT NULL DEFAULT '',
  chat_id         TEXT NOT NULL DEFAULT '',
  top_message_id  TEXT NOT NULL DEFAULT '',
  thread_id       TEXT,
  settled_value   NUMERIC(12,4),
  settled_option  TEXT,
  settled_at      BIGINT,
  created_at      BIGINT NOT NULL DEFAULT unixepoch(),
  updated_at      BIGINT NOT NULL DEFAULT unixepoch()
);
CREATE INDEX IF NOT EXISTS idx_tc_proposals_num ON tc_proposals(num);
CREATE INDEX IF NOT EXISTS idx_tc_proposals_status ON tc_proposals(status);
CREATE INDEX IF NOT EXISTS idx_tc_proposals_end_time ON tc_proposals(end_time);
CREATE INDEX IF NOT EXISTS idx_tc_proposals_thread ON tc_proposals(thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tc_proposals_top_msg ON tc_proposals(top_message_id);

CREATE TABLE IF NOT EXISTS tc_bets (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id  BIGINT NOT NULL REFERENCES tc_proposals(id),
  user_open_id TEXT NOT NULL,
  option_value TEXT NOT NULL,
  lp_amount    NUMERIC(12,4) NOT NULL,
  message_id   TEXT NOT NULL DEFAULT '',
  is_refunded  SMALLINT NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL DEFAULT unixepoch()
);
CREATE INDEX IF NOT EXISTS idx_tc_bets_proposal ON tc_bets(proposal_id);
CREATE INDEX IF NOT EXISTS idx_tc_bets_user ON tc_bets(user_open_id, proposal_id);
CREATE INDEX IF NOT EXISTS idx_tc_bets_refund ON tc_bets(proposal_id, is_refunded);

CREATE TABLE IF NOT EXISTS pending_welcome (
  chat_id   TEXT NOT NULL,
  open_id   TEXT NOT NULL,
  name      TEXT NOT NULL DEFAULT '',
  queued_at BIGINT NOT NULL DEFAULT unixepoch(),
  PRIMARY KEY (chat_id, open_id)
);

CREATE TABLE IF NOT EXISTS predict_counter (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  next_num INTEGER NOT NULL DEFAULT 1
);
INSERT INTO predict_counter(id, next_num) VALUES (1, 1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS predict_proposals (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  num            INTEGER NOT NULL UNIQUE,
  title          TEXT NOT NULL DEFAULT '',
  option_type    TEXT NOT NULL DEFAULT 'discrete' CHECK (option_type = 'discrete'),
  options        TEXT NOT NULL DEFAULT '[]',
  end_time       BIGINT NOT NULL,
  min_bet_lp     NUMERIC(12,4) NOT NULL DEFAULT 1.0,
  max_bet_lp     NUMERIC(12,4) NOT NULL DEFAULT 10.0,
  status         TEXT NOT NULL DEFAULT 'active',
  created_by     TEXT NOT NULL DEFAULT '',
  chat_id        TEXT NOT NULL DEFAULT '',
  top_message_id TEXT NOT NULL DEFAULT '',
  announced_by   TEXT NOT NULL DEFAULT '',
  settled_option TEXT,
  settled_at     BIGINT,
  created_at     BIGINT NOT NULL DEFAULT unixepoch(),
  updated_at     BIGINT NOT NULL DEFAULT unixepoch()
);
CREATE INDEX IF NOT EXISTS idx_predict_proposals_num ON predict_proposals(num);
CREATE INDEX IF NOT EXISTS idx_predict_proposals_status ON predict_proposals(status);
CREATE INDEX IF NOT EXISTS idx_predict_proposals_chat ON predict_proposals(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_predict_proposals_top_msg ON predict_proposals(top_message_id);

CREATE TABLE IF NOT EXISTS predict_bets (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id  BIGINT NOT NULL REFERENCES predict_proposals(id),
  user_open_id TEXT NOT NULL,
  option_value TEXT NOT NULL,
  lp_amount    NUMERIC(12,4) NOT NULL,
  message_id   TEXT NOT NULL DEFAULT '',
  is_refunded  SMALLINT NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL DEFAULT unixepoch()
);
CREATE INDEX IF NOT EXISTS idx_predict_bets_proposal ON predict_bets(proposal_id);
CREATE INDEX IF NOT EXISTS idx_predict_bets_user ON predict_bets(user_open_id, proposal_id);
CREATE INDEX IF NOT EXISTS idx_predict_bets_refund ON predict_bets(proposal_id, is_refunded);

CREATE TABLE IF NOT EXISTS handled_messages (
  message_id TEXT PRIMARY KEY,
  handled_at BIGINT NOT NULL DEFAULT unixepoch()
);
`;

export interface PgMigration {
  version: number;
  description: string;
  sql: string;
}

export const SHARED_MIGRATIONS: PgMigration[] = [
  {
    version: 1,
    description: 'baseline (对应 SQLite shared.db schema_migrations v1-v39 最终形态)',
    sql: BASELINE_SHARED_DDL,
  },
];

export const SOUL_TUDIGONG_MIGRATIONS: PgMigration[] = [
  {
    version: 1,
    description: 'baseline (对应 SQLite tudigong.db schema_migrations v1-v39 最终形态，不含 profiles/pt_ledger/badges/user_badges 四张拆库前历史残留表)',
    sql: BASELINE_SOUL_TUDIGONG_DDL,
  },
];

/** Creates (or replaces) the shared unixepoch() helper function used by every DEFAULT clause above. */
export async function ensureUnixepochFunction(pool: Pool): Promise<void> {
  await pool.query(UNIXEPOCH_FUNCTION);
}

/**
 * Applies ordered, idempotent PostgreSQL migrations tracked in `<schema>.schema_migrations`.
 * `pool` must already be scoped to `schema` (its connection options set `search_path=<schema>`)
 * so the unqualified table names in each migration's SQL land in the right place.
 */
export async function runPgMigrations(pool: Pool, schema: string, migrations: PgMigration[]): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await ensureUnixepochFunction(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at BIGINT NOT NULL DEFAULT unixepoch()
    )
  `);
  const { rows } = await pool.query(`SELECT version FROM ${schema}.schema_migrations`);
  const applied = new Set<number>(rows.map((r: { version: number }) => r.version));
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    await pool.query(m.sql);
    await pool.query(
      `INSERT INTO ${schema}.schema_migrations(version, description) VALUES ($1, $2)`,
      [m.version, m.description],
    );
  }
}
