// Deterministic outbound-message guards for the LLM-facing feishu_send tool.
//
// The model occasionally "tests" its tools by blasting a placeholder such as
// "测试" to every group it can reach. Observed 2026-07-01: tudigong's heartbeat
// run fanned "测试" out to 5 community chats. Prompt-level restraint is not
// reliable for this (the heartbeat playbook already relies on hard gates, not
// LLM self-discipline), so these guards reject the two signatures right at the
// send chokepoint.

// Normalized placeholder tokens that are never a real message to a community.
const TEST_TOKENS = new Set([
  '测试', '測試', 'test', 'testing', 'tests', 'test123', 'testmessage',
  '测试消息', '測試訊息', '测试一下', '測試一下', '测试测试', '測試測試',
  'ping', 'pong', '123', '1234', '12345', '111', '000',
  'abc', 'asdf', 'qwer', 'zxcv',
]);

// Same content sent to this many distinct chats inside the window is treated as
// a broadcast-spam signature. Real broadcasts go through the event system, not
// this per-chat tool.
const FANOUT_WINDOW_MS = 120_000;
const FANOUT_MAX_CHATS = 3;

/** Strip whitespace / punctuation / symbols and lowercase, for token matching. */
export function normalizeForGuard(text: string): string {
  return text.trim().toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * True when the text is empty or an obvious test / placeholder token that
 * should never be sent to a community chat.
 */
export function isMeaninglessMessage(text: string): boolean {
  if (!text || !text.trim()) return true;
  const norm = normalizeForGuard(text);
  if (!norm) return true; // only whitespace / punctuation / emoji
  if (TEST_TOKENS.has(norm)) return true;
  // A short run of a single ASCII letter/digit ("aaaa", "1111") is noise; CJK
  // repeats like "哈哈哈" are legitimate and deliberately excluded.
  if (norm.length <= 6 && /^([a-z0-9])\1*$/.test(norm)) return true;
  return false;
}

export interface FanoutState {
  map: Map<string, { chats: Set<string>; first: number }>;
}

export function newFanoutState(): FanoutState {
  return { map: new Map() };
}

/**
 * Register a send of `text` to `chatId` at time `now`; return true if this send
 * should be BLOCKED because the identical content already reached
 * FANOUT_MAX_CHATS distinct chats within the window. Re-sending to a chat that
 * already received it is allowed (not a fan-out).
 */
export function isFanoutFlood(
  state: FanoutState,
  text: string,
  chatId: string,
  now: number
): boolean {
  const key = normalizeForGuard(text);
  if (!key) return false; // empties are handled by the meaningless guard
  const rec = state.map.get(key);
  if (!rec || now - rec.first > FANOUT_WINDOW_MS) {
    state.map.set(key, { chats: new Set([chatId]), first: now });
    return false;
  }
  if (rec.chats.has(chatId)) return false;
  if (rec.chats.size >= FANOUT_MAX_CHATS) return true;
  rec.chats.add(chatId);
  return false;
}
