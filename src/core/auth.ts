import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR } from './paths.js';
import { authStatus, sendText } from './lark.js';
import { log } from './log.js';

// ── Login expiry tracking and reminders ───────────────────────
// The lark token refresh expires in about 7 days; the device flow re-login needs a browser and cannot be fully automated.
// On startup and during the daily check, run auth status to get refreshExpiresAt and write a local record;
// when near expiry (<24h) or already expired, return an attention flag and optionally send a message to notifyChat to prompt a manual re-login.

const NEAR_EXPIRY_MS = 24 * 60 * 60 * 1000; // within 24 hours of expiry is treated as "near expiry"

export interface AuthRecord {
  profile: string;
  checkedAt: string;
  refreshExpiresAt: string | null;
  loggedIn: boolean;
}

export interface AuthCheckResult extends AuthRecord {
  /** Whether it is near expiry or already expired and a manual re-login should be prompted */
  needsAttention: boolean;
  /** Milliseconds until expiry (null means the expiry time could not be obtained) */
  remainingMs: number | null;
}

function authDir(): string {
  return path.join(RUNTIME_DIR, 'auth');
}

function authFile(profile: string): string {
  return path.join(authDir(), `${profile}.json`);
}

/** Best-effort extraction of refreshExpiresAt from the auth status object (tolerating different field names). */
function extractRefreshExpiresAt(auth: any): string | null {
  const user = auth?.identities?.user ?? {};
  const candidates = [
    user.refreshExpiresAt,
    user.refresh_expires_at,
    user.refreshTokenExpiresAt,
    auth?.refreshExpiresAt,
    auth?.refresh_expires_at,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c;
    if (typeof c === 'number' && c > 0) {
      // support both second and millisecond timestamps
      const ms = c < 1e12 ? c * 1000 : c;
      return new Date(ms).toISOString();
    }
  }
  return null;
}

function isLoggedInFrom(auth: any): boolean {
  const user = auth?.identities?.user;
  return !!(user && (user.available || user.status === 'ready'));
}

/**
 * Check and record the login expiry status for a given profile.
 * - Run auth status to get refreshExpiresAt
 * - Write .agent/auth/<profile>.json (checkedAt / refreshExpiresAt / loggedIn)
 * - When near expiry or already expired, log.warn and (if notifyChat is given) send a reminder message
 */
export function checkAndRecord(
  profile: string,
  notifyChat?: string
): AuthCheckResult {
  let auth: any;
  try {
    auth = authStatus(profile);
  } catch (e) {
    log.error(`auth status 查询失败（profile=${profile}）：`, (e as Error).message);
    auth = {};
  }

  const refreshExpiresAt = extractRefreshExpiresAt(auth);
  const loggedIn = isLoggedInFrom(auth);
  const now = Date.now();

  let remainingMs: number | null = null;
  if (refreshExpiresAt) {
    const t = Date.parse(refreshExpiresAt);
    if (!Number.isNaN(t)) remainingMs = t - now;
  }

  const record: AuthRecord = {
    profile,
    checkedAt: new Date(now).toISOString(),
    refreshExpiresAt,
    loggedIn,
  };

  // write the local record
  try {
    const f = authFile(profile);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(record, null, 2), 'utf8');
  } catch (e) {
    log.warn(`写入 auth 记录失败（profile=${profile}）：`, (e as Error).message);
  }

  const needsAttention =
    !loggedIn || (remainingMs !== null && remainingMs < NEAR_EXPIRY_MS);

  if (needsAttention) {
    const human =
      remainingMs === null
        ? '无法获取到期时间'
        : remainingMs <= 0
          ? '已过期'
          : `约 ${Math.round(remainingMs / 3_600_000)} 小时后到期`;
    const msg = `飞书登录即将/已到期（profile=${profile}，${human}）。请执行 lark-cli --profile ${profile} auth login --domain im 重新登录。`;
    log.warn(msg);
    if (notifyChat) {
      try {
        sendText({ chatId: notifyChat }, `⚠ ${msg}`, { as: 'user', profile });
      } catch (e) {
        log.warn('发送到期提醒失败：', (e as Error).message);
      }
    }
  }

  return { ...record, needsAttention, remainingMs };
}
