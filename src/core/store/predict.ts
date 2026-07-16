import { getDb, tx } from '../db.js';

// Community Prediction module data layer — modeled closely on store/tc.ts, but discrete-option-only
// and judge-announced (no automatic settlement algorithm, so there is no settled_value / thread_id).

// ── Type definitions ──────────────────────────────────────────

export type PredictStatus = 'active' | 'settled' | 'cancelled';

export interface PredictProposal {
  id: number;
  num: number;
  title: string;
  optionType: 'discrete';
  options: string[];
  endTime: number;
  minBetLp: number;
  maxBetLp: number;
  status: PredictStatus;
  createdBy: string;
  chatId: string;
  topMessageId: string;
  /** open_id of the predict_judge badge holder who announced the winning option, once settled. */
  announcedBy: string;
  /** The judge-announced winning option, once settled. */
  settledOption: string | null;
  settledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PredictProposalInput {
  title: string;
  options: string[];
  endTime: number;
  maxBetLp?: number;
  createdBy?: string;
  chatId?: string;
}

export interface PredictBet {
  id: number;
  proposalId: number;
  userOpenId: string;
  optionValue: string;
  lpAmount: number;
  messageId: string;
  isRefunded: boolean;
  createdAt: number;
}

export interface PredictBetInput {
  proposalId: number;
  userOpenId: string;
  optionValue: string;
  lpAmount: number;
  messageId?: string;
}

// ── Row → typed object converters ────────────────────────────

function rowToProposal(row: Record<string, unknown>): PredictProposal {
  let options: string[];
  try {
    options = JSON.parse(String(row['options'] ?? '[]'));
  } catch {
    options = [];
  }
  return {
    id: Number(row['id']),
    num: Number(row['num']),
    title: String(row['title'] ?? ''),
    optionType: 'discrete',
    options,
    endTime: Number(row['end_time']),
    minBetLp: Number(row['min_bet_lp'] ?? 1),
    maxBetLp: Number(row['max_bet_lp'] ?? 10),
    status: String(row['status'] ?? 'active') as PredictStatus,
    createdBy: String(row['created_by'] ?? ''),
    chatId: String(row['chat_id'] ?? ''),
    topMessageId: String(row['top_message_id'] ?? ''),
    announcedBy: String(row['announced_by'] ?? ''),
    settledOption: row['settled_option'] != null ? String(row['settled_option']) : null,
    settledAt: row['settled_at'] != null ? Number(row['settled_at']) : null,
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
}

function rowToBet(row: Record<string, unknown>): PredictBet {
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
export function nextPredictNumUnsafe(): number {
  const db = getDb();
  const row = db.prepare('SELECT next_num FROM predict_counter WHERE id = 1').get() as { next_num: number };
  const num = row.next_num;
  db.prepare('UPDATE predict_counter SET next_num = next_num + 1 WHERE id = 1').run();
  return num;
}

// ── Proposal CRUD ─────────────────────────────────────────────

/**
 * Atomically create a new proposal: assign a number and INSERT in a single tx().
 * Returns the auto-increment id and the assigned proposal number.
 */
export function insertPredictProposal(input: PredictProposalInput): { id: number; num: number } {
  return tx(() => {
    const num = nextPredictNumUnsafe();
    const db = getDb();
    const res = db.prepare(`
      INSERT INTO predict_proposals
        (num, title, option_type, options, end_time, min_bet_lp, max_bet_lp,
         created_by, chat_id, status)
      VALUES (?, ?, 'discrete', ?, ?, 1.0, ?, ?, ?, 'active')
    `).run(
      num,
      input.title,
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
export function updatePredictTopMessageId(id: number, topMessageId: string): boolean {
  const res = getDb().prepare(
    'UPDATE predict_proposals SET top_message_id = ?, updated_at = unixepoch() WHERE id = ?',
  ).run(topMessageId, id);
  return (res.changes ?? 0) > 0;
}

export function getPredictByNum(num: number): PredictProposal | null {
  const row = getDb().prepare('SELECT * FROM predict_proposals WHERE num = ?').get(num) as Record<string, unknown> | undefined;
  return row ? rowToProposal(row) : null;
}

export function getPredictById(id: number): PredictProposal | null {
  const row = getDb().prepare('SELECT * FROM predict_proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToProposal(row) : null;
}

export function getPredictByTopMessageId(msgId: string): PredictProposal | null {
  const row = getDb().prepare('SELECT * FROM predict_proposals WHERE top_message_id = ?').get(msgId) as Record<string, unknown> | undefined;
  return row ? rowToProposal(row) : null;
}

/** Soft-cancel a proposal (status → 'cancelled'). Only transitions from 'active'. */
export function cancelPredictProposal(id: number): boolean {
  const res = getDb().prepare(
    "UPDATE predict_proposals SET status = 'cancelled', updated_at = unixepoch() WHERE id = ? AND status = 'active'",
  ).run(id);
  return (res.changes ?? 0) > 0;
}

/**
 * Mark a proposal as settled by a judge announcement: writes the announced winning option and the
 * announcer's open_id, and transitions status → 'settled'.
 * Idempotent guard: only updates rows where status = 'active', so a repeated / duplicate announcement
 * (a judge resending, or a redelivered Feishu event) returns false and grants no LP twice. This gate
 * matters more here than for TC's cron-settled proposals, since a manual announcement has no scheduler
 * backstop deduping it.
 */
export function settlePredictProposal(
  id: number,
  settledOption: string,
  announcedBy: string,
): boolean {
  const res = getDb().prepare(`
    UPDATE predict_proposals
    SET status = 'settled', settled_option = ?, announced_by = ?,
        settled_at = unixepoch(), updated_at = unixepoch()
    WHERE id = ? AND status = 'active'
  `).run(settledOption, announcedBy, id);
  return (res.changes ?? 0) > 0;
}

/** Return all active proposals ordered by num ASC (for operator listing). */
export function listActivePredicts(): PredictProposal[] {
  const rows = getDb().prepare(
    "SELECT * FROM predict_proposals WHERE status = 'active' ORDER BY num ASC",
  ).all() as Array<Record<string, unknown>>;
  return rows.map(rowToProposal);
}

/**
 * Active proposals bound to a chat, newest first.
 * Bets are associated by chat rather than by thread: the group event stream does not carry a
 * thread id, so a bet is matched to the chat's active proposal(s) instead of a reply thread
 * (same lesson TC learned — see tc-betting-playbook §10).
 */
export function listActivePredictsByChat(chatId: string): PredictProposal[] {
  const rows = getDb().prepare(
    "SELECT * FROM predict_proposals WHERE chat_id = ? AND status = 'active' ORDER BY num DESC",
  ).all(chatId) as Array<Record<string, unknown>>;
  return rows.map(rowToProposal);
}

/** Return the most recent proposals across all statuses (for history view). */
export function listAllPredicts(limit = 20): PredictProposal[] {
  const rows = getDb().prepare(
    'SELECT * FROM predict_proposals ORDER BY num DESC LIMIT ?',
  ).all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToProposal);
}

// ── Bet CRUD ──────────────────────────────────────────────────

export function insertPredictBet(bet: PredictBetInput): number {
  const res = getDb().prepare(`
    INSERT INTO predict_bets (proposal_id, user_open_id, option_value, lp_amount, message_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(bet.proposalId, bet.userOpenId, bet.optionValue, bet.lpAmount, bet.messageId ?? '');
  return Number(res.lastInsertRowid);
}

/** Return all bets for a proposal, ordered by creation time (for settlement and display). */
export function getPredictBets(proposalId: number): PredictBet[] {
  const rows = getDb().prepare(
    'SELECT * FROM predict_bets WHERE proposal_id = ? ORDER BY created_at ASC',
  ).all(proposalId) as Array<Record<string, unknown>>;
  return rows.map(rowToBet);
}

/** Sum of LP across all non-refunded bets a user has placed on a given proposal. */
export function getUserTotalBetLp(proposalId: number, userOpenId: string): number {
  const row = getDb().prepare(
    'SELECT COALESCE(SUM(lp_amount), 0) AS total FROM predict_bets WHERE proposal_id = ? AND user_open_id = ? AND is_refunded = 0',
  ).get(proposalId, userOpenId) as { total: number };
  return row.total;
}

/** Return all non-refunded bets for a proposal (used as the input set for refund or settlement). */
export function getUnrefundedBets(proposalId: number): PredictBet[] {
  const rows = getDb().prepare(
    'SELECT * FROM predict_bets WHERE proposal_id = ? AND is_refunded = 0 ORDER BY id ASC',
  ).all(proposalId) as Array<Record<string, unknown>>;
  return rows.map(rowToBet);
}

/**
 * Mark a single bet as refunded. Idempotent: only transitions is_refunded 0 → 1.
 * The caller is responsible for issuing the corresponding grantPt() in shared.db.
 */
export function markBetRefunded(betId: number): boolean {
  const res = getDb().prepare(
    'UPDATE predict_bets SET is_refunded = 1 WHERE id = ? AND is_refunded = 0',
  ).run(betId);
  return (res.changes ?? 0) > 0;
}
