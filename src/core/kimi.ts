import { resolveKimiBin } from './paths.js';
import { preview } from './log.js';
import { runFileSync, runFileAsync, type ExecError } from './subprocess.js';

// ── kimi-code driver (hardcoded to Kimi, not adapted to other models) ─────────
// One-shot Q&A in headless mode via `kimi -p <prompt>`.
// kimi-code is config-file driven, not flag driven: the soul personality lives in
// <workDir>/.kimi-code/AGENTS.md and the framework tools in <workDir>/.kimi-code/mcp.json
// (both written by the caller before invoking). We only pass runtime flags here.
//   --output-format stream-json : machine-readable, one JSON object per line (clean final text,
//                                 no thinking noise / resume-hint footer).
//   --continue                  : resume the previous kimi session bound to this workDir (cwd),
//                                 giving a chat short-term memory across calls.
//   --skills-dir <dir>          : load Agent Skills from <dir>, replacing kimi's auto-discovered user/project skill roots; repeatable to stack multiple roots.
//   -p <prompt>                 : run a single prompt non-interactively; tool calls auto-execute
//                                 (no TTY = auto-approve; -p cannot be combined with --yolo/--auto).

export interface KimiRunOptions {
  /** User input to send to the agent (the final prompt) */
  prompt: string;
  /** Working directory: the agent's cwd, and where its .kimi-code/ config (AGENTS.md, mcp.json) lives */
  workDir: string;
  /** Continue the previous kimi session for this workDir (per-chat short-term memory) */
  continueSession?: boolean;
  /** Timeout in milliseconds (default 180s, leaving time for tool calls) */
  timeoutMs?: number;
  /** Extra CLI flags passed straight through to kimi (from the kimi profile) */
  extraArgs?: string[];
  /** Skill roots loaded by kimi via repeated --skills-dir flags (replaces auto-discovery) */
  skillsDirs?: string[];
}

const MAX_BUFFER = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes — research-heavy turns can run long

/**
 * Classification of a kimi-code failure. Drives self-healing decisions in the caller:
 * - corrupt-session: the resumed session has an assistant tool_call with no tool result; the
 *   provider rejects every --continue replay with HTTP 400 forever. Heal = reset the session.
 * - transient: network / upstream blip (HTTP 000/5xx/429, ECONNRESET, …). Heal = retry.
 * - timeout: our own execFileSync timeout killed kimi mid-turn; this is what *creates* a
 *   corrupt session, so heal = validate + quarantine the session before anything else.
 * - empty-output: kimi returned no assistant text (often only emitted tool calls then stopped).
 * - content-rejected: the provider's content moderation / risk control rejected the prompt (a 400
 *   "high risk"). Deterministic, so NOT retryable — fall back instead of retrying the same prompt.
 * - config: kimi binary missing / auth / bad flags — not self-healable.
 * - unknown: anything unclassified.
 */
export type KimiErrorKind =
  | 'corrupt-session'
  | 'session-missing'
  | 'transient'
  | 'timeout'
  | 'empty-output'
  | 'content-rejected'
  | 'config'
  | 'unknown';

export interface KimiFailureContext {
  exitCode: number | null;
  signal: string | null;
  killed: boolean;
  sysCode: string | null;
}

/** A structured kimi-code failure. message is a short safe summary; full detail lives in fields. */
export class KimiError extends Error {
  readonly kind: KimiErrorKind;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly killed: boolean;
  readonly sysCode: string | null;
  readonly durationMs: number;
  readonly workDir: string;
  /** Full stderr captured from kimi (may be large — e.g. a dumped HTML page). */
  readonly stderr: string;
  /** Full stdout captured from kimi (the stream-json transcript). */
  readonly stdout: string;
  /** Correlation id, attached by the caller so logs/ledger/postmortem line up. */
  corrId?: string;

  constructor(
    kind: KimiErrorKind,
    detail: string,
    ctx: KimiFailureContext & { durationMs: number; workDir: string; stderr?: string; stdout?: string }
  ) {
    super(KimiError.summarize(kind, detail, ctx));
    this.name = 'KimiError';
    this.kind = kind;
    this.exitCode = ctx.exitCode;
    this.signal = ctx.signal;
    this.killed = ctx.killed;
    this.sysCode = ctx.sysCode;
    this.durationMs = ctx.durationMs;
    this.workDir = ctx.workDir;
    this.stderr = ctx.stderr ?? '';
    this.stdout = ctx.stdout ?? '';
  }

