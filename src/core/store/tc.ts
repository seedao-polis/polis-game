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
export function nextTcNumUnsafe(): number {
  const db = getDb();
  const row = db.prepare('SELECT next_num FROM tc_counter WHERE id = 1').get() as { next_num: number };
  const num = row.next_num;
  db.prepare('UPDATE tc_counter SET next_num = next_num + 1 WHERE id = 1').run();
  return num;
}

// ── Proposal CRUD ─────────────────────────────────────────────

/**
 * Atomically create a new proposal: assign a number and INSERT in a single tx().
 * Returns the auto-increment id and the assigned proposal number.
 */
export function insertTcProposal(input: TcProposalInput): { id: number; num: number } {
  return tx(() => {
    const num = nextTcNumUnsafe();
    const db = getDb();
    const res = db.prepare(`
      INSERT INTO tc_proposals
        (num, title, option_type, options, end_time, min_bet_lp, max_bet_lp,
         created_by, chat_id, status)
      VALUES (?, ?, ?, ?, ?, 1.0, ?, ?, ?, 'active')
    `).run(
      num,
      input.title,
      input.optionType,
      JSON.stringify(input.options),
      input.endTime,
      input.maxBetLp ?? 10,
      input.createdBy ?? '',
      input.chatId ?? '',
    );
    return { id: Number(res.lastInsertRowid), num };
  });
}

/**
 * Backfill the Feishu message_id (om_xxx) after sendPost() returns.
 * Runs outside the insert transaction because sendPost() is a network call.
 */
export function updateTcTopMessageId(id: number, topMessageId: string): boolean {
  const res = getDb().prepare(
    'UPDATE tc_proposals SET top_message_id = ?, updated_at = unixepoch() WHERE id = ?',
  ).run(topMessageId, id);
  return (res.changes ?? 0) > 0;
}

/**
 * Backfill the platform thread_id on the first bet event in this thread.
 * Idempotent: only writes when thread_id IS NULL (first time only).
 */
export function updateTcThreadId(id: number, threadId: string): boolean {
  const res = getDb().prepare(
    'UPDATE tc_proposals SET thread_id = ?, updated_at = unixepoch() WHERE id = ? AND thread_id IS NULL',
  ).run(threadId, id);
  return (res.changes ?? 0) > 0;
}

/**
 * Update mutable admin-managed fields (max_bet_lp, end_time).
 * title / optionType / options are immutable after creation to preserve bet validity.
 */
export function updateTcProposal(id: number, updates: TcProposalUpdate): boolean {
  const sets: string[] = [];
  const params: (number | null)[] = [];
  if (updates.maxBetLp !== undefined) { sets.push('max_bet_lp = ?'); params.push(updates.maxBetLp); }
  if (updates.endTime !== undefined) { sets.push('end_time = ?'); params.push(updates.endTime); }
  if (sets.length === 0) return false;
  sets.push('updated_at = unixepoch()');
  const res = getDb().prepare(
    `UPDATE tc_proposals SET ${sets.join(', ')} WHERE id = ?`,
  ).run(...params, id);
  return (res.changes ?? 0) > 0;
}

export function getTcByNum(num: number): TcProposal | null {
  const row = getDb().prepare('SELECT * FROM tc_proposals WHERE num = ?').get(num) as Record<string, unknown> | undefined;
  return row ? rowToProposal(row) : null;
}

