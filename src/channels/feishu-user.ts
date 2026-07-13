import type { Agent } from '../core/agent.js';
import type { Channel } from './channel.js';
import type { ResolvedAgent } from '../core/configs.js';
import { resolveChatTarget, getChatTier, getAutoPinThreshold } from '../core/configs.js';
import { logicalDayStart, logicalWeekStart, DAY_MS } from '../core/time.js';
import {
  listMessages,
  sendText,
  replyText,
  addReaction,
  removeReaction,
  isLoggedIn,
  listChatMembers,
  listUpcomingCalendarEvents,
  listEventAttendees,
  getEventShareLink,
  recurringSeriesKey,
  type CalendarEvent,
  listWikiSpaces,
  listWikiNodesDeep,
  listDriveFilesDeep,
  listFileViewRecords,
  isViewRecordForbiddenError,
  LarkApiError,
  isChatGoneError,
  isChatInaccessibleError,
  pinMessage,
  unpinMessage,
  downloadMessageResource,
  type LarkMessage,
} from '../core/lark.js';
import { renderMessageBody } from '../core/attachments.js';
import { fireEvent } from '../core/events.js';
import { isMilestoneRecorded, recordMilestone, refreshVisitorMilestonesWiki } from '../core/visitor-milestones.js';
import { loadCursor, saveCursor } from '../core/state.js';
import { append as appendTranscript, upsertChat } from '../core/transcript.js';
import { log, preview } from '../core/log.js';
import { flushTelegramSync } from '../core/telegram.js';
import { checkUserTokenExpiry } from '../core/token-watch.js';
import { dispatchCommand } from '../core/commands.js';
import * as store from '../core/store.js';
import { loadLpStrategy, judgeReply } from '../core/lp-strategy.js';

// After a restart, only respond to messages sent after the startup time; allow some slack for clock skew. Capture (transcript) is not subject to this limit.
const STARTUP_GRACE_MS = 5000;

// Document access-record polling runs on its own slow, dedicated cadence (hourly): it is far heavier
// than member sync (one blocking API call per document) and the underlying signal — a viewer's
// most-recent view time — only advances coarsely, so a short interval would add cost without adding
// resolution.
const DOC_VIEW_REFRESH_MS = 60 * 60 * 1000;
// First document scan is deferred well past startup so the message poll loops and member sync come
// online before this longer-running pass begins.
const DOC_VIEW_INITIAL_DELAY_MS = 8000;
// File types the access-record API accepts; other Drive object kinds (slides, shortcuts, folders) are
// skipped because the API rejects them.
const VIEW_RECORD_FILE_TYPES = new Set(['doc', 'docx', 'sheet', 'bitable', 'mindnote', 'file']);
// Upper bound on documents inspected per round, capping how long a single (synchronous) pass can run.
const DOC_VIEW_MAX_TARGETS = 600;

// User-token expiry is checked a few times a day; day-granularity reminders need no finer cadence, and
// the first check runs shortly after startup so an already-near-expiry token is flagged promptly.
const TOKEN_WATCH_REFRESH_MS = 6 * 60 * 60 * 1000;
const TOKEN_WATCH_INITIAL_DELAY_MS = 12000;

// ── Feishu user identity channel (acting as you) ────────────────────────────────
// Uses the personal account to poll "each internal chat" (can see all messages in the chat), and for each fresh message:
//   ① when capture is on, first record it into transcript (regardless of trigger, as a knowledge-base prerequisite)
//   ② self-identification: skip if sender open_id === selfOpenId (to avoid self-triggering)
//   ③ trigger check: mention / prefix / all → only call the agent when triggered, and the reply is shown as yourself
// Each internal chat runs its own polling loop, with cursor key feishu-user-<profile>-<chatId>.

