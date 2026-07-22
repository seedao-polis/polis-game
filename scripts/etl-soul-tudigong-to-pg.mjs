// ETL: .agent/tudigong.db (SQLite) → PostgreSQL feishu_biz.soul_tudigong schema.
// Run once at the Phase 3 cutover: node --env-file=.env scripts/etl-soul-tudigong-to-pg.mjs
// Idempotent (ON CONFLICT DO NOTHING per row, keyed on each table's own PK) — safe to re-run if
// interrupted, though a clean run against an empty `soul_tudigong` schema is the expected case. Prints
// row counts per table, then runs the verification queries (row-count parity, a 20-row messages
// sample, and tc_counter/predict_counter sequence-number sanity) before exiting non-zero on mismatch.
//
// Explicitly EXCLUDES badges/profiles/pt_ledger/user_badges: these are pre-split leftovers in
// tudigong.db (the LP economy moved to shared.db before this migration; only 4 tables carry residual
// rows there, the rest of the "shared-shaped" tables present in tudigong.db — checkins/chests/
// identity_links/name_overrides/memory_fragments — are always-empty shadow tables created by the same
// schema-migration runner running unconditionally against every soul db file, never written to).
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const url = process.env.AGENT_PG_URL;
if (!url) {
  console.error('AGENT_PG_URL not set (use --env-file=.env)');
  process.exit(1);
}

// See src/core/db.ts's resolvePgConnectionString: the target server does not speak SSL, and
// pg-connection-string's sslmode=prefer no longer falls back to plaintext, so it must be stripped.
function resolvePgConnectionString(raw) {
  const u = new URL(raw);
  u.searchParams.delete('sslmode');
  return u.toString();
}

// Rows per multi-row INSERT statement. The widest table here has 20 columns, so 500 rows/batch stays
// far under PostgreSQL's per-query parameter ceiling while cutting round trips by ~500x versus a
// one-row-per-query loop.
const BATCH_SIZE = 500;

// AGENT_PG_SOUL_SCHEMA overrides the target schema (default 'soul_tudigong') — used to dry-run this
// script against a disposable schema without touching the real production target.
const SCHEMA = process.env.AGENT_PG_SOUL_SCHEMA || 'soul_tudigong';
const soulDbPath = process.env.SOUL_DB_PATH || path.join(REPO_ROOT, '.agent', 'tudigong.db');
const sqlite = new DatabaseSync(soulDbPath, { readOnly: true });
const pool = new pg.Pool({ connectionString: resolvePgConnectionString(url), options: `-c search_path=${SCHEMA}` });

