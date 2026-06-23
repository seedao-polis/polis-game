import { execFileSync, execFile, type StdioOptions } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Shared child-process helpers for the CLI wrappers (lark-cli, kimi-code).
//
// Both wrappers run an external binary, capture its output, and need a *uniform* view of failures —
// but Node spreads the failure details across different fields for the sync and async APIs:
//   execFileSync error: exit code on `.status`, system code (ENOENT/ETIMEDOUT) on `.code`
//   execFileAsync error: exit code on `.code` (number) OR system code on `.code` (string)
// normalizeExecError() folds both shapes into one {@link ExecError}, so callers classify failures
// in one place instead of re-deriving the status-vs-code dance.

/** Normalized failure detail for a child process, unified across the sync and async exec APIs. */
export interface ExecError {
  /** error.message from the underlying exec call. */
  message: string;
  /** Process exit code, or null when the process was killed / never started. */
  exitCode: number | null;
  /** Terminating signal (e.g. 'SIGTERM'), or null. */
  signal: string | null;
  /** Whether the process was killed (timeout / signal). */
  killed: boolean;
  /** System error code (e.g. 'ENOENT', 'ETIMEDOUT'), or null. */
  sysCode: string | null;
  /** Captured stdout (empty when stdout was not piped). */
  stdout: string;
  /** Captured stderr (empty when stderr was not piped/inherited). */
  stderr: string;
}

/** Result of running a child process. `ok` is true iff the process exited 0; otherwise `error` is set. */
export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** stdout followed by stderr — handy for CLIs that print JSON/error envelopes to either stream. */
  combined: string;
  error?: ExecError;
}

export interface RunOptions {
  cwd?: string;
  /** Max bytes captured from stdout/stderr before the call errors. */
  maxBuffer?: number;
  /** Kill the process after this many milliseconds. */
  timeout?: number;
  /** stdio configuration; omit to use the exec API default (sync inherits stderr, async pipes it). */
  stdio?: StdioOptions;
}

/** Fold a caught exec error (sync or async) into the unified {@link ExecError} shape. */
export function normalizeExecError(e: unknown): ExecError {
  const err = e as {
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    message?: string;
    status?: number | null;
    code?: string | number | null;
    signal?: string | null;
    killed?: boolean;
  };
  const exitCode =
    typeof err.status === 'number'
      ? err.status
      : typeof err.code === 'number'
        ? err.code
        : null;
  return {
    message: (err.message ?? '').toString(),
    exitCode,
    signal: typeof err.signal === 'string' ? err.signal : null,
    killed: err.killed === true,
    sysCode: typeof err.code === 'string' ? err.code : null,
    stdout: (err.stdout ?? '').toString(),
    stderr: (err.stderr ?? '').toString(),
  };
}

function toResult(stdout: string, stderr: string): ExecResult {
  return { ok: true, stdout, stderr, combined: stdout + stderr };
}

function toErrorResult(error: ExecError): ExecResult {
  return { ok: false, stdout: error.stdout, stderr: error.stderr, combined: error.stdout + error.stderr, error };
}

/**
 * Run a binary synchronously, capturing output. Never throws on a non-zero exit — the failure is
 * returned as `{ ok: false, error }`. Output is decoded as UTF-8.
 */
export function runFileSync(file: string, args: string[], opts: RunOptions = {}): ExecResult {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf8',
      cwd: opts.cwd,
      maxBuffer: opts.maxBuffer,
      timeout: opts.timeout,
      ...(opts.stdio ? { stdio: opts.stdio } : {}),
    });
    return toResult(stdout ?? '', '');
  } catch (e) {
    return toErrorResult(normalizeExecError(e));
  }
}

/**
 * Run a binary asynchronously without blocking the event loop, capturing output. Never rejects on a
 * non-zero exit — the failure is returned as `{ ok: false, error }`. Output is decoded as UTF-8.
 */
export async function runFileAsync(file: string, args: string[], opts: RunOptions = {}): Promise<ExecResult> {
  try {
    const res = await execFileAsync(file, args, {
      encoding: 'utf8',
      cwd: opts.cwd,
      maxBuffer: opts.maxBuffer,
      timeout: opts.timeout,
      ...(opts.stdio ? { stdio: opts.stdio } : {}),
    });
    return toResult(res.stdout?.toString() ?? '', res.stderr?.toString() ?? '');
  } catch (e) {
    return toErrorResult(normalizeExecError(e));
  }
}
