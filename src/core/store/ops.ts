import { getDb, shouldDivertSoulWrites } from '../db.js';
import { enqueueOutboxWrite } from '../pg-outbox.js';

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

export async function recordError(e: ErrorRecord): Promise<void> {
  const cols = ['corr_id', 'soul', 'chat_id', 'source', 'kind', 'summary', 'exit_code', 'signal', 'duration_ms', 'attempt', 'healed', 'postmortem'];
  const values = [
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
  ];
  try {
    // Append-only error ledger: while the soul PG pool's circuit breaker is open, divert straight to
    // the local outbox instead of attempting PostgreSQL.
    if (shouldDivertSoulWrites()) {
      await enqueueOutboxWrite('errors', cols, values);
      return;
    }
    const db = await getDb();
    await db.query(`INSERT INTO errors(${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, values);
  } catch {
    /* ledger write must never break a reply */
  }
}

export async function recentErrorCount(chatId: string, sinceMs: number): Promise<number> {
  try {
    const db = await getDb();
    const cutoff = Math.floor((Date.now() - sinceMs) / 1000);
    const { rows } = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM errors WHERE chat_id = $1 AND created_at >= $2',
      [chatId, cutoff],
    );
    return rows[0]?.n ?? 0;
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

/**
 * The INSERT carries a RETURNING clause (supported by both node:sqlite and PostgreSQL) so the new
 * row's id can be read back without relying on `lastInsertRowid`, which the PostgreSQL query
 * interface introduced later has no equivalent for.
 */
export async function addPendingReply(r: Omit<PendingReply, 'id'>): Promise<number> {
  try {
    const db = await getDb();
    const { rows } = await db.query<{ id: number }>(
      `
      INSERT INTO pending_replies(agent_id, channel, chat_id, message_id, session_key, sender_open_id, text, reaction_id, pt_spent, attempts)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `,
      [
        r.agentId, r.channel, r.chatId, r.messageId ?? null, r.sessionKey,
        r.senderOpenId ?? null, r.text, r.reactionId ?? null, r.ptSpent ? 1 : 0, r.attempts ?? 0,
      ],
    );
    return rows[0]?.id ?? 0;
  } catch {
    return 0;
  }
}

export async function updatePendingReply(
  id: number,
  patch: { reactionId?: string | null; ptSpent?: boolean; attempts?: number },
): Promise<void> {
  if (!id) return;
  try {
    const db = await getDb();
    if (patch.reactionId !== undefined) {
      await db.query('UPDATE pending_replies SET reaction_id = $1 WHERE id = $2', [patch.reactionId ?? null, id]);
    }
    if (patch.ptSpent !== undefined) {
      await db.query('UPDATE pending_replies SET pt_spent = $1 WHERE id = $2', [patch.ptSpent ? 1 : 0, id]);
    }
    if (patch.attempts !== undefined) {
      await db.query('UPDATE pending_replies SET attempts = $1 WHERE id = $2', [patch.attempts, id]);
    }
  } catch {
    /* best-effort */
  }
}

export async function removePendingReply(id: number): Promise<void> {
  if (!id) return;
  try {
    const db = await getDb();
    await db.query('DELETE FROM pending_replies WHERE id = $1', [id]);
  } catch {
    /* best-effort */
  }
}

export async function listPendingReplies(agentId: string, channel: string): Promise<PendingReply[]> {
  try {
    const db = await getDb();
    const { rows } = await db.query<Record<string, unknown>>(
      `
      SELECT id, agent_id, channel, chat_id, message_id, session_key, sender_open_id, text, reaction_id, pt_spent, attempts
      FROM pending_replies WHERE agent_id = $1 AND channel = $2 ORDER BY id ASC
    `,
      [agentId, channel],
    );
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

export async function recentErrors(limit = 20): Promise<Array<{
  created_at: number;
  corr_id: string | null;
  soul: string | null;
  chat_id: string | null;
  kind: string;
  summary: string;
  healed: number;
}>> {
  try {
    const db = await getDb();
    const { rows } = await db.query<{
      created_at: number;
      corr_id: string | null;
      soul: string | null;
      chat_id: string | null;
      kind: string;
      summary: string;
      healed: number;
    }>(
      'SELECT created_at, corr_id, soul, chat_id, kind, summary, healed FROM errors ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return rows;
  } catch {
    return [];
  }
}

export async function wasTokenExpiryAlertSent(grantKey: string, threshold: number): Promise<boolean> {
  try {
    const db = await getDb();
    const { rows } = await db.query(
      'SELECT 1 FROM token_expiry_alerts WHERE grant_key = $1 AND threshold = $2',
      [grantKey, threshold],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function markTokenExpiryAlertSent(grantKey: string, threshold: number): Promise<boolean> {
  try {
    const db = await getDb();
    const { rowCount } = await db.query(
      'INSERT INTO token_expiry_alerts(grant_key, threshold) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [grantKey, threshold],
    );
    return rowCount > 0;
  } catch {
    return false;
  }
}
