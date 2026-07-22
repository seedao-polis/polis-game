import { getDb, tx } from '../db.js';

// ── Type definitions ──────────────────────────────────────────

export type TcOptionType = 'discrete' | 'continuous';
export type TcStatus = 'active' | 'settled' | 'cancelled';

export interface TcProposal {
  id: number;
  num: number;
  title: string;
  optionType: TcOptionType;
  /** Discrete: string[]; continuous: [min: number, max: number] */
  options: string[] | [number, number];
  endTime: number;
  minBetLp: number;
  maxBetLp: number;
  status: TcStatus;
  createdBy: string;
  chatId: string;
  topMessageId: string;
  threadId: string | null;
  settledValue: number | null;
  settledOption: string | null;
  settledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TcProposalInput {
  title: string;
  optionType: TcOptionType;
  options: string[] | [number, number];
  endTime: number;
  maxBetLp?: number;
  createdBy?: string;
  chatId?: string;
}

export interface TcProposalUpdate {
  maxBetLp?: number;
  endTime?: number;
}

export interface TcBet {
  id: number;
  proposalId: number;
  userOpenId: string;
  optionValue: string;
  lpAmount: number;
  messageId: string;
  isRefunded: boolean;
  createdAt: number;
}

export interface TcBetInput {
  proposalId: number;
  userOpenId: string;
  optionValue: string;
  lpAmount: number;
  messageId?: string;
}

// ── Row → typed object converters ────────────────────────────

function rowToProposal(row: Record<string, unknown>): TcProposal {
  let options: string[] | [number, number];
  try {
    options = JSON.parse(String(row['options'] ?? '[]'));
  } catch {
    options = [];
  }
  return {
    id: Number(row['id']),
    num: Number(row['num']),
    title: String(row['title'] ?? ''),
    optionType: String(row['option_type'] ?? 'discrete') as TcOptionType,
    options,
    endTime: Number(row['end_time']),
    minBetLp: Number(row['min_bet_lp'] ?? 1),
    maxBetLp: Number(row['max_bet_lp'] ?? 10),
    status: String(row['status'] ?? 'active') as TcStatus,
    createdBy: String(row['created_by'] ?? ''),
    chatId: String(row['chat_id'] ?? ''),
    topMessageId: String(row['top_message_id'] ?? ''),
    threadId: row['thread_id'] != null ? String(row['thread_id']) : null,
    settledValue: row['settled_value'] != null ? Number(row['settled_value']) : null,
    settledOption: row['settled_option'] != null ? String(row['settled_option']) : null,
    settledAt: row['settled_at'] != null ? Number(row['settled_at']) : null,
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
}

function rowToBet(row: Record<string, unknown>): TcBet {
  return {
    id: Number(row['id']),
    proposalId: Number(row['proposal_id']),
    userOpenId: String(row['user_open_id'] ?? ''),
    optionValue: String(row['option_value'] ?? ''),
    lpAmount: Number(row['lp_amount']),
    messageId: String(row['message_id'] ?? ''),
    isRefunded: Number(row['is_refunded']) === 1,
    createdAt: Number(row['created_at']),
  };
}

// ── Counter / number assignment ───────────────────────────────

/**
 * Atomically increment the proposal counter and return the number assigned to this proposal.
 * Must be called inside tx(); calling it outside a transaction is unsafe.
 */
export async function nextTcNumUnsafe(): Promise<number> {
  const db = await getDb();
  const { rows } = await db.query<{ next_num: number }>('SELECT next_num FROM tc_counter WHERE id = 1');
  const num = rows[0].next_num;
  await db.query('UPDATE tc_counter SET next_num = next_num + 1 WHERE id = 1');
  return num;
}

// ── Proposal CRUD ─────────────────────────────────────────────

/**
 * Atomically create a new proposal: assign a number and INSERT in a single tx().
 * Returns the auto-increment id and the assigned proposal number.
 *
 * The INSERT carries a RETURNING clause (supported by both node:sqlite and PostgreSQL) so the new
 * row's id can be read back without relying on `lastInsertRowid`, which the PostgreSQL query
 * interface introduced later has no equivalent for.
 */
export async function insertTcProposal(input: TcProposalInput): Promise<{ id: number; num: number }> {
  return tx(async () => {
    const num = await nextTcNumUnsafe();
    const db = await getDb();
    const { rows } = await db.query<{ id: number }>(`
      INSERT INTO tc_proposals
        (num, title, option_type, options, end_time, min_bet_lp, max_bet_lp,
         created_by, chat_id, status)
      VALUES ($1, $2, $3, $4, $5, 1.0, $6, $7, $8, 'active')
      RETURNING id
    `, [
      num,
      input.title,
      input.optionType,
      JSON.stringify(input.options),
      input.endTime,
      input.maxBetLp ?? 10,
      input.createdBy ?? '',
      input.chatId ?? '',
    ]);
    return { id: Number(rows[0].id), num };
  });
}

/**
 * Backfill the Feishu message_id (om_xxx) after sendPost() returns.
 * Runs outside the insert transaction because sendPost() is a network call.
 */
export async function updateTcTopMessageId(id: number, topMessageId: string): Promise<boolean> {
  const db = await getDb();
  const { rowCount } = await db.query(
    'UPDATE tc_proposals SET top_message_id = $1, updated_at = unixepoch() WHERE id = $2',
    [topMessageId, id],
  );
  return rowCount > 0;
}

/**
 * Backfill the platform thread_id on the first bet event in this thread.
 * Idempotent: only writes when thread_id IS NULL (first time only).
 */
export async function updateTcThreadId(id: number, threadId: string): Promise<boolean> {
  const db = await getDb();
  const { rowCount } = await db.query(
    'UPDATE tc_proposals SET thread_id = $1, updated_at = unixepoch() WHERE id = $2 AND thread_id IS NULL',
    [threadId, id],
  );
  return rowCount > 0;
}

/**
 * Update mutable admin-managed fields (max_bet_lp, end_time).
 * title / optionType / options are immutable after creation to preserve bet validity.
 */
export async function updateTcProposal(id: number, updates: TcProposalUpdate): Promise<boolean> {
  const sets: string[] = [];
  const params: (number | null)[] = [];
  if (updates.maxBetLp !== undefined) { params.push(updates.maxBetLp); sets.push(`max_bet_lp = $${params.length}`); }
  if (updates.endTime !== undefined) { params.push(updates.endTime); sets.push(`end_time = $${params.length}`); }
  if (sets.length === 0) return false;
  sets.push('updated_at = unixepoch()');
  params.push(id);
  const db = await getDb();
  const { rowCount } = await db.query(
    `UPDATE tc_proposals SET ${sets.join(', ')} WHERE id = $${params.length}`, params,
  );
  return rowCount > 0;
}

export async function getTcByNum(num: number): Promise<TcProposal | null> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM tc_proposals WHERE num = $1', [num]);
  return rows[0] ? rowToProposal(rows[0]) : null;
}

export async function getTcById(id: number): Promise<TcProposal | null> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM tc_proposals WHERE id = $1', [id]);
  return rows[0] ? rowToProposal(rows[0]) : null;
}

