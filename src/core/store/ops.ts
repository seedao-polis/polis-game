import { getDb } from '../db.js';

// ── error ledger ──────────────────────────────────────────────
// Records every agent/kimi failure for observability + the janitor's threshold alerts.

export interface ErrorRecord {
  corrId?: string | null;
  soul?: string | null;
  chatId?: string | null;
  source?: string | null;
  kind: string;
  summary: string;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number | null;
  attempt?: number;
  healed?: boolean;
  postmortem?: string | null;
}

export function recordError(e: ErrorRecord): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO errors(corr_id, soul, chat_id, source, kind, summary, exit_code, signal, duration_ms, attempt, healed, postmortem)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      e.corrId ?? null,
      e.soul ?? null,
      e.chatId ?? null,
      e.source ?? null,
      e.kind,
      e.summary,
      e.exitCode ?? null,
      e.signal ?? null,
      e.durationMs ?? null,
      e.attempt ?? 1,
      e.healed ? 1 : 0,
      e.postmortem ?? null,
    );
  } catch {
    /* ledger write must never break a reply */
  }
}

export function recentErrorCount(chatId: string, sinceMs: number): number {
  try {
    const db = getDb();
    const cutoff = Math.floor((Date.now() - sinceMs) / 1000);
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM errors WHERE chat_id = ? AND created_at >= ?')
      .get(chatId, cutoff) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

// ── pending replies (restart recovery) ────────────────────────
// A reply being generated is persisted here; deleted when it completes. On worker startup any
// surviving rows are replies interrupted by a restart/crash — recover them (clear reaction, refund
// LP, re-run). All helpers are best-effort: never throw into the reply hot path.

export interface PendingReply {
  id: number;
  agentId: string;
  channel: string;
  chatId: string;
  messageId: string | null;
  sessionKey: string;
  senderOpenId: string | null;
  text: string;
  reactionId: string | null;
  ptSpent: number;
  attempts: number;
}

export function addPendingReply(r: Omit<PendingReply, 'id'>): number {
  try {
    const db = getDb();
    const info = db.prepare(`
      INSERT INTO pending_replies(agent_id, channel, chat_id, message_id, session_key, sender_open_id, text, reaction_id, pt_spent, attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.agentId, r.channel, r.chatId, r.messageId ?? null, r.sessionKey,
      r.senderOpenId ?? null, r.text, r.reactionId ?? null, r.ptSpent ? 1 : 0, r.attempts ?? 0,
    );
    return Number(info.lastInsertRowid) || 0;
  } catch {
    return 0;
  }
}

export function updatePendingReply(
  id: number,
  patch: { reactionId?: string | null; ptSpent?: boolean; attempts?: number },
): void {
  if (!id) return;
  try {
    const db = getDb();
    if (patch.reactionId !== undefined) {
      db.prepare('UPDATE pending_replies SET reaction_id = ? WHERE id = ?').run(patch.reactionId ?? null, id);
    }
    if (patch.ptSpent !== undefined) {
      db.prepare('UPDATE pending_replies SET pt_spent = ? WHERE id = ?').run(patch.ptSpent ? 1 : 0, id);
    }
    if (patch.attempts !== undefined) {
      db.prepare('UPDATE pending_replies SET attempts = ? WHERE id = ?').run(patch.attempts, id);
    }
  } catch {
    /* best-effort */
  }
}

export function removePendingReply(id: number): void {
  if (!id) return;
  try {
    getDb().prepare('DELETE FROM pending_replies WHERE id = ?').run(id);
  } catch {
    /* best-effort */
  }
}

export function listPendingReplies(agentId: string, channel: string): PendingReply[] {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, agent_id, channel, chat_id, message_id, session_key, sender_open_id, text, reaction_id, pt_spent, attempts
      FROM pending_replies WHERE agent_id = ? AND channel = ? ORDER BY id ASC
    `).all(agentId, channel) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      agentId: String(r.agent_id),
      channel: String(r.channel),
      chatId: String(r.chat_id),
      messageId: (r.message_id as string | null) ?? null,
      sessionKey: String(r.session_key ?? ''),
      senderOpenId: (r.sender_open_id as string | null) ?? null,
      text: String(r.text ?? ''),
      reactionId: (r.reaction_id as string | null) ?? null,
      ptSpent: Number(r.pt_spent) || 0,
      attempts: Number(r.attempts) || 0,
    }));
  } catch {
    return [];
  }
}

export function recentErrors(limit = 20): Array<{
  created_at: number;
  corr_id: string | null;
  soul: string | null;
  chat_id: string | null;
  kind: string;
  summary: string;
  healed: number;
}> {
  try {
    const db = getDb();
    return db
      .prepare('SELECT created_at, corr_id, soul, chat_id, kind, summary, healed FROM errors ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{
      created_at: number;
      corr_id: string | null;
      soul: string | null;
      chat_id: string | null;
      kind: string;
      summary: string;
      healed: number;
    }>;
  } catch {
    return [];
  }
}

export function wasTokenExpiryAlertSent(grantKey: string, threshold: number): boolean {
  try {
    const row = getDb()
      .prepare('SELECT 1 FROM token_expiry_alerts WHERE grant_key = ? AND threshold = ?')
      .get(grantKey, threshold);
    return !!row;
  } catch {
    return false;
  }
}

export function markTokenExpiryAlertSent(grantKey: string, threshold: number): boolean {
  try {
    const info = getDb()
      .prepare('INSERT OR IGNORE INTO token_expiry_alerts(grant_key, threshold) VALUES (?, ?)')
      .run(grantKey, threshold);
    return (info.changes as number) > 0;
  } catch {
    return false;
  }
}
