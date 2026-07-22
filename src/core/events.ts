import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, RUNTIME_DIR } from './paths.js';
import { renderEventImage, type TextOverlay } from './event-render.js';
import { uploadImage, sendPost, getUserName, listChatMembers, isChatGoneError, isChatInaccessibleError, type PostElement } from './lark.js';
import * as store from './store.js';
import { log } from './log.js';
import { resolveChatTarget } from './configs.js';

// ── event system (management game) ────────────────────────────
// An event = a base image + text overlays (percentage-positioned) + a markdown caption (title/body)
// + game info (LP/level/badge). On fire: render image -> upload to Feishu -> record dispatch
// (pending) -> send (global to a group / personal P2P) -> write back status + message_id (so a later
// feature can tally reactions). Event definitions live in code (type-safe); base image assets live
// under assets/events/.

export interface EventTypeConfig {
  /** unique event id, e.g. 'morning_greeting' */
  eventTypeId: string;
  /** Feishu post title (may contain placeholders) */
  title: string;
  /** markdown body template; may contain {{date}} {{name}} {{pt}} {{level}} {{badges}} etc. */
  description: string;
  /** 'global' = send to a group; 'personal' = P2P direct message */
  scope: 'global' | 'personal';
  /** default target chat_id for a global event (ignored when personal) */
  targetChatId?: string;
  /** base image path (absolute, or relative to the repo root) */
  baseImage: string;
  /** text overlay blocks (percentage-positioned) */
  overlays: TextOverlay[];
  /** @-mentions usable in the body via a {{@key}} token, e.g. { contact: { id: 'ou_..', name: 'X' } } */
  mentions?: Record<string, { id: string; name?: string }>;
  /** blank lines inserted in each gap (title↔image, image↔body); default 2 */
  gapLines?: number;
  /** output image height in px (aspect kept); defaults to EVENT_IMAGE_HEIGHT (128) */
  imageHeight?: number;
  /**
   * Optional resolver run just before render/send (sync or async). It computes the dynamic parts of
   * a fire — pick a target audience, choose @-mentions, rewrite the body, decide a reward — and may
   * abort the whole fire by returning null (nothing is sent, nothing recorded as failed). This is
   * what turns a static template into a data-driven event. See {@link PreparedEvent}.
   */
  prepare?: (opts: FireEventOptions) => PreparedEvent | null | Promise<PreparedEvent | null>;
  /** Optional schedule making this event eligible for automatic timed+random firing. */
  schedule?: EventSchedule;
}

/** Result of an event's {@link EventTypeConfig.prepare} hook; every field overrides/augments the static config. */
export interface PreparedEvent {
  /** extra placeholder vars merged last (override the built-in date/actor vars) */
  vars?: Record<string, string | number>;
  /** dynamic @-mentions merged over cfg.mentions (referenced as {{@key}} in the body) */
  mentions?: Record<string, { id: string; name?: string }>;
  /** override the body template when it must be computed at fire time (e.g. conditional sentences) */
  description?: string;
  /**
   * Override the single send target (takes precedence over the scope-derived default; opts.target
   * still wins). One fire = one target: a group (chatId) OR one person's P2P (userId). The event's
   * SOURCE (the groups + DB state it's derived from) is separate and lives in this prepare() logic.
   */
  target?: { chatId?: string; userId?: string };
  /** invoked once, only after a successful send — for side effects like granting LP */
  afterSend?: (res: FireEventResult) => void | Promise<void>;
}

// ── schedule (cadence + probability + optional time window) ───
// A "logical day" runs from DAY_START_HOUR (05:00 local) to the next 04:59. Day-based cadences are
// planned at the start of each logical day: when an event is due, a random clock time inside
// [windowStart, windowEnd] is picked for that day, and at that moment it fires with `probability`.
// The minute cadence is sub-day and rolls on a fixed interval instead (no window).

/** Fields common to every cadence. */
interface ScheduleCommon {
  /** probability in [0,1] of firing when the planned moment arrives */
  probability: number;
  /** human-readable note shown in `agent events` */
  note?: string;
}

/** Local time window for day-based cadences: a random fire time is chosen inside [start, end]. */
interface ScheduleWindow {
  /** window start, local "HH:MM" — earliest the random fire time can be (default 10:00) */
  windowStart?: string;
  /** window end, local "HH:MM" — latest the random fire time can be (default = windowStart) */
  windowEnd?: string;
}

/**
 * Timed + random schedule. Five cadence kinds:
 *  - minutes : every N minutes (sub-day; no window). e.g. { kind:'minutes', everyMinutes:30 }
 *  - days    : every X logical days, at a random time in the window. { kind:'days', everyDays:7 }
 *  - weekly  : on a given weekday (1=Mon … 7=Sun). { kind:'weekly', weekday:1 }
 *  - monthly : on a given day-of-month (clamped to the month's last day). { kind:'monthly', day:15 }
 *  - yearly  : on a given month+day (clamped). { kind:'yearly', month:6, day:1 }
 * All carry `probability`; all day-based kinds carry an optional window.
 */
export type EventSchedule =
  | (ScheduleCommon & { kind: 'minutes'; everyMinutes: number })
  | (ScheduleCommon & ScheduleWindow & { kind: 'days'; everyDays: number })
  | (ScheduleCommon & ScheduleWindow & { kind: 'weekly'; weekday: number })
  | (ScheduleCommon & ScheduleWindow & { kind: 'monthly'; day: number })
  | (ScheduleCommon & ScheduleWindow & { kind: 'yearly'; month: number; day: number });

// Default sent-image height (px), aspect kept. Event images are small thumbnails in chat; per-event
// `imageHeight` can override.
const EVENT_IMAGE_HEIGHT = 128;

// Event registry (defined in code, seeded into the DB on fire).
const REGISTRY = new Map<string, EventTypeConfig>();

export function registerEvent(cfg: EventTypeConfig): void {
  REGISTRY.set(cfg.eventTypeId, cfg);
}