  /** Whether retrying could plausibly help (drives the self-heal loop). */
  get retryable(): boolean {
    return (
      this.kind === 'corrupt-session' ||
      this.kind === 'session-missing' ||
      this.kind === 'transient' ||
      this.kind === 'empty-output'
    );
  }

  /** One-line, log-safe summary (no giant stderr dumps). */
  static summarize(
    kind: KimiErrorKind,
    detail: string,
    ctx: { exitCode: number | null; signal: string | null; durationMs: number }
  ): string {
    const bits = [
      `kind=${kind}`,
      ctx.exitCode != null ? `exit=${ctx.exitCode}` : null,
      ctx.signal ? `signal=${ctx.signal}` : null,
      `dur=${Math.round(ctx.durationMs)}ms`,
    ].filter(Boolean);
    return `kimi-code 执行失败（${bits.join(' ')}）：${preview(detail, 80, 40) || '未知错误'}`;
  }

  /** Full multi-line postmortem text for the error log file. */
  postmortem(): string {
    return [
      `kind        : ${this.kind}`,
      `summary     : ${this.message}`,
      `exitCode    : ${this.exitCode}`,
      `signal      : ${this.signal}`,
      `killed      : ${this.killed}`,
      `sysCode     : ${this.sysCode}`,
      `durationMs  : ${Math.round(this.durationMs)}`,
      `workDir     : ${this.workDir}`,
      this.corrId ? `corrId      : ${this.corrId}` : '',
      '',
      '── stderr ──',
      this.stderr.trim() || '(空)',
      '',
      '── stdout (tail) ──',
      this.stdout.slice(-4000).trim() || '(空)',
      '',
    ]
      .filter((l) => l !== '')
      .join('\n');
  }
}

/** Classify a kimi failure from its stderr/stdout text + process exit metadata. */
export function classifyKimiError(detail: string, ctx: KimiFailureContext): KimiErrorKind {
  const d = (detail || '').toLowerCase();
  // The sticky one: an assistant tool_call left without a tool response in the resumed session.
  if (
    /did not have response messages|must be followed by tool messages|tool_call_id|'tool_calls'|"tool_calls"/.test(d)
  ) {
    return 'corrupt-session';
  }
  // Provider-side content moderation / risk control rejected the prompt (e.g. Moonshot 400 "The request
  // was rejected because it was considered high risk"). Deterministic — the identical prompt is rejected
  // again — so this is NOT retryable; fail fast to the generic fallback instead of burning a full retry.
  // Checked before session-missing because kimi prints a benign "starting a fresh session" line first
  // when it had to start fresh, which would otherwise mask the real failure and trigger a pointless retry.
  if (/considered high risk|request was rejected because|命中.{0,6}(风险|安全)|内容(风险|违规)|风险(内容|策略)/.test(d)) {
    return 'content-rejected';
  }
  // --continue pointed at a session that no longer exists (e.g. it was quarantined/removed).
  // Recoverable: retry without --continue to start a fresh session.
  if (/session\b.*\bnot found|was not found|no sessions? to continue/.test(d)) {
    return 'session-missing';
  }
  // Binary missing / auth — not self-healable.
  if (ctx.sysCode === 'ENOENT' || /command not found|no such file|enoent/.test(d)) return 'config';
  if (/unauthor|invalid api key|api key|credential|missing token|\b401\b|\b403\b|forbidden/.test(d)) {
    return 'config';
  }
  // Our own timeout (Node SIGTERM-killed the child) — the prime cause of corrupt sessions.
  if (ctx.sysCode === 'ETIMEDOUT' || (ctx.killed && (ctx.signal === 'SIGTERM' || ctx.signal === 'SIGKILL'))) {
    return 'timeout';
  }
  // Network / upstream blips.
  if (
    /http 000|http 5\d\d|http 429|\b502\b|\b503\b|\b504\b|\b429\b|econnreset|etimedout|enotfound|eai_again|socket hang up|network|timed out|temporarily|rate limit|upstream|connection (refused|reset)/.test(
      d
    )
  ) {
    return 'transient';
  }
  return 'unknown';
}

