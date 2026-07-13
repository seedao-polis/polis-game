import { getLpDb, lpTx } from '../db.js';

// Data-access layer for the SeeDAO history "memory fragment" store (memory_fragments, v32).
// All reads and writes go through the shared LP database (getLpDb/lpTx) so the fragment pool is a
// single cross-agent, cross-module community asset rather than per-soul state. No network calls and no
// Feishu side effects live here — an autonomous /goal loop can ingest Notion history purely through
// these functions and the `fragment` CLI without ever touching the outbound send path.

// ── Type definitions ──────────────────────────────────────────

export type FragmentStatus = 'active' | 'archived';

export interface MemoryFragment {
  id: number;
  content: string;
  contentNorm: string;
  sourceUrl: string;
  sourceNote: string;
  category: string;
  status: FragmentStatus;
  addedBy: string;
  ratingCount: number;
  ratingSum: number;
  createdAt: number;
  updatedAt: number;
}

export interface FragmentInput {
  content: string;
  sourceUrl?: string;
  sourceNote?: string;
  category?: string;
  addedBy?: string;
}

export interface ListFragmentsOpts {
  limit?: number;
  offset?: number;
  status?: FragmentStatus;
  category?: string;
}

// ── Normalization ─────────────────────────────────────────────

/**
 * Build the dedup key: strip whitespace / punctuation / symbols and lowercase.
 * Two fragments differing only in spacing or punctuation collapse to the same key, so the
 * content_norm UNIQUE index rejects them. It cannot catch semantic duplicates (different wording,
 * same fact) — that filtering happens at the harvest/review layer.
 */
export function normalizeFragment(text: string): string {
  return text.trim().toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

// ── Row → typed object converter ──────────────────────────────

function rowToFragment(row: Record<string, unknown>): MemoryFragment {
  return {
    id: Number(row['id']),
    content: String(row['content'] ?? ''),
    contentNorm: String(row['content_norm'] ?? ''),
    sourceUrl: String(row['source_url'] ?? ''),
    sourceNote: String(row['source_note'] ?? ''),
    category: String(row['category'] ?? ''),
    status: String(row['status'] ?? 'active') as FragmentStatus,
    addedBy: String(row['added_by'] ?? ''),
    ratingCount: Number(row['rating_count'] ?? 0),
    ratingSum: Number(row['rating_sum'] ?? 0),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
}

// ── Writes ────────────────────────────────────────────────────

/**
 * Insert a fragment, deduped by normalized content via INSERT OR IGNORE on the content_norm
 * UNIQUE index. Returns whether a new row was written (false when an equivalent fragment already
 * exists) plus the row id (the existing row's id on a dedup hit).
 */
export function insertFragment(input: FragmentInput): { inserted: boolean; id: number } {
  const content = input.content.trim();
  const norm = normalizeFragment(content);
  return lpTx(() => {
    const db = getLpDb();
    const res = db.prepare(`
      INSERT OR IGNORE INTO memory_fragments
        (content, content_norm, source_url, source_note, category, added_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      content,
      norm,
      input.sourceUrl ?? '',
      input.sourceNote ?? '',
      input.category ?? '',
      input.addedBy ?? '',
    );
    if ((res.changes ?? 0) > 0) return { inserted: true, id: Number(res.lastInsertRowid) };
    const existing = db
      .prepare('SELECT id FROM memory_fragments WHERE content_norm = ?')
      .get(norm) as { id: number } | undefined;
    return { inserted: false, id: existing ? existing.id : 0 };
  });
}

/** Soft-archive a fragment (status → 'archived'). It stays in the table but drops out of random draws. */
export function archiveFragment(id: number): boolean {
  const res = getLpDb().prepare(
    "UPDATE memory_fragments SET status = 'archived', updated_at = unixepoch() WHERE id = ? AND status = 'active'",
  ).run(id);
  return (res.changes ?? 0) > 0;
}

// ── Reads ─────────────────────────────────────────────────────

/** A single random active fragment (optionally filtered by category), or null when the pool is empty. */
export function getRandomFragment(opts?: { category?: string }): MemoryFragment | null {
  const db = getLpDb();
  const row = opts?.category
    ? db.prepare(
        "SELECT * FROM memory_fragments WHERE status = 'active' AND category = ? ORDER BY RANDOM() LIMIT 1",
      ).get(opts.category)
    : db.prepare(
        "SELECT * FROM memory_fragments WHERE status = 'active' ORDER BY RANDOM() LIMIT 1",
      ).get();
  return row ? rowToFragment(row as Record<string, unknown>) : null;
}

export function getFragmentById(id: number): MemoryFragment | null {
  const row = getLpDb()
    .prepare('SELECT * FROM memory_fragments WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToFragment(row) : null;
}

/** Look up a fragment by its normalized key (used to resolve a dedup hit to the existing row). */
export function findFragmentByNorm(norm: string): MemoryFragment | null {
  const row = getLpDb()
    .prepare('SELECT * FROM memory_fragments WHERE content_norm = ?')
    .get(norm) as Record<string, unknown> | undefined;
  return row ? rowToFragment(row) : null;
}

/** List fragments newest-first for operator review and dedup lookups. */
export function listFragments(opts: ListFragmentsOpts = {}): MemoryFragment[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) { where.push('status = ?'); params.push(opts.status); }
  if (opts.category) { where.push('category = ?'); params.push(opts.category); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const rows = getLpDb().prepare(
    `SELECT * FROM memory_fragments ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as Array<Record<string, unknown>>;
  return rows.map(rowToFragment);
}

/** Case-insensitive substring search over content, for semantic-dedup review before a write. */
export function searchFragments(query: string, limit = 20): MemoryFragment[] {
  const like = `%${query.trim()}%`;
  const rows = getLpDb().prepare(
    'SELECT * FROM memory_fragments WHERE content LIKE ? ORDER BY id DESC LIMIT ?',
  ).all(like, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToFragment);
}

export function countFragments(opts: { status?: FragmentStatus } = {}): number {
  const row = opts.status
    ? getLpDb().prepare('SELECT COUNT(*) AS n FROM memory_fragments WHERE status = ?').get(opts.status) as { n: number }
    : getLpDb().prepare('SELECT COUNT(*) AS n FROM memory_fragments').get() as { n: number };
  return row.n;
}