export function getEventConfig(eventTypeId: string): EventTypeConfig | undefined {
  return REGISTRY.get(eventTypeId);
}

export function listEventConfigs(): EventTypeConfig[] {
  return [...REGISTRY.values()];
}

/**
 * Resolve an event by either its 1-based number (the index shown in `agent events`) or its
 * eventTypeId. Lets the CLI accept `agent event 1` or `agent event lurker-discovered`.
 */
export function getEventByRef(ref: string): EventTypeConfig | undefined {
  const list = listEventConfigs();
  if (/^\d+$/.test(ref)) {
    const idx = Number(ref) - 1;
    return idx >= 0 && idx < list.length ? list[idx] : undefined;
  }
  return REGISTRY.get(ref);
}

// Built-in sample event: daily morning greeting (placeholder — tune the base image + coords once the
// real asset is provided). Put the base image at: assets/events/morning/base.png (9:25).
registerEvent({
  eventTypeId: 'morning_greeting',
  title: '早安 SeeDAO',
  description: '**{{date}}（{{weekday_cn}}）早安！**\n\n新的一天，SeeDAO 的朋友们冲鸭 🚀',
  scope: 'global',
  baseImage: 'assets/events/morning/base.png',
  overlays: [
    // Write the date in the bottom-center area (sample coords; adjust to the real base image).
    { left: 10, top: 86, width: 80, height: 6, text: '{{date}}', bgColor: 'rgba(0,0,0,0.45)', color: '#ffffff', bold: true, align: 'center' },
  ],
});

// Newcomer welcome is no longer a P2P event: it is a deterministic GROUP post sent by the member-sync
// poll when someone joins the visitor group (see src/core/self-intro.ts + src/channels/feishu-user.ts),
// which invites a self-introduction with a fixed copy. The old first-@ P2P `welcome-party` DM was removed.

// "社区潜水被发现了" — a timed+random event. Once a week (25% chance) it picks a random community
// member who hasn't spoken in ANY monitored chat for the last few days, @-mentions them, and nudges
// everyone to get to know them. If that member has ever interacted with the bot (has first_contact),
// they're rewarded +3 LP and the body says so; otherwise no LP is granted and that sentence is dropped.
// When everyone has spoken recently, prepare() returns null and nothing is sent.
//
// The bot's own open_id — excluded from member-selection in EVERY event by default (we never
// pick the bot as a "member"). The operator/anyone else is NOT excluded. (Future bot-targeted events
// will opt in separately.)
const SELF_BOT_OPEN_ID = 'ou_example_bot';

// Source and (production) target are both SeeDAO 运营小天地: candidates are this group's members, and
// the event is posted to this group. (They're separate concepts that happen to coincide here.) Run
// `pnpm agent event lurker-discovered --test` to instead send only to the operator's own P2P.
// Resolved from configs/lark.json's "运营小天地" alias; empty when unconfigured (event skips cleanly).
const LURKER_SOURCE_CHAT_IDS = [resolveChatTarget('运营小天地')].filter((id): id is string => Boolean(id)); // 运营小天地 — candidate pool
const LURKER_TARGET_CHAT_ID = resolveChatTarget('运营小天地') ?? ''; // 运营小天地 — production target group
// "silent for N days" window. Defaults to 3; overridable via env for testing / tuning.
const LURKER_SILENT_DAYS = Number(process.env.LURKER_SILENT_DAYS) || 3;
const LURKER_PT_REWARD = 3;

