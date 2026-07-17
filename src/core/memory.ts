import fs from 'node:fs';
import path from 'node:path';
import { SOULS_DIR } from './paths.js';

// ── Ultra-lightweight memory system ────────────────────────────────────────────
// Layer 1: memories.md  — key memories (preferences/facts/decisions), one per line
// Layer 2: journal/<YYYY-MM-DD>.md — daily chronological log
// No vector search, just plain keyword matching; lightweight enough, readable, and hand-editable.

function memoryDir(soul: string): string {
  return path.join(SOULS_DIR, soul, 'memory');
}
function memoriesFile(soul: string): string {
  return path.join(memoryDir(soul), 'memories.md');
}
function journalFile(soul: string, date = today()): string {
  return path.join(memoryDir(soul), 'journal', `${date}.md`);
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function nowTime(): string {
  return new Date().toISOString().slice(11, 16);
}
function ensureDir(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

/** Write one key memory */
export function remember(soul: string, text: string): void {
  const f = memoriesFile(soul);
  ensureDir(f);
  fs.appendFileSync(f, `- (${today()}) ${text.trim()}\n`, 'utf8');
}

/** Keyword-search key memories, returning the matching lines */
export function searchMemories(soul: string, query: string, limit = 10): string[] {
  const f = memoriesFile(soul);
  if (!fs.existsSync(f)) return [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .filter((line) => terms.length === 0 || terms.some((t) => line.toLowerCase().includes(t)))
    .slice(-limit);
}

/** Append one journal entry */
export function appendJournal(soul: string, text: string): void {
  const f = journalFile(soul);
  ensureDir(f);
  fs.appendFileSync(f, `- ${nowTime()} ${text.trim()}\n`, 'utf8');
}

/**
 * Runaway guard for the journal injected into the system prompt. The journal is the soul's own diary
 * and legitimately spans every chat of the day, so it is kept whole on disk; this only bounds what a
 * pathological day can push into the prompt. Sized well above real days (observed: ~1KB typical, 6.6KB
 * busiest) so it is a rail, not a behaviour change.
 */
const MAX_JOURNAL_PROMPT_CHARS = 12000;

/** Read today's journal (for persona injection), newest entries kept if it is pathologically long. */
export function todayJournal(soul: string): string {
  const f = journalFile(soul);
  if (!fs.existsSync(f)) return '';
  const raw = fs.readFileSync(f, 'utf8').trim();
  if (raw.length <= MAX_JOURNAL_PROMPT_CHARS) return raw;
  // Keep the tail (the most recent entries) and cut on a line boundary.
  const tail = raw.slice(raw.length - MAX_JOURNAL_PROMPT_CHARS);
  const nl = tail.indexOf('\n');
  return `（今天较早的日誌已略）\n${nl >= 0 ? tail.slice(nl + 1) : tail}`;
}

/** Read all key memories (for persona injection) */
export function allMemories(soul: string): string {
  const f = memoriesFile(soul);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
}

/** Assemble the memory block to be injected into the system prompt */
export function memoryContext(soul: string): string {
  const mem = allMemories(soul);
  const jrnl = todayJournal(soul);
  const parts: string[] = [];
  if (mem) parts.push(`### 你記得的重點\n${mem}`);
  if (jrnl) parts.push(`### 今天的日誌（${today()}）\n${jrnl}`);
  return parts.join('\n\n');
}
