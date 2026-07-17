import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// Walk up from this file's location to find the repo root (the level containing package.json).
// After compilation it is at dist/core/paths.js, source is at src/core/paths.ts; two levels up should be the repo root in both cases.
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const REPO_ROOT = findRepoRoot();
// soul personality and memory live in workspaces/<agent>/; runtime (cursor, auth, transcript) lives in .agent/.
export const SOULS_DIR = path.join(REPO_ROOT, 'workspaces');
export const RUNTIME_DIR = path.join(REPO_ROOT, '.agent');
// Defaults to <repo>/configs; override with AGENT_CONFIGS_DIR (used by tests for an isolated,
// self-contained config fixture, and by deployments that keep configs outside the repo tree).
export const CONFIGS_DIR = process.env.AGENT_CONFIGS_DIR
  ? path.resolve(process.env.AGENT_CONFIGS_DIR)
  : path.join(REPO_ROOT, 'configs');
export const DIST_DIR = path.join(REPO_ROOT, 'dist');

/** Compiled path of the framework's built-in MCP tool server (requires npm run build first) */
export const MCP_SERVER_JS = path.join(DIST_DIR, 'tools', 'mcp-server.js');

/** Resolve the kimi CLI executable: KIMI_BIN env → PATH and common install dirs → fallback. */
export function resolveKimiBin(): string {
  if (process.env.KIMI_BIN) return process.env.KIMI_BIN;

  const win = process.platform === 'win32';
  // kimi-code installs as `kimi`; keep the legacy `kimi-cli` name as a fallback (`.exe` on Windows).
  const names = win ? ['kimi.exe', 'kimi-cli.exe'] : ['kimi', 'kimi-cli'];
  const home = process.env.HOME || process.env.USERPROFILE || '';
  // kimi-code's data root (KIMI_CODE_HOME, default ~/.kimi-code) holds the bundled binary under bin/.
  const kimiHome = process.env.KIMI_CODE_HOME || (home ? path.join(home, '.kimi-code') : '');
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const dirs = [
    ...pathDirs,
    kimiHome ? path.join(kimiHome, 'bin') : '',
    home ? path.join(home, '.local', 'bin') : '',
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ].filter(Boolean);

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* ignore unreadable dirs */
      }
    }
  }
  return names[0]; // fall back to PATH resolution at spawn time
}

/** Resolve lark-cli's run.js (run directly with node to avoid the Windows .cmd shim and encoding issues) */
export function resolveLarkRun(): string | null {
  if (process.env.LARK_RUN) return process.env.LARK_RUN;

  const rel = path.join('@larksuite', 'cli', 'scripts', 'run.js');
  const nodeDir = path.dirname(process.execPath); // directory containing the node executable
  const candidates = [
    // Windows: global install under nvm_symlink
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'nvm_symlink', 'node_modules', rel)
      : '',
    // macOS / Linux (including nvm) and standard installs: <prefix>/lib/node_modules
    path.join(nodeDir, '..', 'lib', 'node_modules', rel),
    // Windows standard install: node_modules alongside node
    path.join(nodeDir, 'node_modules', rel),
  ];

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Build the kimi-code MCP config JSON that exposes the framework's built-in tool server
 * (Feishu messaging, member roster, etc.) to a session. Returns undefined when the server
 * bundle is not yet built. The optional feishuChatId binds tool actions to one chat; omit it
 * for contexts that have no fixed target (e.g. a background heartbeat that decides recipients).
 */
export function buildAgentMcpConfig(opts: {
  soul: string;
  larkProfile?: string;
  feishuChatId?: string;
  /** Feishu message id of the triggering turn; exposed to the MCP tool subprocess as
   *  AGENT_TURN_REF so pt_grant can tag its ledger writes with this turn's ref. Omitted for
   *  contexts with no triggering message (heartbeat / peer / CLI) — mirrors the optionality of
   *  AGENT_FEISHU_CHAT / LARK_PROFILE below. */
  turnRef?: string;
}): string | undefined {
  if (!fs.existsSync(MCP_SERVER_JS)) return undefined;
  const env: Record<string, string> = { AGENT_SOUL: opts.soul };
  if (opts.feishuChatId) env.AGENT_FEISHU_CHAT = opts.feishuChatId;
  if (opts.larkProfile) env.LARK_PROFILE = opts.larkProfile;
  if (opts.turnRef) env.AGENT_TURN_REF = opts.turnRef;
  const larkRun = resolveLarkRun();
  if (larkRun) env.LARK_RUN = larkRun;
  if (process.env.APPDATA) env.APPDATA = process.env.APPDATA;
  return JSON.stringify({
    mcpServers: {
      agent: {
        command: process.execPath, // use the same node
        args: [MCP_SERVER_JS],
        env,
      },
    },
  });
}