registerEvent({
  eventTypeId: 'lurker-discovered',
  title: "🐟 {{lurker_name}} 在社区潜水被发现了", // {{lurker_name}} filled in prepare()
  // description is fully computed in prepare() (conditional reward sentence + dynamic @-mention).
  description: '',
  scope: 'global',
  targetChatId: LURKER_TARGET_CHAT_ID,
  baseImage: 'assets/events/lurker-discovered/base.png',
  overlays: [],
  gapLines: 1,
  schedule: { kind: 'weekly', weekday: 1, windowStart: '19:00', windowEnd: '20:00', probability: 0.25, note: '每周一·19:00-20:00随机·25%触发' },
  prepare: async (opts) => {
    // messages.create_time is in milliseconds, so the cutoff is too.
    const cutoffMs = Date.now() - LURKER_SILENT_DAYS * 86400 * 1000;
    const report = await store.silentMemberReport(cutoffMs, {
      sourceChatIds: LURKER_SOURCE_CHAT_IDS,
      excludeOpenIds: [SELF_BOT_OPEN_ID], // exclude only the bot; everyone else (incl. the operator) is fair game
    });
    // Resolve a real display name for a bare ou_ id. Order: captured name -> the member directory
    // (chat_members, populated by the periodic roster sync) -> live chat roster (im chat.members get,
    // which names CROSS-TENANT/EXTERNAL members too) -> the contact API (internal users only). Live
    // rosters are fetched once per chat and cached for this call; a resolved name is written back to
    // the directory (NOT profiles, to keep gamification clean). Falls back to the open_id if all fail.
    // Caches the fetch PROMISE (not the resolved map) so concurrent resolveName calls for the same
    // chat share one in-flight listChatMembers call instead of each spawning their own.
    const rosterCache = new Map<string, Promise<Map<string, string>>>();
    const roster = (chatId: string): Promise<Map<string, string>> => {
      let r = rosterCache.get(chatId);
      if (!r) {
        r = (async (): Promise<Map<string, string>> => {
          try {
            return await listChatMembers(chatId, { profile: opts.profile });
          } catch (e) {
            // A source chat that's gone shouldn't fail the whole event — flag it and use an empty roster.
            // Only mark on 'dissolved' (definitive); 'inaccessible' is left to the poll loop's conservative
            // stand-down so a transient permission blip during an event doesn't sideline the chat.
            if (isChatGoneError(e)) void store.markChatInactive(chatId, 'dissolved');
            else if (!isChatInaccessibleError(e)) log.warn(`潜水事件读取群成员失败【${chatId}】：`, (e as Error).message);
            return new Map();
          }
        })();
        rosterCache.set(chatId, r);
      }
      return r;
    };
    const resolveName = async (m: store.SilentMember): Promise<string> => {
      if (!m.name) m.name = await store.memberName(m.openId); // directory (already-synced)
      if (!m.name) {
        const fetched = (m.chatId ? (await roster(m.chatId)).get(m.openId) : '') || (await getUserName(m.openId, opts.profile));
        if (fetched) {
          m.name = fetched;
          try { await store.recordChatMember(m.chatId, m.openId, fetched); } catch { /* cache best-effort */ }
        }
      }
      return m.name || m.openId;
    };
    // Show "从未发言" for members with no captured message (lastSpoke=0), else the clock time.
    const fmtLast = (ms: number): string => (ms > 0 ? fmtClock(ms) : '从未发言');
    // Log which groups are the source (the candidate scope) — names from the directory, with counts.
    log.info(
      `潜水事件来源群（${report.chats.length} 个）：` +
        report.chats.map((c) => `${c.name || c.chatId}(${c.present}人)`).join('、')
    );
    // Log the candidate pool so the reason for firing / skipping is visible in the log.
    log.info(
      `潜水事件选人范围：来源群的全部成员（含从没发言的人，仅排除 bot），共 ${report.members.length} 人；` +
        `近 ${LURKER_SILENT_DAYS} 天未发言（含从未发言）${report.silent.length} 人`
    );
    // In dry-run, also list who qualifies (capped), resolving real names for any bare ou_ ids.
    if (opts.dryRun) {
      const sample = (report.silent.length ? report.silent : report.members).slice(0, 20);
      const lines = await Promise.all(sample.map(async (m) => `    - ${await resolveName(m)}（最后发言 ${fmtLast(m.lastSpoke)}）`));
      log.info(
        `${report.silent.length ? '潜水候选名单' : '当前无潜水者，全体成员名单'}（${report.silent.length || report.members.length} 人，取前 ${sample.length}）：\n${lines.join('\n')}`
      );
    }
    // Pick a target: normally a random silent member; with --force (manual run), if nobody is silent
    // we fall back to the quietest member so the event still produces output.
    let lurker: store.SilentMember | undefined;
    if (report.silent.length) {
      lurker = report.silent[Math.floor(Math.random() * report.silent.length)];
    } else if (opts.force && report.members.length) {
      lurker = report.members[0]; // members are sorted oldest-spoke first → the quietest one
      log.info(`潜水事件【手动强制】近 ${LURKER_SILENT_DAYS} 天无人潜水，改选最久未发言者：${await resolveName(lurker)}`);
    }
    if (!lurker) {
      // Scheduled (non-force): everyone has spoken recently → don't send even though it triggered.
      log.info(
        report.members.length
          ? `潜水事件不发送：已知 ${report.members.length} 人近 ${LURKER_SILENT_DAYS} 天都发过言，没有潜水对象（手动触发可加 --force 强制演示）`
          : `潜水事件不发送：数据库里还没有可选的社区成员`
      );
      return null;
    }
    const reward = await store.hasFirstContact(lurker.openId); // only reward if they've ever @-ed the bot
    const lurkerName = await resolveName(lurker); // resolve real name (and cache it) for the @-mention + log
    log.info(`潜水事件选中：${lurkerName}（最后发言 ${fmtLast(lurker.lastSpoke)}，first_contact=${reward}）`);
    const firstLine =
      `今天某个成员的 AI Agent，发现了一个久未发言的社区成员 {{@lurker}}，让我们大家一起来认识他一下吧！` +
      (reward ? `也给他 ${LURKER_PT_REWARD} LP 鼓励！` : '');
    return {
      description: [firstLine, '', `> 此事件每周发生一次，发生概率 25%`].join('\n'),
      vars: { lurker_name: lurkerName }, // fills {{lurker_name}} in the title
      mentions: { lurker: { id: lurker.openId, name: lurker.name } },
      // Target = the 运营小天地 group (scope global + targetChatId). The lurker is a member of it, so
      // {{@lurker}} stays a real @. Under `--test` the CLI redirects the send to the operator's P2P,
      // where the lurker isn't a participant, so it auto-downgrades to "@name" text.
      afterSend: async () => {
        if (reward) {
          try {
            await store.grantPt(lurker.openId, LURKER_PT_REWARD, 'event:lurker-discovered');
            log.info(`潜水被发现奖励：${lurker.openId} +${LURKER_PT_REWARD} LP`);
          } catch (e) {
            log.warn('潜水事件发 LP 失败：', (e as Error).message);
          }
        }
      },
    };
  },
});

// Personal congratulation — a P2P direct message to the recipient, sent on every badge award alongside
// the group announcement. Base image is the shared badge graphic with no overlays, resized to 128px
// height (aspect kept). member_name (recipient) and badge_name (badge headline) come from the award flow.
registerEvent({
  eventTypeId: 'badge-awarded',
  title: "🎖 恭喜你获得了 {{badge_name}} 徽章！",
  description: '{{member_name}}，恭喜你获得了 {{badge_name}} 徽章！',
  scope: 'personal',
  baseImage: 'assets/badges/badge-awarded-default-bg.png',
  overlays: [],
  imageHeight: 128,
  gapLines: 1,
});

// Default badge-award announcement — the fallback the badge system fires when an awarded badge names
// no acquire event of its own. Posted to the SeeDAO 运营小天地 group. The base image has no text/symbol
// overlays and is resized to 128px height (aspect kept). The recipient name and badge name come from
// the award flow via member_name / badge_name vars.
const BADGE_AWARDED_DEFAULT_CHAT_ID = resolveChatTarget('运营小天地') ?? ''; // SeeDAO 运营小天地
registerEvent({
  eventTypeId: 'badge-awarded-default',
  title: "{{member_name}} 得到 {{badge_name}} 徽章！",
  description: [
    '{{member_name}} 得到了 {{badge_name}} 徽章，请大家给这位小伙伴一个鼓励吧！',
    '',
    '> 此事件在成员获得徽章时发生',
  ].join('\n'),
  scope: 'global',
  targetChatId: BADGE_AWARDED_DEFAULT_CHAT_ID,
  baseImage: 'assets/badges/badge-awarded-default-bg.png',
  overlays: [],
  imageHeight: 128,
  gapLines: 1,
});