export function getTcById(id: number): TcProposal | null {
  const row = getDb().prepare('SELECT * FROM tc_proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToProposal(row) : null;
}

export function getTcByTopMessageId(msgId: string): TcProposal | null {
  const row = getDb().prepare('SELECT * FROM tc_proposals WHERE top_message_id = ?').get(msgId) as Record<string, unknown> | undefined;
  return row ? rowToProposal(row) : null;
}

export function getTcByThreadId(threadId: string): TcProposal | null {
  const row = getDb().prepare('SELECT * FROM tc_proposals WHERE thread_id = ?').get(threadId) as Record<string, unknown> | undefined;
  return row ? rowToProposal(row) : null;
}

/**
 * Fallback lookup via the messages table (populated by feishu-user polling).
 * Finds the root message of the thread by ascending position, then looks up the proposal
 * by that root message_id. Used when thread_id has not yet been backfilled.
 */
export function getTcByThreadFallback(threadId: string): TcProposal | null {
  const rootRow = getDb()
    .prepare(`SELECT message_id FROM messages
              WHERE thread_id = ?
              ORDER BY thread_message_position ASC, create_time ASC
              LIMIT 1`)
    .get(threadId) as { message_id: string } | undefined;
  if (!rootRow) return null;
  return getTcByTopMessageId(rootRow.message_id);
}

/**
 * Find the active TC proposal (if any) whose thread matches threadId.
 * Two-stage: fast path (thread_id already backfilled) → fallback (messages table lookup + backfill).
 */
export function findActiveTcByThread(threadId: string): TcProposal | null {
  // Fast path: thread_id already known
  const fast = getTcByThreadId(threadId);
  if (fast && fast.status === 'active') return fast;
  // Fallback: derive from the messages table root message
  const fallback = getTcByThreadFallback(threadId);
  if (fallback && fallback.status === 'active') {
    updateTcThreadId(fallback.id, threadId);
    return fallback;
  }
  return null;
}

/** Soft-cancel a proposal (status → 'cancelled'). Only transitions from 'active'. */
export function cancelTcProposal(id: number): boolean {
  const res = getDb().prepare(
    "UPDATE tc_proposals SET status = 'cancelled', updated_at = unixepoch() WHERE id = ? AND status = 'active'",
  ).run(id);
  return (res.changes ?? 0) > 0;
}

/**
 * Mark a proposal as settled: writes the canonical outcome and transitions status → 'settled'.
 * Idempotent guard: only updates rows where status = 'active', so a second call returns false.
 */
export function settleTcProposal(
  id: number,
  settledValue: number | null,
  settledOption: string | null,
): boolean {
  const res = getDb().prepare(`
    UPDATE tc_proposals
    SET status = 'settled', settled_value = ?, settled_option = ?,
        settled_at = unixepoch(), updated_at = unixepoch()
    WHERE id = ? AND status = 'active'
  `).run(settledValue, settledOption, id);
  return (res.changes ?? 0) > 0;
}

/** Return all active proposals past their end_time, ordered oldest-first (for batch settlement). */
export function listExpiredActiveTcs(): TcProposal[] {
  const now = Math.floor(Date.now() / 1000);
  const rows = getDb().prepare(
    "SELECT * FROM tc_proposals WHERE status = 'active' AND end_time <= ? ORDER BY end_time ASC",
  ).all(now) as Array<Record<string, unknown>>;
  return rows.map(rowToProposal);
}

/** Return all active proposals ordered by num ASC (for operator listing). */
export function listActiveTcs(): TcProposal[] {
  const rows = getDb().prepare(
    "SELECT * FROM tc_proposals WHERE status = 'active' ORDER BY num ASC",
  ).all() as Array<Record<string, unknown>>;
  return rows.map(rowToProposal);
}

/**
 * Active proposals bound to a chat, newest first.
 * Bets are associated by chat rather than by thread: the group event stream does not carry a
 * thread id, so a bet is matched to the chat's active proposal(s) instead of a reply thread.
 */
export function listActiveTcsByChat(chatId: string): TcProposal[] {
  const rows = getDb().prepare(
    "SELECT * FROM tc_proposals WHERE chat_id = ? AND status = 'active' ORDER BY num DESC",
  ).all(chatId) as Array<Record<string, unknown>>;
  return rows.map(rowToProposal);
}

/** Return the most recent proposals across all statuses (for history view). */
export function listAllTcs(limit = 20): TcProposal[] {
  const rows = getDb().prepare(
    'SELECT * FROM tc_proposals ORDER BY num DESC LIMIT ?',
  ).all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToProposal);
}

// ── Bet CRUD ──────────────────────────────────────────────────

export function insertTcBet(bet: TcBetInput): number {
  const res = getDb().prepare(`
    INSERT INTO tc_bets (proposal_id, user_open_id, option_value, lp_amount, message_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(bet.proposalId, bet.userOpenId, bet.optionValue, bet.lpAmount, bet.messageId ?? '');
  return Number(res.lastInsertRowid);
}

/** Return all bets for a proposal, ordered by creation time (for settlement and display). */
export function getTcBets(proposalId: number): TcBet[] {
  const rows = getDb().prepare(
    'SELECT * FROM tc_bets WHERE proposal_id = ? ORDER BY created_at ASC',
  ).all(proposalId) as Array<Record<string, unknown>>;
  return rows.map(rowToBet);
}

/** Sum of LP across all non-refunded bets a user has placed on a given proposal. */
export function getUserTotalBetLp(proposalId: number, userOpenId: string): number {
  const row = getDb().prepare(
    'SELECT COALESCE(SUM(lp_amount), 0) AS total FROM tc_bets WHERE proposal_id = ? AND user_open_id = ? AND is_refunded = 0',
  ).get(proposalId, userOpenId) as { total: number };
  return row.total;
}

/** Return all non-refunded bets for a proposal (used as the input set for refund or settlement). */
export function getUnrefundedBets(proposalId: number): TcBet[] {
  const rows = getDb().prepare(
    'SELECT * FROM tc_bets WHERE proposal_id = ? AND is_refunded = 0 ORDER BY id ASC',
  ).all(proposalId) as Array<Record<string, unknown>>;
  return rows.map(rowToBet);
}

/**
 * Mark a single bet as refunded. Idempotent: only transitions is_refunded 0 → 1.
 * The caller is responsible for issuing the corresponding grantPt() in shared.db.
 */
export function markBetRefunded(betId: number): boolean {
  const res = getDb().prepare(
    'UPDATE tc_bets SET is_refunded = 1 WHERE id = ? AND is_refunded = 0',
  ).run(betId);
  return (res.changes ?? 0) > 0;
}
