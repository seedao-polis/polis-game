import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunked, multiRowValues } from './batch.js';

// multiRowValues is the one piece of the batched writers that is pure text manipulation, and the one
// whose failure mode is silent: a placeholder numbered wrong still parses, still binds, and simply
// writes the wrong column values. Pin the numbering contract directly rather than only through a
// round trip to a database.

test('multiRowValues numbers placeholders continuously across rows', () => {
  const { clause, params } = multiRowValues([['a', 1], ['b', 2], ['c', 3]]);
  assert.equal(clause, '($1, $2), ($3, $4), ($5, $6)');
  assert.deepEqual(params, ['a', 1, 'b', 2, 'c', 3]);
});

test('multiRowValues keeps params in row-major order matching the clause', () => {
  const rows = [['t1', 'docx', 100], ['t2', 'sheet', 200]];
  const { clause, params } = multiRowValues(rows);
  // Every placeholder index must address the value the clause claims it does.
  const indices = [...clause.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(indices, [1, 2, 3, 4, 5, 6], 'indices are 1-based and gap-free');
  assert.deepEqual(indices.map((n) => params[n - 1]), rows.flat());
});

test('multiRowValues handles a single row and a single column', () => {
  assert.deepEqual(multiRowValues([['only']]), { clause: '($1)', params: ['only'] });
});

test('multiRowValues on no rows yields an empty clause', () => {
  // Callers must short-circuit before reaching SQL — `VALUES ` with nothing after it is a syntax
  // error — so this only pins that the helper itself does not invent a row.
  assert.deepEqual(multiRowValues([]), { clause: '', params: [] });
});

test('multiRowValues preserves null and 0 as bound values', () => {
  // A row column that is null/0 must still occupy its placeholder slot; dropping it would shift every
  // subsequent value by one column.
  const { clause, params } = multiRowValues([[null, 0, ''], ['x', 1, 'y']]);
  assert.equal(clause, '($1, $2, $3), ($4, $5, $6)');
  assert.deepEqual(params, [null, 0, '', 'x', 1, 'y']);
});

test('chunked splits into full chunks with a possibly shorter last one', () => {
  assert.deepEqual(chunked([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunked([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
  assert.deepEqual(chunked([1], 5), [[1]]);
  assert.deepEqual(chunked([], 5), []);
});

test('chunked covers every element exactly once', () => {
  const items = Array.from({ length: 451 }, (_, i) => i);
  const batches = chunked(items, 200);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.flat(), items);
});
