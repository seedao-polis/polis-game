// ETL: .agent/shared.db (SQLite) → PostgreSQL feishu_biz.shared schema.
// Run once at the Phase 2 cutover: node --env-file=.env scripts/etl-shared-to-pg.mjs
// Idempotent (ON CONFLICT DO NOTHING per row) — safe to re-run if interrupted, though a clean run
// against an empty `shared` schema is the expected case. Prints row counts per table, then runs the
// verification queries (row-count parity, a 20-row pt_ledger sample, and the exact SUM(delta) /
// SUM(pt_balance) parity check) before exiting non-zero on any mismatch.
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

// AGENT_PG_SHARED_SCHEMA overrides the target schema (default 'shared') — used to dry-run this
// script against a disposable schema without touching the real production target.
const SCHEMA = process.env.AGENT_PG_SHARED_SCHEMA || 'shared';
const sharedDbPath = process.env.SHARED_DB_PATH || path.join(REPO_ROOT, '.agent', 'shared.db');
const sqlite = new DatabaseSync(sharedDbPath, { readOnly: true });
const pool = new pg.Pool({ connectionString: resolvePgConnectionString(url), options: `-c search_path=${SCHEMA}` });

// Parent tables before children (FK order): badges/profiles have no dependencies; pt_ledger/checkins/
// user_badges reference profiles (and badges); the rest are independent.
const TABLES = [
  { name: 'badges', cols: ['badge_id', 'name', 'description', 'emoji', 'headline', 'file', 'title', 'type', 'role', 'endorser', 'duration', 'category', 'event', 'created_at'] },
  { name: 'profiles', cols: ['open_id', 'name', 'pt_balance', 'level', 'first_seen', 'last_seen'],
    cast: { pt_balance: (v) => Number(v) } },
  { name: 'pt_ledger', cols: ['id', 'user_open_id', 'delta', 'reason', 'ref_message_id', 'created_at'],
    cast: { delta: (v) => Number(v) } },
  { name: 'checkins', cols: ['id', 'user_open_id', 'checkin_date', 'pt_awarded', 'created_at'],
    cast: { pt_awarded: (v) => Number(v) } },
  { name: 'user_badges', cols: ['user_open_id', 'badge_id', 'awarded_at', 'ref', 'awarded_by', 'note'] },
  { name: 'identity_links', cols: ['open_id', 'canonical_id', 'created_at'] },
  { name: 'name_overrides', cols: ['open_id', 'name', 'updated_at'] },
  { name: 'memory_fragments', cols: ['id', 'content', 'content_norm', 'source_url', 'source_note', 'category', 'status', 'added_by', 'rating_count', 'rating_sum', 'created_at', 'updated_at'] },
  { name: 'chests', cols: ['chest_id', 'name', 'owner_open_id', 'is_public', 'created_at'] },
];