export async function getTcByTopMessageId(msgId: string): Promise<TcProposal | null> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM tc_proposals WHERE top_message_id = $1', [msgId]);
  return rows[0] ? rowToProposal(rows[0]) : null;
}

export async function getTcByThreadId(threadId: string): Promise<TcProposal | null> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM tc_proposals WHERE thread_id = $1', [threadId]);
  return rows[0] ? rowToProposal(rows[0]) : null;
}

/**
 * Fallback lookup via the messages table (populated by feishu-user polling).
 * Finds the root message of the thread by ascending position, then looks up the proposal
 * by that root message_id. Used when thread_id has not yet been backfilled.
 */
export async function getTcByThreadFallback(threadId: string): Promise<TcProposal | null> {
  const db = await getDb();
  const { rows } = await db.query<{ message_id: string }>(
    `SELECT message_id FROM messages
       WHERE thread_id = $1
       ORDER BY thread_message_position ASC, create_time ASC
       LIMIT 1`,
    [threadId],
  );
  const rootRow = rows[0];
  if (!rootRow) return null;
  return getTcByTopMessageId(rootRow.message_id);
}

/**
 * Find the active TC proposal (if any) whose thread matches threadId.
 * Two-stage: fast path (thread_id already backfilled) → fallback (messages table lookup + backfill).
 */
export async function findActiveTcByThread(threadId: string): Promise<TcProposal | null> {
  // Fast path: thread_id already known
  const fast = await getTcByThreadId(threadId);
  if (fast && fast.status === 'active') return fast;
  // Fallback: derive from the messages table root message
  const fallback = await getTcByThreadFallback(threadId);
  if (fallback && fallback.status === 'active') {
    await updateTcThreadId(fallback.id, threadId);
    return fallback;
  }
  return null;
}

