import fs from 'node:fs';
import path from 'node:path';
import { SOULS_DIR } from './paths.js';
import { loadConfigs } from './configs.js';
import { appendDocxContent } from './lark.js';
import { log } from './log.js';
import {
  hasVisitorMilestone,
  recordVisitorMilestone as storeRecordVisitorMilestone,
  listVisitorMilestones,
  type VisitorPerson,
} from './store/members.js';

// Visitor-count milestone ledger. The visitor-num-notify announcement must fire exactly once per
// hundred, ever — surviving restarts (the previous in-memory round-over-round dedup re-fired after a
// restart because its baseline reset). This module keeps a persistent record in two mirrored places:
//   • a human-readable JSON file per chat under the soul workspace (visitors/<chatId>.json)
//   • the visitor_milestones DB table
// Either being present means "already announced". On a new milestone it also overwrites the
// "访客里程碑" wiki page from the DB snapshot. All writes are deterministic; no LLM involved.

interface LedgerEntry {
  /** open_id of the milestone-th visitor (present-member arrival order). */
  openId: string;
  name: string;
  /** unix seconds when the milestone was reached (the visitor's first_seen for backfilled records). */
  reachedAt: number;
}
interface Ledger {
  chatId: string;
  milestones: Record<string, LedgerEntry>;
}

/** Path to the per-chat JSON ledger under the soul workspace. */
function ledgerPath(soul: string, chatId: string): string {
  return path.join(SOULS_DIR, soul, 'visitors', `${chatId}.json`);
}

/** Load the JSON ledger for a chat, or an empty ledger when the file is missing / unreadable. */
export function loadLedger(soul: string, chatId: string): Ledger {
  try {
    const raw = fs.readFileSync(ledgerPath(soul, chatId), 'utf8');
    const doc = JSON.parse(raw) as Ledger;
    if (doc && typeof doc === 'object' && doc.milestones) return doc;
  } catch { /* missing or malformed → empty */ }
  return { chatId, milestones: {} };
}

/** True when the milestone is recorded in either the DB ledger or the JSON file. */
export function isMilestoneRecorded(soul: string, chatId: string, milestone: number): boolean {
  if (hasVisitorMilestone(chatId, milestone)) return true;
  const ledger = loadLedger(soul, chatId);
  return Boolean(ledger.milestones[String(milestone)]);
}

/**
 * Freeze a milestone in both the DB and the JSON file. Idempotent: re-recording the same milestone
 * keeps the first entry. Returns the entry written (or the existing one).
 */
export function recordMilestone(soul: string, chatId: string, milestone: number, person: VisitorPerson, reachedAt: number): LedgerEntry {
  const entry: LedgerEntry = { openId: person.openId, name: person.name, reachedAt };

  // DB mirror (INSERT OR IGNORE — keeps first).
  try { storeRecordVisitorMilestone(chatId, milestone, person.openId, person.name, reachedAt); }
  catch (e) { log.warn(`访客里程碑写库失败【${milestone}】：`, (e as Error).message); }

  // JSON ledger (keep first entry for a milestone).
  const ledger = loadLedger(soul, chatId);
  const key = String(milestone);
  if (!ledger.milestones[key]) {
    ledger.milestones[key] = entry;
    try {
      const p = ledgerPath(soul, chatId);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(ledger, null, 2), 'utf8');
    } catch (e) {
      log.warn(`访客里程碑写 JSON 失败【${milestone}】：`, (e as Error).message);
    }
  }
  return ledger.milestones[key]!;
}

/** Format unix seconds as "YYYY-MM-DD" (local date). */
function fmtDate(sec: number): string {
  return new Date(sec * 1000).toLocaleString('sv-SE', { hour12: false }).slice(0, 10);
}

/** Render the "访客里程碑" wiki page body from the DB snapshot (deterministic, no LLM). */
export function renderMilestonesMarkdown(chatId: string): string {
  const rows = listVisitorMilestones(chatId);
  const updated = new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16).replace('T', ' ');
  const head = `# 访客里程碑\n\n> 记录 SeeDAO 围观群每满 100 人时的第 100·N 位访客。最后更新：${updated}（自动更新）\n\n`;
  const table = `| 里程碑 | 第 N 位访客 | 达成日期 |\n|--------|-------------|----------|\n`;
  if (rows.length === 0) return head + table + '| （暂无）| | |\n';
  const body = rows
    .map((r) => `| 第 ${r.milestone} 人 | ${r.name || '(未知)'} | ${fmtDate(r.reachedAt)} |`)
    .join('\n');
  return head + table + body + '\n';
}

/**
 * Overwrite the "访客里程碑" wiki page with the current milestone table. Returns false when the wiki
 * document id is not configured or the write fails (non-fatal).
 */
export function refreshVisitorMilestonesWiki(chatId: string, opts: { profile?: string } = {}): boolean {
  let docId: string | undefined;
  try { docId = loadConfigs().lark.visitorMilestoneWikiDocId; }
  catch { return false; }
  if (!docId) return false;
  return appendDocxContent(docId, renderMilestonesMarkdown(chatId), { profile: opts.profile, overwrite: true, format: 'markdown' });
}