// FK-parent-first order (mirrors db-pg-schema.ts's BASELINE_SOUL_TUDIGONG_DDL creation order).
// `identity: true` marks a BIGINT GENERATED ALWAYS AS IDENTITY primary key (needs OVERRIDING SYSTEM
// VALUE to carry the original id, and its sequence reset afterwards so future inserts don't collide).
// `conflict` overrides the default `ON CONFLICT DO NOTHING` when a row must be reconciled instead of
// skipped (tc_counter/predict_counter: their single fixed row is seeded by the baseline DDL itself and
// must be updated to the live next_num, not left at the seeded default of 1).
const TABLES = [
  { name: 'chats', cols: ['chat_id', 'name', 'chat_type', 'chat_mode', 'external', 'tenant_key', 'lark_profile', 'first_seen', 'updated_at', 'dissolved_at', 'inactive_reason'] },
  { name: 'messages', cols: ['message_id', 'chat_id', 'sender_open_id', 'sender_id_type', 'sender_type', 'sender_tenant_key', 'sender_name', 'msg_type', 'text', 'mentions', 'thread_id', 'thread_message_position', 'message_position', 'create_time', 'updated', 'deleted', 'raw', 'collected_at', 'reply_to_id', 'root_id'] },
  { name: 'activities', identity: true, cols: ['id', 'type', 'actor_open_id', 'chat_id', 'ref_message_id', 'payload', 'created_at'] },
  { name: 'errors', identity: true, cols: ['id', 'corr_id', 'soul', 'chat_id', 'source', 'kind', 'summary', 'exit_code', 'signal', 'duration_ms', 'attempt', 'healed', 'postmortem', 'created_at'] },
  { name: 'pending_replies', identity: true, cols: ['id', 'agent_id', 'channel', 'chat_id', 'message_id', 'session_key', 'sender_open_id', 'text', 'reaction_id', 'pt_spent', 'attempts', 'created_at'], cast: { pt_spent: (v) => Number(v) } },
  { name: 'event_types', cols: ['event_type_id', 'title', 'description', 'scope', 'target_chat_id', 'base_image', 'render_config', 'enabled', 'created_at', 'updated_at'] },
  { name: 'event_dispatches', identity: true, cols: ['id', 'event_type_id', 'trigger_reason', 'scope', 'actor_open_id', 'target', 'rendered_image', 'payload', 'status', 'message_id', 'error_msg', 'created_at', 'sent_at'] },
  { name: 'event_reactions', identity: true, cols: ['id', 'dispatch_id', 'message_id', 'reactor_open_id', 'emoji_type', 'reacted_at'] },
  { name: 'event_schedule_state', cols: ['event_type_id', 'last_eval_at', 'last_fire_at', 'last_outcome', 'next_fire_at'] },
  { name: 'chat_members', cols: ['chat_id', 'open_id', 'name', 'present', 'first_seen', 'last_seen'] },
  { name: 'member_sync_rounds', identity: true, cols: ['id', 'synced_at', 'chat_count', 'present_total', 'joined_count', 'left_count', 'renamed_count', 'roster_total', 'joined_detail', 'left_detail', 'renamed_detail', 'source', 'created_at', 'present_distinct', 'present_internal', 'present_external'] },
  { name: 'calendar_event_rsvp_rounds', identity: true, cols: ['id', 'synced_at', 'event_id', 'calendar_id', 'title', 'start_time', 'end_time', 'accepted', 'declined', 'tentative', 'needs_action', 'signup_total', 'source', 'created_at'] },
  { name: 'doc_view_events', identity: true, cols: ['id', 'file_token', 'file_type', 'source', 'space_id', 'title', 'viewer_id', 'viewer_name', 'last_view_time', 'recorded_at'] },
  { name: 'token_expiry_alerts', cols: ['grant_key', 'threshold', 'sent_at'] },
  { name: 'memory_items', identity: true, cols: ['id', 'namespace', 'key', 'content', 'visibility', 'sensitivity', 'source', 'created_at', 'updated_at', 'expires_at'] },
  { name: 'chat_reactions', cols: ['message_id', 'chat_id', 'reactor_open_id', 'emoji_type', 'action_time', 'first_seen'] },
  { name: 'pinned_messages', cols: ['message_id', 'chat_id', 'reactor_count', 'pinned_at'] },
  { name: 'activity_meetups', identity: true, cols: ['id', 'lark_event_id', 'title', 'description', 'recurrence', 'start_time', 'end_time', 'meetup_url', 'app_link', 'calendar_id', 'created_by', 'status', 'created_at', 'updated_at', 'share_link'] },
  { name: 'activity_meetup_tags', cols: ['meetup_id', 'tag'] },
  { name: 'meetup_subscriptions', identity: true, cols: ['id', 'user_open_id', 'tag', 'created_at'] },
  { name: 'visitor_milestones', cols: ['chat_id', 'milestone', 'open_id', 'name', 'reached_at'] },
  { name: 'like_maniac_weeks', cols: ['week_start', 'open_id', 'name', 'reaction_count', 'reached_at'] },
  { name: 'tc_counter', cols: ['id', 'next_num'], conflict: 'ON CONFLICT (id) DO UPDATE SET next_num = excluded.next_num' },
  { name: 'tc_proposals', identity: true, cols: ['id', 'num', 'title', 'option_type', 'options', 'end_time', 'min_bet_lp', 'max_bet_lp', 'status', 'created_by', 'chat_id', 'top_message_id', 'thread_id', 'settled_value', 'settled_option', 'settled_at', 'created_at', 'updated_at'], cast: { min_bet_lp: (v) => Number(v), max_bet_lp: (v) => Number(v), settled_value: (v) => (v === null ? null : Number(v)) } },
  { name: 'tc_bets', identity: true, cols: ['id', 'proposal_id', 'user_open_id', 'option_value', 'lp_amount', 'message_id', 'is_refunded', 'created_at'], cast: { lp_amount: (v) => Number(v) } },
  { name: 'pending_welcome', cols: ['chat_id', 'open_id', 'name', 'queued_at'] },
  { name: 'predict_counter', cols: ['id', 'next_num'], conflict: 'ON CONFLICT (id) DO UPDATE SET next_num = excluded.next_num' },
  { name: 'predict_proposals', identity: true, cols: ['id', 'num', 'title', 'option_type', 'options', 'end_time', 'min_bet_lp', 'max_bet_lp', 'status', 'created_by', 'chat_id', 'top_message_id', 'announced_by', 'settled_option', 'settled_at', 'created_at', 'updated_at'], cast: { min_bet_lp: (v) => Number(v), max_bet_lp: (v) => Number(v) } },
  { name: 'predict_bets', identity: true, cols: ['id', 'proposal_id', 'user_open_id', 'option_value', 'lp_amount', 'message_id', 'is_refunded', 'created_at'], cast: { lp_amount: (v) => Number(v) } },
  { name: 'handled_messages', cols: ['message_id', 'handled_at'] },
];

