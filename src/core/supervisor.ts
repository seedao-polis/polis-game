import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR } from './paths.js';
import { log } from './log.js';
import * as store from './store.js';
import { scanCorruptSessions, quarantineSession } from './kimi-session.js';
import { loadConfigs, listAgents, resolveAgent, resolveChatTarget, loadChatPolicies, type WorkerTarget } from './configs.js';
import { sendText } from './lark.js';
import { flushTelegramSync } from './telegram.js';
import { listScheduledEvents, rollScheduledEvent, type EventSchedule } from './events.js';
import { generateAndSendDailyReport, generateAndSendMonthlyReport } from './ops-report.js';
import { generateAndSendWeeklyReport } from './weekly-report.js';
import { checkUserTokenExpiry } from './token-watch.js';
import { purgeExpiredMemories, listKnownChatIds } from './store/memory.js';
import { aggregateGroupTopics } from './group-intel.js';
import {
  LOGICAL_DAY_START_HOUR as DAY_START_HOUR,
  logicalDayIndex,
  logicalDayCalendarDate,
  parseHHMM,
  formatHHMM,
  clampDayOfMonth,
  safeSetTimeout,
  localDateTimeFromEpochSec,
} from './time.js';

// ── serve supervisor (hot reload) ─────────────────────────────
// pnpm agent serve = the supervisor: it runs the real agent (worker) in a child process and only watches over and restarts it.
// After changing code → pnpm agent update (sends SIGHUP once the build completes) → the supervisor gracefully swaps out the old worker and starts the new version.
// worker = `agent serve` run again with AGENT_WORKER=1, running the actual channel logic.

const PID_FILE = path.join(RUNTIME_DIR, 'serve.pid');
const RELOAD_DEBOUNCE_MS = 600;
const TERM_GRACE_MS = 5000;
const CRASH_RESPAWN_MS = 2000;

