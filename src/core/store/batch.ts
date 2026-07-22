// Helpers for collapsing per-row statements into multi-row ones. Polling sweeps re-observe mostly
// unchanged data (a document's viewers, a message's reactions) and write it with ON CONFLICT DO
// NOTHING, so the overwhelming majority of those statements are no-ops — yet each one still costs a
// full round trip. Across a WAN link that is both the bulk of a sweep's wall-clock time and, more
// importantly, one more chance per statement to land on a stalled network path.

/** Slice an array into chunks of at most `size` elements (last chunk may be shorter). */
export function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Build a multi-row `VALUES ($1,$2),($3,$4),…` clause and its flat parameter list from one array of
 * column values per row. Placeholder numbering is continuous across rows, matching the `$N`
 * convention every store call site uses (and which the SQLite fallback translates). Every row must
 * supply the same columns in the same order; rows carrying SQL literals rather than bound values
 * build their clause inline instead.
 */
export function multiRowValues(rows: unknown[][]): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  const groups = rows.map((cols) => {
    const base = params.length;
    params.push(...cols);
    return `(${cols.map((_, i) => `$${base + i + 1}`).join(', ')})`;
  });
  return { clause: groups.join(', '), params };
}
