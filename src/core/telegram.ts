import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── Telegram one-way push (agent → Telegram) ───────────────────
// A thin wrapper over the Telegram Bot API used to MIRROR serve logs to a Telegram chat (and, later,
// to push charts/images). It is strictly outbound — no webhook, no inbound updates, no interaction.
//
// Design constraints (all matter):
//  - Never block and never throw into the logging path: log lines are buffered and flushed on a timer
//    via async fetch; failures are swallowed (the local file always keeps the complete log).
//  - Never call back into ./log.ts — this module reports its own diagnostics straight to stderr, so a
//    push failure can never recurse (failure → log → push → failure → …).
//  - Rate-limit aware: Telegram allows ~1 message/second to a single chat. Lines are batched into one
//    message per flush window; multi-chunk flushes are spaced out; a flood is coalesced (head+tail).
//  - Secrets come from the environment (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID), never from configs.

const TG_API = 'https://api.telegram.org';

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
const LEVEL_RANK: Record<Level, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

// Telegram caps a text message at 4096 chars; stay well under it to leave room for safety.
const MAX_MSG_CHARS = 3500;
// Under a debug flood we coalesce the buffer to head+tail with an elision note so we never try to
// ship hundreds of messages (and trip rate limits). The full detail is always in the local log file.
const MAX_BUFFER_LINES = 800;
const KEEP_HEAD = 50;
const KEEP_TAIL = 50;
// Spacing between consecutive chunks within one flush, to respect the ~1 msg/s per-chat limit.
const INTER_CHUNK_MS = 1100;

function token(): string {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}
function chatId(): string {
  return (process.env.TELEGRAM_CHAT_ID || '').trim();
}
/** Target chat for operational alerts (token-expiry reminders); falls back to the log chat. */
function alertChatId(): string {
  return (process.env.TELEGRAM_ALERT_CHAT_ID || '').trim() || chatId();
}

/** Whether both the bot token and target chat id are configured. */
export function isTelegramConfigured(): boolean {
  return Boolean(token() && chatId());
}

// ── log-mirror sink ────────────────────────────────────────────
// Disabled by default; enabled only by the serve command (so one-off CLI commands don't spam Telegram).
let sinkEnabled = false;
let threshold = LEVEL_RANK.INFO;
let flushMs = 3000;
let tag = 'sup'; // distinguishes supervisor vs worker lines (both run `serve`)
let timer: NodeJS.Timeout | null = null;
let sending = false; // guard so timer flushes never overlap
let buffer: string[] = [];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Turn on log mirroring for this process. Idempotent and a no-op when Telegram isn't configured.
 * Called by the `serve` command in both the supervisor and the worker; config is read here (after
 * .env has been loaded) rather than at import time. The flush timer is unref'd so it never keeps the
 * process alive on its own (a short-lived CLI command would otherwise hang on it).
 */
export function enableLogSink(): void {
  if (sinkEnabled || !isTelegramConfigured()) return;
  threshold = LEVEL_RANK[(process.env.TELEGRAM_LOG_LEVEL || '').toUpperCase() as Level] ?? LEVEL_RANK.INFO;
  const ms = Number(process.env.TELEGRAM_FLUSH_MS);
  flushMs = Number.isFinite(ms) && ms >= 1000 ? ms : 3000;
  tag = process.env.AGENT_WORKER ? 'wkr' : 'sup';
  sinkEnabled = true;
  timer = setInterval(() => {
    void flushAsync();
  }, flushMs);
  timer.unref();
}

/**
 * Buffer one already-formatted log line (with trailing newline) for the next flush. Called from
 * log.ts on every emit, BEFORE its local LOG_LEVEL gate, so the Telegram threshold is independent.
 * A no-op unless the sink is enabled and the line meets TELEGRAM_LOG_LEVEL.
 */
export function pushLogLine(level: string, line: string): void {
  if (!sinkEnabled) return;
  const rank = LEVEL_RANK[level as Level] ?? LEVEL_RANK.INFO;
  if (rank < threshold) return;
  buffer.push(`[${tag}] ${line.replace(/\n+$/, '')}`);
  if (buffer.length > MAX_BUFFER_LINES) {
    const omitted = buffer.length - KEEP_HEAD - KEEP_TAIL;
    buffer = [
      ...buffer.slice(0, KEEP_HEAD),
      `… 省略 ${omitted} 行（完整见本地日志）…`,
      ...buffer.slice(-KEEP_TAIL),
    ];
  }
}

