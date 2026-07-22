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

/** Escape LIKE/ILIKE wildcard characters so user-supplied search text is matched literally. */
function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
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
 * Insert a fragment, deduped by normalized content via an idempotent insert on the content_norm
 * UNIQUE index. Returns whether a new row was written (false when an equivalent fragment already
 * exists) plus the row id (the existing row's id on a dedup hit).
 *
 * The INSERT carries a RETURNING clause (supported by both node:sqlite and PostgreSQL) so the new
 * row's id can be read back without relying on `lastInsertRowid`, which the query-based executor
 * interface has no equivalent for.
 */
export async function insertFragment(input: FragmentInput): Promise<{ inserted: boolean; id: number }> {
  const content = input.content.trim();
  const norm = normalizeFragment(content);
  return lpTx(async () => {
    const db = await getLpDb();
    const { rows } = await db.query<{ id: number }>(`
      INSERT INTO memory_fragments
        (content, content_norm, source_url, source_note, category, added_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (content_norm) DO NOTHING
      RETURNING id
    `, [
      content,
      norm,
      input.sourceUrl ?? '',
      input.sourceNote ?? '',
      input.category ?? '',
      input.addedBy ?? '',
    ]);
    if (rows[0]) return { inserted: true, id: Number(rows[0].id) };
    const existing = await db.query<{ id: number }>('SELECT id FROM memory_fragments WHERE content_norm = $1', [norm]);
    return { inserted: false, id: existing.rows[0] ? existing.rows[0].id : 0 };
  });
}

/** Soft-archive a fragment (status → 'archived'). It stays in the table but drops out of random draws. */
export async function archiveFragment(id: number): Promise<boolean> {
  const db = await getLpDb();
  const { rowCount } = await db.query(
    "UPDATE memory_fragments SET status = 'archived', updated_at = unixepoch() WHERE id = $1 AND status = 'active'",
    [id],
  );
  return rowCount > 0;
}

// ── Reads ─────────────────────────────────────────────────────

/** A single random active fragment (optionally filtered by category), or null when the pool is empty. */
export async function getRandomFragment(opts?: { category?: string }): Promise<MemoryFragment | null> {
  const db = await getLpDb();
  const { rows } = opts?.category
    ? await db.query<Record<string, unknown>>(
        "SELECT * FROM memory_fragments WHERE status = 'active' AND category = $1 ORDER BY RANDOM() LIMIT 1",
        [opts.category],
      )
    : await db.query<Record<string, unknown>>(
        "SELECT * FROM memory_fragments WHERE status = 'active' ORDER BY RANDOM() LIMIT 1",
      );
  return rows[0] ? rowToFragment(rows[0]) : null;
}

export async function getFragmentById(id: number): Promise<MemoryFragment | null> {
  const db = await getLpDb();
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM memory_fragments WHERE id = $1', [id]);
  return rows[0] ? rowToFragment(rows[0]) : null;
}

/** Look up a fragment by its normalized key (used to resolve a dedup hit to the existing row). */
export async function findFragmentByNorm(norm: string): Promise<MemoryFragment | null> {
  const db = await getLpDb();
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM memory_fragments WHERE content_norm = $1', [norm]);
  return rows[0] ? rowToFragment(rows[0]) : null;
}

/** List fragments newest-first for operator review and dedup lookups. */
export async function listFragments(opts: ListFragmentsOpts = {}): Promise<MemoryFragment[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
  if (opts.category) { params.push(opts.category); where.push(`category = $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(opts.limit ?? 50);
  const limitIdx = params.length;
  params.push(opts.offset ?? 0);
  const offsetIdx = params.length;
  const db = await getLpDb();
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM memory_fragments ${clause} ORDER BY id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return rows.map(rowToFragment);
}

/**
 * Case-insensitive substring search over content, for semantic-dedup review before a write.
 * ILIKE (not LIKE): PostgreSQL's LIKE is case-sensitive, unlike SQLite's ASCII-only case-insensitive
 * default. User input is escaped so literal `%`/`_` in a search phrase aren't treated as wildcards.
 */
export async function searchFragments(query: string, limit = 20): Promise<MemoryFragment[]> {
  const like = `%${escapeLikePattern(query.trim())}%`;
  const db = await getLpDb();
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM memory_fragments WHERE content ILIKE $1 ESCAPE '\\' ORDER BY id DESC LIMIT $2`,
    [like, limit],
  );
  return rows.map(rowToFragment);
}

export async function countFragments(opts: { status?: FragmentStatus } = {}): Promise<number> {
  const db = await getLpDb();
  const { rows } = opts.status
    ? await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM memory_fragments WHERE status = $1', [opts.status])
    : await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM memory_fragments');
  return Number(rows[0]?.n ?? 0);
}