export function readServePid(): number | null {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Whether the process is alive (signal 0 = probe only, sends no signal). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePid(): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function clearPid(): void {
  try {
    if (readServePid() === process.pid) fs.unlinkSync(PID_FILE);
  } catch {
    /* if it can't be cleared, never mind */
  }
}

export interface SupervisorOptions {
  /** Selects which agents the supervised worker should run. */
  target: WorkerTarget;
  /** 静默模式：worker 照常采集/同步/记录，但不回复任何飞书 p2p/群/@（透传给 worker 的 AGENT_QUIET）。 */
  quiet?: boolean;
}

/**
 * Schedule a recurring daily task at 05:00 local time that brings every user's
 * LP balance up to the configured floor. Reschedules itself after each run so
 * the supervisor keeps firing it every day for as long as it stays resident.
 */
function scheduleDailyPtReset(): void {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 5, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntilNext = next.getTime() - now.getTime();
  setTimeout(() => {
    try {
      const result = store.resetDailyPtFloor();
      log.info(`每日 LP 补底完成：补足 ${result.affected} 名用户`);
    } catch (e) {
      log.error('每日 LP 补底失败：', (e as Error).message);
    }
    // Reschedule approximately 24 hours later (re-anchored to the next 05:00).
    setTimeout(scheduleDailyPtReset, 0);
  }, msUntilNext);
}

// SeeDAO 运营小天地 group; scheduled ops reports post here (alongside Telegram). The real chat_id
// lives in configs/lark.json's knownInternalChats under the "运营小天地" alias; when it is missing the
// report still goes to Telegram and Feishu delivery is skipped (no invalid-receive_id error).
function opsReportTargets(): { larkChat?: string } {
  const chat = resolveChatTarget('运营小天地');
  if (!chat) {
    log.warn('运营报告未配置飞书群（configs/lark.json knownInternalChats 缺「运营小天地」别名），本次仅发 Telegram。');
    return {};
  }
  return { larkChat: chat };
}

/**
 * Schedule the daily ops report at 04:59 local time, just before the 05:00 logical-day rollover,
 * so it captures the logical day that is about to close. Self-reschedules to the next 04:59.
 */
function scheduleDailyOpsReport(): void {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 4, 59, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(async () => {
    try {
      // At 04:59 "now" still sits inside the closing logical day, so it resolves to that day.
      await generateAndSendDailyReport(new Date(), opsReportTargets());
    } catch (e) {
      log.error('每日运营报告生成失败：', (e as Error).message);
    }
    setTimeout(scheduleDailyOpsReport, 0); // re-anchor to the next 04:59
  }, next.getTime() - now.getTime());
}

/**
 * Schedule the monthly ops report at 04:59 on the 1st of each month, just before the 05:00 logical
 * rollover, so it captures the logical month that is about to close. Self-reschedules to the next 1st 04:59.
 */
function scheduleMonthlyOpsReport(): void {
  const now = new Date();
  let next = new Date(now.getFullYear(), now.getMonth(), 1, 4, 59, 0, 0);
  if (next <= now) next = new Date(now.getFullYear(), now.getMonth() + 1, 1, 4, 59, 0, 0);
  // The re-anchor delay is always ~28-31 days, which exceeds setTimeout's 2^31-1 ms (~24.8-day)
  // ceiling. A plain setTimeout would overflow that to 1ms and fire almost immediately, re-generating
  // the report in a tight loop; safeSetTimeout chains the wait so it fires once, on the 1st at 04:59.
  safeSetTimeout(async () => {
    try {
      // At 04:59 on the 1st "now" still sits inside the closing logical month.
      await generateAndSendMonthlyReport(new Date(), opsReportTargets());
    } catch (e) {
      log.error('每月运营报告生成失败：', (e as Error).message);
    }
    setTimeout(scheduleMonthlyOpsReport, 0); // re-anchor to the next month's 1st 04:59
  }, next.getTime() - now.getTime());
}

/**
 * Schedule the weekly community ops report at every Thursday 21:00 local time. Self-reschedules
 * after each run so the cadence continues indefinitely. Weekly delay (7 days = 604,800,000 ms)
 * is below Node's 2^31-1 ms ceiling (~24.8 days), so a plain setTimeout is safe.
 */
function scheduleWeeklyOpsReport(): void {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 4=Thu
  const daysToThursday = (4 - day + 7) % 7;
  const next = new Date(
    now.getFullYear(), now.getMonth(), now.getDate() + daysToThursday, 21, 0, 0, 0
  );
  // If today is Thursday and we're already at or past 21:00, advance to next Thursday.
  if (next <= now) next.setDate(next.getDate() + 7);

  const msUntilNext = next.getTime() - now.getTime();
  log.info(`周报排程：下次触发 ${localDateTimeFromEpochSec(Math.floor(next.getTime() / 1000))}`);

  setTimeout(async () => {
    // Proactively check user token expiry before the report run so auth issues surface early.
    try {
      const profile = eventSendProfile();
      if (profile) await checkUserTokenExpiry(profile);
    } catch (e) {
      log.warn('周报 token 检查失败：', (e as Error).message);
    }
    try {
      await generateAndSendWeeklyReport(new Date(), {
        notifyChatId: opsReportTargets().larkChat,
      });
    } catch (e) {
      log.error('每周社区动态周报生成失败：', (e as Error).message);
    }
    setTimeout(scheduleWeeklyOpsReport, 0); // re-anchor to the next Thursday 21:00
  }, msUntilNext);
}

// A "logical day" runs from DAY_START_HOUR (05:00) local to the next day's 04:59 — the same anchor as
// the daily LP reset (DAY_START_HOUR and the logical-day helpers come from ./time). The event
// day-planner runs at the start of each logical day.
// Default within-day fire time for a scheduled event that declares no window.
const DEFAULT_FIRE_MIN = 10 * 60;
// How long after a planned fire time we'll still catch up (e.g. after a brief restart). Past this —
// the server was down across the whole window — we abandon the slot instead of pinging at an odd hour.
const CATCHUP_GRACE_SEC = 2 * 3600;

/** Resolve a lark profile to send scheduled events with (first enabled agent's profile). */
function eventSendProfile(): string | undefined {
  try {
    const cfg = loadConfigs();
    for (const id of listAgents(cfg)) {
      if (cfg.agents.agents[id]?.enabled) return resolveAgent(id, cfg).larkProfile;
    }
  } catch {
    /* config unavailable */
  }
  return undefined;
}

/** [startMin, endMin] for a schedule's window, defaulting to a single point at DEFAULT_FIRE_MIN. */
export function windowMinutes(sch: { windowStart?: string; windowEnd?: string }): [number, number] {
  const start = parseHHMM(sch.windowStart) ?? DEFAULT_FIRE_MIN;
  const end = parseHHMM(sch.windowEnd) ?? start;
  return [start, Math.max(start, end)];
}

/**
 * Pick a random clock time inside [startMin, endMin] for the logical day that `now` falls in, and
 * return its epoch ms. Window times ≥ 05:00 land on the logical day's calendar date; times < 05:00
 * land on the following calendar date (still within the same 05:00→04:59 logical day).
 */
export function randomFireTimeMs(now: Date, startMin: number, endMin: number): number {
  const ld = new Date(now.getTime() - DAY_START_HOUR * 3600 * 1000); // calendar date of the logical day
  const pick = startMin + Math.floor(Math.random() * (endMin - startMin + 1));
  const dayOffset = pick >= DAY_START_HOUR * 60 ? 0 : 1;
  return new Date(ld.getFullYear(), ld.getMonth(), ld.getDate() + dayOffset, 0, pick, 0, 0).getTime();
}

// Timers armed per event (keyed by eventTypeId): a one-shot for day-based plans, or a recurring tick
// for a minute cadence. Tracked so we can re-arm idempotently and cancel them on shutdown.
const armedEventTimers = new Map<string, NodeJS.Timeout>();

/**
 * Whether a day-based schedule is due on the logical day containing `now`. `days` uses an interval
 * counter (>= everyDays since the last plan); `weekly`/`monthly`/`yearly` match the calendar
 * (weekday config 1=Mon..7=Sun -> JS 0=Sun..6=Sat via %7). The minute cadence is never due here.
 */
function isDueDay(sch: EventSchedule, now: Date, evalIdx: number | null, todayIdx: number): boolean {
  switch (sch.kind) {
    case 'days':
      return evalIdx === null || todayIdx - evalIdx >= Math.max(1, sch.everyDays);
    case 'weekly':
      return logicalDayCalendarDate(now).getDay() === sch.weekday % 7;
    case 'monthly': {
      const ld = logicalDayCalendarDate(now);
      return ld.getDate() === clampDayOfMonth(sch.day, ld.getFullYear(), ld.getMonth());
    }
    case 'yearly': {
      const ld = logicalDayCalendarDate(now);
      return ld.getMonth() + 1 === sch.month && ld.getDate() === clampDayOfMonth(sch.day, ld.getFullYear(), sch.month - 1);
    }
    default:
      return false;
  }
}

/** Run an event's probability check now (fire on a hit), logging the outcome. */
async function fireScheduledNow(eventTypeId: string): Promise<void> {
  try {
    const outcome = await rollScheduledEvent(eventTypeId, eventSendProfile());
    log.info(`事件判定结果【${eventTypeId}】= ${outcome}`);
  } catch (e) {
    log.error(`事件判定失败【${eventTypeId}】：`, (e as Error).message);
  }
}

/** Arm (or re-arm) a one-shot timer to roll a day-based event after `delayMs`. */
function armEventTimer(eventTypeId: string, delayMs: number): void {
  const existing = armedEventTimers.get(eventTypeId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    armedEventTimers.delete(eventTypeId);
    void fireScheduledNow(eventTypeId);
  }, Math.max(0, delayMs));
  armedEventTimers.set(eventTypeId, t);
}

