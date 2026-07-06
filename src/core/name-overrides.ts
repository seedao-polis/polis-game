import fs from 'node:fs';
import path from 'node:path';
import { CONFIGS_DIR } from './paths.js';

// ── Preferred display-name overrides ───────────────────────────
// A pure display layer keyed by open_id. Feishu hands us each person's own display name (e.g. "李"),
// which we capture faithfully into the DB; but some members ask to be addressed by a different name
// (e.g. Fivea). This maps open_id → preferred name at render time, so the raw captured record stays
// truthful while every user-facing surface (LP footer, the agent's identity context, member reports)
// shows the requested name. Backed by configs/name-overrides.json (falls back to the committed
// .example when absent), parsed once per process.

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

/** The operator-preferred display name for an open_id, or undefined when none is configured. */
export function preferredName(openId: string): string | undefined {
  if (!openId) return undefined;
  const v = load()[openId];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
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
