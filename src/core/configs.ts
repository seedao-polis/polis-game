import fs from 'node:fs';
import path from 'node:path';
import { CONFIGS_DIR } from './paths.js';
import { listChats } from './lark.js';
import { log } from './log.js';

// ── Centralized configuration layer ───────────────────────────
// Read configs/agents.json / lark.json / kimi.json, merge defaults with the lark/kimi profiles,
// and resolve listen ("all-internal" or an array of aliases) into the actual list of oc_ chats.
// configs only holds "connection / identity / listen scope / wiring"; tokens do not go into configs.

export type Identity = 'user' | 'bot';
export type TriggerMode = 'mention' | 'prefix' | 'all';

// When a response is needed, first add this reaction as a "thinking / answering now" indicator and
// remove it after replying (emoji_type, overridable in configs). Status_PrivateMessage is the
// "thinking" status emoji (Thinking/ThinkingFace are invalid emoji_type values on Feishu).
const DEFAULT_REACTION_EMOJI = 'Status_PrivateMessage';
// While a reply is queued behind another (serial processing), show this "please wait" reaction
// instead; it switches to the thinking reaction once it is this message's turn to be answered.
// OnIt is a confirmed-valid Feishu emoji_type (Coffee was unverified).
const DEFAULT_QUEUED_EMOJI = 'OnIt';

// Lark profile name used as the final fallback when an agent/soul does not map to a
// profile of its own. Operators name their canonical profile this so a fresh soul
// (or one without dedicated credentials) still has something to connect with.
const DEFAULT_LARK_PROFILE = 'default';

export interface DefaultsConfig {
  /** Fallback lark profile name when an agent has no `lark` and no soul-named profile. Optional; resolution still falls back to the built-in `default` profile. */
  lark?: string;
  kimi: string;
  pollIntervalMs: number;
  contextSize: number;
  reactionEmoji?: string;
  queuedReactionEmoji?: string;
}

export interface RawAgentConfig {
  enabled?: boolean;
  soul: string;
  workspace?: string;
  identity: Identity;
  lark?: string;
  kimi?: string;
  listen: 'all-internal' | 'all' | string[];
  exclude?: string[];
  capture?: boolean;
  trigger?: TriggerMode;
  triggerPrefix?: string;
  /** Prefix prepended to replies in the USER channel only (messages appear under the operator's own
   *  account there, so a name prefix disambiguates the agent). The BOT channel adds no prefix — the bot
   *  already has its own display name in Feishu. */
  replyPrefix?: string;
  pollIntervalMs?: number;
  contextSize?: number;
  reactionEmoji?: string;
  queuedReactionEmoji?: string;
  /** When true, the agent also responds (not just collects) in external/cross-tenant groups. */
  interactExternal?: boolean;
  /** When true, the channel only collects/syncs (roster, doc-view, RSVP, message capture) and never
   *  replies. Lets the user-token data collection run without ever answering on the operator's behalf. */
  collectOnly?: boolean;
}

export interface AgentsFile {
  version: number;
  defaults: DefaultsConfig;
  agents: Record<string, RawAgentConfig>;
}

export interface LarkProfile {
  larkProfile: string;
  appId: string;
  tenantKey: string;
  userOpenId: string;
  botOpenId: string;
  botName: string;
}

export interface LarkFile {
  version: number;
  larkRun: string | null;
  profiles: Record<string, LarkProfile>;
  knownInternalChats: Record<string, string>;
  notifyChat: string;
  discovery: { mode: string; refreshMinutes: number };
  event: { key: string };
}

export interface KimiProfile {
  kimiBin: string | null;
  timeoutMs: number;
  sessionScope: 'per-chat' | 'per-message';
  extraArgs: string[];
  /** Inline self-heal retry budget on a recoverable kimi failure (default 1, i.e. up to 2 attempts). */
  maxRetries?: number;
}

export interface KimiFile {
  version: number;
  profiles: Record<string, KimiProfile>;
}

export interface Configs {
  agents: AgentsFile;
  lark: LarkFile;
  kimi: KimiFile;
}

// ── Chat policy configuration (chat-policies.json) ───────────────────────
// Per-group prompt overrides: each chat_id maps to a policy that controls
// the group tier and optional system-prompt appends for that chat.
// Tier-level policy text is resolved from tierPolicies (file) then BUILTIN_TIER_POLICY (fallback).

/** Three-tier group classification set by operators in chat-policies.json. */
export type ChatTier = 'public' | 'member' | 'work';

export interface ChatPolicy {
  /** Human-readable label for this chat (used in logs). */
  name: string;
  /** Tier classification for this chat. */
  tier: ChatTier;
  /** Optional extra text appended after the tier policy in the assembled system prompt. */
  systemPromptAppend?: string;
}

