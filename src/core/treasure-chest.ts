import { getLpDb } from './db.js';
import { spendPt, grantPt, getProfile, findOpenIdsByName, hasBadge } from './store/gamification.js';
import { memberName } from './store/members.js';
import { parseCommand, parseLpAmount } from './commands.js';

// Treasure chest module: owner-only virtual LP accounts. A chest's balance lives in the shared
// pt_ledger/profiles under its chest_id (an opaque string, treated exactly like any member's
// open_id); the chests table only records ownership metadata. Deposit and withdrawal are
// deterministic, LLM-free commands gated on `sender === chest.ownerOpenId` — never routed through
// the unauthenticated MCP `pt_grant` tool.

/** Fixed id of the one "公益宝箱" instance that automatically receives a community-prediction
 *  settlement contribution (see predict-settlement.ts). */
export const PUBLIC_WELFARE_CHEST_ID = 'chest:public-welfare';
/** Owner of the 公益宝箱 — Ricky Wang's primary account (admin, verified in the member directory). */
export const PUBLIC_WELFARE_CHEST_OWNER = 'ou_9686d5436aaa04bde9953ef40b5bc4c3';
/** Badge that gates chest creation: only holders of 宝箱怪的朋友 may create a chest, keeping the chest
 *  namespace curated instead of open to everyone. The system-created 公益宝箱 goes through createChest
 *  directly (not the command layer), so it is never subject to this gate. */
export const CHEST_KEEPER_BADGE_ID = 'chest_keeper';

export interface Chest {
  chestId: string;
  name: string;
  ownerOpenId: string;
  isPublic: boolean;
  createdAt: number;
}

export interface CreateChestInput {
  chestId: string;
  name: string;
  ownerOpenId: string;
  isPublic?: boolean;
}

export type ChestOpError = 'not_found' | 'not_owner' | 'insufficient_balance' | 'invalid_amount';

function rowToChest(row: Record<string, unknown>): Chest {
  return {
    chestId: String(row['chest_id']),
    name: String(row['name'] ?? ''),
    ownerOpenId: String(row['owner_open_id'] ?? ''),
    isPublic: Number(row['is_public']) === 1,
    createdAt: Number(row['created_at']),
  };
}

export async function getChest(chestId: string): Promise<Chest | null> {
  const db = await getLpDb();
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM chests WHERE chest_id = $1', [chestId]);
  return rows[0] ? rowToChest(rows[0]) : null;
}

/** Look up a chest by its display name (the name members type in "宝箱 <名称>" commands). */
export async function getChestByName(name: string): Promise<Chest | null> {
  const db = await getLpDb();
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT * FROM chests WHERE name = $1 ORDER BY created_at ASC LIMIT 1', [name],
  );
  return rows[0] ? rowToChest(rows[0]) : null;
}

/** All chests owned by a given open_id. */
export async function listChestsByOwner(ownerOpenId: string): Promise<Chest[]> {
  const db = await getLpDb();
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT * FROM chests WHERE owner_open_id = $1 ORDER BY created_at ASC', [ownerOpenId],
  );
  return rows.map(rowToChest);
}

/**
 * Create a chest. NOT an upsert: a second "creation" call for the same chest_id is silently ignored
 * (created:false, existing ownership untouched) rather than reassigning ownership — otherwise anyone
 * could hijack an existing chest by "recreating" it under their own open_id. Ledger initialization
 * uses grantPt(chestId, 0, ...) rather than spendPt, so a brand-new chest account never triggers the
 * 120 LP first-contact gift (that gift lives in ensureProfileRaw, which only spendPt/recordInteraction
 * call — grantPt's upsertProfileRaw is a plain no-side-effect upsert).
 */
export async function createChest(input: CreateChestInput): Promise<{ chest: Chest; created: boolean }> {
  const db = await getLpDb();
  const { rowCount } = await db.query(`
    INSERT INTO chests(chest_id, name, owner_open_id, is_public)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (chest_id) DO NOTHING
  `, [input.chestId, input.name, input.ownerOpenId, input.isPublic ? 1 : 0]);
  const created = rowCount > 0;
  if (created) {
    await grantPt(input.chestId, 0, 'chest_create');
  }
  return { chest: (await getChest(input.chestId))!, created };
}

