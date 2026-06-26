import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.js';
import { listPeersInChat } from './configs.js';

// Lightweight off-Feishu coordination bus for same-chat agents.
//
// Feishu drops every app-sent message before another bot can hear it, so bots cannot see each
// other talk in a group. The bus works around that: when an agent speaks in a chat it writes a
// short cue (who said what, in which chat) to every same-chat peer's inbox. A peer reads the cue
// and decides whether to chime in — producing a conversation that, to humans in the group, looks
// like the agents are talking to each other on Feishu.
//
// Paths are anchored to REPO_ROOT (never process.cwd) so they resolve identically from a serve
// process and from the heartbeat's throwaway workDir.
export const PEER_BUS_DIR = path.join(REPO_ROOT, 'data', 'peer-bus');

// Anti-loop chain limits. A chain a human never joined winds down on its own.
// agentChainDepth: human-initiated turn = 1, each agent hop +1; stop at/after the cap.
export const MAX_AGENT_CHAIN_DEPTH = 6;
// budget: total agent messages a single chain may emit before it must stop.
export const DEFAULT_CHAIN_BUDGET = 8;

export interface PeerCue {
  from: string;
  chatId: string;
  topic: string;
  message: string;
  budget: number;
  agentChainDepth: number;
}

interface StoredCue extends PeerCue {
  timestamp: string;
  read: boolean;
}

function inboxFile(soul: string): string {
  return path.join(PEER_BUS_DIR, soul, 'inbox.jsonl');
}

/** Ensure a soul's inbox file exists (so a watcher can attach to it) and return its path. */
export function ensureInbox(soul: string): string {
  const file = inboxFile(soul);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
  return file;
}

/**
 * Append a cue to every other agent that listens to the same chat (peers resolved from the agent
 * roster, so collaboration is config-driven, not hard-coded). Returns the soul names written to.
 */
export function broadcastCue(cue: PeerCue): string[] {
  const peers = listPeersInChat(cue.chatId, cue.from);
  if (peers.length === 0) return [];
  const stored: StoredCue = { ...cue, timestamp: new Date().toISOString(), read: false };
  const line = JSON.stringify(stored) + '\n';
  for (const peer of peers) {
    const dir = path.join(PEER_BUS_DIR, peer);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'inbox.jsonl'), line, 'utf8');
  }
  return peers;
}

/** True when the soul has at least one unread cue (cheap check to avoid waking the LLM needlessly). */
export function hasUnreadCue(soul: string): boolean {
  const file = inboxFile(soul);
  if (!fs.existsSync(file)) return false;
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .some((l) => {
        try { return !(JSON.parse(l) as StoredCue).read; } catch { return false; }
      });
  } catch {
    return false;
  }
}

/** Read a soul's unread cues (oldest→newest), marking them read in place. */
export function readUnreadCues(soul: string): PeerCue[] {
  const file = inboxFile(soul);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const unread: PeerCue[] = [];
  const rewritten = lines.map((l) => {
    let obj: StoredCue;
    try { obj = JSON.parse(l) as StoredCue; } catch { return l; }
    if (!obj.read) {
      unread.push({
        from: obj.from,
        chatId: obj.chatId,
        topic: obj.topic,
        message: obj.message,
        budget: obj.budget,
        agentChainDepth: obj.agentChainDepth,
      });
      obj.read = true;
    }
    return JSON.stringify(obj);
  });
  if (unread.length > 0) fs.writeFileSync(file, rewritten.join('\n') + '\n', 'utf8');
  return unread;
}