export interface ChatPoliciesFile {
  version: number;
  /** Per-chat tier overrides; operator can set custom tier policy text per tier. */
  tierPolicies?: Partial<Record<ChatTier, string>>;
  /** Default tier for chats not listed in chatPolicies. */
  defaultTier?: ChatTier;
  chatPolicies: Record<string, ChatPolicy>;
}

/**
 * Built-in tier policy text used when the operator has not supplied a custom tierPolicies entry.
 * These are the authoritative defaults for each tier level.
 */
export const BUILTIN_TIER_POLICY: Record<ChatTier, string> = {
  public:
    '你现在所在的是公开群，面向外部观察者与潜在参与者。可以介绍 SeeDAO 的公开信息、公开活动与参与方式；不要透露会员群、工作群的内部事务、未公开决策或成员私人信息。语气友善、简洁、偏公开传播。',
  member:
    '你现在所在的是会员群，面向 SeeDAO 会员。可以讨论面向会员的事务与活动；但不要透露工作群的内部运营细节或未公开决策。语气亲切、具体。',
  work: '你现在所在的是工作群，面向核心工作成员。可以讨论社区内部运营、治理、协作等各类事务。',
};

// ── Admin identity configuration (admins.json) ────────────────────────────────
// Lists the open_ids that are granted admin-level memory access (admin_only visibility).
// The file is optional; when absent, the effective admin list is empty.

export interface AdminsFile {
  version: number;
  admins: string[];
}

let _admins: AdminsFile | null = null;

/**
 * Load and cache the admins.json configuration. When the file is absent, returns an
 * empty admin list. Safe to call repeatedly — the file is parsed only once per process.
 */
export function loadAdmins(): AdminsFile {
  if (_admins) return _admins;
  const file = resolveConfigFile(path.join(CONFIGS_DIR, 'admins.json'));
  if (!fs.existsSync(file)) {
    _admins = { version: 1, admins: [] };
    return _admins;
  }
  _admins = readJson<AdminsFile>(file);
  return _admins;
}

/**
 * Return true when the given open_id appears in the admins list.
 */
export function isAdmin(openId: string): boolean {
  const cfg = loadAdmins();
  return cfg.admins.includes(openId);
}

let _chatPolicies: ChatPoliciesFile | null = null;

/**
 * Load and cache the chat-policies.json configuration. Returns the full file.
 * Safe to call repeatedly; the file is parsed only once per process.
 */
export function loadChatPolicies(): ChatPoliciesFile {
  if (_chatPolicies) return _chatPolicies;
  const file = resolveConfigFile(path.join(CONFIGS_DIR, 'chat-policies.json'));
  if (!fs.existsSync(file)) {
    _chatPolicies = { version: 2, chatPolicies: {} };
    return _chatPolicies;
  }
  _chatPolicies = readJson<ChatPoliciesFile>(file);
  return _chatPolicies;
}

/**
 * Look up the policy for a specific chat id. Returns null when no policy is configured
 * for that chat (callers should apply no override in that case).
 */
export function getChatPolicy(chatId: string): ChatPolicy | null {
  const cfg = loadChatPolicies();
  return cfg.chatPolicies[chatId] ?? null;
}

/**
 * Return the tier classification for a chat. Falls back to the file-level defaultTier,
 * then to 'public' when neither the chat nor the file has an explicit setting.
 */
export function getChatTier(chatId: string): ChatTier {
  const cfg = loadChatPolicies();
  const policy = cfg.chatPolicies[chatId];
  return policy?.tier ?? cfg.defaultTier ?? 'public';
}

/**
 * Return the system-prompt policy text for a given tier. Uses the operator-supplied
 * tierPolicies entry when present, falling back to the built-in constant.
 */
export function getTierPolicyText(tier: ChatTier): string {
  const cfg = loadChatPolicies();
  return cfg.tierPolicies?.[tier] ?? BUILTIN_TIER_POLICY[tier];
}

/** A single resolved chat (including its alias and external flag). */
export interface ResolvedChat {
  chatId: string;
  name: string;
  /** Whether this is a cross-tenant external group. */
  external: boolean;
}

