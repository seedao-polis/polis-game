// ── Group topic aggregator ────────────────────────────────────────────────────
// Deterministic frequency-based hot-topic extraction from recent chat history.
// No LLM involved — the result is reproducible for a given set of messages, which
// makes it straightforward to unit-test. The aggregate is written to a group-scoped
// memory entry so it is automatically injected into group prompts via the existing
// prepare() injection path.

import { getRecentMessagesForChat, upsertMemory } from './store/memory.js';

// ── Tokenizer ─────────────────────────────────────────────────────────────────
// Strategy: consecutive ASCII alphanumeric runs become one token (English words,
// numbers); consecutive CJK code-points produce both unigrams and bigrams so that
// two-character Chinese terms are captured without a dictionary. Punctuation,
// whitespace, and single-char ASCII are discarded.

const CJK_RANGE = /[一-鿿㐀-䶿 0-⩭f가-힯]/;

function isCjk(ch: string): boolean {
  return CJK_RANGE.test(ch);
}

/**
 * Tokenize a mixed Chinese/English message text into candidate words for frequency
 * counting. English/number runs are kept as-is; CJK characters produce unigrams and
 * overlapping bigrams so that compound terms like "社区" are captured.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/[A-Za-z0-9]/.test(ch)) {
      // Collect the full ASCII run.
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9]/.test(text[j]!)) j++;
      const word = text.slice(i, j).toLowerCase();
      if (word.length >= 2) tokens.push(word);
      i = j;
    } else if (isCjk(ch)) {
      // Unigram
      tokens.push(ch);
      // Bigram with the next CJK character, if any.
      if (i + 1 < text.length && isCjk(text[i + 1]!)) {
        tokens.push(text[i]! + text[i + 1]!);
      }
      i++;
    } else {
      i++;
    }
  }
  return tokens;
}

// ── Stop-word list ─────────────────────────────────────────────────────────────
// Common high-frequency tokens that carry no topical signal. Intentionally kept
// short: covering the most frequent Chinese particles and English function words is
// sufficient; rare stop-words will be drowned out by topical content anyway.
const STOP_WORDS = new Set([
  // Chinese particles, pronouns, connectors
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '我们', '你们', '他们',
  '这', '那', '有', '和', '与', '或', '也', '不', '都', '但', '就', '从', '到',
  '很', '还', '对', '会', '要', '吗', '呢', '啊', '嗯', '哦', '哈', '哈哈',
  '一个', '一些', '这个', '那个', '什么', '怎么', '如何', '可以', '可能',
  // English function words
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'to', 'of', 'in', 'on', 'at', 'by', 'for',
  'with', 'and', 'or', 'but', 'not', 'no', 'if', 'so', 'as', 'it',
  'i', 'we', 'you', 'he', 'she', 'they', 'this', 'that',
]);

function isStopWord(token: string): boolean {
  return STOP_WORDS.has(token);
}

/**
 * Given an array of raw message texts, compute the top-N tokens by frequency,
 * excluding stop-words and returning them in descending-frequency order.
 */
export function topTokens(texts: string[], topN = 8): string[] {
  const freq = new Map<string, number>();
  for (const text of texts) {
    for (const tok of tokenize(text)) {
      if (!isStopWord(tok)) {
        freq.set(tok, (freq.get(tok) ?? 0) + 1);
      }
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([tok]) => tok);
}

/**
 * Aggregate the hot topics for a chat from its recent message history and write the
 * result as a 'topics' memory entry in the group:{chatId} namespace.
 *
 * The analysis is deterministic and requires no LLM. The written memory is
 * automatically injected into group prompts via the existing prepare() path because
 * group:{chatId} is in the allowedNamespaces whitelist.
 *
 * Returns the generated summary string (useful for testing and logging).
 */
export async function aggregateGroupTopics(chatId: string): Promise<string> {
  const rows = await getRecentMessagesForChat(chatId, 300);
  const texts = rows.map((r) => r.text).filter(Boolean);

  if (texts.length === 0) return '';

  const top = topTokens(texts, 8);
  if (top.length === 0) return '';

  const summary = `近期话题热词：${top.join('、')}`;

  await upsertMemory({
    namespace: `group:${chatId}`,
    key: 'topics',
    content: summary,
    visibility: 'group',
    source: 'auto',
  });

  return summary;
}