/** Soft-cancel a proposal (status → 'cancelled'). Only transitions from 'active'. */
export async function cancelTcProposal(id: number): Promise<boolean> {
  const db = await getDb();
  const { rowCount } = await db.query(
    "UPDATE tc_proposals SET status = 'cancelled', updated_at = unixepoch() WHERE id = $1 AND status = 'active'",
    [id],
  );
  return rowCount > 0;
}

/**
 * Mark a proposal as settled: writes the canonical outcome and transitions status → 'settled'.
 * Idempotent guard: only updates rows where status = 'active', so a second call returns false.
 */
export async function settleTcProposal(
  id: number,
  settledValue: number | null,
  settledOption: string | null,
): Promise<boolean> {
  const db = await getDb();
  const { rowCount } = await db.query(`
    UPDATE tc_proposals
    SET status = 'settled', settled_value = $1, settled_option = $2,
        settled_at = unixepoch(), updated_at = unixepoch()
    WHERE id = $3 AND status = 'active'
  `, [settledValue, settledOption, id]);
  return rowCount > 0;
}

/** Return all active proposals past their end_time, ordered oldest-first (for batch settlement). */
export async function listExpiredActiveTcs(): Promise<TcProposal[]> {
  const now = Math.floor(Date.now() / 1000);
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    "SELECT * FROM tc_proposals WHERE status = 'active' AND end_time <= $1 ORDER BY end_time ASC",
    [now],
  );
  return rows.map(rowToProposal);
}

/** Return all active proposals ordered by num ASC (for operator listing). */
export async function listActiveTcs(): Promise<TcProposal[]> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    "SELECT * FROM tc_proposals WHERE status = 'active' ORDER BY num ASC",
  );
  return rows.map(rowToProposal);
}

/**
 * Active proposals bound to a chat, newest first.
 * Bets are associated by chat rather than by thread: the group event stream does not carry a
 * thread id, so a bet is matched to the chat's active proposal(s) instead of a reply thread.
 */
export async function listActiveTcsByChat(chatId: string): Promise<TcProposal[]> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    "SELECT * FROM tc_proposals WHERE chat_id = $1 AND status = 'active' ORDER BY num DESC",
    [chatId],
  );
  return rows.map(rowToProposal);
}

/** Return the most recent proposals across all statuses (for history view). */
export async function listAllTcs(limit = 20): Promise<TcProposal[]> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT * FROM tc_proposals ORDER BY num DESC LIMIT $1', [limit],
  );
  return rows.map(rowToProposal);
}

// ── Bet CRUD ──────────────────────────────────────────────────

export async function insertTcBet(bet: TcBetInput): Promise<number> {
  const db = await getDb();
  const { rows } = await db.query<{ id: number }>(`
    INSERT INTO tc_bets (proposal_id, user_open_id, option_value, lp_amount, message_id)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [bet.proposalId, bet.userOpenId, bet.optionValue, bet.lpAmount, bet.messageId ?? '']);
  return Number(rows[0].id);
}

/** Return all bets for a proposal, ordered by creation time (for settlement and display). */
export async function getTcBets(proposalId: number): Promise<TcBet[]> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT * FROM tc_bets WHERE proposal_id = $1 ORDER BY created_at ASC', [proposalId],
  );
  return rows.map(rowToBet);
}

/** Sum of LP across all non-refunded bets a user has placed on a given proposal. */
export async function getUserTotalBetLp(proposalId: number, userOpenId: string): Promise<number> {
  const db = await getDb();
  const { rows } = await db.query<{ total: number }>(
    'SELECT COALESCE(SUM(lp_amount), 0) AS total FROM tc_bets WHERE proposal_id = $1 AND user_open_id = $2 AND is_refunded = 0',
    [proposalId, userOpenId],
  );
  return rows[0].total;
}

/** Return all non-refunded bets for a proposal (used as the input set for refund or settlement). */
export async function getUnrefundedBets(proposalId: number): Promise<TcBet[]> {
  const db = await getDb();
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT * FROM tc_bets WHERE proposal_id = $1 AND is_refunded = 0 ORDER BY id ASC', [proposalId],
  );
  return rows.map(rowToBet);
}

/**
 * Mark a single bet as refunded. Idempotent: only transitions is_refunded 0 → 1.
 * The caller is responsible for issuing the corresponding grantPt() in shared.db.
 */
export async function markBetRefunded(betId: number): Promise<boolean> {
  const db = await getDb();
  const { rowCount } = await db.query(
    'UPDATE tc_bets SET is_refunded = 1 WHERE id = $1 AND is_refunded = 0', [betId],
  );
  return rowCount > 0;
}