// Push minute-cadence event ticks off the whole-minute / 整点 grid, and space multiple events apart, so
// scheduled-event checks never fire exactly on the hour together with the data-collection polls. The
// offset phase carries forward because each subsequent tick reschedules at the plain interval.
const MINUTE_EVENT_PHASE_OFFSET_MS = 17_000;
const MINUTE_EVENT_STAGGER_MS = 3_000;

/** Start a recurring tick for a minute-cadence event (re-anchored on each supervisor start). */
function armMinuteLoop(eventTypeId: string, everyMinutes: number, index = 0): void {
  const existing = armedEventTimers.get(eventTypeId);
  if (existing) clearTimeout(existing);
  const ms = Math.max(1, everyMinutes) * 60_000;
  const tick = (): void => {
    void fireScheduledNow(eventTypeId);
    armedEventTimers.set(eventTypeId, setTimeout(tick, ms));
  };
  const firstDelay = ms + MINUTE_EVENT_PHASE_OFFSET_MS + index * MINUTE_EVENT_STAGGER_MS;
  armedEventTimers.set(eventTypeId, setTimeout(tick, firstDelay));
  log.info(`事件已排程【${eventTypeId}】：每 ${everyMinutes} 分钟判定一次（首次延后 ${Math.round(firstDelay / 1000)} 秒以错开整点）`);
}

/** Arm every minute-cadence event's recurring tick (called once on startup). */
function armMinuteEvents(): void {
  let index = 0;
  for (const cfg of listScheduledEvents()) {
    const sch = cfg.schedule!;
    if (sch.kind === 'minutes') armMinuteLoop(cfg.eventTypeId, sch.everyMinutes, index++);
  }
}