/** Resolved agent config: merges defaults, obtains the profile, and resolves listen into a list of oc_ chats. */
export interface ResolvedAgent {
  id: string;
  enabled: boolean;
  soul: string;
  workspace: string;
  identity: Identity;
  larkProfile: string;
  larkProfileName: string;
  larkProfileMeta: LarkProfile;
  kimiProfile: KimiProfile;
  chats: ResolvedChat[];
  /** listen==='all': listen to as many chats as possible (bot applies no whitelist; user scans all chats) */
  listenAll: boolean;
  /** Re-discover the chat list (for the user channel to periodically rescan and pick up newly joined chats) */
  rediscover: () => ResolvedChat[];
  /** Rescan interval (milliseconds, from lark.discovery.refreshMinutes) */
  discoveryRefreshMs: number;
  capture: boolean;
  trigger: TriggerMode;
  triggerPrefix: string;
  replyPrefix: string;
  pollIntervalMs: number;
  contextSize: number;
  /** emoji_type for the "thinking / answering now" reaction (added -> removed after replying) */
  reactionEmoji: string;
  /** emoji_type for the "queued, please wait" reaction shown while a reply waits its turn */
  queuedReactionEmoji: string;
  /** open_id for self-identification under the user identity (used to avoid self-triggering) */
  selfOpenId: string;
  /** Notification chat (chat_id after alias resolution) */
  notifyChatId: string;
  /** When true, the agent also responds (not just collects) in external/cross-tenant groups. */
  interactExternal: boolean;
  /** When true, the channel only collects/syncs and never replies (user-token data collection without
   *  operator-impersonation replies). */
  collectOnly: boolean;
}

/**
 * Resolve a config file path, falling back to its committed `*.example` template when the
 * real file is absent. This lets a fresh clone run (and the test suite pass) before an
 * operator has filled in their private configs; a real `configs/*.json` always takes precedence.
 */
function resolveConfigFile(file: string): string {
  if (fs.existsSync(file)) return file;
  const example = `${file}.example`;
  if (fs.existsSync(example)) return example;
  return file;
}