// Default batch badge-award announcement — fired once when a badge is awarded to 2+ members at once and
// the badge names no acquire event of its own. Posted to the SeeDAO 围观群 group. Every recipient is
// @-mentioned in the body (downgraded to plain "@name" text for anyone not in the target group). The
// base image has no overlays and is resized to 128px height (aspect kept). badge_name comes from the
// award flow via vars; the recipient list comes via opts.recipients.
const BADGE_AWARDED_GROUP_CHAT_ID = resolveChatTarget('围观群') ?? ''; // SeeDAO 围观群
registerEvent({
  eventTypeId: 'badge-awarded-group',
  title: "有一群人得到 {{badge_name}} 徽章！",
  description: '{{members_name}} 得到了 {{badge_name}} 徽章，请大家给这些小伙伴一个鼓励吧！\n\n> 此事件在多位成员同时获得相同徽章时发生',
  scope: 'global',
  targetChatId: BADGE_AWARDED_GROUP_CHAT_ID,
  baseImage: 'assets/badges/badge-awarded-group-bg.png',
  overlays: [],
  imageHeight: 128,
  gapLines: 1,
  prepare: (opts) => {
    // One @-mention per recipient; the body lists them all, joined by 、. An @ of anyone not in the
    // target group is turned into plain "@name" text at send time by downgradeAtNonMembers.
    const recipients = opts.recipients ?? [];
    const mentions: Record<string, { id: string; name?: string }> = {};
    const tokens = recipients.map((r, i) => {
      const key = `m${i}`;
      mentions[key] = { id: r.openId, name: r.name };
      return `{{@${key}}}`;
    });
    return {
      description: `${tokens.join('、')} 得到了 {{badge_name}} 徽章，请大家给这些小伙伴一个鼓励吧！\n\n> 此事件在多位成员同时获得相同徽章时发生`,
      mentions,
    };
  },
});

// Course-signup milestone announcement — fired by the calendar RSVP poll when a 共学/课 activity's signup
// count newly crosses a milestone, to flag that slots are limited. Posted to the SeeDAO 围观群 group.
// All placeholders (event_name, accept_num, remaining = 100-accept_num, event_link) come from the poll via
// vars; the cap is fixed at 100. Base image has no overlays and is resized to 128px height (aspect kept).
const CLASS_EVENT_NOTIFY_CHAT_ID = resolveChatTarget('围观群') ?? ''; // SeeDAO 围观群
registerEvent({
  eventTypeId: 'class-event-notify',
  title: "【剩 {{remaining}} 名额】 {{event_name}}报名达 {{accept_num}} 人",
  description: [
    "课程 **{{event_name}}** 在刚刚不久，报名人数达到了 {{accept_num}} 人",
    '本次上限 100 位，只剩下 {{remaining}} 位名额，赶紧报名吧！',
    '活动请见：{{event_link}}',
    '',
    '> 此事件在课程类活动短期有多人报名时发生',
  ].join('\n'),
  scope: 'global',
  targetChatId: CLASS_EVENT_NOTIFY_CHAT_ID,
  baseImage: 'assets/events/class-event-notify-bg.png',
  overlays: [],
  imageHeight: 128,
  gapLines: 1,
});

// Visitor-count milestone announcement — fired by the member-sync poll when the SeeDAO 2.0 社区围观群's
// present member count newly crosses a multiple of 100, to welcome the growing crowd. Posted to the
// SeeDAO 围观群 group, @-mentioning two fixed contacts (downgraded to plain text if either is not in
// the target group). visitor_num is the crossed milestone threshold (e.g. 400 — a round hundred, not the
// exact live total such as 402), supplied by the poll via vars. Base image has no overlays and is resized
// to 128px height.
const VISITOR_NUM_NOTIFY_CHAT_ID = resolveChatTarget('围观群') ?? ''; // SeeDAO 围观群
registerEvent({
  eventTypeId: 'visitor-num-notify',
  title: 'SeeDAO 访客人数达到 {{visitor_num}} 人',
  description: [
    '由于 SeeDAO 近期受到关注，许多人来到社区，目前访客人数达到 {{visitor_num}} 人',
    '欢迎阅读上方列表中的【知识库】了解更多社区信息，以及从【Pin】参与近期的公开活动',
    '如果想进一步了解如何成为 SeeDAO 成员，解锁更多社区权限与福利',
    '请查看官网 https://seedao.xyz 或私信 {{@contact_1}}, {{@contact_2}}',
    '做为一个数字城邦，欢迎更多人来到 SeeDAO 一起 ～共在、涌现、逍遥～',
  ].join('\n'),
  scope: 'global',
  targetChatId: VISITOR_NUM_NOTIFY_CHAT_ID,
  baseImage: 'assets/events/visitor-num-notify-bg.png',
  overlays: [],
  imageHeight: 128,
  gapLines: 1,
  mentions: {
    contact_1: { id: 'ou_example_admin', name: '管理员' },
    contact_2: { id: 'ou_example_operator', name: '操作者' },
  },
});