/**
 * Plan and arm every day-based scheduled event for the current logical day. Idempotent — safe to call
 * at each logical-day start AND on supervisor startup:
 *  - a pending plan (next_fire_at) in the future -> re-arm its timer; recently past -> catch-up roll;
 *    long past (downtime spanned the window) -> abandon the slot;
 *  - no pending plan and already planned today -> nothing;
 *  - no pending plan and due (per the cadence) -> pick a random within-window time, persist + arm it.
 * Minute-cadence events run on their own interval (armMinuteEvents), not here.
 *
 * Exported for testability; the supervisor is the only production caller.
 */
export function planAndArmEvents(): void {
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const todayIdx = logicalDayIndex(now.getTime());
  for (const cfg of listScheduledEvents()) {
    const sch = cfg.schedule!;
    if (sch.kind === 'minutes') continue; // recurring; armed by armMinuteEvents
    try {
      const st = store.getScheduleState(cfg.eventTypeId);
      // future plan -> arm; recently past -> catch up (brief restart); long past (downtime spanned the
      // window) -> abandon as a missed window rather than ping at an odd hour. Slot consumed either way.
      const armOrCatchUp = (fireSec: number): void => {
        if (fireSec > nowSec) {
          armEventTimer(cfg.eventTypeId, (fireSec - nowSec) * 1000);
          log.info(`事件待命【${cfg.eventTypeId}】${formatHHMM(fireSec * 1000)} 判定（概率 ${Math.round(sch.probability * 100)}%）`);
        } else if (nowSec - fireSec <= CATCHUP_GRACE_SEC) {
          log.info(`事件补判定【${cfg.eventTypeId}】（计划 ${formatHHMM(fireSec * 1000)} 已过 ${Math.round((nowSec - fireSec) / 60)} 分，补发）`);
          void fireScheduledNow(cfg.eventTypeId);
        } else {
          log.info(`事件错过时段【${cfg.eventTypeId}】（计划 ${formatHHMM(fireSec * 1000)} 已过太久，本轮作废）`);
          store.resolveScheduleRoll(cfg.eventTypeId, 'missed');
        }
      };
      // 1) A plan is already pending for this cycle — re-arm / catch up / abandon it.
      if (st.nextFireAt != null) {
        armOrCatchUp(st.nextFireAt);
        continue;
      }
      // 2) No pending plan. If we already planned/resolved today, do nothing more today.
      const evalIdx = st.lastEvalAt != null ? logicalDayIndex(st.lastEvalAt * 1000) : null;
      if (evalIdx === todayIdx) continue;
      // 3) Due per this cadence?
      if (!isDueDay(sch, now, evalIdx, todayIdx)) continue;
      // 4) Plan a random within-window time for today, persist it, then arm/catch-up/abandon.
      const [startMin, endMin] = windowMinutes(sch);
      const fireSec = Math.floor(randomFireTimeMs(now, startMin, endMin) / 1000);
      store.planScheduleFire(cfg.eventTypeId, fireSec, nowSec);
      log.info(`事件已排程【${cfg.eventTypeId}】今天 ${formatHHMM(fireSec * 1000)} 判定`);
      armOrCatchUp(fireSec);
    } catch (e) {
      log.error(`事件排程失败【${cfg.eventTypeId}】：`, (e as Error).message);
    }
  }
}

/**
 * Run the day-planner at the start of each logical day (DAY_START_HOUR local) and reschedule. The
 * planner picks each due event's random within-window fire time for the new day. Startup calls
 * planAndArmEvents() directly so a supervisor started mid-day still plans/arms today.
 */
function scheduleEventDayPlanner(): void {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DAY_START_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => {
    try {
      planAndArmEvents();
    } catch (e) {
      log.error('事件日规划失败：', (e as Error).message);
    }
    setTimeout(scheduleEventDayPlanner, 0); // re-anchor to the next 05:00
  }, next.getTime() - now.getTime());
}

// ── daily memory maintenance ──────────────────────────────────
// Runs at 04:50 local time each day — just before the 04:55 ops report and the
// 05:00 logical-day rollover — to keep the memory store lean and the group-topic
// entries fresh.

/**
 * Run one memory maintenance cycle: purge expired entries, then aggregate hot topics
 * for every chat that has recent message history (from the messages table) and every
 * chat that has an explicit chat policy entry. Self-reschedules to the next 04:50.
 */