function readJson<T>(file: string): T {
  const resolved = resolveConfigFile(file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`找不到配置文件：${file}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as T;
}

/** Load the three configuration files. */
export function loadConfigs(): Configs {
  return {
    agents: readJson<AgentsFile>(path.join(CONFIGS_DIR, 'agents.json')),
    lark: readJson<LarkFile>(path.join(CONFIGS_DIR, 'lark.json')),
    kimi: readJson<KimiFile>(path.join(CONFIGS_DIR, 'kimi.json')),
  };
}

/** Selects which agents a serve / supervisor invocation should run. */
export interface WorkerTarget {
  /** Run the agents of this workspace soul. */
  soul: string;
  /** Which identity channels of that soul to bring up (bot / user / both). */
  identities: Identity[];
}

/** List all agent ids defined in configs. */
export function listAgents(cfg?: Configs): string[] {
  const c = cfg ?? loadConfigs();
  return Object.keys(c.agents.agents);
}

/** Resolve every agent id whose soul matches the given workspace soul. */
export function listAgentsBySoul(soul: string, cfg?: Configs): string[] {
  const c = cfg ?? loadConfigs();
  return Object.keys(c.agents.agents).filter((id) => c.agents.agents[id]?.soul === soul);
}

/** Resolve an alias (or a raw oc_ value) into a chat_id; look up the alias in knownInternalChats, and if not found treat it as a chat_id as-is. */
function resolveAlias(lark: LarkFile, alias: string): string {
  return lark.knownInternalChats[alias] ?? alias;
}

/**
 * Resolve a chat alias into a usable chat_id for a send target, or null when it is not configured.
 * Unlike resolveAlias, this never returns a non-chat string: an unknown alias, an empty value, or a
 * sanitized `oc_example_*` placeholder all resolve to null, so callers skip delivery cleanly instead
 * of handing the Feishu API an invalid receive_id. Real ids live in configs/lark.json's
 * knownInternalChats; a config-load failure (e.g. in tests) also resolves to null.
 */
export function resolveChatTarget(alias: string, cfg?: Configs): string | null {
  try {
    const lark = (cfg ?? loadConfigs()).lark;
    const id = lark.knownInternalChats[alias] ?? alias;
    if (!id || !id.startsWith('oc_') || id.startsWith('oc_example')) return null;
    return id;
  } catch {
    return null;
  }
}

/**
 * Resolve listen into the actual list of chats to listen on.
 * - "all": call listChats to get all chats (no internal/external filtering), applying exclude (listen to as many as possible, no cherry-picking).
 * - "all-internal": same as above but keep only internal chats with external===false.
 * - array of aliases: resolve each alias -> chat_id.
 * When "all" / "all-internal" fails, fall back to knownInternalChats (at least the known chats are available).
 */
function resolveListen(
  raw: RawAgentConfig,
  lark: LarkFile,
  larkProfile: string
): ResolvedChat[] {
  if (raw.listen === 'all' || raw.listen === 'all-internal') {
    const internalOnly = raw.listen === 'all-internal';
    const excludeIds = new Set(
      (raw.exclude ?? []).map((a) => resolveAlias(lark, a))
    );
    let chats: ResolvedChat[] = [];
    try {
      chats = listChats(larkProfile)
        .filter((c) => !internalOnly || c.external === false)
        .filter((c) => !excludeIds.has(c.chatId))
        .map((c) => ({ chatId: c.chatId, name: c.name, external: c.external }));
    } catch (e) {
      log.warn(
        `探索群清单失败，改用 knownInternalChats 作为后备：`,
        (e as Error).message
      );
      chats = Object.entries(lark.knownInternalChats)
        .filter(([, id]) => !excludeIds.has(id))
        .map(([name, id]) => ({ chatId: id, name, external: false }));
    }
    return chats;
  }
  // array of aliases — treat as internal by convention
  const aliasToName = new Map<string, string>();
  for (const [name, id] of Object.entries(lark.knownInternalChats)) {
    aliasToName.set(id, name);
  }
  return raw.listen.map((alias) => {
    const chatId = resolveAlias(lark, alias);
    return { chatId, name: aliasToName.get(chatId) ?? alias, external: false };
  });
}

/**
 * Resolve which lark profile an agent should use. Each soul/bot can carry its own
 * Lark credentials, so several bots can run side by side. Resolution tries, in order:
 * the agent's explicit `lark` override -> a profile named after its soul -> the
 * configured `defaults.lark` -> the built-in `default` profile. The first name that
 * exists in lark.json wins; if none do, it throws asking for a `default` profile.
 */
export function resolveLarkProfileName(
  raw: RawAgentConfig,
  defaults: DefaultsConfig,
  profiles: Record<string, LarkProfile>
): string {
  const candidates = [raw.lark, raw.soul, defaults.lark, DEFAULT_LARK_PROFILE];
  for (const name of candidates) {
    if (name && profiles[name]) return name;
  }
  const tried = candidates.filter(Boolean).join(' / ');
  throw new Error(
    `找不到可用的 lark profile（已尝试：${tried}）。请在 configs/lark.json 的 profiles 里至少定义一个【${DEFAULT_LARK_PROFILE}】。`
  );
}

/**
 * Resolve a single agent: merge defaults, obtain the lark/kimi profile, and resolve listen into a list of oc_ chats.
 * "all-internal" calls listChats on the fly to discover and filter by external===false.
 */
export function resolveAgent(agentId: string, cfg?: Configs): ResolvedAgent {
  const c = cfg ?? loadConfigs();
  const raw = c.agents.agents[agentId];
  if (!raw) {
    throw new Error(`找不到 agent【${agentId}】（configs/agents.json）`);
  }
  const defaults = c.agents.defaults;

  const larkProfileName = resolveLarkProfileName(raw, defaults, c.lark.profiles);
  const larkMeta = c.lark.profiles[larkProfileName]!;

  const kimiProfileName = raw.kimi ?? defaults.kimi;
  const kimiProfile = c.kimi.profiles[kimiProfileName];
  if (!kimiProfile) {
    throw new Error(`找不到 kimi profile【${kimiProfileName}】（configs/kimi.json）`);
  }

  const larkProfile = larkMeta.larkProfile;
  const rediscover = (): ResolvedChat[] => resolveListen(raw, c.lark, larkProfile);
  const chats = rediscover();
  const listenAll = raw.listen === 'all';
  const discoveryRefreshMs =
    Math.max(1, c.lark.discovery?.refreshMinutes ?? 10) * 60_000;

  const identity = raw.identity;
  const selfOpenId =
    identity === 'bot' ? larkMeta.botOpenId : larkMeta.userOpenId;
  const notifyChatId = resolveAlias(c.lark, c.lark.notifyChat);

  return {
    id: agentId,
    enabled: raw.enabled ?? false,
    soul: raw.soul,
    workspace: raw.workspace ?? raw.soul,
    identity,
    larkProfile,
    larkProfileName,
    larkProfileMeta: larkMeta,
    kimiProfile,
    chats,
    listenAll,
    rediscover,
    discoveryRefreshMs,
    capture: raw.capture ?? identity === 'user',
    trigger: raw.trigger ?? 'mention',
    triggerPrefix: raw.triggerPrefix ?? '',
    replyPrefix: raw.replyPrefix ?? '',
    pollIntervalMs: raw.pollIntervalMs ?? defaults.pollIntervalMs,
    contextSize: raw.contextSize ?? defaults.contextSize,
    reactionEmoji: raw.reactionEmoji ?? defaults.reactionEmoji ?? DEFAULT_REACTION_EMOJI,
    queuedReactionEmoji:
      raw.queuedReactionEmoji ?? defaults.queuedReactionEmoji ?? DEFAULT_QUEUED_EMOJI,
    selfOpenId,
    notifyChatId,
    interactExternal: raw.interactExternal ?? false,
    collectOnly: raw.collectOnly ?? false,
  };
}