/** Idempotently ensure the one public-welfare chest exists, owned by Ricky. Safe to call every settlement. */
export async function ensurePublicWelfareChest(): Promise<Chest> {
  return (await createChest({
    chestId: PUBLIC_WELFARE_CHEST_ID,
    name: '公益宝箱',
    ownerOpenId: PUBLIC_WELFARE_CHEST_OWNER,
    isPublic: true,
  })).chest;
}

/** Current LP balance of a chest (or any account) — a thin read over the shared profiles table. */
export async function chestBalance(chestId: string): Promise<number> {
  return (await getProfile(chestId))?.ptBalance ?? 0;
}

/**
 * Move LP from one account to another (both live in the same shared pt_ledger, so both legs are
 * covered by grantPt/spendPt's own lpTx). Debits first with reason `${reason}:out`; on success credits
 * with `${reason}:in`. Returns insufficient_balance without any write when the debit fails.
 */
export async function transferPt(
  from: string,
  to: string,
  amount: number,
  reason: string,
  ref?: string,
): Promise<{ ok: true } | { ok: false; error: 'insufficient_balance' }> {
  const spent = await spendPt(from, amount, `${reason}:out`, ref);
  if (!spent) return { ok: false, error: 'insufficient_balance' };
  await grantPt(to, amount, `${reason}:in`, ref);
  return { ok: true };
}

/** Deposit LP from the chest's owner into the chest. Owner-only. */
export async function chestDeposit(
  chestId: string,
  senderOpenId: string,
  amount: number,
  ref?: string,
): Promise<{ ok: true; balance: number } | { ok: false; error: ChestOpError }> {
  const chest = await getChest(chestId);
  if (!chest) return { ok: false, error: 'not_found' };
  if (senderOpenId !== chest.ownerOpenId) return { ok: false, error: 'not_owner' };
  if (!(amount > 0)) return { ok: false, error: 'invalid_amount' };
  const result = await transferPt(senderOpenId, chestId, amount, 'chest_deposit', ref);
  if (!result.ok) return result;
  return { ok: true, balance: await chestBalance(chestId) };
}

/** Withdraw LP from the chest to a target account. Owner-only. */
export async function chestWithdraw(
  chestId: string,
  senderOpenId: string,
  targetOpenId: string,
  amount: number,
  ref?: string,
): Promise<{ ok: true; balance: number } | { ok: false; error: ChestOpError }> {
  const chest = await getChest(chestId);
  if (!chest) return { ok: false, error: 'not_found' };
  if (senderOpenId !== chest.ownerOpenId) return { ok: false, error: 'not_owner' };
  if (!(amount > 0)) return { ok: false, error: 'invalid_amount' };
  const result = await transferPt(chestId, targetOpenId, amount, 'chest_withdraw', ref);
  if (!result.ok) return result;
  return { ok: true, balance: await chestBalance(chestId) };
}

/** Deterministic, human-legible chest id derived from its display name. */
function deriveChestId(name: string): string {
  return `chest:${name.trim()}`;
}

const CHEST_USAGE =
  '用法：\n' +
  '  宝箱 创建 <名称>          — 创建宝箱，你将成为拥有者\n' +
  '  宝箱 <名称>              — 查询宝箱余额\n' +
  '  宝箱 <名称> 存入 <金额>   — 【仅拥有者】从自己账户存入\n' +
  '  宝箱 <名称> 转出 @某人 <金额> — 【仅拥有者】从宝箱转出给某人';

/**
 * Handle an in-group chest command. Deterministic — never touches the LLM. Query is open to anyone;
 * deposit / withdraw are gated on `sender === chest.ownerOpenId`. Must run before the bet parser (like
 * the community-prediction announce/cancel commands), since "宝箱 X 转出 @某人 3" ends in a number.
 */