function isAgentMessage(content: string): boolean {
  return content.startsWith('🤖');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class FeishuUserChannel implements Channel {
  readonly name = 'feishu-user';
  private cfg: ResolvedAgent;
  private startedAtMs = 0;

  constructor(cfg: ResolvedAgent) {
    this.cfg = cfg;
  }

  run(agent: Agent): Promise<void> {
    const cfg = this.cfg;
    const profile = cfg.larkProfile;
    this.startedAtMs = Date.now();
    // 采集不回复：照常采集对话、记录互动、同步群成员/文档访问，但绝不回复任何飞书 p2p/群/@，也不调用
    // LLM（不耗 kimi、不扣 LP、不加表情）。两种来源——全局静默（serve --quiet → AGENT_QUIET），或本频道被
    // 标记为 collectOnly（专做 user-token 数据采集、永不替操作者本人发言）。CLI 频道是独立进程，不受影响。
    const collectOnly = cfg.collectOnly === true;
    const quiet = process.env.AGENT_QUIET === '1' || collectOnly;
    const modeNote = collectOnly
      ? '，采集专用（user-token 数据采集，不回复）'
      : quiet
        ? '，quiet 静默模式：只采集不回复'
        : '';

    if (!isLoggedIn(profile)) {
      throw new Error(
        `lark-cli 尚未登录（profile=${profile}）：请先 lark-cli --profile ${profile} auth login --domain im`
      );
    }
    if (cfg.chats.length === 0) {
      log.warn(`${agent.name}：没有要监听的内部群（listen 解析为空），频道闲置。`);
    }

    log.info(
      `${agent.name} 已上线（飞书 user 频道，profile=${profile}${modeNote}）。` +
        `启动监听 ${cfg.chats.length} 个群（${cfg.listenAll ? '全部群' : '内部群'}），每 ${cfg.pollIntervalMs}ms 轮询（各群起步错开 ${cfg.discoveryStaggerMs}ms），` +
        `每 ${Math.round(cfg.discoveryRefreshMs / 1000)} 秒重扫一次群清单（成员/报名同步同周期、每项间隔 ${cfg.discoveryStaggerMs}ms 依序进行）。`
    );
    log.info(`   触发模式：${cfg.trigger}；采集：${cfg.capture ? '开' : '关'}`);

    let running = true;
    const stop = (): void => {
      running = false;
      log.info('收到结束信号，已保存进度，退出。');
      flushTelegramSync(); // best-effort: drain buffered logs to Telegram before exiting
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop); // the supervisor sends SIGTERM on hot restart

    // Chats whose listening loop has already started (deduplicated by chatId), to avoid starting duplicate loops on rescan.
    const started = new Set<string>();
    const startNew = (chats: { chatId: string; name: string; external: boolean }[]): number => {
      let added = 0;
      for (const chat of chats) {
        if (!chat.chatId || started.has(chat.chatId)) continue;
        const reason = store.chatInactiveReason(chat.chatId);
        // A dissolved chat (232009) is permanently gone — never re-listen. Mark it started so repeated
        // rescans don't keep logging the skip.
        if (reason === 'dissolved') {
          started.add(chat.chatId);
          log.info(`群【${chat.name || chat.chatId}】已解散，跳过监听。`);
          continue;
        }
        // An 'inaccessible' chat that shows up here again is in our live discovery list → we can reach
        // it once more (re-added). Clear the flag and resume monitoring it.
        if (reason === 'inaccessible') {
          store.clearChatInactive(chat.chatId);
          log.info(`群【${chat.name || chat.chatId}】恢复可访问，重新开始监听。`);
        }
        started.add(chat.chatId);
        // Stagger each chat's poll-loop start so the loops never fire in unison (a burst that hammers
        // Feishu at the same instant, e.g. on the hour). Steady-state cadence stays at pollIntervalMs;
        // only the initial phase is offset. `added` is the pre-increment index, so the first chat starts
        // immediately and each subsequent one is pushed back by one stagger step.
        const startDelayMs = added * cfg.discoveryStaggerMs;
        added += 1;
        this.startChatLoop(agent, chat.chatId, chat.name, chat.external, () => running, startDelayMs);
      }
      return added;
    };

    startNew(cfg.chats);


    // Sync the full member roster of every monitored chat into the directory (chat_members): captures
    // everyone (internal AND external), even people who never spoke; new joiners are imported, leavers
    // are kept (present=0) in case they return. Best-effort per chat. Each listChatMembers is a
    // blocking lark-cli call, so this briefly delays polling — acceptable on the discovery cadence.
    const syncMembers = async (chats: { chatId: string; name: string }[]): Promise<void> => {
      // Visitor-count milestone: announce each time the watched 围观群's present count crosses a multiple
      // of VISITOR_STEP (every 100 people).
      // SeeDAO 2.0 社区围观群; resolved from configs/lark.json's "围观群" alias. Empty when unconfigured,
      // so the chat.chatId === VISITOR_WATCH_CHAT_ID check below never matches and no milestone fires.
      const VISITOR_WATCH_CHAT_ID = resolveChatTarget('围观群') ?? '';
      const VISITOR_STEP = 100;
      let added = 0;
      let present = 0;
      let left = 0;
      let renamed = 0;
      // Aggregate the per-person change detail across all chats, so this round can be persisted with
      // the (open_id, name) of everyone who joined / left / got renamed (see member_sync_rounds).
      const joined: store.MemberRef[] = [];
      const leftMembers: store.MemberRef[] = [];
      const renamedMembers: store.MemberRef[] = [];
      // Spread the per-chat fetches across the cycle: each listChatMembers is a blocking lark-cli call,
      // and firing them all back-to-back used to land a burst of requests at the top of the cycle (which,
      // on a whole-minute cadence, collided at 整点). A small gap between chats avoids the thundering herd.
      const staggerMs = cfg.discoveryStaggerMs;
      let polled = 0;
      for (const chat of chats) {
        if (!running) return;
        if (!chat.chatId) continue;
        if (store.isChatInactive(chat.chatId)) continue; // known gone/inaccessible → skip silently
        if (polled > 0 && staggerMs > 0) await sleep(staggerMs);
        polled += 1;
        try {
          const roster = listChatMembers(chat.chatId, { profile });
          // We're always a member of a chat we monitor, so a truly empty roster means the fetch failed
          // transiently (and was swallowed). Skip rather than let syncChatMembers mark EVERYONE left —
          // which would corrupt the present count and the member_sync_rounds analytics. Retries next round.
          if (roster.size === 0) {
            log.warn(`群成员同步【${chat.name || chat.chatId}】：本轮取到空名册（疑似临时失败），跳过本轮以免误判全员离开。`);
            continue;
          }
          // Capture the watched group's pre-sync count so a crossing can be detected against this round.
          const watchPrev = chat.chatId === VISITOR_WATCH_CHAT_ID ? store.presentMemberCount(chat.chatId) : -1;
          const r = store.syncChatMembers(chat.chatId, roster);
          added += r.added;
          present += r.total;
          left += r.left;
          renamed += r.renamed;
          joined.push(...r.joinedMembers);
          leftMembers.push(...r.leftMembers);
          renamedMembers.push(...r.renamedMembers);
          if (r.added > 0 || r.left > 0 || r.renamed > 0) {
            log.info(`群成员同步【${chat.name || chat.chatId}】：在群 ${r.total} 人，新增 ${r.added}，离开 ${r.left}（已保留），改名 ${r.renamed}`);
          }
          // Visitor-count milestone: announce exactly once per hundred, ever. The persistent ledger
          // (visitor_milestones DB + visitors/<chatId>.json) is the idempotency gate; it survives
          // restarts, unlike the old in-memory round-over-round baseline which re-announced after a
          // restart. On a genuinely new milestone, freeze who the milestone-th visitor is (present-
          // member arrival order — matching the present count that drives the milestone), record it,
          // mirror to the wiki, then announce.
          if (watchPrev >= 0) {
            const visitorNum = r.total;
            const milestone = Math.floor(visitorNum / VISITOR_STEP) * VISITOR_STEP;
            if (milestone >= VISITOR_STEP && !isMilestoneRecorded(cfg.soul, chat.chatId, milestone)) {
              const person = store.nthPresentMemberByArrival(chat.chatId, milestone)
                ?? { openId: '', name: '', firstSeen: Math.floor(Date.now() / 1000) };
              recordMilestone(cfg.soul, chat.chatId, milestone, person, Math.floor(Date.now() / 1000));
              refreshVisitorMilestonesWiki(chat.chatId, { profile });
              log.info(`访客里程碑达成【${chat.name || chat.chatId}】：第 ${milestone} 人（${person.name || person.openId || '未知'}），记录并发送通知`);
              void fireEvent('visitor-num-notify', {
                profile,
                triggerReason: 'visitor_milestone',
                // Announce the crossed threshold (e.g. 400), not the exact live total (e.g. 402).
                vars: { visitor_num: milestone },
              });
            } else {
              log.debug(`访客人数监测【${chat.name || chat.chatId}】：当前 ${visitorNum} 人，里程碑 ${milestone}${milestone >= VISITOR_STEP ? ' 已记录' : ' 未达标'}，不发送`);
            }
          }
          // Deterministic newcomer welcome (batched): when members join the watched visitor group, queue
          // them for the next welcome digest instead of welcoming right away — the digest (08:30/14:30/
          // 20:30, supervisor.ts) drains the queue and @-mentions the whole window's arrivals in ONE
          // message, so a poll every 5 minutes doesn't trickle out lots of tiny welcomes. Gated on
          // watchPrev > 0 so a chat's very first sync — which flags its whole existing roster as "joined"
          // — never enqueues a bulk welcome; only genuine post-baseline joiners are queued. Each person
          // appears in joinedMembers only the first time they show up, so nobody is queued twice.
          if (chat.chatId === VISITOR_WATCH_CHAT_ID && watchPrev > 0 && r.joinedMembers.length > 0) {
            try {
              store.enqueuePendingWelcome(chat.chatId, r.joinedMembers);
              log.info(`迎新：已把 ${r.joinedMembers.length} 位新成员加入迎新队列【${chat.name || chat.chatId}】，待下次播报（08:30/14:30/20:30）统一欢迎`);
            } catch (e) {
              log.warn(`迎新入队失败【${chat.name || chat.chatId}】：${(e as Error).message}`);
            }
          }
        } catch (e) {
          // A dissolved group (232009) is permanently gone: flag it (members→离开), stop syncing it,
          // and don't treat it as a sync failure worth a warning every 5 minutes.
          if (isChatGoneError(e)) {
            const n = store.markChatInactive(chat.chatId, 'dissolved');
            log.warn(`群成员同步：群【${chat.name || chat.chatId}】已解散（code 232009），已标记 ${n} 名成员离开，今后不再同步该群。`);
            continue;
          }
          // Inaccessible (kicked / no permission): the per-chat poll loop owns the conservative
          // stand-down (after N consecutive). Here just note it once and move on, no per-chat hammering.
          if (isChatInaccessibleError(e)) {
            log.warn(`群成员同步：群【${chat.name || chat.chatId}】暂时无法访问（疑似被移出/无权限），交由轮询循环判定是否停轮。`);
            continue;
          }
          log.warn(`群成员同步失败【${chat.name || chat.chatId}】：`, (e as Error).message);
        }
      }
      const dir = store.directoryStats();
      // Persist this round to the ops time-series (every round, even no-change ones, so the series is
      // continuous). Best-effort: a failed write never disrupts the sync loop.
      store.recordMemberSyncRound({
        syncedAt: Math.floor(Date.now() / 1000),
        chatCount: chats.length,
        presentTotal: present,
        presentDistinct: dir.present,
        presentInternal: dir.presentInternal,
        presentExternal: dir.presentExternal,
        joinedCount: added,
        leftCount: left,
        renamedCount: renamed,
        rosterTotal: dir.distinct,
        joinedDetail: store.formatMemberRefs(joined),
        leftDetail: store.formatMemberRefs(leftMembers),
        renamedDetail: store.formatMemberRefs(renamedMembers),
        source: 'live',
      });
      // Only worth an INFO line when something actually changed; otherwise keep it at DEBUG so the
      // routine "nothing changed" sync (every few minutes) doesn't spam the log.
      const summary = `群成员同步完成：${chats.length} 群、在群合计 ${present} 人、在群去重 ${dir.present} 人、本轮新增 ${added} 人、离开 ${left} 人、改名 ${renamed} 人；名册累计 ${dir.distinct} 人`;
      if (added > 0 || left > 0 || renamed > 0) log.info(summary);
      else log.debug(summary);
    };

    // Reaction poll: for each group, fetch the last N messages WITH their reactions once and drive two
    // separate concerns off that single fetch:
    //   (1) like-maniac harvest — NON-WORK groups only: record each (message, reactor, emoji) into
    //       chat_reactions (deduped); when a member's reaction count *within the current logical week*
    //       reaches LIKE_MANIAC_WEEKLY_THRESHOLD, fire the like-maniac milestone once (gated to once per
    //       member per week by the like_maniac_weeks ledger). The first round only seeds the backlog.
    //   (2) auto-pin popular messages — any group with autoPinMinReactors configured (config-driven, see
    //       chat-policies.json): when TODAY's message has been reacted to by >= that many distinct people,
    //       pin it (once, idempotent via pinned_messages).
    // A group is scanned if it needs EITHER concern. Runs on the discovery cadence alongside member sync
    // (which populates reactor display names first).
    const REACTION_SCAN_MESSAGES = 18; // "近 18 则讯息" per the event spec
    const LIKE_MANIAC_WEEKLY_THRESHOLD = 66; // fire when a member reaches 66 reactions within one logical week
    const PIN_CAP = 5; // keep at most this many of OUR auto-pins per chat; unpin the oldest beyond it
    const REACTION_SEED_KEY = `feishu-reactions-seed-${profile}`;
    // Processing-indicator reactions the bot/operator add while replying (added→removed) are NOT genuine
    // likes; skip them so a thinking/queued marker never inflates a like count (both concerns).
    const INDICATOR_EMOJIS = new Set([cfg.reactionEmoji, cfg.queuedReactionEmoji]);
    const BOT_OPEN_ID = cfg.larkProfileMeta.botOpenId;
    const syncChatReactions = async (chats: { chatId: string; name: string }[]): Promise<void> => {
      const staggerMs = cfg.discoveryStaggerMs;
      const seeded = loadCursor(REACTION_SEED_KEY).lastPosition === 1;
      // Only TODAY's (current logical day) messages are eligible for auto-pin.
      const todayStartMs = logicalDayStart(new Date()).getTime();
      // Reactors with at least one new (first-seen) reaction this round → only these members can have
      // newly reached the weekly threshold, so only they are re-checked below.
      const newByMember = new Map<string, number>();
      let scannedChats = 0;
      let totalNew = 0;
      let pinned = 0;
      let unpinnedOld = 0;
      let polled = 0;
      for (const chat of chats) {
        if (!running) return;
        if (!chat.chatId) continue;
        if (store.isChatInactive(chat.chatId)) continue; // known gone/inaccessible → skip silently
        const doLikeTally = getChatTier(chat.chatId) !== 'work'; // likes are only harvested in non-work groups
        const pinThreshold = getAutoPinThreshold(chat.chatId); // 0 = auto-pin disabled for this chat
        if (!doLikeTally && pinThreshold === 0) continue; // nothing to do for this chat
        if (polled > 0 && staggerMs > 0) await sleep(staggerMs);
        polled += 1;
        try {
          const messages = listMessages(chat.chatId, {
            pageSize: REACTION_SCAN_MESSAGES,
            sort: 'desc',
            includeReactions: true,
            profile,
          });
          scannedChats += 1;
          for (const msg of messages) {
            // Single pass over this message's reactions: collect distinct human reactors (for the pin
            // check) and, in non-work groups, record each reaction (for the like tally).
            const humanReactors = new Set<string>();
            for (const rx of msg.reactions ?? []) {
              if (rx.operatorType && rx.operatorType !== 'user') continue; // skip app/bot reactions
              if (rx.reactorOpenId === BOT_OPEN_ID) continue; // never count the bot itself
              if (INDICATOR_EMOJIS.has(rx.emojiType)) continue; // skip processing-indicator reactions
              humanReactors.add(rx.reactorOpenId);
              if (doLikeTally) {
                const fresh = store.recordChatReaction({
                  messageId: msg.messageId,
                  chatId: chat.chatId,
                  reactorOpenId: rx.reactorOpenId,
                  emojiType: rx.emojiType,
                  actionTime: rx.actionTime,
                });
                if (fresh) {
                  newByMember.set(rx.reactorOpenId, (newByMember.get(rx.reactorOpenId) ?? 0) + 1);
                  totalNew += 1;
                }
              }
            }
            // Auto-pin: a today's message reacted to by >= threshold distinct people gets pinned once.
            if (pinThreshold > 0 && humanReactors.size >= pinThreshold && !store.isMessagePinned(msg.messageId)) {
              const createMs = Number(msg.createTime);
              if (Number.isFinite(createMs) && createMs >= todayStartMs) {
                if (pinMessage(msg.messageId, { as: 'bot', profile })) {
                  store.recordPinnedMessage(msg.messageId, chat.chatId, humanReactors.size);
                  pinned += 1;
                  log.info(
                    `热门消息置顶【${chat.name || chat.chatId}】：${humanReactors.size} 人反应（阈值 ${pinThreshold}），已置顶 message_id=${msg.messageId}`
                  );
                  // Cap: keep at most PIN_CAP of OUR auto-pins in this chat; unpin the oldest beyond it.
                  // Drop each from tracking regardless of the unpin result — an unpin failure almost always
                  // means the pin is already gone (message deleted / unpinned by hand), so keeping the row
                  // would wedge the cap; the small risk is one extra visible pin after a transient blip.
                  for (const oldId of store.pinnedMessagesOldestBeyond(chat.chatId, PIN_CAP)) {
                    const removed = unpinMessage(oldId, { as: 'bot', profile });
                    store.removePinnedMessage(oldId);
                    unpinnedOld += 1;
                    if (removed) {
                      log.info(`热门消息取消置顶【${chat.name || chat.chatId}】：超过 ${PIN_CAP} 条上限，取消最旧 message_id=${oldId}`);
                    } else {
                      log.warn(`热门消息取消置顶失败但已移除追踪【${chat.name || chat.chatId}】：message_id=${oldId}（可能已被删除或手动取消）`);
                    }
                  }
                } else {
                  log.warn(
                    `热门消息置顶失败【${chat.name || chat.chatId}】：message_id=${msg.messageId}（bot 可能不在群或缺 Pin 权限）`
                  );
                }
              }
            }
          }
        } catch (e) {
          if (isChatGoneError(e)) {
            store.markChatInactive(chat.chatId, 'dissolved');
            continue;
          }
          // Inaccessible: the per-chat poll loop owns the conservative stand-down; just skip here.
          if (isChatInaccessibleError(e)) continue;
          log.warn(`表情反应采集失败【${chat.name || chat.chatId}】：`, (e as Error).message);
        }
      }

      // First-ever round: only seed the LIKE backlog (no milestone firing), then remember we've seeded so
      // subsequent rounds fire on genuinely new reactions. Auto-pin is NOT gated by the seed flag — it
      // ran inside the loop above, so today's already-popular messages get pinned even on the first round.
      if (!seeded) {
        saveCursor(REACTION_SEED_KEY, { lastPosition: 1, lastMessageId: null });
        log.info(
          `表情反应采集：首轮基线，已记录 ${totalNew} 条历史反应（本轮不触发点赞里程碑），本轮置顶 ${pinned} 条热门消息，共扫描 ${scannedChats} 个群。`
        );
        return;
      }

      // Steady state: for each member with new reactions this round, fire once if their reaction count
      // within the CURRENT logical week has reached the threshold and the milestone hasn't already fired
      // for them this week. The like_maniac_weeks ledger is the restart-proof once-per-week gate — a plain
      // in-memory crossing check would re-fire after a restart or on late-arriving out-of-week reactions.
      // fire-and-forget — fireEvent never throws into this poll.
      const weekStart = logicalWeekStart(new Date());
      const weekStartSec = Math.floor(weekStart.getTime() / 1000);
      const weekEndSec = weekStartSec + Math.floor((7 * DAY_MS) / 1000);
      for (const [openId, delta] of newByMember) {
        if (delta <= 0) continue;
        const weeklyCount = store.weeklyMemberReactionCount(openId, weekStartSec, weekEndSec);
        const name = store.memberName(openId) || openId;
        if (weeklyCount < LIKE_MANIAC_WEEKLY_THRESHOLD) {
          log.debug(`点赞监测【${name}】：本周 ${weeklyCount}（本轮 +${delta}），阈值 ${LIKE_MANIAC_WEEKLY_THRESHOLD}`);
          continue;
        }
        if (store.isLikeManiacWeekRecorded(weekStartSec, openId)) {
          log.debug(`点赞监测【${name}】：本周 ${weeklyCount}，已触发过点赞狂魔，跳过`);
          continue;
        }
        if (!store.recordLikeManiacWeek(weekStartSec, openId, name, weeklyCount)) continue; // lost the race
        log.info(`点赞狂魔提醒触发【${name}】：本周点赞 ${weeklyCount}（本轮 +${delta}）达 ${LIKE_MANIAC_WEEKLY_THRESHOLD}，发送通知`);
        void fireEvent('like-maniac-notify', {
          profile,
          triggerReason: 'like_milestone',
          actorOpenId: openId,
          vars: { member_name: name },
        });
      }
      const summary = `表情反应采集完成：扫描 ${scannedChats} 个群，新增 ${totalNew} 条反应，置顶 ${pinned} 条热门消息，取消旧置顶 ${unpinnedOld} 条`;
      if (totalNew > 0 || pinned > 0 || unpinnedOld > 0) log.info(summary);
      else log.debug(summary);
    };
    // Poll all upcoming (not-yet-started) Feishu calendar events and record per-event RSVP counts into
    // calendar_event_rsvp_rounds. Runs on the same discoveryRefreshMs cadence as member sync. No quiet
    // guard: RSVP collection is pure data gathering, same as member sync — runs in quiet mode too.
    const syncCalendarEventRsvp = async (): Promise<void> => {
      const staggerMs = cfg.discoveryStaggerMs;
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const startIso = new Date().toISOString().slice(0, 10);
        const endIso = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
        const events = listUpcomingCalendarEvents({ profile, startIso, endIso });
        // Only track events that have not yet started; past/ongoing events have no meaningful signup trend.
        const upcoming = events.filter((e) => e.startTimeSec > nowSec);
        // +agenda expands a recurring event into one item per occurrence (same series uuid, different
        // _<ts> suffix), all sharing identical RSVP — so tracking every future occurrence is pure
        // redundancy. Collapse each series to just its soonest upcoming occurrence; non-recurring
        // events have a unique series key and are unaffected.
        const nearestBySeries = new Map<string, CalendarEvent>();
        for (const e of upcoming) {
          const key = recurringSeriesKey(e.eventId);
          const cur = nearestBySeries.get(key);
          if (!cur || e.startTimeSec < cur.startTimeSec) nearestBySeries.set(key, e);
        }
        const tracked = [...nearestBySeries.values()].sort((a, b) => a.startTimeSec - b.startTimeSec);
        if (tracked.length === 0) {
          log.debug('活动报名采集：当前窗口内无尚未开始的活动，跳过本轮。');
          return;
        }
        // Signup milestones for course-type activities (共学/课). When the signup count (accept + tentative)
        // newly crosses one of these, a "limited slots" reminder fires once.
        const CLASS_SIGNUP_THRESHOLDS = [10, 25, 40, 50, 60, 75, 90];
        // Stagger the per-event attendee fetches for the same reason as member sync (see above).
        let polledEv = 0;
        for (const e of tracked) {
          if (!running) return;
          if (polledEv > 0 && staggerMs > 0) await sleep(staggerMs);
          polledEv += 1;
          try {
            const attendees = listEventAttendees(e.calendarId, e.eventId, { profile });
            let accepted = 0;
            let declined = 0;
            let tentative = 0;
            let needsAction = 0;
            for (const a of attendees) {
              if (a.rsvpStatus === 'removed') continue;
              if (a.rsvpStatus === 'accept') accepted += 1;
              else if (a.rsvpStatus === 'decline') declined += 1;
              else if (a.rsvpStatus === 'tentative') tentative += 1;
              else if (a.rsvpStatus === 'needs_action') needsAction += 1;
            }
            const signupTotal = accepted + declined + tentative + needsAction;
            const prev = store.latestCalendarEventRsvpRound(e.eventId);
            store.recordCalendarEventRsvpRound({
              syncedAt: nowSec,
              eventId: e.eventId,
              calendarId: e.calendarId,
              title: e.summary,
              startTime: e.startTimeSec,
              endTime: e.endTimeSec,
              accepted,
              declined,
              tentative,
              needsAction,
              signupTotal,
              source: 'live',
            });
            const changed = !prev
              || prev.accepted !== accepted
              || prev.declined !== declined
              || prev.tentative !== tentative
              || prev.needsAction !== needsAction;
            // Change in the headline signup count since the previous round (the whole count on first
            // sight): a gain reads as 新增 N, a withdrawal as 取消 N, and it leads the line.
            const acceptedDelta = accepted - (prev?.accepted ?? 0);
            const deltaLabel = acceptedDelta < 0 ? `取消 ${-acceptedDelta}` : `新增 ${acceptedDelta}`;
            if (changed) {
              log.info(`活动报名采集【${e.summary}】：${deltaLabel}，报名(接受) ${accepted}，拒绝 ${declined}，待定 ${tentative}，待回复 ${needsAction}`);
            } else {
              log.debug(`活动报名采集【${e.summary}】：无变化（报名(接受) ${accepted}）`);
            }
            // Course-signup milestone notify: only for 共学/课 activities. accept_num counts accept + tentative
            // (待定). A milestone fires only when accept_num newly crosses a threshold vs the previous round
            // (so thresholds already passed before tracking began never back-fire). The per-poll monitoring
            // line is logged at INFO whenever the count changed (or a milestone fires) and DEBUG otherwise,
            // so the supervisor's log stream shows the course being watched. fire-and-forget — fireEvent
            // sends as the bot and never throws into this poll.
            if (e.summary.includes('共学') || e.summary.includes('课')) {
              const acceptNum = accepted + tentative;
              const prevAcceptNum = prev ? prev.accepted + prev.tentative : 0;
              const crossed = CLASS_SIGNUP_THRESHOLDS.filter((t) => prevAcceptNum < t && acceptNum >= t);
              const reached = CLASS_SIGNUP_THRESHOLDS.filter((t) => acceptNum >= t);
              const next = CLASS_SIGNUP_THRESHOLDS.find((t) => acceptNum < t);
              const status = `课程报名监测【${e.summary}】：报名(含待定) ${acceptNum} 人，已达阈值 ${reached.join('/') || '无'}`
                + (next ? `，下一阈值 ${next}（还差 ${next - acceptNum} 人）` : '，已达最高阈值');
              if (crossed.length > 0) {
                // Prefer the browser-openable web share link; fall back to the in-app app_link. Only
                // fetched here (on a crossing), so the extra API call stays off the hot poll path.
                const eventLink = getEventShareLink(e.calendarId, e.eventId, { profile }) || e.appLink;
                log.info(`${status}；本轮跨越 ${crossed.join('/')}，触发报名提醒`);
                void fireEvent('class-event-notify', {
                  profile,
                  triggerReason: 'class_signup_milestone',
                  vars: {
                    event_name: e.summary.trim(),
                    accept_num: acceptNum,
                    remaining: Math.max(0, 100 - acceptNum),
                    event_link: eventLink,
                  },
                });
              } else if (changed) {
                log.info(status);
              } else {
                log.debug(status);
              }
            }
          } catch (evErr) {
            log.warn(`活动报名采集【${e.summary}】失败：`, (evErr as Error).message);
          }
        }
        const collapsed = upcoming.length - tracked.length;
        const summary = `活动报名采集完成：本轮采集 ${tracked.length} 个尚未开始的活动`
          + (collapsed > 0 ? `（重复活动合并了 ${collapsed} 个未来实例，只取最近一次）` : '');
        log.debug(summary);
      } catch (err) {
        log.warn('活动报名采集整体失败：', (err as Error).message);
      }
    };

    // Poll document access records: enumerate every document the user can administer (all nodes of each
    // accessible wiki space, plus the user's own Drive documents), read each one's access records, and
    // log the per-document delta. Recording is idempotent on (file, viewer, last-view-time), so only a
    // genuinely new viewer or an advanced view time is written and logged. Documents the user only has
    // edit/read access to reject the access-record call; those are counted as a coverage gap, and the
    // first rejection in a wiki space short-circuits the rest of that space. No quiet guard: like member
    // sync this is pure data gathering and runs in quiet mode too.
    const syncDocViewRecords = async (): Promise<void> => {
      const staggerMs = cfg.discoveryStaggerMs;
      try {
        // Reduce every candidate document to the object token + type the access-record API expects.
        const targets: Array<{ fileToken: string; fileType: string; source: string; spaceId: string; title: string }> = [];
        for (const space of listWikiSpaces({ profile })) {
          for (const node of listWikiNodesDeep(space.spaceId, { profile })) {
            if (!VIEW_RECORD_FILE_TYPES.has(node.objType)) continue;
            targets.push({ fileToken: node.objToken, fileType: node.objType, source: 'wiki', spaceId: space.spaceId, title: node.title });
          }
        }
        for (const file of listDriveFilesDeep({ profile })) {
          if (!VIEW_RECORD_FILE_TYPES.has(file.type)) continue;
          targets.push({ fileToken: file.token, fileType: file.type, source: 'drive', spaceId: '', title: file.name });
        }
        // A wiki object can also surface via Drive enumeration; keep one target per file token.
        const byToken = new Map<string, typeof targets[0]>();
        for (const t of targets) if (!byToken.has(t.fileToken)) byToken.set(t.fileToken, t);
        const unique = [...byToken.values()];
        const capped = unique.slice(0, DOC_VIEW_MAX_TARGETS);

        let scanned = 0;
        let forbidden = 0;
        let newViews = 0;
        // Spaces lacking owner/admin rights reject every file identically; remember them so one rejection
        // skips the rest of that space instead of probing every node.
        const forbiddenSpaces = new Set<string>();
        // Stagger the per-document access-record reads: this hourly pass scans the most documents of any
        // loop (~one blocking call each), so without spreading them it is the densest burst we emit.
        let scanAttempts = 0;
        for (const t of capped) {
          if (!running) return;
          if (t.spaceId && forbiddenSpaces.has(t.spaceId)) continue;
          if (scanAttempts > 0 && staggerMs > 0) await sleep(staggerMs);
          scanAttempts += 1;
          let records;
          try {
            records = listFileViewRecords(t.fileToken, t.fileType, { profile });
          } catch (e) {
            if (isViewRecordForbiddenError(e)) {
              forbidden += 1;
              if (t.spaceId) forbiddenSpaces.add(t.spaceId);
            } else {
              log.warn(`文档访问采集【${t.title}】失败：`, (e as Error).message);
            }
            continue;
          }
          scanned += 1;
          let fresh = 0;
          const freshNames: string[] = [];
          for (const r of records) {
            const inserted = store.recordDocViewEvent({
              fileToken: t.fileToken,
              fileType: t.fileType,
              source: t.source,
              spaceId: t.spaceId,
              title: t.title,
              viewerId: r.viewerId,
              viewerName: r.name,
              lastViewTime: r.lastViewTimeSec,
            });
            if (inserted) {
              fresh += 1;
              if (r.name) freshNames.push(r.name);
            }
          }
          if (fresh > 0) {
            newViews += fresh;
            log.info(`文档访问采集【${t.title}】：新增 ${fresh} 条访问（${freshNames.slice(0, 8).join('、')}）`);
          }
        }
        const truncated = unique.length > capped.length ? `（候选 ${unique.length} 个，本轮只扫前 ${capped.length} 个）` : '';
        const gap = forbidden > 0 ? `，${forbidden} 个无访问记录权限已跳过` : '';
        const summary = `文档访问采集完成：扫描 ${scanned} 个文档，新增 ${newViews} 条访问记录${gap}${truncated}`;
        if (newViews > 0) log.info(summary);
        else log.debug(summary);
      } catch (err) {
        log.warn('文档访问采集整体失败：', (err as Error).message);
      }
    };

    // Initial sync runs slightly after startup so the poll loops come online first. Member sync and RSVP
    // each stagger their internal per-chat/per-event calls, so this is awaited (fire-and-forget).
    setTimeout(() => {
      if (!running) return;
      void (async () => {
        await syncMembers(cfg.chats);
        await syncChatReactions(cfg.chats);
        await syncCalendarEventRsvp();
      })();
    }, 3000);

    // Document access-record polling runs on its own hourly loop, independent of the message poll and
    // discovery cadences, with the first pass deferred until startup has settled. The scan itself now
    // staggers its per-document reads, so reschedule only AFTER it completes (no overlapping passes).
    const docViewLoop = async (): Promise<void> => {
      if (!running) return;
      await syncDocViewRecords();
      if (running) setTimeout(() => void docViewLoop(), DOC_VIEW_REFRESH_MS);
    };
    setTimeout(() => void docViewLoop(), DOC_VIEW_INITIAL_DELAY_MS);

    // Watch the user token's expiry and push escalating Telegram reminders as it nears the re-login
    // deadline. Independent of the message poll cadence; reminders de-duplicate per grant so renewing
    // silences them.
    const tokenWatchLoop = (): void => {
      if (!running) return;
      void checkUserTokenExpiry(profile);
      if (running) setTimeout(tokenWatchLoop, TOKEN_WATCH_REFRESH_MS);
    };
    setTimeout(tokenWatchLoop, TOKEN_WATCH_INITIAL_DELAY_MS);

    // Periodically rescan the chat list (pick up newly joined chats) AND refresh every chat's member
    // roster, on the discovery cadence (discoveryRefreshMs, e.g. 7m17s — deliberately off the whole-minute
    // grid so the cycle never phase-locks to 整点). Member sync and RSVP each stagger their internal calls,
    // so the next cycle is scheduled only AFTER this one finishes — never overlapping, and the small
    // stagger-tail (a handful of seconds) is negligible against the multi-minute period.
    const rescan = async (): Promise<void> => {
      if (!running) return;
      try {
        const chats = cfg.rediscover();
        const added = startNew(chats);
        if (added > 0) log.info(`重扫群清单：新增监听 ${added} 个群（共 ${started.size}）`);
        await syncMembers(chats);
        await syncChatReactions(chats);
        await syncCalendarEventRsvp();
      } catch (e) {
        log.warn('重扫群清单失败：', (e as Error).message);
      }
      if (running) setTimeout(() => void rescan(), cfg.discoveryRefreshMs);
    };
    setTimeout(() => void rescan(), cfg.discoveryRefreshMs);

    return new Promise(() => {
      /* stays resident until SIGINT */
    });
  }

  /** Start an independent polling loop for a single chat (each with its own cursor). */
  private startChatLoop(
    agent: Agent,
    chatId: string,
    chatName: string,
    external: boolean,
    isRunning: () => boolean,
    initialDelayMs = 0
  ): void {
    const cfg = this.cfg;
    const profile = cfg.larkProfile;
    // 采集不回复（serve --quiet → AGENT_QUIET，或本频道 collectOnly）：照常采集/记录，但 handle() 不回复、
    // 不调用 LLM、不加表情。collectOnly 让 user-token 数据采集运行时永不替操作者本人发言。
    const quiet = process.env.AGENT_QUIET === '1' || cfg.collectOnly === true;
    // Register this chat in the database so messages can reference it via foreign key.
    try { upsertChat({ chatId, name: chatName, external }); } catch { /* best-effort */ }
    const key = `feishu-user-${profile}-${chatId}`;
    const cursor = loadCursor(key);

    if (cursor.lastPosition === null) {
      try {
        const latest = listMessages(chatId, { pageSize: 1, sort: 'desc', profile });
        cursor.lastPosition = latest.length ? latest[0].position : -1;
        cursor.lastMessageId = latest.length ? latest[0].messageId : null;
        saveCursor(key, cursor);
        log.info(`[${chatName || chatId}] 首次启动，从 position ${cursor.lastPosition} 之后监听`);
      } catch (e) {
        // A chat that's already dissolved at startup: mark it and don't start a poll loop for it
        // (otherwise the first tick would just stand it down anyway, after a scary init error).
        if (isChatGoneError(e)) {
          const n = store.markChatInactive(chatId, 'dissolved');
          log.warn(`[${chatName || chatId}] 群已解散（code 232009），不启动轮询；已标记 ${n} 名成员离开。`);
          return;
        }
        log.error(`[${chatName || chatId}] 初始化游标失败：`, (e as Error).message);
      }
    } else {
      log.info(`[${chatName || chatId}] 接续进度，从 position ${cursor.lastPosition} 之后监听`);
    }

    // Download a message's file attachment on demand (cached), so the context can inline its content.
    const fetchFile = (messageId: string, fileKey: string, fileName: string): string | null =>
      downloadMessageResource(messageId, fileKey, { type: 'file', profile, fileName });

    // Message types the model should see in the conversation context: text, plus file/image/video
    // attachments (rendered as a marker, with text-file content inlined). Everything else (system,
    // interactive cards, shares, ...) stays out of the context as before.
    const CONTEXT_MSG_TYPES = new Set(['text', 'file', 'image', 'media']);

    const buildContext = (descMessages: LarkMessage[], upto: number): string =>
      descMessages
        .filter((m) => m.position <= upto && CONTEXT_MSG_TYPES.has(m.msgType))
        .slice(0, cfg.contextSize)
        .reverse()
        .map((m) => {
          const agentMsg = isAgentMessage(m.content);
          const who = agentMsg ? agent.name : '使用者';
          let text: string;
          if (m.msgType === 'text') {
            text = agentMsg ? m.content.replace(/^🤖\s*[^:：]*[:：]\s*/, '') : m.content;
          } else {
            // File/image/video attachment: render a marker and inline text-file content when possible.
            text = renderMessageBody(m, { fetchFile, maxInlineChars: 2000 });
          }
          return text ? `${who}: ${text}` : '';
        })
        .filter(Boolean)
        .join('\n');

    // Self-identification: if the sender open_id equals our own open_id, the message was sent by us.
    const isSelf = (msg: LarkMessage): boolean => {
      if (msg.senderOpenId && msg.senderOpenId === cfg.selfOpenId) {
        return true;
      }
      // Secondary safeguard: the 🤖 prefix.
      return isAgentMessage(msg.content);
    };

    // Trigger check: mention (mentions contains selfOpenId) / prefix / all (accept everything).
    const isTriggered = (msg: LarkMessage): { hit: boolean; text: string } => {
      if (cfg.trigger === 'all') return { hit: true, text: msg.content };
      if (cfg.trigger === 'prefix') {
        if (cfg.triggerPrefix && msg.content.startsWith(cfg.triggerPrefix)) {
          return { hit: true, text: msg.content.slice(cfg.triggerPrefix.length).trim() };
        }
        return { hit: false, text: msg.content };
      }
      // mention
      if (msg.mentions.includes(cfg.selfOpenId)) {
        return { hit: true, text: msg.content };
      }
      return { hit: false, text: msg.content };
    };

    const handle = (msg: LarkMessage, all: LarkMessage[], userText: string): void => {
      log.info(`[${chatName || chatId}] 收到：${preview(userText)}`);
      // Processing indicator: once we detect we should respond, add a reaction first and remove it after the reply is sent (best-effort; failures do not affect the reply).
      // 静默模式不加“处理中”表情（那也是一种对外可见的回应）。
      const reactionId = !quiet && msg.messageId
        ? addReaction(msg.messageId, cfg.reactionEmoji, { as: 'user', profile })
        : null;
      let reply: string;
      // Try command mode first (pure code, no kimi call); only hand off to the agent if nothing matches.
      const dr = dispatchCommand(userText, {
        agentName: agent.name,
        identity: cfg.identity,
        source: this.name,
        chatId,
        senderOpenId: msg.senderOpenId,
      });
      // LP strategy for this soul (cost and optional classification).
      const strategy = loadLpStrategy(cfg.soul);
      const senderOpenId = msg.senderOpenId;

      if (dr.handled) {
        log.info(`命令：${dr.command}`);
        reply = dr.reply ?? '';
        // Record command activity for analytics.
        try {
          store.recordActivity('command', senderOpenId || null, chatId, msg.messageId || null, { command: dr.command, args: dr.args ?? [] });
        } catch { /* best-effort */ }
      } else if (quiet) {
        // 静默模式：消息已采集 + 互动已记录，不调用 LLM、不回复。
        reply = '';
        log.info(`[${chatName || chatId}] quiet 模式：已采集，略过 LLM 回复（${preview(userText)}）`);
      } else {
        // LP gating: deduct before calling the LLM; refund on error; show balance in footer on success.
        if (senderOpenId) {
          const cost = strategy.cost;
          const spent = store.spendPt(senderOpenId, cost, 'llm_reply', msg.messageId || undefined);
          if (!spent) {
            reply = '你的 LP 不足，明天 05:00 会自动补到 10，或完成任务赚取。';
          } else {
            try {
              reply = agent.respond({
                message: userText,
                context: buildContext(all, msg.position),
                session: `${cfg.id}-${chatId}`,
                userOpenId: senderOpenId,
                chatId,
                source: this.name,
              });
              // Classify the reply, grant bonus LP if applicable, then build the footer with the net delta.
              const { category, reply: judged } = judgeReply(reply, strategy);
              if (category.grant > 0) {
                store.grantPt(senderOpenId, category.grant, category.reason, msg.messageId || undefined);
              }
              const netDelta = category.grant - cost;
              reply = store.stripStatusFooter(judged) + store.buildStatusFooter(senderOpenId, netDelta, category.footerLabel || undefined);
            } catch (e) {
              log.error('agent 回复失败（已回退通用回复）：', (e as Error).message);
              store.grantPt(senderOpenId, cost, 'refund_on_error', msg.messageId || undefined);
              reply = '（抱歉，我这边出错了，请稍后再试。）';
            }
          }
        } else {
          try {
            reply = agent.respond({
              message: userText,
              context: buildContext(all, msg.position),
              session: `${cfg.id}-${chatId}`,
              chatId,
              source: this.name,
            });
          } catch (e) {
            log.error('agent 回复失败（已回退通用回复）：', (e as Error).message);
            reply = '（抱歉，我这边出错了，请稍后再试。）';
          }
        }
      }
      try {
        if (!quiet && reply) {
          // Reply within the original message's thread (do not start a new topic in topic-based chats); fall back to sending to the chat directly when there is no message_id.
          if (msg.messageId) {
            replyText(msg.messageId, cfg.replyPrefix + reply, { as: 'user', profile, inThread: true });
          } else {
            sendText({ chatId }, cfg.replyPrefix + reply, { as: 'user', profile });
          }
          const { body, footer } = store.splitStatusFooter(reply);
          log.info(`[${chatName || chatId}] 已回复：${preview(body)}`);
          if (footer) log.info(`[${chatName || chatId}] 尾部状态：${footer}`);
        }
      } catch (e) {
        log.error('发送失败：', (e as Error).message);
      } finally {
        if (msg.messageId && reactionId) removeReaction(msg.messageId, reactionId, { as: 'user', profile });
      }
    };

    const pollOnce = (): void => {
      const messages = listMessages(chatId, { pageSize: 20, sort: 'desc', profile });
      const fresh = messages
        .filter((m) => Number.isFinite(m.position) && m.position > (cursor.lastPosition ?? -1))
        .sort((a, b) => a.position - b.position);

      for (const msg of fresh) {
        cursor.lastPosition = msg.position;
        cursor.lastMessageId = msg.messageId;

        // ① Full capture (before self-identification and trigger checks); runs for both internal and external chats.
        if (cfg.capture) {
          try {
            appendTranscript(chatId, {
              message_id: msg.messageId,
              create_time: msg.createTime,
              sender_open_id: msg.senderOpenId,
              sender_name: msg.senderName,
              msg_type: msg.msgType,
              text: msg.content,
              mentions: msg.mentions,
              sender_id_type: msg.senderIdType,
              sender_type: msg.senderType,
              sender_tenant_key: msg.senderTenantKey,
              thread_id: msg.threadId,
              thread_message_position: msg.threadMessagePosition,
              message_position: msg.position,
            });
          } catch (e) {
            log.warn('采集失败：', (e as Error).message);
          }
        }

        // ② Self-identification: skip messages we sent ourselves
        if (isSelf(msg)) {
          saveCursor(key, cursor);
          continue;
        }

        // ③ Trigger check: only respond when permitted for this chat type.
        // External chats only trigger when interactExternal is enabled; collection (①) is always on.
        const createMs = Number(msg.createTime);
        const tooOld = Number.isFinite(createMs) && createMs < this.startedAtMs - STARTUP_GRACE_MS;
        const canInteract = !external || cfg.interactExternal;
        if (!tooOld && msg.msgType === 'text' && canInteract) {
          const { hit, text } = isTriggered(msg);
          if (hit) {
            // Record the interaction best-effort before handing off to the handler.
            if (msg.senderOpenId) {
              try {
                store.recordInteraction(msg.senderOpenId, msg.senderName, chatId, msg.messageId);
              } catch { /* best-effort: do not block reply on gamification errors */ }
            }
            handle(msg, messages, text);
          }
        }
        saveCursor(key, cursor);
      }
    };

    // Backoff state for this chat's poll loop. A single Feishu blip (e.g. code 2200 "Internal Error")
    // self-heals on the next poll, so the poll interval itself IS the retry — we just keep the first
    // few failures quiet (WARN) and only escalate to ERROR + exponential backoff when failures
    // persist (a sustained outage, or we were removed from the chat). Resets to normal on any success.
    let consecutiveFails = 0;
    const MAX_BACKOFF_MS = 60_000;
    // Escalate to ERROR (and stop calling each blip an error) once this many polls fail in a row.
    const ESCALATE_AFTER = 3;
    // Count of CONSECUTIVE "chat inaccessible" polls (kicked / no permission). Unlike a dissolved chat
    // we don't stand down on the first hit — only once it persists this many polls in a row — because
    // the condition may be a transient permission blip and is recoverable (we may be re-added).
    let inaccessibleStreak = 0;
    const INACCESSIBLE_STANDDOWN_AFTER = 3;

    const tick = (): void => {
      if (!isRunning()) return;
      let nextDelay = cfg.pollIntervalMs;
      try {
        pollOnce();
        consecutiveFails = 0; // recovered → back to the normal cadence
        inaccessibleStreak = 0;
      } catch (e) {
        // Dissolved group (232009): permanently gone. Flag it (members→离开), stop this poll loop
        // entirely (no reschedule below), and don't keep logging it as a recurring failure.
        if (isChatGoneError(e)) {
          const n = store.markChatInactive(chatId, 'dissolved');
          log.warn(`[${chatName || chatId}] 群已解散（code 232009），停止轮询；已标记 ${n} 名成员离开。`);
          try { store.recordActivity('chat_dissolved', null, chatId, null); } catch { /* best-effort */ }
          return; // do NOT setTimeout(tick) → this chat's loop ends
        }
        // Inaccessible (kicked out / no permission): possibly recoverable, so stand down only after it
        // persists INACCESSIBLE_STANDDOWN_AFTER consecutive polls. Below threshold → back off and retry.
        if (isChatInaccessibleError(e)) {
          inaccessibleStreak += 1;
          if (inaccessibleStreak >= INACCESSIBLE_STANDDOWN_AFTER) {
            const n = store.markChatInactive(chatId, 'inaccessible');
            log.warn(`[${chatName || chatId}] 已连续 ${inaccessibleStreak} 次无法访问该群（疑似被移出/无权限），停止轮询；已标记 ${n} 名成员离开。重新入群后会在下次重扫/重启时自动恢复。`);
            try { store.recordActivity('chat_inaccessible', null, chatId, null); } catch { /* best-effort */ }
            return; // stand down: no reschedule
          }
          consecutiveFails += 1;
          nextDelay = Math.min(cfg.pollIntervalMs * 2 ** Math.min(consecutiveFails, 5), MAX_BACKOFF_MS);
          log.warn(
            `[${chatName || chatId}] 暂时无法访问该群（第 ${inaccessibleStreak}/${INACCESSIBLE_STANDDOWN_AFTER} 次），${Math.round(nextDelay / 1000)}s 后重试：`,
            (e as Error).message
          );
          if (isRunning()) setTimeout(tick, nextDelay);
          return;
        }
        // Any other failure → require the inaccessible streak to be CONSECUTIVE, so reset it here.
        inaccessibleStreak = 0;
        consecutiveFails += 1;
        const err = e as Error;
        // Unknown (non-LarkApiError) failures are treated as retryable too: the next poll retries.
        const retryable = err instanceof LarkApiError ? err.retryable : true;
        // Slow the loop down on sustained failure so a real outage doesn't flood the log every 4s.
        nextDelay = Math.min(
          cfg.pollIntervalMs * 2 ** Math.min(consecutiveFails, 5),
          MAX_BACKOFF_MS
        );
        const codeTag =
          err instanceof LarkApiError && err.code
            ? `（code=${err.code}${err.logId ? `, log_id=${err.logId}` : ''}）`
            : '';
        // A retryable blip that hasn't repeated is expected and self-healing → keep it at WARN.
        // Persistent or non-retryable failures are real and actionable → ERROR, with backoff noted.
        if (retryable && consecutiveFails < ESCALATE_AFTER) {
          log.warn(`[${chatName || chatId}] 轮询暂时失败，下次轮询自动重试：`, err.message + codeTag);
        } else {
          log.error(
            `[${chatName || chatId}] 轮询连续失败 ${consecutiveFails} 次，${Math.round(nextDelay / 1000)}s 后重试：`,
            err.message + codeTag
          );
        }
      }
      if (isRunning()) setTimeout(tick, nextDelay);
    };
    // Defer the first poll by the caller-supplied stagger offset so sibling chat loops don't all fire
    // their first tick at the same instant (0 = start immediately, preserving the original behavior).
    if (initialDelayMs > 0) setTimeout(tick, initialDelayMs);
    else tick();
  }
}