/** Pack lines into messages each <= maxChars, joining with newlines; hard-splits any over-long line. */
function* chunkLines(lines: string[], maxChars: number): Generator<string> {
  let cur = '';
  for (const raw of lines) {
    let line = raw;
    while (line.length > maxChars) {
      if (cur) {
        yield cur;
        cur = '';
      }
      yield line.slice(0, maxChars);
      line = line.slice(maxChars);
    }
    if (!cur) cur = line;
    else if (cur.length + 1 + line.length <= maxChars) cur += `\n${line}`;
    else {
      yield cur;
      cur = line;
    }
  }
  if (cur) yield cur;
}

/** POST one plain-text message (no parse_mode, so arbitrary log content can't break formatting). */
async function postMessage(text: string): Promise<void> {
  const res = await fetch(`${TG_API}/bot${token()}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId(), text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

/** Drain the buffer to Telegram. Never overlaps; on failure the batch is dropped (kept in local log). */
async function flushAsync(): Promise<void> {
  if (sending || buffer.length === 0) return;
  sending = true;
  const lines = buffer;
  buffer = [];
  try {
    let first = true;
    for (const chunk of chunkLines(lines, MAX_MSG_CHARS)) {
      if (!first) await sleep(INTER_CHUNK_MS);
      first = false;
      await postMessage(chunk);
    }
  } catch (e) {
    process.stderr.write(`[telegram] 推送失败（已丢弃本批，完整见本地日志）：${(e as Error).message}\n`);
  } finally {
    sending = false;
  }
}

/**
 * Best-effort SYNCHRONOUS drain of whatever is still buffered, for use in shutdown handlers that call
 * process.exit() right after (an async flush would never complete). Uses curl so it actually blocks
 * until sent; any failure is swallowed (the local log file is complete regardless).
 */
export function flushTelegramSync(): void {
  if (!sinkEnabled || buffer.length === 0 || !isTelegramConfigured()) return;
  const lines = buffer;
  buffer = [];
  try {
    for (const chunk of chunkLines(lines, MAX_MSG_CHARS)) {
      const payload = JSON.stringify({ chat_id: chatId(), text: chunk, disable_web_page_preview: true });
      execFileSync(
        'curl',
        ['-s', '-m', '5', '-X', 'POST', `${TG_API}/bot${token()}/sendMessage`, '-H', 'content-type: application/json', '--data-binary', payload],
        { stdio: 'ignore' }
      );
    }
  } catch (e) {
    process.stderr.write(`[telegram] 退出前同步冲刷失败：${(e as Error).message}\n`);
  }
}

// ── direct sends (ops notifications / charts) ──────────────────

/** Send a single plain-text message immediately (used by `agent tg-test` and ad-hoc notifications). */
export async function sendTelegramMessage(text: string): Promise<void> {
  if (!isTelegramConfigured()) throw new Error('未配置 Telegram：缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID');
  await postMessage(text.slice(0, 4096));
}

/**
 * Push a one-off operational alert to the alert chat (TELEGRAM_ALERT_CHAT_ID, else the log chat).
 * Strictly best-effort: returns false and never throws when the bot token or chat is unconfigured, or
 * on any transport failure, so background watchers can fire-and-forget. Independent of the log sink,
 * so alerts go out even when log mirroring is disabled.
 */
export async function sendTelegramAlert(text: string): Promise<boolean> {
  const tk = token();
  const chat = alertChatId();
  if (!tk || !chat) return false;
  try {
    const res = await fetch(`${TG_API}/bot${tk}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4096), disable_web_page_preview: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Send a photo with an optional caption. `image` may be a Buffer, a local file path, or an http(s)
 * URL (Telegram fetches the URL itself). Phase-2 chart pushing builds on this.
 */
export async function sendTelegramPhoto(image: Buffer | string, caption?: string): Promise<void> {
  if (!isTelegramConfigured()) throw new Error('未配置 Telegram：缺少 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID');
  const form = new FormData();
  form.set('chat_id', chatId());
  if (caption) form.set('caption', caption.slice(0, 1024));
  if (typeof image === 'string' && /^https?:\/\//.test(image)) {
    form.set('photo', image);
  } else {
    const buf = typeof image === 'string' ? fs.readFileSync(image) : image;
    const name = typeof image === 'string' ? path.basename(image) : 'chart.png';
    // Copy into a fresh ArrayBuffer so the Blob part type is unambiguous (Node's Buffer maps to a
    // SharedArrayBuffer-union view that BlobPart rejects).
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(buf);
    form.set('photo', new Blob([ab]), name);
  }
  const res = await fetch(`${TG_API}/bot${token()}/sendPhoto`, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}