// City-hall proposal verdict announcement — posted to the SeeDAO 运营小天地 group after the city-hall
// members deliberate and vote on a proposal. proposal_name / proposal_voted_result / proposal_url come
// from the firing side via vars (a future proposal system, or a one-off fireEvent script — the
// `agent event` CLI can't pass custom vars). Manual-only for now: no schedule, no @-mention, no reward.
// Base image has no overlays and is resized to 128px height (aspect kept).
const CITYHALL_PROPOSAL_VOTED_CHAT_ID = resolveChatTarget('运营小天地') ?? ''; // SeeDAO 运营小天地
registerEvent({
  eventTypeId: 'cityhall-proposal-voted-notify',
  title: '市政厅成员对 {{proposal_name}} 做出决议',
  description: [
    '市政厅成员近期针对提案 **{{proposal_name}}** 进行讨论与举行会议',
    '',
    '并正式针对该提案，在市政厅内做出决议： **{{proposal_voted_result}}**',
    '',
    '提案内容请见：　{{proposal_url}}',
    '',
    '> 此事件在市政厅对提案做出决议时发生',
  ].join('\n'),
  scope: 'global',
  targetChatId: CITYHALL_PROPOSAL_VOTED_CHAT_ID,
  baseImage: 'assets/events/cityhall-proposal-voted-notify-bg.png',
  overlays: [], // base image only, no text/symbol overlay
  imageHeight: 128,
  gapLines: 1,
});

// Like-maniac milestone announcement — fired by the reaction-harvest poll when a community member's
// emoji-reaction count within the current logical week (Mon 05:00 → next Mon 04:59, across the monitored
// non-work groups) reaches 66, at most once per member per week.
// Posted to the SeeDAO 围观群 group. member_name comes from the poll via vars; the rewarded member's
// open_id comes via actorOpenId, and prepare() grants them LP after a successful send. Base image has no
// overlays and is resized to 128px height (aspect kept).
const LIKE_MANIAC_NOTIFY_CHAT_ID = resolveChatTarget('围观群') ?? ''; // SeeDAO 围观群
const LIKE_MANIAC_PT_REWARD = 20;
registerEvent({
  eventTypeId: 'like-maniac-notify',
  title: '点赞狂魔 {{member_name}} 出现了',
  description: [
    '社区成员 **{{member_name}}** 近期对社区动态疯狂点赞',
    'SeeDAO 是不是做对什么事，让人会如此疯狂的按赞呢？让我们继续看下去',
    '',
    '> 此事件在社区成员一周内点赞达 66 次时发生',
  ].join('\n'),
  scope: 'global',
  targetChatId: LIKE_MANIAC_NOTIFY_CHAT_ID,
  baseImage: 'assets/events/like-maniac-notify-bg.png',
  overlays: [],
  imageHeight: 128,
  gapLines: 1,
  // The event body names the member as bold text (member_name), not a tappable @, to keep the sentence
  // formatting the operator specified. prepare() only wires the LP reward for the rewarded reactor.
  prepare: (opts) => {
    const actor = opts.actorOpenId;
    return {
      afterSend: async () => {
        if (!actor) return;
        try {
          await store.grantPt(actor, LIKE_MANIAC_PT_REWARD, 'event:like-maniac-notify');
          log.info(`点赞狂魔奖励：${actor} +${LIKE_MANIAC_PT_REWARD} LP`);
        } catch (e) {
          log.warn('点赞狂魔事件发 LP 失败：', (e as Error).message);
        }
      },
    };
  },
});

// First-try announcement — celebrates the first community member to try a newly-launched feature.
// Posted to the SeeDAO 围观群 group. Manual-only for now: the operator supplies member_name (the
// discoverer) and function_name (the feature) — function_name is free text only the operator knows,
// so this can't be auto-derived; the `agent event` CLI can't pass custom vars, so a real fire uses a
// one-off fireEvent script carrying vars + actorOpenId (see community-notify-events-playbook §9).
// member_name is rendered as bold text (not a tappable @) to keep the sentence the operator wrote.
// prepare() wires the LP reward for the discoverer (opts.actorOpenId), granted only on a successful
// send. Base image has no overlays and is resized to 128px height (aspect kept).
const FIRST_TRY_NOTIFY_CHAT_ID = resolveChatTarget('围观群') ?? ''; // SeeDAO 围观群
const FIRST_TRY_PT_REWARD = 10;
registerEvent({
  eventTypeId: 'first-try-notify',
  title: '{{member_name}} 发现了新功能 {{function_name}}', // titles are plain text: no quotes, no bold
  description: [
    "社区成员 **{{member_name}}** 刚刚发现了一个新功能 '{{function_name}}'",
    '一起来尝试玩玩看这个新功能，下次发现新功能的人可能就是你！',
    '',
    '> 此事件在社区成员首次使用新上线的功能时发生',
  ].join('\n'),
  scope: 'global',
  targetChatId: FIRST_TRY_NOTIFY_CHAT_ID,
  baseImage: 'assets/events/first-try-notify-bg.png',
  overlays: [],
  imageHeight: 128,
  gapLines: 1,
  prepare: (opts) => {
    const actor = opts.actorOpenId;
    return {
      afterSend: async () => {
        if (!actor) return;
        try {
          await store.grantPt(actor, FIRST_TRY_PT_REWARD, 'event:first-try-notify');
          log.info(`首次尝新功能奖励：${actor} +${FIRST_TRY_PT_REWARD} LP`);
        } catch (e) {
          log.warn('首次尝新功能事件发 LP 失败：', (e as Error).message);
        }
      },
    };
  },
});

/**
 * Human-readable target label for logs: "群名（chat_id）" for a group / "用户名（open_id）" for a P2P,
 * falling back to the bare id when the name isn't known (e.g. chat not yet synced into the directory).
 */
async function describeTarget(target: { chatId?: string; userId?: string }): Promise<string> {
  if (target.chatId) {
    const name = await store.chatName(target.chatId);
    return name ? `${name}（${target.chatId}）` : target.chatId;
  }
  if (target.userId) {
    const name = await store.memberName(target.userId);
    return name ? `${name}（${target.userId}）` : target.userId;
  }
  return '(无)';
}

/** Format an epoch-ms timestamp as local "MM-DD HH:MM" for log diagnostics. */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Local date/time placeholder values. */
function dateVars(d = new Date()): Record<string, string> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const weekdayCn = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return {
    date: `${y}-${m}-${day}`,
    date_cn: `${y}年${m}月${day}日`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    weekday_cn: `周${weekdayCn}`,
  };
}

