import fs from 'node:fs';
import path from 'node:path';
import { SOULS_DIR } from './paths.js';
import { memoryContext } from './memory.js';
import { getChatPolicy, getChatTier, getTierPolicyText } from './configs.js';

// ── Soul persona assembler ───────────────────────────────────────────
// Read the standard persona files under workspaces/<name>/, assemble them into a single system
// prompt in a fixed order. kimi-code has no --agent-file flag: the caller writes this markdown to a
// project-local .kimi-code/AGENTS.md, which kimi-code loads as the agent's instructions.

// Standard persona assembly order
const SOUL_FILES = [
  'IDENTITY.md', // name, role, emoji
  'SOUL.md', // personality, core values
  'AGENTS.md', // work rules, safety boundaries
  'TOOLS.md', // tools/environment settings
  'USER.md', // user data
  'BOOT.md', // boot instructions
  'HEARTBEAT.md', // background task list
];

export interface AssembledSoul {
  /** soul name */
  name: string;
  /** Assembled system prompt (markdown), to be written as the agent's .kimi-code/AGENTS.md */
  systemPrompt: string;
}

function soulDir(name: string): string {
  return path.join(SOULS_DIR, name);
}

export function soulExists(name: string): boolean {
  return fs.existsSync(soulDir(name));
}

export function listSouls(): string[] {
  if (!fs.existsSync(SOULS_DIR)) return [];
  return fs
    .readdirSync(SOULS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// Underscore-prefixed workspaces (e.g. _shared, _template) are tooling directories, not runnable agents.
export function isToolingWorkspace(name: string): boolean {
  return name.startsWith('_');
}

export interface AssembleSoulOptions {
  /**
   * Chat id of the active conversation. When provided, the per-chat policy's
   * systemPromptAppend is appended to the assembled prompt.
   */
  chatId?: string;
}

/**
 * Assemble a soul: read persona files + inject memory → return the system prompt markdown.
 * When chatId is supplied, the matching chat policy's systemPromptAppend is appended so
 * each group can receive a tailored prompt strategy without modifying the soul files.
 * The caller materializes the result as the agent's .kimi-code/AGENTS.md.
 */
export function assembleSoul(name: string, opts?: AssembleSoulOptions): AssembledSoul {
  const dir = soulDir(name);
  if (!fs.existsSync(dir)) {
    throw new Error(`找不到 soul：${name}（预期目录 ${dir}）`);
  }

  const sections: string[] = [];
  for (const file of SOUL_FILES) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8').trim();
      if (content) sections.push(content);
    }
  }
  if (sections.length === 0) {
    throw new Error(`soul ${name} 没有任何人格档（IDENTITY.md / SOUL.md ...）`);
  }

  // Inject static soul-level memory (playbooks / journal entries).
  const mem = memoryContext(name);
  if (mem) {
    sections.push(`## 你的記憶\n${mem}`);
  }

  // Append tier policy and per-chat supplement when a chat id is provided.
  // The tier policy text is always appended (from file or built-in default);
  // the per-chat systemPromptAppend is optional and stacks on top.
  if (opts?.chatId) {
    const tier = getChatTier(opts.chatId);
    sections.push(getTierPolicyText(tier));
    const policy = getChatPolicy(opts.chatId);
    if (policy?.systemPromptAppend) {
      sections.push(policy.systemPromptAppend.trim());
    }
  }

  const systemPrompt = sections.join('\n\n---\n\n') + '\n';
  return { name, systemPrompt };
}