async function runEtl() {
  for (const t of TABLES) {
    const rows = sqlite.prepare(`SELECT ${t.cols.join(',')} FROM ${t.name}`).all();
    let imported = 0;
    const overriding = t.identity ? ' OVERRIDING SYSTEM VALUE' : '';
    const conflict = t.conflict ?? 'ON CONFLICT DO NOTHING';
    // Batched multi-row INSERT: the largest tables here run to several thousand rows (e.g.
    // calendar_event_rsvp_rounds), and one round trip per row against a remote server would turn the
    // cutover's stop-the-world window into tens of minutes. BATCH_SIZE keeps each statement's
    // parameter count (batch size × column count) comfortably under PostgreSQL's per-query limit.
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const valueGroups = [];
      const params = [];
      let p = 1;
      for (const row of batch) {
        const values = t.cols.map((c) => (t.cast?.[c] ? t.cast[c](row[c]) : row[c]));
        valueGroups.push(`(${values.map(() => `$${p++}`).join(',')})`);
        params.push(...values);
      }
      const res = await pool.query(
        `INSERT INTO ${t.name}(${t.cols.join(',')})${overriding} VALUES ${valueGroups.join(',')} ${conflict}`,
        params,
      );
      imported += res.rowCount ?? 0;
    }
    console.log(`${t.name}: ${rows.length} rows in SQLite, ${imported} newly inserted/updated into PostgreSQL`);
  }

  // Reset auto-increment sequences for every identity table populated with explicit ids above
  // (otherwise the next INSERT without an explicit id would collide with the highest imported id).
  const identityTables = TABLES.filter((t) => t.identity).map((t) => t.name);
  for (const t of identityTables) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1), (SELECT MAX(id) FROM ${t}) IS NOT NULL)`,
    );
  }
  console.log(`sequences reset for: ${identityTables.join(', ')}`);
}

async function verify() {
  let ok = true;

  // 1) Row-count parity per table.
  for (const t of TABLES) {
    const sqliteCount = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get().n;
    const pgCount = (await pool.query(`SELECT COUNT(*)::int AS n FROM ${t.name}`)).rows[0].n;
    const match = sqliteCount === pgCount;
    if (!match) ok = false;
    console.log(`${match ? 'OK  ' : 'FAIL'} row count ${t.name}: sqlite=${sqliteCount} pg=${pgCount}`);
  }

  // 2) Sample 20 messages rows by message_id, compare the columns most exposed to type drift.
  const sampleIds = sqlite.prepare('SELECT message_id FROM messages ORDER BY RANDOM() LIMIT 20').all().map((r) => r.message_id);
  let sampleMismatches = 0;
  for (const id of sampleIds) {
    const sRow = sqlite.prepare('SELECT message_id, chat_id, sender_open_id, text, create_time FROM messages WHERE message_id = ?').get(id);
    const pRes = await pool.query('SELECT message_id, chat_id, sender_open_id, text, create_time FROM messages WHERE message_id = $1', [id]);
    const pRow = pRes.rows[0];
    if (!pRow) { sampleMismatches++; console.log(`FAIL sample messages message_id=${id}: missing in PostgreSQL`); continue; }
    if (Number(sRow.create_time) !== Number(pRow.create_time) || sRow.chat_id !== pRow.chat_id || sRow.text !== pRow.text) {
      sampleMismatches++;
      console.log(`FAIL sample messages message_id=${id}: sqlite=${JSON.stringify(sRow)} pg=${JSON.stringify(pRow)}`);
    }
  }
  if (sampleMismatches > 0) ok = false;
  console.log(`${sampleMismatches === 0 ? 'OK  ' : 'FAIL'} messages 20-row sample: ${sampleMismatches} mismatches`);

  // 3) tc_counter/predict_counter next_num must exceed the highest imported num (never reissue a
  // number already used by a settled/active proposal).
  for (const [counter, proposals] of [['tc_counter', 'tc_proposals'], ['predict_counter', 'predict_proposals']]) {
    const nextNum = (await pool.query(`SELECT next_num FROM ${counter} WHERE id = 1`)).rows[0]?.next_num;
    const maxNumRow = await pool.query(`SELECT COALESCE(MAX(num), 0)::int AS m FROM ${proposals}`);
    const maxNum = maxNumRow.rows[0].m;
    const match = nextNum !== undefined && nextNum > maxNum;
    if (!match) ok = false;
    console.log(`${match ? 'OK  ' : 'FAIL'} ${counter}.next_num=${nextNum} > max(${proposals}.num)=${maxNum}`);
  }

  // 4) schema_migrations sanity.
  const migRes = await pool.query(`SELECT version FROM ${SCHEMA}.schema_migrations ORDER BY version`);
  const versions = migRes.rows.map((r) => r.version);
  console.log(`soul_tudigong.schema_migrations versions: ${JSON.stringify(versions)}`);
  if (versions.length !== 1 || versions[0] !== 1) ok = false;

  return ok;
}

try {
  await runEtl();
  console.log('\n--- verification ---');
  const ok = await verify();
  if (!ok) {
    console.error('\nETL verification FAILED — see FAIL lines above. Do not proceed with cutover.');
    process.exit(1);
  }
  console.log('\nETL verification passed.');
} finally {
  sqlite.close();
  await pool.end();
}