/** Replace {{key}} in a template with vars[key] (unknown placeholders -> ''). */
function fillTemplate(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * Build one post paragraph from a body line. A line with no {{@key}} token becomes a single markdown
 * element; a line with mention tokens is split into text + at elements (so the mention is tappable).
 */
function buildLine(line: string, mentions: Record<string, { id: string; name?: string }>): PostElement[] {
  if (!/\{\{@\w+\}\}/.test(line)) return [{ tag: 'md', text: line }];
  const els: PostElement[] = [];
  const re = /\{\{@(\w+)\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) els.push({ tag: 'text', text: line.slice(last, m.index) });
    const mn = mentions[m[1]];
    if (mn) els.push({ tag: 'at', user_id: mn.id, ...(mn.name ? { user_name: mn.name } : {}) });
    else els.push({ tag: 'text', text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < line.length) els.push({ tag: 'text', text: line.slice(last) });
  return els;
}

/** Game-info placeholders for a user (name/pt/level/badges). */
async function actorVars(openId: string): Promise<Record<string, string | number>> {
  const out: Record<string, string | number> = {};
  try {
    const p = await store.getProfile(openId);
    if (p) {
      out.name = p.name || '';
      out.pt = p.ptBalance;
      out.level = p.level;
    }
    const badges = await store.listBadges(openId);
    out.badges = badges.map((b) => `${b.emoji || ''}${b.name}`).join('、');
    out.badge_count = badges.length;
  } catch {
    /* best-effort: leave blank if unavailable */
  }
  return out;
}

export interface FireEventOptions {
  /** trigger reason (recorded on the dispatch), e.g. 'daily_cron' / 'level_up' / 'manual' */
  triggerReason?: string;
  /** personal-event target open_id; also drives the name/pt/level/badges placeholders */
  actorOpenId?: string;
  /** batch recipients for multi-actor announcements (e.g. badge-awarded-group); each becomes an @-mention */
  recipients?: Array<{ openId: string; name?: string }>;
  /** override the send target; if omitted, inferred from scope (global->targetChatId, personal->actor P2P) */
  target?: { chatId?: string; userId?: string };
  /** lark profile (Feishu identity / tenant) */
  profile?: string;
  /** extra placeholders (override the built-in date/actor vars) */
  vars?: Record<string, string | number>;
  /**
   * Preview only: run prepare + render but DON'T upload, send, record a dispatch, or run afterSend
   * (so no Feishu message and no LP granted). Used by `agent event <id> --dry-run` to safely inspect
   * who would be picked and what the message would say.
   */
  dryRun?: boolean;
  /**
   * Manual/forced trigger (set by `pnpm agent event`): the event is fired regardless of its schedule
   * timing and probability (the manual path never rolls), and a prepare() hook should relax its
   * audience gating so the event still produces output. Scheduled fires never set this.
   */
  force?: boolean;
}

export interface FireEventResult {
  dispatchId: number;
  ok: boolean;
  messageId?: string;
  error?: string;
  /** true when the event's prepare hook aborted the fire (e.g. no eligible audience) — not an error */
  skipped?: boolean;
}

// ── interaction triggers ──────────────────────────────────────
// Checked in the reply path BEFORE the LLM answers: each rule decides, from the interaction context,
// whether to fire an event (e.g. a brand-new member gets the welcome event in their DM). Add more
// rules here over time (level-up, LP threshold, badge earned, ...).

export interface TriggerContext {
  /** open_id of the user we're replying to */
  senderOpenId: string;
  /** chat the interaction happened in */
  chatId: string;
  /** true only on the user's very first interaction (from store.recordInteraction) */
  isFirstInteraction: boolean;
  /** lark profile to send with */
  larkProfile?: string;
  /** soul (workspace) this interaction belongs to; gates soul-scoped triggers */
  soul: string;
}

interface TriggerRule {
  name: string;
  /** Souls this trigger applies to; skipped for any other soul (welcome events are soul-specific). */
  souls: string[];
  shouldFire(ctx: TriggerContext): boolean;
  fire(ctx: TriggerContext): Promise<unknown>;
}

// Currently empty: the first-@ P2P welcome DM was removed (newcomers are now welcomed by the
// deterministic group post in feishu-user.ts). The framework below is kept as the extension point —
// add rules here over time (level-up, LP threshold, badge earned, ...), soul-scoped via `souls`.
const TRIGGERS: TriggerRule[] = [];

/**
 * Run all interaction triggers for the current reply. Best-effort: a trigger failure is logged but
 * never blocks the LLM reply. Call this just before generating the answer.
 */
export async function checkAndFireTriggers(ctx: TriggerContext): Promise<void> {
  for (const rule of TRIGGERS) {
    if (!rule.souls.includes(ctx.soul)) continue;
    let fire = false;
    try {
      fire = rule.shouldFire(ctx);
    } catch {
      fire = false;
    }
    if (!fire) continue;
    try {
      log.info(`互动触发事件【${rule.name}】，对象 ${ctx.senderOpenId}`);
      await rule.fire(ctx);
    } catch (e) {
      log.error(`事件触发失败【${rule.name}】：`, (e as Error).message);
    }
  }
}

// ── timed + random scheduler ──────────────────────────────────
// The supervisor owns the timers (planning at each logical-day start, arming a one-shot timer for the
// chosen within-window time). This module owns the per-event semantics: which events are scheduled,
// and what happens at the planned instant (the dice roll + fire). State persistence keeps a weekly
// cadence weekly and survives restarts.

/** Events that declare a `schedule` (candidates for the timed+random scheduler). */
export function listScheduledEvents(): EventTypeConfig[] {
  return listEventConfigs().filter((e) => e.schedule);
}

const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六', '日']; // index by weekday%7 or 1..7

/** Human-readable one-line description of a schedule, for `agent events`. */
export function describeSchedule(sch: EventSchedule): string {
  const p = `${Math.round(sch.probability * 100)}%`;
  const win =
    'windowStart' in sch && sch.windowStart
      ? ` ${sch.windowStart}-${sch.windowEnd ?? sch.windowStart}`
      : '';
  switch (sch.kind) {
    case 'minutes':
      return `每${sch.everyMinutes}分钟@${p}`;
    case 'days':
      return `每${sch.everyDays}天${win}@${p}`;
    case 'weekly':
      return `每周${WEEKDAY_CN[sch.weekday % 7]}${win}@${p}`;
    case 'monthly':
      return `每月${sch.day}号${win}@${p}`;
    case 'yearly':
      return `每年${sch.month}月${sch.day}日${win}@${p}`;
  }
}

/**
 * The action at a planned fire instant: roll the probability and, on a hit, fire the event. Records
 * the outcome and clears the pending plan (so it won't re-fire). Returns the outcome string. The
 * caller (supervisor) decides *when* this runs; here we only decide *whether* it fires this time.
 */
export async function rollScheduledEvent(eventTypeId: string, profile?: string): Promise<string> {
  const cfg = getEventConfig(eventTypeId);
  if (!cfg || !cfg.schedule) return 'no-schedule';
  // Probability miss → consume the plan, nothing sent.
  if (Math.random() >= cfg.schedule.probability) {
    await store.resolveScheduleRoll(eventTypeId, 'missed');
    log.info(`事件未命中【${eventTypeId}】（概率 ${Math.round(cfg.schedule.probability * 100)}%）`);
    return 'missed';
  }
  // Hit → try to fire. prepare() may still skip (e.g. no eligible audience).
  log.info(`事件命中【${eventTypeId}】，准备发送…`);
  const res = await fireEvent(eventTypeId, { triggerReason: 'scheduled', profile });
  const outcome: 'fired' | 'skipped' | 'send-failed' = res.skipped ? 'skipped' : res.ok ? 'fired' : 'send-failed';
  await store.resolveScheduleRoll(eventTypeId, outcome);
  return outcome;
}

/**
 * The set of open_ids that are actually IN a send destination: a group's full roster, or — for a P2P
 * DM — its two participants (the recipient + this bot). Returns null when membership can't be
 * determined (then we don't touch the @-mentions). Used to downgrade @ of non-members to plain text.
 */
async function destinationMemberIds(
  target: { chatId?: string; userId?: string },
  profile?: string,
): Promise<Set<string> | null> {
  try {
    if (target.chatId) return new Set((await listChatMembers(target.chatId, { profile })).keys());
    if (target.userId) return new Set([target.userId, SELF_BOT_OPEN_ID]);
  } catch {
    /* ignore — treat as unknown */
  }
  return null;
}

/**
 * Replace @-mentions of people who are NOT in the destination with plain "@name" text. Feishu rejects
 * an `at` to a non-member (code 230002 "Bot/User can NOT be out of the chat"), but mentioning them by
 * name as text is allowed — so an event can still name someone who isn't in the target chat (e.g. a
 * lurker named in a P2P). No-op when membership is unknown. Returns how many were downgraded.
 */
function downgradeAtNonMembers(content: PostElement[][], memberIds: Set<string> | null): number {
  if (!memberIds) return 0;
  let n = 0;
  for (const para of content) {
    for (let i = 0; i < para.length; i++) {
      const el = para[i];
      if (el.tag === 'at' && !memberIds.has(el.user_id)) {
        para[i] = { tag: 'text', text: `@${el.user_name || el.user_id}` };
        n += 1;
      }
    }
  }
  return n;
}

/**
 * Fire an event: render -> upload -> record -> send -> write back status. Fully wrapped in try/catch;
 * any failure marks the dispatch failed and records the error rather than throwing into the caller's
 * hot path (returns ok=false).
 */
export async function fireEvent(eventTypeId: string, opts: FireEventOptions = {}): Promise<FireEventResult> {
  const cfg = getEventConfig(eventTypeId);
  if (!cfg) {
    log.error(`事件触发失败：找不到事件定义【${eventTypeId}】`);
    return { dispatchId: 0, ok: false, error: `unknown event type: ${eventTypeId}` };
  }

  // Run the optional resolver first. Returning null aborts the fire cleanly (nothing sent / recorded);
  // a thrown error is treated as a real failure.
  let prepared: PreparedEvent | null = null;
  if (cfg.prepare) {
    try {
      prepared = await cfg.prepare(opts);
    } catch (e) {
      log.error(`事件 prepare 失败【${eventTypeId}】：`, (e as Error).message);
      return { dispatchId: 0, ok: false, error: `prepare failed: ${(e as Error).message}` };
    }
    if (prepared === null) {
      log.info(`事件跳过【${eventTypeId}】：prepare 判定本次不发送`);
      return { dispatchId: 0, ok: false, skipped: true };
    }
  }

  // Assemble placeholder vars: date -> actor game info -> prepared -> caller overrides.
  const vars: Record<string, string | number> = {
    ...dateVars(),
    ...(opts.actorOpenId ? await actorVars(opts.actorOpenId) : {}),
    ...(prepared?.vars ?? {}),
    ...(opts.vars ?? {}),
  };

  // Merge @-mentions: static config first, dynamic (prepared) ones override.
  const mentions: Record<string, { id: string; name?: string }> = {
    ...(cfg.mentions ?? {}),
    ...(prepared?.mentions ?? {}),
  };

  // Body template: prepared override (computed at fire time) wins over the static config.
  const description = prepared?.description ?? cfg.description;

  // Resolve the single send target. Precedence: explicit caller target -> prepared target -> scope
  // default (global -> targetChatId group, personal -> actor's P2P). One fire goes to one place.
  const target: { chatId?: string; userId?: string } =
    opts.target ??
    prepared?.target ??
    (cfg.scope === 'personal' ? { userId: opts.actorOpenId } : { chatId: cfg.targetChatId });
  if (!target.chatId && !target.userId) {
    log.error(`事件触发失败【${eventTypeId}】：没有发送目标（global 缺 targetChatId 或 personal 缺 actorOpenId）`);
    return { dispatchId: 0, ok: false, error: 'no target' };
  }

  // Mirror the event definition into the DB (so dispatches can reference it and it's maintainable).
  try {
    await store.upsertEventType({
      eventTypeId: cfg.eventTypeId,
      title: cfg.title,
      description: cfg.description,
      scope: cfg.scope,
      targetChatId: cfg.targetChatId ?? null,
      baseImage: cfg.baseImage,
      renderConfig: JSON.stringify(cfg.overlays),
    });
  } catch {
    /* best-effort */
  }

  // Record a pending dispatch up front (skipped in dry-run — a preview leaves no trace).
  let dispatchId = 0;
  if (!opts.dryRun) try {
    dispatchId = await store.insertEventDispatch({
      eventTypeId: cfg.eventTypeId,
      triggerReason: opts.triggerReason ?? 'manual',
      scope: cfg.scope,
      actorOpenId: opts.actorOpenId ?? null,
      target: target.chatId ?? target.userId ?? null,
      payload: vars,
    });
  } catch (e) {
    log.warn(`事件 dispatch 记录失败【${eventTypeId}】：`, (e as Error).message);
  }

  const fail = async (error: string): Promise<FireEventResult> => {
    log.error(`事件发送失败【${eventTypeId}】(dispatch=${dispatchId})：${error}`);
    try {
      await store.updateEventDispatch(dispatchId, { status: 'failed', errorMsg: error });
    } catch { /* best-effort */ }
    try {
      await store.recordError({ kind: 'event', summary: `事件【${eventTypeId}】发送失败：${error}`.slice(0, 300), source: 'events' });
    } catch { /* best-effort */ }
    return { dispatchId, ok: false, error };
  };

  try {
    // 1) Render the image (overlay text).
    const baseImage = path.isAbsolute(cfg.baseImage) ? cfg.baseImage : path.join(REPO_ROOT, cfg.baseImage);
    if (!fs.existsSync(baseImage)) return fail(`底图不存在：${baseImage}`);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '');
    const outPath = path.join(RUNTIME_DIR, 'event-render', `${cfg.eventTypeId}-${stamp}.png`);
    const rendered = await renderEventImage({ baseImage, overlays: cfg.overlays, outPath, vars, outHeight: cfg.imageHeight ?? EVENT_IMAGE_HEIGHT });

    // Who is actually in the destination? Used to downgrade @ of non-members to plain text (an `at`
    // to someone not in the chat is rejected; naming them as text is fine). Only looked up when there
    // are mentions to check.
    const destIds = Object.keys(mentions).length ? await destinationMemberIds(target, opts.profile) : null;

    // Dry-run: stop here — show who would be picked and what the message would say, then bail out
    // before uploading / sending / recording / rewarding.
    if (opts.dryRun) {
      const previewTo = await describeTarget(target);
      const mentionList = Object.entries(mentions).map(([k, v]) => {
        const inChat = destIds ? destIds.has(v.id) : null;
        const tag = inChat === false ? '[不在目标→降级为@文本]' : inChat === true ? '[可@]' : '';
        return `${k}=${v.id}${v.name ? `(${v.name})` : ''}${tag}`;
      }).join('，') || '(无)';
      const previewBody = fillTemplate(description, vars);
      log.info(
        `[dry-run] 事件【${eventTypeId}】\n  目标: ${previewTo}\n  @: ${mentionList}\n  标题: ${fillTemplate(cfg.title, vars)}\n  底图: ${rendered.outPath}\n  正文:\n${previewBody.split('\n').map((l) => '    ' + l).join('\n')}`
      );
      return { dispatchId: 0, ok: true };
    }

    // 2) Upload to get an image_key.
    const imageKey = await uploadImage(rendered.outPath, { profile: opts.profile });
    if (!imageKey) return fail('上传图片失败（uploadImage 返回 null）');

    // 3) Build the post content: title -> (blank) -> image -> (blank) -> body, with @-mentions.
    const title = fillTemplate(cfg.title, vars);
    const gap = Math.max(0, cfg.gapLines ?? 2);
    const blank = (): PostElement[] => [{ tag: 'text', text: '' }];
    const content: PostElement[][] = [];
    for (let i = 0; i < gap; i++) content.push(blank()); // gap after the title header
    content.push([{ tag: 'img', image_key: imageKey }]); // image in the middle
    for (let i = 0; i < gap; i++) content.push(blank()); // gap before the body
    const bodyText = fillTemplate(description, vars);
    for (const line of bodyText.split('\n')) {
      content.push(line.trim() ? buildLine(line, mentions) : blank());
    }
    // Downgrade @ of anyone not in the destination to plain "@name" text (avoids the 230002 reject).
    const downgraded = downgradeAtNonMembers(content, destIds);
    if (downgraded > 0) log.info(`事件【${eventTypeId}】：${downgraded} 个 @ 对象不在目标会话，已改为 @名字 文本`);

    // 4) Send to the single target.
    const res = await sendPost(target, { title, content }, { as: 'bot', profile: opts.profile });

    // 5) Write back success + message_id.
    try {
      await store.updateEventDispatch(dispatchId, {
        status: 'sent',
        messageId: res.messageId ?? null,
        sentAt: Math.floor(Date.now() / 1000),
      });
    } catch { /* best-effort */ }
    log.info(`事件已发送【${eventTypeId}】，目标 ${await describeTarget(target)}（message_id=${res.messageId ?? '?'}）`);
    const result: FireEventResult = { dispatchId, ok: true, messageId: res.messageId };

    // 6) Post-send side effects (e.g. grant LP). Best-effort: a reward failure must not undo the send.
    if (prepared?.afterSend) {
      try {
        await prepared.afterSend(result);
      } catch (e) {
        log.warn(`事件 afterSend 失败【${eventTypeId}】：`, (e as Error).message);
      }
    }
    return result;
  } catch (e) {
    return fail((e as Error).message);
  }
}
