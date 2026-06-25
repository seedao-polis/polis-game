import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Point SOULS_DIR (via AGENT_CONFIGS_DIR overrides are not applicable here; we override SOULS_DIR
// indirectly by writing strategy files into a temp workspace and manipulating the module cache).
// Since loadLpStrategy uses a module-level Map cache, we must ensure each test scenario uses a
// unique soul name pointing to the real workspace files or to temp directories we create.

// Use the actual workspaces directory (which contains the two LP_STRATEGY.json files we created).
// For the "missing file" scenario we use a unique name that has no workspace directory.

const { loadLpStrategy, judgeReply, buildJudgeInstruction } = await import('./lp-strategy.js');

// ── loadLpStrategy ────────────────────────────────────────────────────────────

test('loadLpStrategy: profile-writer-yihan has judgeEnabled=true and 3 categories', () => {
  const s = loadLpStrategy('profile-writer-yihan');
  assert.equal(s.judgeEnabled, true);
  assert.equal(s.cost, 0.1);
  assert.equal(s.categories.length, 3);
  assert.ok(s.categories.some((c) => c.name === '访谈中'));
  assert.ok(s.categories.some((c) => c.name === '画重点'));
  assert.ok(s.categories.some((c) => c.name === '无关'));
  // Default / fallback category is 访谈中 (benign default; 无关 only when the model explicitly flags it)
  const def = s.categories.find((c) => c.isDefault);
  assert.equal(def?.name, '访谈中');
});

test('loadLpStrategy: tudigong has judgeEnabled=false and 1 default category', () => {
  const s = loadLpStrategy('tudigong');
  assert.equal(s.judgeEnabled, false);
  assert.equal(s.cost, 0.1);
  assert.equal(s.categories.length, 1);
  assert.equal(s.categories[0]?.name, 'default');
  assert.equal(s.categories[0]?.isDefault, true);
});

test('loadLpStrategy: non-existent soul falls back to minimal strategy', () => {
  const s = loadLpStrategy('__no_such_soul_xyz__');
  assert.equal(s.judgeEnabled, false);
  assert.equal(s.cost, 0.1);
  assert.equal(s.categories.length, 1);
  assert.equal(s.categories[0]?.isDefault, true);
  assert.equal(s.categories[0]?.grant, 0);
});

// ── judgeReply (judgeEnabled=true) ────────────────────────────────────────────

test('judgeReply: detects 画重点 marker and strips marker line', () => {
  const s = loadLpStrategy('profile-writer-yihan');
  const raw = '这是一条很有价值的回复。\nLP_JUDGE: 画重点';
  const { category, reply } = judgeReply(raw, s);
  assert.equal(category.name, '画重点');
  assert.equal(category.grant, 0.4);
  assert.ok(!reply.includes('LP_JUDGE'), 'marker line must be stripped');
  assert.ok(reply.includes('这是一条很有价值的回复。'), 'body must be preserved');
});

test('judgeReply: detects 访谈中 marker', () => {
  const s = loadLpStrategy('profile-writer-yihan');
  const raw = '正在正确回答问题。\nLP_JUDGE: 访谈中';
  const { category, reply } = judgeReply(raw, s);
  assert.equal(category.name, '访谈中');
  assert.equal(category.grant, 0.1);
  assert.ok(!reply.includes('LP_JUDGE'));
});

test('judgeReply: no marker falls back to default (访谈中)', () => {
  const s = loadLpStrategy('profile-writer-yihan');
  const raw = '这是一条没有标记的回复。';
  const { category, reply } = judgeReply(raw, s);
  assert.equal(category.name, '访谈中');
  assert.equal(category.grant, 0.1);
  assert.equal(reply, raw);
});

test('judgeReply: unrecognised token falls back to default', () => {
  const s = loadLpStrategy('profile-writer-yihan');
  const raw = '回复内容。\nLP_JUDGE: 乱写';
  const { category, reply } = judgeReply(raw, s);
  assert.equal(category.name, '访谈中');
  assert.ok(!reply.includes('LP_JUDGE'), 'marker line still stripped even for unknown token');
});

test('judgeReply: tolerates backtick noise around marker and token', () => {
  const s = loadLpStrategy('profile-writer-yihan');
  const raw = '回复内容。\n`LP_JUDGE: 画重点`';
  const { category } = judgeReply(raw, s);
  assert.equal(category.name, '画重点');
});

test('judgeReply: tolerates full-width colon', () => {
  const s = loadLpStrategy('profile-writer-yihan');
  const raw = '回复内容。\nLP_JUDGE：画重点';
  const { category } = judgeReply(raw, s);
  assert.equal(category.name, '画重点');
});

test('judgeReply: uses last marker when multiple lines appear', () => {
  const s = loadLpStrategy('profile-writer-yihan');
  const raw = '开头内容。\nLP_JUDGE: 访谈中\n中间内容。\nLP_JUDGE: 画重点';
  const { category } = judgeReply(raw, s);
  assert.equal(category.name, '画重点');
});

test('judgeReply: strips all marker lines and collapses excess blank lines', () => {
  const s = loadLpStrategy('profile-writer-yihan');
  const raw = '正文内容。\n\nLP_JUDGE: 访谈中\n\n';
  const { reply } = judgeReply(raw, s);
  assert.ok(!reply.includes('LP_JUDGE'));
  // Should not end with excessive whitespace
  assert.equal(reply, reply.trimEnd());
});

// ── judgeReply (judgeEnabled=false) ──────────────────────────────────────────

test('judgeReply: judgeEnabled=false always returns default, does not strip anything', () => {
  const s = loadLpStrategy('tudigong');
  const raw = '这是土地公的回复。\nLP_JUDGE: 画重点';
  const { category, reply } = judgeReply(raw, s);
  assert.equal(category.name, 'default');
  assert.equal(category.grant, 0);
  // Reply must NOT be modified — marker line stays
  assert.equal(reply, raw);
});

// ── buildJudgeInstruction ─────────────────────────────────────────────────────

test('buildJudgeInstruction: returns empty string for judgeEnabled=false', () => {
  const s = loadLpStrategy('tudigong');
  assert.equal(buildJudgeInstruction(s), '');
});

test('buildJudgeInstruction: includes all three category names and criteria', () => {
  const s = loadLpStrategy('profile-writer-yihan');
  const instr = buildJudgeInstruction(s);
  assert.ok(instr.length > 0);
  assert.ok(instr.includes('访谈中'), 'must mention 访谈中');
  assert.ok(instr.includes('画重点'), 'must mention 画重点');
  assert.ok(instr.includes('无关'), 'must mention 无关');
  assert.ok(instr.includes('LP_JUDGE'), 'must include the marker name');
  // Instruction should be in Simplified Chinese
  assert.ok(instr.includes('评分判定') || instr.includes('类别'), 'must contain Chinese content');
});