function scheduleDailyMemoryMaintenance(): void {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 4, 50, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(async () => {
    try {
      // 1) Purge expired memory entries.
      const purged = purgeExpiredMemories();
      if (purged > 0) log.info(`记忆维护：已清理 ${purged} 条已过期记忆`);

      // 2) Aggregate group topics for all known chats.
      //    Collect chat ids from: (a) messages history, (b) chat-policies entries.
      const fromMessages = listKnownChatIds();
      const fromPolicies = Object.keys(loadChatPolicies().chatPolicies);
      const chatIds = [...new Set([...fromMessages, ...fromPolicies])];

      let aggregated = 0;
      for (const chatId of chatIds) {
        try {
          const summary = aggregateGroupTopics(chatId);
          if (summary) aggregated++;
        } catch (e) {
          log.warn(`记忆维护：群话题聚合失败（${chatId}）：${(e as Error).message}`);
        }
      }
      if (chatIds.length > 0) {
        log.info(`记忆维护：已更新 ${aggregated}/${chatIds.length} 个群的话题热词`);
      }
    } catch (e) {
      log.error('记忆维护失败：', (e as Error).message);
    }
    setTimeout(scheduleDailyMemoryMaintenance, 0); // re-anchor to the next 04:50
  }, next.getTime() - now.getTime());
}

// ── background session janitor (self-heal) ────────────────────
// A poisoned kimi session (an orphan tool call) makes every later --continue fail with HTTP 400
// forever. The inline self-heal in respond() fixes a chat the moment someone hits the error; this
// janitor proactively sweeps ALL of our sessions on a timer so a poisoned one gets cleaned even if
// nobody re-triggers it. It only ever touches sessions whose workDir lives under .agent/, so the
// developer's own kimi sessions are never affected.

const JANITOR_FIRST_MS = 60_000;

function janitorIntervalMs(): number {
  const m = Number(process.env.SESSION_JANITOR_MIN);
  return (Number.isFinite(m) && m > 0 ? m : 30) * 60_000;
}

/** Resolve the ops notify chat (first enabled agent's notifyChat) for self-heal heads-ups. */
function notifyTarget(): { chatId: string; profile: string } | null {
  try {
    const cfg = loadConfigs();
    for (const id of listAgents(cfg)) {
      if (!cfg.agents.agents[id]?.enabled) continue;
      const r = resolveAgent(id, cfg);
      if (r.notifyChatId) return { chatId: r.notifyChatId, profile: r.larkProfile };
    }
  } catch {
    /* config unavailable — skip notifications */
  }
  return null;
}

/** Schedule the recurring session sweep; reschedules itself after each run. */
function scheduleSessionJanitor(): void {
  const run = (): void => {
    try {
      const corrupt = scanCorruptSessions(); // only sessions under .agent/
      let healed = 0;
      for (const c of corrupt) {
        if (quarantineSession(c.sessionDir)) {
          healed += 1;
          log.warn(`session 守护：隔离损坏会话（orphans=${c.orphans}）${c.sessionDir}`);
        }
      }
      if (healed > 0) {
        log.warn(`session 守护：本轮共隔离 ${healed} 个损坏会话，相关群下次对话会自动重建。`);
        if (process.env.SESSION_JANITOR_NOTIFY !== '0') {
          const t = notifyTarget();
          if (t) {
            try {
              sendText(
                { chatId: t.chatId },
                `⚙️ 自愈：清理了 ${healed} 个损坏的对话会话，受影响的群下次对话会自动重建（无需人工处理）。`,
                { as: 'bot', profile: t.profile }
              );
            } catch (e) {
              log.warn('session 守护通知失败：', (e as Error).message);
            }
          }
        }
      }
    } catch (e) {
      log.error('session 守护运行失败：', (e as Error).message);
    }
    setTimeout(run, janitorIntervalMs());
  };
  setTimeout(run, JANITOR_FIRST_MS);
}

