import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Point the DB at a temp file before any module imports touch the real DB.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-fragments-test-'));
process.env.AGENT_DB_PATH = path.join(TMP, 'test.db');

const {
  insertFragment, getRandomFragment, listFragments, searchFragments,
  countFragments, archiveFragment, findFragmentByNorm, normalizeFragment,
} = await import('./store/fragments.js');
const { closeDb } = await import('./db.js');

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── normalizeFragment ─────────────────────────────────────────

describe('normalizeFragment', () => {
  it('strips whitespace/punctuation and lowercases', () => {
    assert.equal(normalizeFragment('  SeeDAO，成立 于 2021! '), 'seedao成立于2021');
  });
});

// ── insert + dedup ────────────────────────────────────────────

describe('insertFragment dedup', () => {
  it('inserts a new fragment', () => {
    const r = insertFragment({ content: 'SeeDAO 于 2021 年发起', category: '起源' });
    assert.equal(r.inserted, true);
    assert.ok(r.id > 0);
  });

  it('dedupes punctuation/whitespace variants to the same row', () => {
    const first = insertFragment({ content: 'DAO 三大件是钱包、投票、多签' });
    const again = insertFragment({ content: ' dao 三大件是钱包、投票、多签！！ ' });
    assert.equal(again.inserted, false);
    assert.equal(again.id, first.id);
  });
});

// ── random draw ───────────────────────────────────────────────

describe('getRandomFragment', () => {
  it('returns an active fragment', () => {
    const f = getRandomFragment();
    assert.ok(f && f.status === 'active');
  });

  it('respects the category filter', () => {
    insertFragment({ content: '治理相关的一条历史', category: '治理' });
    const f = getRandomFragment({ category: '治理' });
    assert.ok(f && f.category === '治理');
  });

  it('returns null when a category has no active rows', () => {
    assert.equal(getRandomFragment({ category: '不存在的标签' }), null);
  });
});

// ── archive excludes from the active pool ─────────────────────

describe('archiveFragment', () => {
  it('archived rows drop out of random draws and re-archive is a no-op', () => {
    const { id } = insertFragment({ content: '仅此一条 archive 专用', category: 'archive-test' });
    assert.equal(archiveFragment(id), true);
    assert.equal(getRandomFragment({ category: 'archive-test' }), null);
    assert.equal(archiveFragment(id), false);
  });
});

// ── search / count / findByNorm ───────────────────────────────

describe('search, count, findFragmentByNorm', () => {
  it('searchFragments matches by substring', () => {
    assert.ok(searchFragments('三大件').length >= 1);
  });

  it('findFragmentByNorm resolves the normalized key', () => {
    assert.ok(findFragmentByNorm(normalizeFragment('SeeDAO 于 2021 年发起')));
  });

  it('countFragments counts active rows', () => {
    assert.ok(countFragments({ status: 'active' }) >= 1);
  });

  it('listFragments returns newest-first', () => {
    const rows = listFragments({ limit: 100 });
    assert.ok(rows.length >= 1);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1]!.id > rows[i]!.id);
  });
});
