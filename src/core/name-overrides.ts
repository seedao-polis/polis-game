import fs from 'node:fs';
import path from 'node:path';
import { CONFIGS_DIR } from './paths.js';
import { getLpDb } from './db.js';

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
function selfServiceName(openId: string): string | undefined {
  try {
    const row = getLpDb()
      .prepare('SELECT name FROM name_overrides WHERE open_id = ?')
      .get(openId) as { name?: string } | undefined;
    const v = row?.name;
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The preferred display name for an open_id, or undefined when none is set. Operator config takes
 * precedence over the member's own self-service rename.
 */
export function preferredName(openId: string): string | undefined {
  if (!openId) return undefined;
  return configOverride(openId) ?? selfServiceName(openId);
}

/**
 * Apply the preferred-name override to a raw display name: returns the configured override when one
 * exists for this open_id, otherwise the raw name unchanged. Safe to call with an empty raw name
 * (an override still wins).
 */
export function applyNameOverride(openId: string, rawName: string): string {
  return preferredName(openId) ?? rawName;
}

/** Test-only: clear the memoized map so a freshly written config is picked up. */
export function _resetNameOverridesCache(): void {
  _cache = null;
}