async function runEtl() {
  for (const t of TABLES) {
    const rows = sqlite.prepare(`SELECT ${t.cols.join(',')} FROM ${t.name}`).all();
    let imported = 0;
    // Tables carrying over an explicit `id` (pt_ledger/checkins/memory_fragments) target a
    // GENERATED ALWAYS AS IDENTITY column, which rejects an explicit id value unless the INSERT
    // says OVERRIDING SYSTEM VALUE — required here so the original ids (and everything that
    // references them, e.g. ref_message_id lookups) survive the migration unchanged.
    const overriding = t.cols.includes('id') ? ' OVERRIDING SYSTEM VALUE' : '';
    for (const row of rows) {
      const values = t.cols.map((c) => (t.cast?.[c] ? t.cast[c](row[c]) : row[c]));
      const placeholders = t.cols.map((_, i) => `$${i + 1}`).join(',');
      const res = await pool.query(
        `INSERT INTO ${t.name}(${t.cols.join(',')})${overriding} VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        values,
      );
      imported += res.rowCount ?? 0;
    }
    console.log(`${t.name}: ${rows.length} rows in SQLite, ${imported} newly inserted into PostgreSQL`);
  }

  // Reset auto-increment sequences for tables with a BIGINT GENERATED ALWAYS AS IDENTITY id column
  // that was populated with explicit ids above (otherwise the next INSERT without an explicit id
  // would collide with the highest imported id).
  for (const t of ['pt_ledger', 'checkins', 'memory_fragments']) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1), (SELECT MAX(id) FROM ${t}) IS NOT NULL)`,
    );
  }
  console.log('sequences reset for: pt_ledger, checkins, memory_fragments');
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

  // 2) Sample 20 pt_ledger rows by id, compare every column.
  const sampleIds = sqlite.prepare('SELECT id FROM pt_ledger ORDER BY RANDOM() LIMIT 20').all().map((r) => r.id);
  let sampleMismatches = 0;
  for (const id of sampleIds) {
    const sRow = sqlite.prepare('SELECT id, user_open_id, delta, reason, ref_message_id, created_at FROM pt_ledger WHERE id = ?').get(id);
    const pRes = await pool.query('SELECT id, user_open_id, delta, reason, ref_message_id, created_at FROM pt_ledger WHERE id = $1', [id]);
    const pRow = pRes.rows[0];
    if (!pRow) { sampleMismatches++; console.log(`FAIL sample pt_ledger id=${id}: missing in PostgreSQL`); continue; }
    const sDelta = Number(sRow.delta).toFixed(1);
    const pDelta = Number(pRow.delta).toFixed(1);
    if (sDelta !== pDelta || sRow.user_open_id !== pRow.user_open_id || sRow.reason !== pRow.reason) {
      sampleMismatches++;
      console.log(`FAIL sample pt_ledger id=${id}: sqlite=${JSON.stringify(sRow)} pg=${JSON.stringify(pRow)}`);
    }
  }
  if (sampleMismatches > 0) ok = false;
  console.log(`${sampleMismatches === 0 ? 'OK  ' : 'FAIL'} pt_ledger 20-row sample: ${sampleMismatches} mismatches`);

  // 3) Money parity: SUM(delta) in pt_ledger must equal SUM(pt_balance) in profiles on BOTH sides,
  // and both sides must equal each other — compared as toFixed(1) strings to sidestep SQLite REAL
  // (binary float) vs PostgreSQL NUMERIC (exact decimal) representation differences at the margins.
  const sqliteLedgerSum = sqlite.prepare('SELECT SUM(delta) AS s FROM pt_ledger').get().s;
  const sqliteProfileSum = sqlite.prepare('SELECT SUM(pt_balance) AS s FROM profiles').get().s;
  const pgLedgerSum = (await pool.query('SELECT SUM(delta)::numeric AS s FROM pt_ledger')).rows[0].s;
  const pgProfileSum = (await pool.query('SELECT SUM(pt_balance)::numeric AS s FROM profiles')).rows[0].s;
  const fmt = (v) => Number(v).toFixed(1);
  console.log(`SQLite  pt_ledger SUM(delta)=${fmt(sqliteLedgerSum)}  profiles SUM(pt_balance)=${fmt(sqliteProfileSum)}`);
  console.log(`Postgres pt_ledger SUM(delta)=${fmt(pgLedgerSum)}  profiles SUM(pt_balance)=${fmt(pgProfileSum)}`);
  const moneyOk =
    fmt(sqliteLedgerSum) === fmt(sqliteProfileSum) &&
    fmt(pgLedgerSum) === fmt(pgProfileSum) &&
    fmt(sqliteLedgerSum) === fmt(pgLedgerSum);
  if (!moneyOk) ok = false;
  console.log(`${moneyOk ? 'OK  ' : 'FAIL'} money parity (sqlite ledger == sqlite profiles == pg ledger == pg profiles)`);

  // 4) schema_migrations sanity.
  const migRes = await pool.query(`SELECT version FROM ${SCHEMA}.schema_migrations ORDER BY version`);
  const versions = migRes.rows.map((r) => r.version);
  console.log(`shared.schema_migrations versions: ${JSON.stringify(versions)}`);
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
