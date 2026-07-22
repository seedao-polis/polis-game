import { authStatus } from './lark.js';
import { sendTelegramAlert } from './telegram.js';
import { log } from './log.js';
import { wasTokenExpiryAlertSent, markTokenExpiryAlertSent } from './store.js';

// ── user-token expiry watch ────────────────────────────────────
// The Feishu user token (used for knowledge-base access-record polling) must be renewed by an
// interactive re-login before its refresh token expires; the short access token auto-refreshes and is
// not the signal. This watcher escalates a Telegram reminder as that deadline approaches — one push at
// each day-before mark — and embeds the exact re-authorization command. Reminders are de-duplicated per
// authorization grant, so renewing (which moves the deadline out ~a week) silences them until the next
// cycle. Everything here is best-effort and self-contained so a watch tick never disrupts the channel.

// Day-before-expiry marks at which a reminder fires (3 → 2 → 1 → 0, the last meaning the deadline day
// or later). Ordered most- to least-urgent so a single tick that has crossed several at once (e.g.
// after downtime) reports by the closest mark instead of an over-optimistic one.
const ALERT_THRESHOLDS_DAYS = [0, 1, 2, 3];

const THRESHOLD_LABEL: Record<number, string> = {
  3: '还有约 3 天到期',
  2: '还有约 2 天到期',
  1: '还有约 1 天到期（明天）',
  0: '今天到期或已过期',
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Re-authorization command that preserves the current scope set. `auth login --scope` overwrites the
 * grant, so the renewed scopes must equal the current ones — echoing the live scope list keeps every
 * existing capability (im / calendar / drive / wiki / offline_access) intact.
 */
function renewCommand(profile: string, scopes: string[]): string {
  return `lark-cli --profile ${profile} auth login --scope "${scopes.join(' ')}"`;
}

/** Compose the reminder text, including remaining-time wording and the renewal command. */
function buildAlert(profile: string, mark: number, scopes: string[]): string {
  return (
    `【城邦土地神 提醒】飞书 user token ${THRESHOLD_LABEL[mark] ?? '即将到期'}（profile ${profile}）。\n` +
    `到期后知识库文档访问采集会停摆，请在终端重新授权（会打开浏览器完成）：\n\n` +
    `${renewCommand(profile, scopes)}\n\n` +
    `重新授权后本提醒自动停止。`
  );
}

/** Human-readable summary of the user token's remaining lifetime, for CLI inspection. */
export async function describeTokenExpiry(profile: string): Promise<string> {
  const user = (await authStatus(profile))?.identities?.user;
  const expiryIso = user?.refreshExpiresAt;
  if (typeof expiryIso !== 'string' || !expiryIso) return '无法读取 user token 到期时间（可能未登录或字段缺失）。';
  const ms = Date.parse(expiryIso);
  if (!Number.isFinite(ms)) return `user token 到期时间无法解析：${expiryIso}`;
  const daysLeft = (ms - Date.now()) / MS_PER_DAY;
  return `user token 刷新令牌到期：${new Date(ms).toLocaleString()}（约剩 ${daysLeft.toFixed(1)} 天）`;
}

/**
 * Inspect the user token's remaining lifetime and push escalating Telegram reminders at the 3/2/1/0-day
 * marks as the refresh-token deadline nears. Marks already sent for the current grant are skipped; when
 * several have been crossed at once only one message is sent (worded by the closest mark) and all are
 * recorded. Safe to call repeatedly on a timer.
 */
export async function checkUserTokenExpiry(profile: string): Promise<void> {
  try {
    const user = (await authStatus(profile))?.identities?.user;
    const expiryIso = user?.refreshExpiresAt;
    if (typeof expiryIso !== 'string' || !expiryIso) return;
    const expiryMs = Date.parse(expiryIso);
    if (!Number.isFinite(expiryMs)) return;

    // The grant key changes whenever the token is re-authorized, giving each grant its own reminder
    // schedule. grantedAt pins it to a specific login; the expiry timestamp is a fallback.
    const grantStamp = typeof user?.grantedAt === 'string' ? user.grantedAt : expiryIso;
    const grantKey = `${profile}:${grantStamp}`;
    const daysLeft = (expiryMs - Date.now()) / MS_PER_DAY;
    const scopes = typeof user?.scope === 'string' ? user.scope.split(/\s+/).filter(Boolean) : [];

    // Resolve each threshold's "already sent" check concurrently, then filter synchronously on the
    // resolved values — .filter() itself cannot await, and an unresolved Promise is always truthy, so
    // negating it inline would silently disable every reminder.
    const checked = await Promise.all(
      ALERT_THRESHOLDS_DAYS.map(async (mark) => ({
        mark,
        eligible: daysLeft <= mark && !(await wasTokenExpiryAlertSent(grantKey, mark)),
      })),
    );
    const crossed = checked.filter((c) => c.eligible).map((c) => c.mark);
    if (crossed.length === 0) return;

    const closest = Math.min(...crossed);
    const ok = await sendTelegramAlert(buildAlert(profile, closest, scopes));
    if (ok) {
      // Record every crossed mark so passed thresholds never re-fire, while a send failure leaves them
      // unmarked to retry on the next tick.
      for (const mark of crossed) await markTokenExpiryAlertSent(grantKey, mark);
      log.info(`已推送 token 到期提醒（${THRESHOLD_LABEL[closest]}）到 Telegram。`);
    } else {
      log.warn('token 到期提醒推送失败，下一轮重试。');
    }
  } catch (e) {
    log.warn('token 到期检查失败：', (e as Error).message);
  }
}