export async function tryHandleChestCommand(
  rawText: string,
  senderOpenId: string,
): Promise<{ reply: string } | false> {
  const cmd = parseCommand(rawText);
  if (!cmd) return false;
  if (cmd.name !== '宝箱' && cmd.name !== 'chest') return false;
  const args = cmd.args;
  if (!senderOpenId) return { reply: '无法确认你的身份，请在飞书群内使用此命令。' };
  if (args.length === 0) return { reply: CHEST_USAGE };

  const first = args[0]!;
  if (first === '创建' || first.toLowerCase() === 'create') {
    if (!(await hasBadge(senderOpenId, CHEST_KEEPER_BADGE_ID))) {
      return { reply: '只有持有【宝箱怪的朋友】徽章的成员才能创建宝箱，先找管理员申请这枚徽章吧。' };
    }
    const name = args.slice(1).join(' ').trim();
    if (!name) return { reply: '用法：宝箱 创建 <名称>' };
    if ([...name].length > 40) return { reply: '宝箱名称太长，请换一个短一点的（≤40 字）再试。' };
    const chestId = deriveChestId(name);
    const { chest, created } = await createChest({ chestId, name, ownerOpenId: senderOpenId });
    if (!created) {
      return chest.ownerOpenId === senderOpenId
        ? { reply: `宝箱【${name}】你之前已经创建过了，直接发【宝箱 ${name}】即可查询。` }
        : { reply: `宝箱【${name}】这个名字已经被占用了，换一个名字再试。` };
    }
    return {
      reply: `宝箱【${name}】已创建，你是它的拥有者。\n` +
             `存入：宝箱 ${name} 存入 <金额>\n` +
             `转出：宝箱 ${name} 转出 @某人 <金额>`,
    };
  }

  // Everything else: args[0] is the chest name; an optional args[1] is the sub-action.
  const name = first.trim();
  const chest = await getChestByName(name);
  if (!chest) return { reply: `找不到宝箱【${name}】。用【宝箱 创建 <名称>】新建一个。` };

  const sub = args[1];
  if (!sub) {
    // Bare "宝箱 <名称>" — balance query, open to anyone.
    const balance = await chestBalance(chest.chestId);
    const ownerName = (await memberName(chest.ownerOpenId)) || chest.ownerOpenId;
    return { reply: `宝箱【${chest.name}】当前余额：${balance.toFixed(1)} LP（拥有者：${ownerName}）` };
  }

  if (sub === '存入' || sub.toLowerCase() === 'deposit') {
    if (senderOpenId !== chest.ownerOpenId) return { reply: `只有宝箱【${chest.name}】的拥有者才能存入。` };
    const amount = parseLpAmount(args.slice(2));
    if (amount === null) return { reply: `用法：宝箱 ${chest.name} 存入 <金额>，例如「宝箱 ${chest.name} 存入 5」。` };
    const result = await chestDeposit(chest.chestId, senderOpenId, amount);
    if (!result.ok) {
      return { reply: result.error === 'insufficient_balance' ? 'LP 余额不足，存入失败。' : '存入失败，请重试。' };
    }
    return { reply: `已向宝箱【${chest.name}】存入 ${amount.toFixed(1)} LP，宝箱当前余额：${result.balance.toFixed(1)} LP。` };
  }

  if (sub === '转出' || sub.toLowerCase() === 'withdraw') {
    if (senderOpenId !== chest.ownerOpenId) return { reply: `只有宝箱【${chest.name}】的拥有者才能转出。` };
    const rest = args.slice(2);
    if (rest.length < 2) {
      return { reply: `用法：宝箱 ${chest.name} 转出 @某人 <金额>，例如「宝箱 ${chest.name} 转出 @小明 3」。` };
    }
    const amount = parseLpAmount(rest.slice(-1));
    if (amount === null) {
      return { reply: `用法：宝箱 ${chest.name} 转出 @某人 <金额>，例如「宝箱 ${chest.name} 转出 @小明 3」。` };
    }
    const targetToken = rest.slice(0, -1).join(' ').trim().replace(/^@/, '');
    if (!targetToken) return { reply: '请指定转出对象，例如「宝箱 公益宝箱 转出 @小明 3」。' };
    let targetOpenId: string;
    if (targetToken.startsWith('ou_')) {
      targetOpenId = targetToken;
    } else {
      const matches = await findOpenIdsByName(targetToken);
      if (matches.length === 0) return { reply: `找不到成员【${targetToken}】，请确认名字或改用 open_id（ou_ 开头）。` };
      if (matches.length > 1) return { reply: `【${targetToken}】匹配到多个成员，请改用 open_id（ou_ 开头）指定。` };
      targetOpenId = matches[0]!.openId;
    }
    const result = await chestWithdraw(chest.chestId, senderOpenId, targetOpenId, amount);
    if (!result.ok) {
      return { reply: result.error === 'insufficient_balance' ? `宝箱【${chest.name}】余额不足，转出失败。` : '转出失败，请重试。' };
    }
    const targetName = (await memberName(targetOpenId)) || targetOpenId;
    return { reply: `已从宝箱【${chest.name}】转出 ${amount.toFixed(1)} LP 给 ${targetName}，宝箱当前余额：${result.balance.toFixed(1)} LP。` };
  }

  return { reply: CHEST_USAGE };
}
