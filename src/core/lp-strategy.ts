import fs from 'node:fs';
import path from 'node:path';
import { SOULS_DIR } from './paths.js';

// Per-soul LP scoring strategy: drives category detection, grant calculation, and footer labels.
// Loaded once per soul and cached in a module-level Map for the lifetime of the process.

/** One classification category in an LP strategy: defines grant amount, ledger reason, and footer display. */
export interface LpCategory {
  /** Token that the model must output in the LP_JUDGE marker line. */
  name: string;
  /** LP points granted for this category (0 means no grantPt call is made). */
  grant: number;
  /** Ledger reason code for the grantPt call. Empty string when grant === 0. */
  reason: string;
  /** Text shown in the footer parentheses (empty string suppresses the label). */
  footerLabel: string;
  /** Whether this category acts as the fallback when no marker is found or the token is unrecognised. */
  isDefault?: boolean;
  /** Human-readable classification criteria injected into the prompt for judgeEnabled souls. */
  criteria?: string;
}

/** Soul-level LP scoring configuration loaded from LP_STRATEGY.json. */
export interface LpStrategy {
  version: number;
  /** When true, the framework injects classification instructions and parses LP_JUDGE markers. */
  judgeEnabled: boolean;
  /** Marker prefix the model must use in the classification line (e.g. "LP_JUDGE"). */
  marker: string;
  /** LP cost deducted before each LLM reply. */
  cost: number;
  /** All possible categories; exactly one must carry isDefault === true (ensured by loadLpStrategy). */
  categories: LpCategory[];
}

// Minimal fallback strategy: mirrors pre-feature behaviour (fixed -0.1 per reply, no classification).
const FALLBACK_STRATEGY: LpStrategy = {
  version: 1,
  judgeEnabled: false,
  marker: 'LP_JUDGE',
  cost: 0.1,
  categories: [{ name: 'default', grant: 0, reason: '', footerLabel: '', isDefault: true }],
};

// Module-level cache: soul name → resolved strategy (populated on first access per soul).
const _cache = new Map<string, LpStrategy>();

/**
 * Load and cache the LP strategy for a soul from its workspace LP_STRATEGY.json.
 * Falls back to the minimal default strategy when the file is absent.
 * Guarantees that exactly one category carries isDefault === true.
 */
export function loadLpStrategy(soul: string): LpStrategy {
  const cached = _cache.get(soul);
  if (cached) return cached;

  const file = path.join(SOULS_DIR, soul, 'LP_STRATEGY.json');
  let strategy: LpStrategy;

  if (!fs.existsSync(file)) {
    strategy = FALLBACK_STRATEGY;
  } else {
    try {
      strategy = JSON.parse(fs.readFileSync(file, 'utf8')) as LpStrategy;
    } catch {
      strategy = FALLBACK_STRATEGY;
    }
  }

  // Ensure exactly one default category exists.
  const hasDefault = strategy.categories.some((c) => c.isDefault);
  if (!hasDefault && strategy.categories.length > 0) {
    // Treat the last category as the implicit default.
    strategy.categories[strategy.categories.length - 1]!.isDefault = true;
  }

  _cache.set(soul, strategy);
  return strategy;
}

/**
 * Return the default (fallback) category from a strategy.
 * Scans for isDefault === true; falls back to categories[0] when none is marked.
 */
export function defaultCategory(strategy: LpStrategy): LpCategory {
  return strategy.categories.find((c) => c.isDefault) ?? strategy.categories[0]!;
}

/**
 * Classify a model reply using the strategy's marker and categories.
 *
 * When judgeEnabled is false, returns the default category immediately without any parsing.
 * When judgeEnabled is true, searches for the last line containing "<marker>: <token>" (tolerates
 * full-width colons, surrounding whitespace, backticks, and asterisks). All marker lines are
 * stripped from the returned reply regardless of whether the token was recognised.
 * Unrecognised tokens and missing markers both fall back to the default category.
 */
export function judgeReply(
  reply: string,
  strategy: LpStrategy,
): { category: LpCategory; reply: string } {
  if (!strategy.judgeEnabled) {
    return { category: defaultCategory(strategy), reply };
  }

  // Escape the marker string for use in a regex.
  const escapedMarker = strategy.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Match a line that contains the marker followed by an optional colon (ASCII or full-width) and a token.
  // Tolerates leading/trailing whitespace, backticks, and asterisks around both marker and token.
  const lineRegex = new RegExp(
    `^[ \\t]*[*\`]*${escapedMarker}[*\`]*[ \\t]*[:：][ \\t]*[*\`]*([^\\n*\`]+?)[*\`]*[ \\t]*$`,
    'gm',
  );

  let lastToken: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = lineRegex.exec(reply)) !== null) {
    lastToken = m[1]?.trim();
  }

  // Strip all marker lines from the reply regardless of whether the token was valid.
  const stripRegex = new RegExp(
    `^[ \\t]*[*\`]*${escapedMarker}[*\`]*[ \\t]*[:：][^\\n]*$`,
    'gm',
  );
  let cleaned = reply.replace(stripRegex, '');
  // Collapse runs of three or more newlines left by removal, then trim trailing whitespace.
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');

  // Resolve the token to a category; fall back to the default when unrecognised.
  let category: LpCategory | undefined;
  if (lastToken) {
    category = strategy.categories.find((c) => c.name === lastToken);
  }
  if (!category) {
    category = defaultCategory(strategy);
  }

  return { category, reply: cleaned };
}

/**
 * Build the Simplified-Chinese classification instruction to inject at the end of the prompt.
 * Returns an empty string when judgeEnabled is false (e.g. tudigong).
 * The instruction tells the model to append exactly one LP_JUDGE marker line per reply,
 * lists every category with its criteria, and explains that the line will be auto-removed.
 */
export function buildJudgeInstruction(strategy: LpStrategy): string {
  if (!strategy.judgeEnabled) return '';

  const lines = strategy.categories
    .filter((c) => c.criteria)
    .map((c) => `- ${c.name}：${c.criteria}`)
    .join('\n');

  return (
    `【评分判定】请在本次回复的最末另起一行，按格式 \`${strategy.marker}: <类别>\` 标注本轮交流的类别` +
    `（只标一个，仅依据【当前对话者】这一轮发言判断）。可选类别：\n${lines}\n` +
    `这一行仅供系统记分，会被自动移除、不会展示给对方。`
  );
}
