import fs from 'node:fs';
import path from 'node:path';
import { CONFIGS_DIR } from './paths.js';
import { getLpDb, type SqlExecutor } from './db.js';

// ── Preferred display-name overrides ───────────────────────────
// A pure display layer keyed by open_id. Feishu hands us each person's own display name (e.g. "李"),
// which we capture faithfully into the DB; but some members ask to be addressed by a different name
// (e.g. Fivea). This maps open_id → preferred name at render time, so the raw captured record stays
// truthful while every user-facing surface (LP footer, the agent's identity context, member reports)
// shows the requested name. Two layers, in precedence order:
//   1. Operator-curated configs/name-overrides.json (falls back to the committed .example), parsed once.
//   2. A member's own self-service rename (the "@我 改名 <名字>" command), stored in the shared
//      name_overrides table and read live so a rename in one process is visible everywhere at once.
// The operator config wins so a deliberate operator directive can't be undone by a self-rename.

interface NameOverridesFile {
  version?: number;
  /** open_id → preferred display name */
  overrides?: Record<string, string>;
}

let _cache: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (_cache) return _cache;
  const file = path.join(CONFIGS_DIR, 'name-overrides.json');
  const resolved = fs.existsSync(file) ? file : `${file}.example`;
  try {
    if (fs.existsSync(resolved)) {
      const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as NameOverridesFile;
      _cache = parsed.overrides ?? {};
    } else {
      _cache = {};
    }
  } catch {
    _cache = {};
  }
  return _cache;
}

/** The operator-curated (configs/name-overrides.json) preferred name for an open_id, if any. */
function configOverride(openId: string): string | undefined {
  const v = load()[openId];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * A member's own self-service rename from the shared name_overrides table (set via the 改名 command).
 * Read live (uncached) so a rename made in one process is immediately visible in every other process;
 * best-effort — any DB error (table absent, db unavailable) resolves to "no self-service override".
 */
async function selfServiceName(openId: string): Promise<string | undefined> {
  try {
    const db = await getLpDb();
    const { rows } = await db.query<{ name?: string }>('SELECT name FROM name_overrides WHERE open_id = $1', [openId]);
    const v = rows[0]?.name;
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Batch-load the entire self-service name_overrides table into a Map, for callers that would
 * otherwise resolve one open_id at a time in a loop (e.g. leaderboard()) — see the migration plan's
 * N+1 note: over a network-backed PostgreSQL connection, resolving up to 100 rows individually would
 * turn one query into up to 100 extra round-trips. The table is small (a handful of rows in practice),
 * so a full scan is cheap. Best-effort: any DB error resolves to an empty map (no overrides applied).
 */
export async function loadSelfServiceOverrides(db: SqlExecutor): Promise<Map<string, string>> {
  try {
    const { rows } = await db.query<{ open_id: string; name: string }>('SELECT open_id, name FROM name_overrides');
    return new Map(rows.map((r) => [r.open_id, r.name]));
  } catch {
    return new Map();
  }
}

/**
 * The preferred display name for an open_id, or undefined when none is set. Operator config takes
 * precedence over the member's own self-service rename. `preloaded`, when given, is consulted
 * instead of a live per-call query (see {@link loadSelfServiceOverrides}).
 */
export async function preferredName(openId: string, preloaded?: Map<string, string>): Promise<string | undefined> {
  if (!openId) return undefined;
  const configName = configOverride(openId);
  if (configName) return configName;
  if (preloaded) {
    const v = preloaded.get(openId);
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  }
  return selfServiceName(openId);
}

/**
 * Apply the preferred-name override to a raw display name: returns the configured override when one
 * exists for this open_id, otherwise the raw name unchanged. Safe to call with an empty raw name
 * (an override still wins). `preloaded`, when given, avoids a live per-call self-service lookup.
 */
export async function applyNameOverride(openId: string, rawName: string, preloaded?: Map<string, string>): Promise<string> {
  return (await preferredName(openId, preloaded)) ?? rawName;
}

/** Test-only: clear the memoized map so a freshly written config is picked up. */
export function _resetNameOverridesCache(): void {
  _cache = null;
}