/** Build the kimi CLI argv from run options. */
export function buildArgs(opts: KimiRunOptions): string[] {
  const args: string[] = ['--output-format', 'stream-json'];
  if (opts.continueSession) args.push('--continue');
  if (opts.skillsDirs?.length) {
    for (const dir of opts.skillsDirs) args.push('--skills-dir', dir);
  }
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  args.push('-p', opts.prompt);
  return args;
}

/** Convert a normalized exec failure into a classified {@link KimiError}. */
function toKimiError(err: ExecError, opts: KimiRunOptions, startedAt: number): KimiError {
  const detail = (err.stderr || err.stdout || err.message || '').trim();
  const ctx: KimiFailureContext = {
    exitCode: err.exitCode,
    signal: err.signal,
    killed: err.killed,
    sysCode: err.sysCode,
  };
  const kind = classifyKimiError(detail, ctx);
  return new KimiError(kind, detail, {
    ...ctx,
    durationMs: Date.now() - startedAt,
    workDir: opts.workDir,
    stderr: err.stderr,
    stdout: err.stdout,
  });
}

/** Parse the final assistant reply from kimi stdout, or throw a classified KimiError if empty. */
function finalize(out: string, opts: KimiRunOptions, startedAt: number): string {
  const reply = parseFinalMessage(out);
  if (reply) return reply;
  // No assistant text. If the transcript actually carries the corrupt-session signature,
  // surface that (so the caller heals the session) instead of a vague "empty output".
  const ctx: KimiFailureContext = { exitCode: 0, signal: null, killed: false, sysCode: null };
  const kind = classifyKimiError(out, ctx);
  throw new KimiError(kind === 'unknown' ? 'empty-output' : kind, out.slice(0, 400).trim() || '(空输出)', {
    ...ctx,
    durationMs: Date.now() - startedAt,
    workDir: opts.workDir,
    stdout: out,
  });
}

/**
 * Synchronously call kimi-code and return the final assistant message (plain text).
 * On failure throws a {@link KimiError} carrying a classification + full stderr/stdout so the
 * caller can log richly and decide how to self-heal. Blocks the event loop — prefer
 * {@link runKimiAsync} from request handlers that must stay responsive (e.g. the bot channel).
 */
export function runKimi(opts: KimiRunOptions): string {
  const startedAt = Date.now();
  // No stdio override: keep execFileSync's default so kimi's own progress on stderr stays visible
  // in the console while still being captured for failure classification.
  const r = runFileSync(resolveKimiBin(), buildArgs(opts), {
    cwd: opts.workDir,
    maxBuffer: MAX_BUFFER,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!r.ok) throw toKimiError(r.error!, opts, startedAt);
  return finalize(r.stdout, opts, startedAt);
}

/**
 * Asynchronous twin of {@link runKimi}: spawns kimi as a child process without blocking the event
 * loop, so the caller can keep receiving (and reacting to) new messages while a reply is generated.
 */
export async function runKimiAsync(opts: KimiRunOptions): Promise<string> {
  const startedAt = Date.now();
  const r = await runFileAsync(resolveKimiBin(), buildArgs(opts), {
    cwd: opts.workDir,
    maxBuffer: MAX_BUFFER,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!r.ok) throw toKimiError(r.error!, opts, startedAt);
  return finalize(r.stdout, opts, startedAt);
}

/**
 * Parse kimi-code `--output-format stream-json`: one JSON object per line. The final reply is the
 * last `{ "role": "assistant", "content": "<text>" }` line — tool-call-only assistant lines carry
 * `tool_calls` instead of a string `content`, and `meta` / `tool` lines are ignored.
 */
function parseFinalMessage(raw: string): string {
  let last = '';
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let obj: { role?: string; content?: unknown };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // skip any non-JSON notices (e.g. "No sessions to continue ...")
    }
    if (obj.role === 'assistant' && typeof obj.content === 'string' && obj.content.trim()) {
      last = obj.content.trim();
    }
  }
  return last;
}
