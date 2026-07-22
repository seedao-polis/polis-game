// One-time smoke test against the remote feishu_biz PostgreSQL server: creates a throwaway schema,
// applies the baseline DDL, runs one insert/select round-trip, then drops the schema. Not part of
// the pnpm test suite — run manually with `node --env-file=.env scripts/smoke-test-pg.mjs` before
// the real Phase 2/3 cutover, to confirm connectivity/permissions without touching `shared` or
// `soul_tudigong`.
import pg from 'pg';

const url = process.env.AGENT_PG_URL;
if (!url) {
  console.error('AGENT_PG_URL not set (use --env-file=.env)');
  process.exit(1);
}

// The target server does not speak SSL at all: pg-connection-string >=2.14 treats
// sslmode=prefer/require/verify-ca as aliases for verify-full and unconditionally attempts a TLS
// handshake, which this particular server rejects outright ("The server does not support SSL
// connections") instead of falling back to plaintext the way libpq's real `prefer` semantics would.
// AGENT_PG_URL in .env intentionally keeps the user-supplied sslmode=prefer for documentation
// purposes; every actual pg.Pool/Client construction strips it so the driver connects in plaintext.
function resolvePgConnectionString(raw) {
  const u = new URL(raw);
  u.searchParams.delete('sslmode');
  return u.toString();
}

const schema = `smoke_shared_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
const pool = new pg.Pool({ connectionString: resolvePgConnectionString(url), options: `-c search_path=${schema}` });

try {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await pool.query(`
    CREATE OR REPLACE FUNCTION unixepoch() RETURNS bigint AS $$
      SELECT extract(epoch FROM now())::bigint
    $$ LANGUAGE sql STABLE;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS smoke_probe (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      note TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT unixepoch()
    )
  `);
  const inserted = await pool.query(
    `INSERT INTO smoke_probe(note) VALUES ($1) RETURNING id, note, created_at`,
    ['pg migration smoke test'],
  );
  console.log('insert round-trip:', inserted.rows[0]);
  const selected = await pool.query('SELECT COUNT(*)::int AS n FROM smoke_probe');
  console.log('select round-trip: count =', selected.rows[0].n);
  console.log('smoke test OK, schema:', schema);
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  console.log('dropped schema:', schema);
  await pool.end();
}
