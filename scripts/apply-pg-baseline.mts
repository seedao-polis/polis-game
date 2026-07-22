// One-time Phase 0 preparation: creates the `shared` and `soul_tudigong` schemas in the real
// feishu_biz PostgreSQL database and applies the baseline DDL (version 1 in each schema's own
// schema_migrations table). Idempotent (CREATE TABLE IF NOT EXISTS + version-tracked), safe to
// re-run. Run with: node --env-file=.env --import tsx scripts/apply-pg-baseline.mts
import pg from 'pg';
import { SHARED_MIGRATIONS, SOUL_TUDIGONG_MIGRATIONS, runPgMigrations } from '../src/core/db-pg-schema.ts';

const url = process.env.AGENT_PG_URL;
if (!url) {
  console.error('AGENT_PG_URL not set (use --env-file=.env)');
  process.exit(1);
}

// See resolvePgConnectionString in scripts/smoke-test-pg.mjs: the target server does not speak
// SSL, and pg-connection-string's sslmode=prefer no longer falls back to plaintext, so it must be
// stripped before constructing any pg.Pool/Client against this server.
function resolvePgConnectionString(raw: string): string {
  const u = new URL(raw);
  u.searchParams.delete('sslmode');
  return u.toString();
}

async function applySchema(schema: string, migrations: typeof SHARED_MIGRATIONS): Promise<void> {
  const pool = new pg.Pool({
    connectionString: resolvePgConnectionString(url as string),
    options: `-c search_path=${schema}`,
  });
  try {
    await runPgMigrations(pool, schema, migrations);
    console.log(`applied baseline DDL to schema "${schema}"`);
  } finally {
    await pool.end();
  }
}

await applySchema('shared', SHARED_MIGRATIONS);
await applySchema('soul_tudigong', SOUL_TUDIGONG_MIGRATIONS);
console.log('done.');