/** Start the supervisor: stays resident, watches over the worker child process, and SIGHUP triggers a graceful restart. */
export function runSupervisor(opts: SupervisorOptions): Promise<void> {
  const existing = readServePid();
  if (existing && existing !== process.pid && isAlive(existing)) {
    log.error(
      `已有运行中的 serve（pid=${existing}）。请先 kill 它，或用 pnpm agent update 触发重载。`
    );
    process.exit(1);
  }
  writePid();

  const scriptPath = process.argv[1]; // dist/bin/agent.js
  // Re-launch the worker for the same soul + startup mode. The mode flag round-trips the identity
  // selection so the spawned worker rebuilds the same WorkerTarget.
  const modeFlag =
    opts.target.identities.length > 1
      ? '--both'
      : opts.target.identities[0] === 'user'
        ? '--user'
        : '--bot';
  const childArgs = ['serve', opts.target.soul, modeFlag];

  // The supervisor owns the user-token data plane: tell the worker which soul's user-identity channel to
  // run as a collect-only collector (roster sync / doc-view / message capture).
  const collectorSoul = opts.target.soul;

  // The supervisor itself touches the DB (daily LP floor reset, ops reports), so name the per-soul DB
  // file the same way the worker does (workspaces/<soul>/ ⇒ .agent/<soul>.db). The spawned worker
  // inherits this through process.env and re-pins it from its own resolved workspace.
  process.env.AGENT_SOUL = opts.target.soul;

  let child: ChildProcess | null = null;
  let shuttingDown = false;
  let reloadQueued = false; // the child process was terminated by us deliberately because of a "reload"
  let debounce: NodeJS.Timeout | null = null;

  const startChild = (): void => {
    log.info('启动 worker…');
    child = spawn(process.execPath, [scriptPath, ...childArgs], {
      stdio: 'inherit',
      // AGENT_QUIET propagates the静默模式 into the worker; AGENT_COLLECTOR_SOUL tells the worker to also
      // run that soul's user-identity channel as a collect-only collector (user-token data plane).
      env: {
        ...process.env,
        AGENT_WORKER: '1',
        ...(opts.quiet ? { AGENT_QUIET: '1' } : {}),
        ...(collectorSoul ? { AGENT_COLLECTOR_SOUL: collectorSoul } : {}),
      },
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (shuttingDown) return;
      if (reloadQueued) {
        reloadQueued = false;
        startChild(); // reload: the old one has exited, start the new version
        return;
      }
      if (signal === 'SIGINT' || signal === 'SIGTERM') return; // external termination, leave it to shutdown
      log.warn(`worker 非预期结束（code=${code} signal=${signal}），${CRASH_RESPAWN_MS / 1000}s 后重启…`);
      setTimeout(() => {
        if (!shuttingDown && !child) startChild();
      }, CRASH_RESPAWN_MS);
    });
  };

  const reload = (): void => {
    if (shuttingDown) return;
    if (child) {
      log.info('重载：停止旧 worker，换上新版…');
      reloadQueued = true;
      const dying = child;
      dying.kill('SIGTERM');
      // If it hasn't exited within the grace period, force-kill it to avoid getting stuck.
      setTimeout(() => {
        if (dying === child && !dying.killed) dying.kill('SIGKILL');
      }, TERM_GRACE_MS);
    } else {
      startChild();
    }
  };

  // SIGHUP (sent by pnpm agent update once the build completes) → reload after debouncing.
  process.on('SIGHUP', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      log.info('收到重载信号（SIGHUP），重启 worker。');
      reload();
    }, RELOAD_DEBOUNCE_MS);
  });

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (debounce) clearTimeout(debounce);
    for (const t of armedEventTimers.values()) clearTimeout(t);
    armedEventTimers.clear();
    if (child) child.kill('SIGTERM');
    clearPid();
    log.info('监督者已退出。');
    flushTelegramSync(); // best-effort: drain any buffered logs to Telegram before exiting
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info(
    `serve 监督者已启动（pid=${process.pid}）。改 code 后跑 pnpm agent update 会自动热重启。Ctrl+C 结束。`
  );
  if (opts.quiet) {
    log.info('静默模式（--quiet）：worker 照常采集对话与数据、但不回复任何飞书 p2p/群/@；定时事件仍照常运行。');
  }
  scheduleDailyPtReset();
  scheduleDailyMemoryMaintenance(); // daily 04:50 memory TTL purge + group topic aggregation
  scheduleDailyOpsReport();    // daily 04:55 ops report (closing logical day) -> 运营小天地 + Telegram
  scheduleMonthlyOpsReport();  // monthly on 1st at 04:55 ops report (closing logical month)
  scheduleWeeklyOpsReport();   // weekly Thursday 21:00 community ops report -> wiki + 运营小天地
  scheduleEventDayPlanner(); // daily 05:00 logical-day planner
  planAndArmEvents();        // and plan/arm today's day-based events now (covers a mid-day start)
  armMinuteEvents();         // start recurring ticks for minute-cadence events
  scheduleSessionJanitor();
  startChild();

  return new Promise(() => {
    /* stays resident until SIGINT / SIGTERM */
  });
}
