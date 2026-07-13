#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../core/agent.js';
import { listSouls, soulExists, isToolingWorkspace } from '../core/soul.js';
import { CliChannel } from '../channels/cli.js';
import { channelForIdentity } from '../channels/index.js';
import type { Channel } from '../channels/channel.js';
import {
  loadConfigs,
  listAgents,
  resolveAgent,
  userOpenIdForProfile,
  type ResolvedAgent,
  type WorkerTarget,
  type Identity,
} from '../core/configs.js';

/** Default workspace soul used when `serve` / `cli` is invoked without an explicit soul. */
const DEFAULT_SOUL = 'tudigong';
import { checkAndRecord } from '../core/auth.js';
import {
  larkTimeToMs,
  recallMessage,
  createCalendarEvent,
  cancelCalendarEvent,
  updateCalendarEvent,
  recurringSeriesKey as larkRecurringSeriesKey,
  appendDocxContent,
} from '../core/lark.js';
import { runSupervisor, readServePid, isAlive } from '../core/supervisor.js';
import { REPO_ROOT, RUNTIME_DIR } from '../core/paths.js';
import { log } from '../core/log.js';
import * as store from '../core/store.js';
import { getLpDb } from '../core/db.js';
import { scanCorruptSessions, quarantineSession } from '../core/kimi-session.js';
import { reloadSoulIfChanged } from '../core/skills.js';
import { fireEvent, listEventConfigs, getEventByRef, getEventConfig, describeSchedule } from '../core/events.js';
import { enableLogSink, flushTelegramSync, isTelegramConfigured, sendTelegramMessage, sendTelegramAlert } from '../core/telegram.js';
import { checkUserTokenExpiry, describeTokenExpiry } from '../core/token-watch.js';
import { startHeartbeat } from '../core/heartbeat.js';
import { generateAndSendDailyReport, generateAndSendMonthlyReport } from '../core/ops-report.js';
import { generateAndSendWeeklyReport } from '../core/weekly-report.js';
import { getFlag, hasFlag } from '../core/argv.js';
import {
  insertMeetup,
  setMeetupTags,
  getMeetupById,
  getMeetupByEventId,
  cancelMeetup as storeCancelMeetup,
  updateMeetup,
  listUpcomingMeetups,
} from '../core/store/meetups.js';
import { generateMeetupWikiMarkdown, refreshMeetupWiki } from '../core/meetup-wiki.js';

// Load .env (Node >=20.12 built-in) so secrets like TELEGRAM_* reach process.env without a dotenv
// dependency. Must run before anything reads the env; tolerant of a missing .env (env may come from
// the shell instead). The supervisor inherits this into the worker it spawns.
const loadEnvFile = (process as { loadEnvFile?: (p?: string) => void }).loadEnvFile;
if (loadEnvFile) {
  try {
    loadEnvFile(path.join(REPO_ROOT, '.env'));
  } catch {
    /* no .env present (or unreadable) — fine */
  }
}

function usage(): void {
  console.log(`agent — 城邦土地神 常驻 agent 框架（kimi-cli + lark-cli）

用法:
  agent cli [soul]                              本地终端机 REPL，直接跟 agent 对话（不碰飞书，有对话记忆）
  agent serve [soul] [--bot|--user|--both] [--sup] [--quiet]  启动常驻服务；不带 soul 默认 tudigong。启动模式（互斥，默认 --bot）：--bot 只起 bot 身份（对外回复）、--user 只起 user 身份（user-token 采集、不回复）、--both 两个都起。加 --sup 才挂监督者（定时事件/LP 补底/会话守护/热重启/PID 锁）+ 自动补一个 user-token 采集器（群成员/文档访问，采集不回复、不替你本人发言），不加则裸跑 worker；--quiet 静默模式：照常采集对话与数据、但不回复任何飞书 p2p/群/@（CLI 不受影响）
  agent update [--pull]                         重新构建并热重启运行中的 serve（--pull 先 git pull）
  agent agents                                  列出 configs 里的 agent 与其 identity / listen / trigger
  agent run <soul> [--channel cli]              本地 REPL 测试（不碰飞书）
  agent ask <soul> <消息...>                    一次性问答（非互动）
  agent souls                                   列出可用的 soul（workspaces/）
  agent backfill                                把 .agent/transcripts/*.jsonl 的旧记录迁移到 SQLite 数据库
  agent backfill-members                        从 logs/*.log 补录历史群成员同步轮次到 member_sync_rounds（仅补 live 记录开始之前）
  agent calendar-events                          列出当前追踪的未开始活动及最新报名数（接受/拒绝/待定/待回复）
  agent doc-views                                列出最近采集到的文档访问记录（访问者 + 最近访问时间）
  agent token-check [--test]                     查看 user token 剩余有效期并按需推送到期提醒（--test 发一条测试提醒到 Telegram）
  agent daily-reset [--floor <n>]               立即执行每日 LP 补底（预设下限 10）
  agent reset-all-pt [--to <n>]                 把所有人的 LP 重置为同一数值（预设 120）
  agent lp-migrate [--from <soul>]              把某个 soul 库的 LP/徽章一次性迁入共享库 .agent/shared.db（预设 from tudigong）
  agent link <from_open_id> <to_open_id>        把 from 这个 open_id 归并到 to 这个人（跨 app 同一人 LP 统一；from 自己的 LP 作废）
  agent doctor [--fix]                           扫描损坏的 kimi 会话并查看最近错误（--fix 隔离损坏会话）
  agent events                                   列出已定义的事件（含编号、范围、排程）
  agent event <编号|id> [--test] [--to <oc/ou>] [--dry-run]  手动触发一个事件（仅 server 端；--test 只发给操作者本人 P2P；--dry-run 只预览不发送）
  agent unsend <message_id> [--as bot|user]     撤回一条已发送的消息（默认 as bot；事件消息就是 bot 发的）
  agent report daily|monthly [--date YYYY-MM-DD] [--lark-user <open_id>] [--lark-chat <chat_id>]  生成并发送运营数据报告（默认 Telegram；--lark-user 私聊预览，--lark-chat 发群）
  agent tg-test [消息...]                        发一条测试消息到 Telegram（验证 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID）
  agent heartbeat <soul> [--dry-run] [--test]   手动触发一次心跳巡检（--dry-run 只预览；--test 只发操作者 P2P）
  agent help                                    显示说明

范例:
  agent cli                                     用默认 soul（tudigong）开 REPL 对话
  agent cli tudigong                            指定 soul 开 REPL 对话
  agent serve                                   启动 tudigong（默认 soul、默认 --bot），裸跑 worker、不挂监督者
  agent serve --sup                             启动 tudigong 的 bot + 监督者（常驻、可热重启、跑定时事件）
  agent serve tudigong --both --sup             指定 soul，bot + user 都启动 + 监督者
  agent serve tudigong --user --quiet           只启动 tudigong 的 user 身份、静默采集、裸跑无监督者
  agent update                                  改完 code 后热重启（需 serve --sup 在跑）
  agent ask tudigong "你好"                     一次性问一句
  agent backfill                                迁移旧 JSONL 采集数据到数据库
  agent daily-reset --floor 20                  把余额低于 20 的用户补到 20
  agent reset-all-pt                            把所有人的 LP 重置为 120
  agent events                                  查看事件编号
  agent event 1                                 手动触发 1 号事件（等同 agent event lurker-discovered）
  agent event 1 --test                          只发给操作者本人 P2P（验收用，不发到真实目标群）
`);
}

// Reject tooling workspaces (_shared, _template); they are scaffolding, not runnable agents.
function assertRunnableSoul(name: string): void {
  if (isToolingWorkspace(name)) {
    log.error(`【${name}】是工具型目录（_shared / _template 等下划线开头目录），不能作为 agent 启动。请用 create-agent skill 从 _template 创建真正的 workspace。`);
    process.exit(1);
  }
}

// Resolve the serve startup mode flags into the identity channels to run. --bot / --user / --both are
// mutually exclusive; the default when none is given is bot-only.
function parseServeIdentities(argv: string[]): Identity[] {
  const picked = (['bot', 'user', 'both'] as const).filter((f) => hasFlag(argv, f));
  if (picked.length > 1) {
    log.error('--bot / --user / --both 互斥，只能选一个');
    process.exit(1);
  }
  const mode = picked[0] ?? 'bot';
  return mode === 'both' ? ['bot', 'user'] : [mode];
}

/** worker: read configs → for each enabled agent run an auth check, resolve it, build Agent + channel, and stay resident until a termination signal. */
async function runWorker(target: WorkerTarget): Promise<void> {
  const cfg = loadConfigs();
  // The startup mode (--bot / --user / --both) is authoritative: a soul's agents are picked by matching
  // soul + selected identity, independent of the per-agent `enabled` flag.
  const ids = listAgents(cfg).filter((id) => {
    const raw = cfg.agents.agents[id];
    if (!raw) return false;
    return raw.soul === target.soul && target.identities.includes(raw.identity);
  });

  // Startup cleanup: quarantine any sessions a previous crash / hot-reload left corrupt, so they
  // don't trip --continue on the first message. The background janitor lives in the supervisor and
  // is NOT reloaded by `pnpm agent update`, so doing it here guarantees every worker start is clean.
  try {
    const corrupt = scanCorruptSessions();
    let healed = 0;
    for (const c of corrupt) {
      if (quarantineSession(c.sessionDir)) {
        healed += 1;
        log.warn(`启动清理：隔离损坏会话（orphans=${c.orphans}）${c.sessionDir}`);
      }
    }
    if (healed > 0) log.info(`启动清理：共隔离 ${healed} 个损坏会话（多半是上次重启打断留下的）`);
  } catch (e) {
    log.warn('启动清理失败：', (e as Error).message);
  }

  // Resolve each agent to be started (including listen → oc_ list discovery).
  const resolved: ResolvedAgent[] = ids.map((id) => resolveAgent(id, cfg));

  // Under --sup the supervisor passes the served soul here (AGENT_COLLECTOR_SOUL): bring up that soul's
  // user-identity channel as a collect-only collector. Roster sync / doc-view / RSVP / message capture all
  // require a user token (a Feishu constraint), but the collector never replies on the operator's behalf —
  // replies stay the bot's job. Any user-identity agent already in the set is likewise forced collect-only,
  // so the user-token data plane is never tied to running an agent that answers as the operator.
  const collectorSoul = process.env.AGENT_COLLECTOR_SOUL;
  if (collectorSoul) {
    for (const r of resolved) {
      if (r.identity === 'user') r.collectOnly = true;
    }
    const userId = listAgents(cfg).find(
      (id) => cfg.agents.agents[id]?.identity === 'user' && cfg.agents.agents[id]?.soul === collectorSoul
    );
    if (userId && !ids.includes(userId)) {
      resolved.push({ ...resolveAgent(userId, cfg), collectOnly: true });
    } else if (!userId) {
      log.warn(`soul【${collectorSoul}】没有 user 身份的 agent，跳过 user-token 数据采集（群成员/文档访问需要 user token）。`);
    }
  }

  if (resolved.length === 0) {
    log.error(
      `没有可启动的 agent：soul=${target.soul}、身份=${target.identities.join('/')}。` +
        `请确认 configs/agents.json 里有对应 identity 的 agent（如 ${target.soul}-bot / ${target.soul}-user）。`
    );
    process.exit(1);
  }

  // The runtime DB is named after the served soul (.agent/<soul>.db). Every agent in one worker shares a
  // soul; pin it here — before any store access — so this process and the MCP server (its own process, via
  // Agent.buildMcpConfig's env) open the same per-soul DB file.
  process.env.AGENT_SOUL = resolved[0].workspace;

  // Skill reload: kimi snapshots a session's skills at creation and never re-reads them on --continue.
  // On every worker (re)start — which includes `agent update`'s hot-reload — reconcile the served soul's
  // skills + uppercase persona files against the last fingerprint; when they changed, the soul's sessions
  // are quarantined so each chat's next message rebuilds a session that loads the new skills + persona.
  try {
    const soulReload = reloadSoulIfChanged(resolved[0].workspace);
    if (soulReload.firstRun) {
      log.info(`soul 基线已记录（soul=${resolved[0].workspace}）；之后改动 skill 或大写人格档（SOUL/AGENTS/IDENTITY 等）会在重启 / update 时自动重置会话套用。`);
    } else if (soulReload.changed) {
      log.info(`skill / 人格档有变更：已重置 ${soulReload.quarantined} 个会话，相关群下次对话将载入新内容。`);
    }
  } catch (e) {
    log.warn('soul 重载检查失败：', (e as Error).message);
  }

  // Login expiry check: check each lark profile in use once.
  const checkedProfiles = new Set<string>();
  for (const r of resolved) {
    if (checkedProfiles.has(r.larkProfile)) continue;
    checkedProfiles.add(r.larkProfile);
    const result = checkAndRecord(r.larkProfile, r.notifyChatId);
    log.info(
      `auth 检查 profile=${r.larkProfile}：${result.loggedIn ? '已登录' : '未登录'}` +
        (result.refreshExpiresAt ? `，refresh 到期 ${result.refreshExpiresAt}` : '')
    );
  }

  const runs: Promise<void>[] = [];
  for (const r of resolved) {
    log.info(
      `启动 agent【${r.id}】（identity=${r.identity}，soul=${r.soul}，监听 ${r.chats.length} 群，trigger=${r.trigger}` +
        `${r.collectOnly ? '，采集专用·不回复（被 @ 也不应答）' : ''}）`
    );
    const agent = new Agent(r.workspace, {
      workspace: r.workspace,
      larkProfile: r.larkProfile,
      feishuChatId: r.chats[0]?.chatId,
      kimiProfile: r.kimiProfile,
    });
    const channel = channelForIdentity(r.identity, r);
    runs.push(channel.run(agent));
  }

  // Heartbeat is intrinsic to a served agent, not a supervisor feature: arm it in the worker so it runs
  // whether serve is bare or supervised. Gate it to the bot identity (the heartbeat acts as the bot) and
  // skip it in quiet mode — this also avoids double-firing when bot and user identities run as separate
  // processes. The recurring timer is process-local and dies with the worker on shutdown / hot-reload.
  const botAgent = resolved.find((r) => r.identity === 'bot');
  if (botAgent && process.env.AGENT_QUIET !== '1') {
    startHeartbeat(botAgent.workspace, {
      larkProfile: botAgent.larkProfile,
      kimiProfile: botAgent.kimiProfile,
    });
  }

  await Promise.all(runs);
}

/** Rebuild (tsc); on success notify the running serve supervisor to hot-reload (SIGHUP). */
async function update(argv: string[]): Promise<void> {
  if (hasFlag(argv, 'pull')) {
    log.info('git pull --ff-only…');
    try {
      execFileSync('git', ['pull', '--ff-only'], { stdio: 'inherit', cwd: REPO_ROOT });
    } catch {
      log.error('git pull 失败，已中止（未重新构建）。');
      process.exit(1);
    }
  }

  log.info('构建中（pnpm build）…');
  try {
    // Run build with the same package manager (pnpm/npm) that launched this process, to avoid PATH issues.
    const pm = process.env.npm_execpath;
    if (pm) {
      execFileSync(process.execPath, [pm, 'run', 'build'], { stdio: 'inherit', cwd: REPO_ROOT });
    } else {
      execFileSync('pnpm', ['run', 'build'], { stdio: 'inherit', cwd: REPO_ROOT });
    }
  } catch {
    log.error('构建失败，已中止（不重载，运行中的 serve 仍用旧版）。');
    process.exit(1);
  }

  const pid = readServePid();
  if (pid && isAlive(pid)) {
    process.kill(pid, 'SIGHUP');
    log.info(`已通知运行中的 serve（pid=${pid}）热重启，应用新版程序。`);
  } else {
    log.info('构建完成。目前没有运行中的 serve；下次 pnpm agent serve 即用新版。');
  }
}

/**
 * Migrate historical JSONL transcript files from .agent/transcripts/ into the SQLite database.
 * Each file is named <chatId>.jsonl; each line is a JSON object with at minimum
 * message_id and create_time. Skips lines that are already present (INSERT OR IGNORE).
 */
function backfill(): void {
  const transcriptsDir = path.join(RUNTIME_DIR, 'transcripts');
  if (!fs.existsSync(transcriptsDir)) {
    console.log('没有找到 .agent/transcripts/ 目录，无需迁移。');
    return;
  }
  const files = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) {
    console.log('transcripts/ 目录内没有 .jsonl 文件，无需迁移。');
    return;
  }
  let totalWritten = 0;
  let totalSkipped = 0;
  for (const file of files) {
    const chatId = path.basename(file, '.jsonl');
    store.upsertChat({ chatId, external: false });
    const filePath = path.join(transcriptsDir, file);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    let written = 0;
    let skipped = 0;
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(s) as Record<string, unknown>;
      } catch {
        skipped += 1;
        continue;
      }
      const messageId = (obj['message_id'] as string | undefined) ?? '';
      if (!messageId) { skipped += 1; continue; }
      const inserted = store.insertMessage({
        messageId,
        chatId,
        senderOpenId: (obj['sender_open_id'] as string | undefined) ?? '',
        senderName: (obj['sender_name'] as string | undefined) ?? '',
        msgType: (obj['msg_type'] as string | undefined) ?? 'text',
        text: (obj['text'] as string | undefined) ?? '',
        mentions: Array.isArray(obj['mentions']) ? (obj['mentions'] as string[]) : [],
        createTime: larkTimeToMs(obj['create_time']),
      });
      if (inserted) { written += 1; } else { skipped += 1; }
    }
    console.log(`  ${file}: 写入 ${written} 条，跳过 ${skipped} 条`);
    totalWritten += written;
    totalSkipped += skipped;
  }
  console.log(`\n迁移完成：共写入 ${totalWritten} 条，跳过 ${totalSkipped} 条。`);
}

/**
 * Reconstruct the member-sync round time-series (member_sync_rounds) from historical log files,
 * for the period BEFORE live recording began. Parses the "群成员同步完成：…" completion lines under
 * logs/*.log (oldest first); each becomes one round. Per-person (open_id, name) detail is left empty
 * (the old logs never carried it). The 离开 (left) count is taken from the completion line when present
 * (new format), else summed from the per-chat "…离开 N（已保留）…" lines emitted just before it.
 *
 * Deduped head-counts can't be read from the old logs, so they're ESTIMATED under an explicit model
 * (assume nobody left historically):
 *   present_distinct = roster_total   (no leavers → distinct present == distinct ever seen)
 *   present_internal = min(current internal head-count, roster_total)   (internal held at today's value)
 *   present_external = roster_total − present_internal                  (all historical growth is external)
 * "current internal head-count" is directoryStats().presentInternal at backfill time.
 *
 * Re-runnable: existing backfill rows are deleted and rebuilt each run (live rows untouched). synced_at
 * is UNIQUE and rounds at/after the earliest live round are skipped, so it never collides with live data.
 */
function backfillMemberRounds(): void {
  const logsDir = path.join(REPO_ROOT, 'logs');
  if (!fs.existsSync(logsDir)) {
    console.log('没有找到 logs/ 目录，无可补录的日志。');
    return;
  }
  const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log')).sort();
  if (files.length === 0) {
    console.log('logs/ 目录内没有 .log 文件，无可补录的日志。');
    return;
  }
  // Baseline for the internal-group estimate: today's distinct internal head-count, held constant
  // across all historical rounds (external = roster − internal absorbs the growth).
  const internalBaseline = store.directoryStats().presentInternal;
  // Rebuild backfill rows from scratch so re-runs pick up the current model/baseline (live rows kept).
  const wiped = store.deleteBackfillRounds();
  // Only backfill rounds strictly before the first live-recorded round (when one exists), so we fill
  // history without colliding with or duplicating the rounds the running service already records.
  const liveFrom = store.earliestMemberRoundAt('live');
  const TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}\b/;
  // Completion line; the 在群去重 and 离开 groups are both optional (only present in newer log formats),
  // matched non-capturing so the numbered capture indices below stay stable across all three formats.
  const DONE = /群成员同步完成：(\d+) 群、在群合计 (\d+) 人(?:、在群去重 \d+ 人)?、本轮新增 (\d+) 人(?:、离开 (\d+) 人)?、改名 (\d+) 人；名册累计 (\d+) 人/;
  const PER_CHAT = /群成员同步【.*?】：在群 \d+ 人，新增 \d+，离开 (\d+)（已保留），改名 \d+/;

  const tsToUnix = (line: string): number | null => {
    const m = TS.exec(line);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m.map(Number);
    return Math.floor(new Date(y, mo - 1, d, h, mi, s).getTime() / 1000);
  };

  let inserted = 0;
  let skipped = 0;
  let pending: Array<{ at: number; left: number }> = []; // per-chat left counts awaiting a completion
  for (const file of files) {
    const lines = fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n');
    for (const line of lines) {
      const at = tsToUnix(line);
      if (at === null) continue;
      const pc = PER_CHAT.exec(line);
      if (pc) {
        pending.push({ at, left: Number(pc[1]) });
        continue;
      }
      const done = DONE.exec(line);
      if (!done) continue;
      const chatCount = Number(done[1]);
      const presentTotal = Number(done[2]);
      const joinedCount = Number(done[3]);
      const leftFromLine = done[4] !== undefined ? Number(done[4]) : null;
      const renamedCount = Number(done[5]);
      const rosterTotal = Number(done[6]);
      // Attribute per-chat left lines within the 2 minutes before this completion; drop older orphans
      // (rounds whose completion line was dropped at DEBUG never reach here, so their left can't leak).
      const recent = pending.filter((p) => p.at >= at - 120 && p.at <= at);
      const leftCount = leftFromLine ?? recent.reduce((sum, p) => sum + p.left, 0);
      pending = [];
      if (liveFrom !== null && at >= liveFrom) { skipped += 1; continue; }
      // Estimated deduped head-counts (see the model in this function's doc comment).
      const presentDistinct = rosterTotal;
      const presentInternal = Math.min(internalBaseline, rosterTotal);
      const presentExternal = presentDistinct - presentInternal;
      const ok = store.recordMemberSyncRound({
        syncedAt: at,
        chatCount,
        presentTotal,
        presentDistinct,
        presentInternal,
        presentExternal,
        joinedCount,
        leftCount,
        renamedCount,
        rosterTotal,
        source: 'backfill',
      });
      if (ok) inserted += 1; else skipped += 1;
    }
  }
  if (wiped > 0) console.log(`已清除旧的补录轮次 ${wiped} 条，按当前模型重建。`);
  console.log(`内部群基准（现在的内部群去重人数）：${internalBaseline} 人；历史内部恒按此值、外部 = 名册累计 − 内部。`);
  console.log(`成员同步轮次补录完成：写入 ${inserted} 轮，跳过 ${skipped} 轮（处于 live 记录区间）。`);
  if (liveFrom !== null) {
    const when = new Date(liveFrom * 1000).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`（live 记录最早从 ${when} 开始，仅补录此之前的历史轮次。）`);
  }
}

/**
 * Diagnose self-heal health: scan our kimi sessions for corruption (orphan tool calls), optionally
 * quarantine them (--fix), and show the most recent failures from the error ledger.
 */
function doctor(argv: string[]): void {
  const fix = hasFlag(argv, 'fix');
  console.log('扫描损坏的 kimi 会话（仅 .agent/ 下、本框架自己的会话）…');
  const corrupt = scanCorruptSessions();
  if (corrupt.length === 0) {
    console.log('  没有发现损坏会话。');
  } else {
    for (const c of corrupt) {
      const where = c.workDir || c.sessionDir;
      if (fix) {
        const ok = quarantineSession(c.sessionDir);
        console.log(`  ${ok ? '已隔离' : '隔离失败'}（orphans=${c.orphans}）${where}`);
      } else {
        console.log(`  损坏（orphans=${c.orphans}）${where}`);
      }
    }
    if (!fix) console.log('\n  加上 --fix 可隔离这些会话（可逆，仅改名 + 移除索引行）。');
  }

  const errors = store.recentErrors(15);
  console.log(`\n最近 ${errors.length} 条错误记录：`);
  if (errors.length === 0) {
    console.log('  （暂无）');
  } else {
    for (const e of errors) {
      const when = new Date(e.created_at * 1000).toISOString().replace('T', ' ').slice(0, 19);
      console.log(
        `  ${when}  [${e.corr_id ?? '------'}]  ${e.kind}${e.healed ? '(已自愈)' : ''}  ${e.soul ?? ''}  ${e.summary}`
      );
    }
  }

  const inactive = store.listInactiveChats();
  if (inactive.length > 0) {
    console.log(`\n已停服的群 ${inactive.length} 个（已自动停止轮询与同步）：`);
    for (const d of inactive) {
      const when = new Date(d.inactiveAt * 1000).toISOString().replace('T', ' ').slice(0, 19);
      const reasonZh = d.reason === 'inaccessible' ? '不可访问/被移出' : '已解散(232009)';
      console.log(`  ${when}  [${reasonZh}]  ${d.name || '(无名)'}  ${d.chatId}`);
    }
  }
}

/** List the agents in configs along with their key settings. */
function agentsList(): void {
  const cfg = loadConfigs();
  const ids = listAgents(cfg);
  if (ids.length === 0) {
    console.log('(configs/agents.json 尚无 agent)');
    return;
  }
  for (const id of ids) {
    const raw = cfg.agents.agents[id];
    const listen = Array.isArray(raw.listen) ? raw.listen.join(',') : raw.listen;
    console.log(
      `${id}\t[${raw.enabled ? 'enabled' : 'disabled'}]\t` +
        `identity=${raw.identity}\tlisten=${listen}\ttrigger=${raw.trigger ?? 'mention'}\tcapture=${raw.capture ?? raw.identity === 'user'}`
    );
  }
}

// ── command handlers ──────────────────────────────────────────
// One handler per `agent <cmd>` subcommand. Each receives the full argv (the command name is at
// argv[0]; positional args are argv[1..]). Handlers are registered in COMMANDS and dispatched by main().

async function cmd_agents(_argv: string[]): Promise<void> {
  agentsList();
}

async function cmd_backfill(_argv: string[]): Promise<void> {
  backfill();
}

async function cmd_backfill_members(_argv: string[]): Promise<void> {
  backfillMemberRounds();
}

async function cmd_calendar_events(_argv: string[]): Promise<void> {
  // Deduplicate: keep only the latest round per event_id, then filter to upcoming (not yet started).
  const allRows = store.recentCalendarEventRsvpRounds(500);
  const latestPerEvent = new Map<string, typeof allRows[0]>();
  for (const row of allRows) {
    if (!latestPerEvent.has(row.eventId)) latestPerEvent.set(row.eventId, row);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const upcoming = [...latestPerEvent.values()]
    .filter((r) => r.startTime > nowSec)
    .sort((a, b) => a.startTime - b.startTime);
  if (upcoming.length === 0) {
    console.log('(暂无追踪中的活动)');
  } else {
    for (const r of upcoming) {
      const startStr = new Date(r.startTime * 1000).toLocaleString();
      console.log(`【${r.title}】开始：${startStr}`);
      console.log(`  报名(接受) ${r.accepted}  拒绝 ${r.declined}  待定 ${r.tentative}  待回复 ${r.needsAction}`);
    }
  }
}

async function cmd_doc_views(_argv: string[]): Promise<void> {
  // Show the most recent document view events (one line per observed viewer-view), newest first.
  const rows = store.recentDocViewEvents(100);
  if (rows.length === 0) {
    console.log('(暂无文档访问记录)');
  } else {
    for (const r of rows) {
      const when = new Date(r.lastViewTime * 1000).toLocaleString();
      console.log(`【${r.title || r.fileToken}】${r.viewerName || r.viewerId} 访问于 ${when}`);
    }
  }
}

async function cmd_token_check(argv: string[]): Promise<void> {
  // Resolve the lark profile from the first enabled agent (same source the channels use).
  let profile = '';
  try {
    const cfg = loadConfigs();
    for (const id of listAgents(cfg)) {
      if (cfg.agents.agents[id]?.enabled) {
        profile = resolveAgent(id, cfg).larkProfile;
        break;
      }
    }
  } catch { /* ignore */ }
  if (!profile) {
    log.error('找不到可用的 lark profile（configs 里没有 enabled 的 agent）。');
    process.exit(1);
  }
  if (hasFlag(argv, 'test')) {
    // Send a sample reminder to the alert chat to verify delivery, without touching dedup state.
    const ok = await sendTelegramAlert(
      `【城邦土地神 提醒｜测试】这是 token 到期提醒的测试消息（profile ${profile}）。\n` +
      `真实提醒会在到期前 3 天 / 2 天 / 1 天 / 当天各推一次，并附重新授权命令。`
    );
    console.log(ok ? '已发送测试提醒到 Telegram alert 频道。' : '发送失败：未配置 TELEGRAM_BOT_TOKEN 或 alert chat。');
    return;
  }
  console.log(describeTokenExpiry(profile));
  await checkUserTokenExpiry(profile);
}

async function cmd_doctor(argv: string[]): Promise<void> {
  doctor(argv);
}

async function cmd_events(_argv: string[]): Promise<void> {
  const list = listEventConfigs();
  if (list.length === 0) {
    console.log('(尚无事件定义)');
  } else {
    console.log('编号\t事件 id\t\t范围\t排程\t标题');
    list.forEach((e, i) => {
      const sch = e.schedule ? describeSchedule(e.schedule) : '手动';
      console.log(`[${i + 1}]\t${e.eventTypeId}\t[${e.scope}]\t${sch}\t${e.title}`);
    });
    console.log('\n手动触发：pnpm agent event <编号|事件id> [--to <oc/ou>] [--actor <ou>]');
  }
}

// Manually fire any event by its number (from `agent events`) or its event id. This is a server-side
// CLI command only — it is never exposed to chat users or MCP, so triggering stays an operator action.
async function cmd_event(argv: string[]): Promise<void> {
  const ref = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
  if (!ref) {
    log.error('用法: agent event <编号|事件id> [--test] [--to <oc_xxx|ou_xxx>] [--actor <ou_xxx>] [--reason <r>] [--profile <p>] [--dry-run]\n      （编号见 agent events；--test 只发给操作者本人 P2P）');
    process.exit(1);
  }
  const cfgEvent = getEventByRef(ref);
  if (!cfgEvent) {
    log.error(`找不到事件【${ref}】。用 agent events 查看可用事件与编号。`);
    process.exit(1);
  }
  // Resolve the lark profile (prefer --profile) and the operator's own open_id (the lark profile's
  // userOpenId) from the first enabled agent — the latter is the --test destination.
  let profile = getFlag(argv, 'profile');
  let operatorOpenId: string | undefined;
  try {
    const cfg = loadConfigs();
    for (const id of listAgents(cfg)) {
      if (cfg.agents.agents[id]?.enabled) {
        const r = resolveAgent(id, cfg);
        if (!profile) profile = r.larkProfile;
        operatorOpenId = r.larkProfileMeta.userOpenId;
        break;
      }
    }
  } catch { /* ignore */ }
  const test = hasFlag(argv, 'test');
  const to = getFlag(argv, 'to');
  // --test wins: send only to the operator's own P2P (safe verification, no real group/recipient).
  let target = to ? (to.startsWith('ou_') ? { userId: to } : { chatId: to }) : undefined;
  if (test) {
    if (!operatorOpenId) {
      log.error('--test 需要 lark profile 的 userOpenId（操作者），但未解析到。');
      process.exit(1);
    }
    target = { userId: operatorOpenId };
  }
  const actorOpenId = getFlag(argv, 'actor');
  const reason = getFlag(argv, 'reason') ?? (test ? 'manual_test' : 'manual');
  const dryRun = hasFlag(argv, 'dry-run');
  // Manual runs force-fire: bypass schedule timing + probability, and relax prepare() audience gating.
  const modeTag = `${dryRun ? '预览' : '手动触发'}${test ? '（test 模式·仅发给操作者本人 P2P）' : ''}`;
  log.info(`${modeTag}事件【${cfgEvent.eventTypeId}】（强制，不受定时与概率限制）…`);
  const res = await fireEvent(cfgEvent.eventTypeId, { triggerReason: reason, actorOpenId, target, profile, dryRun, force: true });
  if (res.ok && dryRun) {
    console.log('dry-run 完成（未发送、未发 LP）。见上方预览。');
  } else if (res.ok) {
    console.log(`已发送：message_id=${res.messageId ?? '?'}（dispatch=${res.dispatchId}）`);
    if (res.messageId) console.log(`撤回：pnpm agent unsend ${res.messageId}`);
  } else if (res.skipped) {
    console.log(`已跳过：事件【${cfgEvent.eventTypeId}】判定本次无需发送（例如没有符合条件的对象）。`);
  } else {
    console.log(`发送失败：dispatch=${res.dispatchId} error=${res.error ?? '?'}`);
    process.exit(1);
  }
}

// Recall (撤回) a sent message by its message_id. Server-side operator command. Events are bot-sent,
// so the default identity is bot; pass --as user to recall a user-identity message.
async function cmd_unsend(argv: string[]): Promise<void> {
  const messageId = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
  if (!messageId) {
    log.error('用法: agent unsend <message_id> [--as bot|user] [--profile <p>]');
    process.exit(1);
  }
  let profile = getFlag(argv, 'profile');
  if (!profile) {
    try {
      const cfg = loadConfigs();
      for (const id of listAgents(cfg)) {
        if (cfg.agents.agents[id]?.enabled) { profile = resolveAgent(id, cfg).larkProfile; break; }
      }
    } catch { /* ignore */ }
  }
  const as = (getFlag(argv, 'as') as 'bot' | 'user' | undefined) ?? 'bot';
  log.info(`撤回消息【${messageId}】（as ${as}）…`);
  const res = recallMessage(messageId, { as, profile });
  if (res.ok) {
    console.log(`已撤回：${messageId}`);
  } else {
    console.log(`撤回失败：${res.error ?? '?'}`);
    process.exit(1);
  }
}

async function cmd_badge(argv: string[]): Promise<void> {
  const sub = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
  if (!sub || sub === 'help') {
    log.error([
      '用法:',
      '  agent badge import <json_file> [--profile <p>]      导入徽章定义（JSON 单对象或数组）',
      '  agent badge award <badge-ref> <target> [--profile <p>] [--note <text>] [--dry-run]  发放徽章',
      '  agent badge list [target]                           列出徽章（无参数=全部定义，有参数=成员持有）',
    ].join('\n'));
    process.exit(1);
  }

  // Resolve lark profile and operator open_id (same pattern as `event` command).
  let profile = getFlag(argv, 'profile');
  let operatorOpenId: string | undefined;
  try {
    const cfg = loadConfigs();
    for (const id of listAgents(cfg)) {
      if (cfg.agents.agents[id]?.enabled) {
        const r = resolveAgent(id, cfg);
        if (!profile) profile = r.larkProfile;
        operatorOpenId = r.larkProfileMeta.userOpenId;
        break;
      }
    }
  } catch { /* ignore */ }

  // badge import <json_file>
  if (sub === 'import') {
    const jsonFile = argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined;
    if (!jsonFile) {
      log.error('用法: agent badge import <json_file>');
      process.exit(1);
    }
    let raw: string;
    try {
      raw = fs.readFileSync(jsonFile, 'utf-8');
    } catch (e) {
      log.error(`读取文件失败：${jsonFile}：${(e as Error).message}`);
      process.exit(1);
    }
    let items: unknown[];
    try {
      const parsed = JSON.parse(raw) as unknown;
      items = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      log.error(`JSON 解析失败：${(e as Error).message}`);
      process.exit(1);
    }
    let imported = 0;
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const b = item as Record<string, unknown>;
      const headline = (b['headline'] as string | undefined) ?? '';
      const category = (b['category'] as string | undefined) ?? '';
      const duration = (b['duration'] as string | undefined) ?? '';
      // Generate a stable badge_id from content hash when not provided.
      const badgeId = (b['badge_id'] as string | undefined) ||
        'badge-' + createHash('sha1').update(`${headline}|${category}|${duration}`).digest('hex').slice(0, 8);
      const badgeName = (b['badge_name'] as string | undefined) || headline;
      store.upsertBadge({
        badgeId,
        name: badgeName,
        description: (b['description'] as string | undefined) ?? '',
        emoji: (b['emoji'] as string | undefined) ?? '',
        headline,
        file: (b['file'] as string | undefined) ?? '',
        title: (b['title'] as string | undefined) ?? '',
        type: (b['type'] as string | undefined) ?? '',
        role: (b['role'] as string | undefined) ?? '',
        endorser: (b['endorser'] as string | undefined) ?? '',
        duration,
        category,
        event: (b['event'] as string | undefined) ?? '',
      });
      console.log(`导入：badge_id=${badgeId}  headline=${headline || badgeName}`);
      imported++;
    }
    console.log(`共导入 ${imported} 条徽章定义。`);
    return;
  }

  // badge award <badge-ref> <target...> [--note <text>] [--dry-run]
  if (sub === 'award') {
    const badgeRef = argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined;
    // Collect every positional target after the badge ref, skipping flags and their values so a
    // value like `--note 恭喜` is never mistaken for a recipient.
    const valueFlags = new Set(['profile', 'note']);
    const targetArgs: string[] = [];
    for (let i = 3; i < argv.length; i++) {
      const a = argv[i]!;
      if (a.startsWith('--')) {
        if (valueFlags.has(a.slice(2))) i++;
        continue;
      }
      targetArgs.push(a);
    }
    if (!badgeRef || targetArgs.length === 0) {
      log.error('用法: agent badge award <badge-ref> <target> [target2 ...] [--profile <p>] [--note <text>] [--dry-run]');
      process.exit(1);
    }
    const note = getFlag(argv, 'note');
    const dryRun = hasFlag(argv, 'dry-run');

    // Mirror this award's logs — the award lines plus every event fireEvent emits — to Telegram so the
    // supervisor's log stream captures badge activity even though this is a standalone CLI command. The
    // sink's flush timer is unref'd, so drain it synchronously on exit. Skipped under --dry-run.
    if (!dryRun) {
      enableLogSink();
      process.on('exit', () => { try { flushTelegramSync(); } catch { /* best-effort */ } });
    }

    // Resolve badge.
    const badge = store.getBadge(badgeRef);
    if (!badge) {
      log.error(`找不到徽章【${badgeRef}】。用 agent badge list 查看可用徽章。`);
      process.exit(1);
    }
    const badgeDisplay = badge.headline || badge.name;
    const badgeName = badge.headline || badge.name;

    // Resolve every target to an open_id + name. Any failure (not found / ambiguous) aborts the whole
    // award so a batch never goes out half-resolved. Repeated targets are de-duplicated.
    const recipients: Array<{ openId: string; name: string }> = [];
    const seen = new Set<string>();
    for (const t of targetArgs) {
      let openId: string;
      let name = '';
      if (t.startsWith('ou_')) {
        openId = t;
        name = store.memberName(openId) || openId;
      } else {
        const matches = store.findOpenIdsByName(t);
        if (matches.length === 0) {
          log.error(`在成员目录中找不到名称为【${t}】的成员（仅搜索已同步的 chat_members）。`);
          log.error('建议：改用 ou_xxxxxx 直接指定，或等待下一轮成员目录同步后重试。');
          process.exit(1);
        }
        if (matches.length > 1) {
          log.error(`名称【${t}】匹配到多名成员，请改用 ou_xxxxxx 明确指定：`);
          for (const m of matches) console.log(`  ${m.openId}  ${m.name}`);
          process.exit(1);
        }
        openId = matches[0]!.openId;
        name = matches[0]!.name;
      }
      if (seen.has(openId)) continue;
      seen.add(openId);
      recipients.push({ openId, name: name || openId });
    }

    // Pick the announcement event: a badge's own event (first "/"-segment) overrides the defaults;
    // otherwise the batch default for 2+ recipients, or the single default for one.
    const announceEventId = (badge.event ? badge.event.split('/')[0]!.trim() : '')
      || (recipients.length >= 2 ? 'badge-awarded-group' : 'badge-awarded-default');

    if (dryRun) {
      console.log(`[dry-run] 将发放徽章【${badgeDisplay}】（${badge.badgeId}）给 ${recipients.length} 人：`);
      for (const r of recipients) console.log(`  ${r.name}（${r.openId}）`);
      if (note) console.log(`[dry-run] 备注：${note}`);
      console.log(`[dry-run] 私信事件：badge-awarded（逐人）；群公告事件：${announceEventId}`);
      console.log('[dry-run] 完成（未写入数据库，未触发事件）。');
      return;
    }

    // Award each recipient; collect those newly granted (awardBadge=false means already held → skip).
    const granted: Array<{ openId: string; name: string }> = [];
    for (const r of recipients) {
      store.ensureProfile(r.openId, r.name || undefined);
      if (store.awardBadge(r.openId, badge.badgeId, note ?? undefined)) {
        granted.push(r);
        log.info(`徽章发放：【${badgeDisplay}】（${badge.badgeId}）→ ${r.name}（${r.openId}）`);
      } else {
        log.info(`徽章发放跳过：${r.name}（${r.openId}）已持有【${badgeDisplay}】`);
      }
    }
    if (granted.length === 0) {
      log.info(`徽章发放结束：【${badgeDisplay}】无新增持有者（全部已持有），不触发事件。`);
      return;
    }
    log.info(`徽章发放完成：【${badgeDisplay}】共 ${granted.length} 人：${granted.map((g) => g.name).join('、')}`);

    // Personal P2P congratulation to every newly-awarded recipient.
    for (const g of granted) {
      const pr = await fireEvent('badge-awarded', {
        actorOpenId: g.openId,
        profile,
        triggerReason: 'badge_award',
        vars: { member_name: g.name, badge_name: badgeName },
      });
      if (pr.ok) log.info(`私信恭喜已发送 → ${g.name}（message_id=${pr.messageId ?? '?'}）`);
      else if (pr.skipped) log.info(`私信恭喜已跳过 → ${g.name}（prepare 判定不发送）`);
      else log.warn(`私信恭喜发送失败 → ${g.name}：${pr.error ?? '未知错误'}`);
    }

    // One group announcement listing everyone newly awarded. Re-pick by granted count so an all-but-one
    // already-held batch still uses the single-recipient default.
    const finalAnnounceId = (badge.event ? badge.event.split('/')[0]!.trim() : '')
      || (granted.length >= 2 ? 'badge-awarded-group' : 'badge-awarded-default');
    if (getEventConfig(finalAnnounceId)) {
      const eventResult = await fireEvent(finalAnnounceId, {
        actorOpenId: granted.length === 1 ? granted[0]!.openId : undefined,
        profile,
        triggerReason: 'badge_award',
        recipients: granted,
        vars: { member_name: granted[0]!.name, badge_name: badgeName },
      });
      if (eventResult.ok) {
        log.info(`群公告已触发：${finalAnnounceId}（message_id=${eventResult.messageId ?? '?'}）`);
      } else if (eventResult.skipped) {
        log.info(`群公告已跳过：${finalAnnounceId}（prepare 判定不发送）`);
      } else {
        log.error(`群公告触发失败：${finalAnnounceId}：${eventResult.error ?? '未知错误'}`);
      }
    } else {
      log.warn(`徽章事件未注册，跳过：${finalAnnounceId}`);
    }
    return;
  }

  // badge list [target]
  if (sub === 'list') {
    const targetArg = argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined;
    if (!targetArg) {
      // List all badge definitions.
      const all = store.listBadges();
      if (all.length === 0) {
        console.log('（暂无已定义徽章）');
      } else {
        console.log(`共 ${all.length} 条徽章定义：`);
        for (const b of all) {
          const display = b.headline || b.name;
          console.log(`  ${b.badgeId}  ${display}  [${b.type || '-'}]`);
        }
      }
      return;
    }
    // List badges held by a specific member.
    let targetOpenId: string;
    let targetName = '';
    if (targetArg.startsWith('ou_')) {
      targetOpenId = targetArg;
      targetName = store.memberName(targetOpenId) || targetOpenId;
    } else {
      const matches = store.findOpenIdsByName(targetArg);
      if (matches.length === 0) {
        log.error(`找不到名称为【${targetArg}】的成员。`);
        process.exit(1);
      }
      if (matches.length > 1) {
        log.error(`名称【${targetArg}】匹配到多名成员，请改用 ou_xxxxxx 指定：`);
        for (const m of matches) console.log(`  ${m.openId}  ${m.name}`);
        process.exit(1);
      }
      targetOpenId = matches[0]!.openId;
      targetName = matches[0]!.name;
    }
    const displayName = targetName || targetOpenId;
    const badges = store.listBadges(targetOpenId);
    if (badges.length === 0) {
      console.log(`${displayName} 暂无徽章。`);
    } else {
      console.log(`${displayName} 持有 ${badges.length} 枚徽章：`);
      for (const b of badges) {
        const display = b.headline || b.name;
        console.log(`  ${b.badgeId}  ${display}  [${b.type || '-'}]`);
      }
    }
    return;
  }

  log.error(`未知 badge 子命令：${sub}。用 agent badge help 查看用法。`);
  process.exit(1);
}

async function cmd_daily_reset(argv: string[]): Promise<void> {
  const floorStr = getFlag(argv, 'floor');
  const floor = floorStr !== undefined ? Number(floorStr) : 10;
  if (!Number.isInteger(floor) || floor < 0) {
    log.error('--floor 必须是非负整数');
    process.exit(1);
  }
  const result = store.resetDailyPtFloor(floor);
  console.log(`每日 LP 补底完成：补足 ${result.affected} 名用户（下限 ${floor}）`);
}

async function cmd_reset_all_pt(argv: string[]): Promise<void> {
  const toStr = getFlag(argv, 'to');
  let target: number | undefined;
  if (toStr !== undefined) {
    target = Number(toStr);
    if (!Number.isInteger(target) || target < 0) {
      log.error('--to 必须是非负整数');
      process.exit(1);
    }
  }
  const result = store.resetAllPtTo(target);
  console.log(`LP 重置完成：${result.affected} 名用户已重置为 ${result.target} LP`);
}

// Seed the shared LP database from a source per-agent db (default tudigong) so the existing community LP
// and badges become the shared baseline. Copies only the LP cluster, idempotently (INSERT OR IGNORE).
async function cmd_lp_migrate(argv: string[]): Promise<void> {
  const srcName = (getFlag(argv, 'from') || 'tudigong').replace(/[^A-Za-z0-9._-]/g, '_');
  const srcPath = path.join(RUNTIME_DIR, `${srcName}.db`);
  if (!fs.existsSync(srcPath)) {
    log.error(`源 db 不存在：${srcPath}`);
    process.exit(1);
  }
  const db = getLpDb(); // creates + migrates the shared LP db
  db.exec(`ATTACH DATABASE '${srcPath.replace(/'/g, "''")}' AS src`);
  const tables = ['badges', 'profiles', 'pt_ledger', 'checkins', 'user_badges']; // parents before children (FK order)
  try {
    db.exec('BEGIN');
    for (const t of tables) db.exec(`INSERT OR IGNORE INTO ${t} SELECT * FROM src.${t}`);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    db.exec('DETACH DATABASE src');
    log.error('LP 迁移失败：', (e as Error).message);
    process.exit(1);
  }
  db.exec('DETACH DATABASE src');
  const counts = tables.map((t) => `${t}=${(db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n}`);
  console.log(`LP 已迁入共享库（来源 ${srcName}.db）：${counts.join(', ')}`);
}

// Alias one open_id to another person's identity so their LP / badges unify across agents (each Feishu app
// gives a person a different open_id). The `from` identity's own LP is discarded (作废以共享库为准).
async function cmd_link(argv: string[]): Promise<void> {
  const from = argv[1];
  const to = argv[2];
  if (!from || !to || from.startsWith('--') || to.startsWith('--')) {
    log.error('用法: agent link <from_open_id> <to_open_id>（把 from 这个 open_id 归并到 to 这个人，from 自己的 LP 作废）');
    process.exit(1);
  }
  const canon = store.canonicalId(to);
  if (from === canon) {
    console.log(`无需归并：${from} 已经是 ${canon}`);
    return;
  }
  const db = getLpDb();
  try {
    db.exec('BEGIN');
    // discard the source identity's own LP history, then point it at the canonical identity
    db.prepare('DELETE FROM pt_ledger WHERE user_open_id = ?').run(from);
    db.prepare('DELETE FROM checkins WHERE user_open_id = ?').run(from);
    db.prepare('DELETE FROM user_badges WHERE user_open_id = ?').run(from);
    db.prepare('DELETE FROM profiles WHERE open_id = ?').run(from);
    db.prepare('UPDATE identity_links SET canonical_id = ? WHERE canonical_id = ?').run(canon, from);
    db.prepare('INSERT OR REPLACE INTO identity_links(open_id, canonical_id) VALUES (?, ?)').run(from, canon);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    log.error('link 失败：', (e as Error).message);
    process.exit(1);
  }
  console.log(`已归并：${from} → ${canon}（${from} 之后的 LP 都记到 ${canon}）`);
}

async function cmd_serve(argv: string[]): Promise<void> {
  const positionalSoul = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
  if (positionalSoul) assertRunnableSoul(positionalSoul);
  const soul = positionalSoul ?? DEFAULT_SOUL;

  // Startup mode: which identity channels of the soul to bring up. --bot (default) / --user / --both,
  // mutually exclusive. --bot runs the replying bot; --user runs the user-token data plane (collect-only);
  // --both runs them together.
  const identities = parseServeIdentities(argv);

  // --quiet (静默/观察模式): keep running everything EXCEPT replying to feishu p2p/group/mention —
  // messages are still captured, members synced, data recorded. Propagated to the worker via the
  // AGENT_QUIET env var (the supervisor passes it through on spawn); channels read it from there.
  const quiet = hasFlag(argv, 'quiet');
  // --sup: opt-in to the resident supervisor (background event schedules, LP reset, session janitor,
  // hot-reload via SIGHUP, PID lock, crash-respawn). Without it, serve runs a bare worker — the channel
  // directly, with none of those side effects. The choice is explicit and independent of the soul.
  const withSupervisor = hasFlag(argv, 'sup');
  // Mirror serve logs to Telegram (if TELEGRAM_* is configured). Called for both the supervisor and
  // the worker, so both processes' logs flow through — distinguished by a [sup]/[wkr] tag.
  enableLogSink();

  const target: WorkerTarget = { soul, identities };

  // AGENT_WORKER=1 means this process was spawned as a child by the supervisor → run the channel directly.
  // Otherwise a direct serve: run the supervisor only when --sup is passed, else a bare worker.
  if (process.env.AGENT_WORKER) {
    await runWorker(target);
  } else if (withSupervisor) {
    await runSupervisor({ target, quiet });
  } else {
    await runWorker(target);
  }
}

async function cmd_update(argv: string[]): Promise<void> {
  await update(argv);
}

async function cmd_cli(argv: string[]): Promise<void> {
  const souls = listSouls();
  // Positional argument is the soul; if omitted use the default (prefer tudigong, otherwise the first available soul).
  const arg = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
  const soul = arg ?? (souls.includes(DEFAULT_SOUL) ? DEFAULT_SOUL : souls[0]);
  if (!soul || !soulExists(soul)) {
    log.error(
      arg
        ? `找不到 soul【${arg}】。可用：${souls.join(', ') || '(无)'}`
        : `找不到可用的 soul，请先在 workspaces/ 下创建。可用：${souls.join(', ') || '(无)'}`
    );
    process.exit(1);
  }
  assertRunnableSoul(soul);
  process.env.AGENT_SOUL = soul; // names the DB file (.agent/<soul>.db)
  const agent = new Agent(soul);
  // Each startup gets a fixed session so this REPL conversation has short-term memory (/reset starts over).
  const session = `cli-${soul}-${process.pid}`;
  const channel: Channel = new CliChannel({ session });
  await channel.run(agent);
}

async function cmd_souls(_argv: string[]): Promise<void> {
  const souls = listSouls();
  console.log(souls.length ? souls.join('\n') : '(尚无 soul，请在 workspaces/ 下创建)');
}

async function cmd_ask(argv: string[]): Promise<void> {
  const soul = argv[1];
  const message = argv.slice(2).join(' ');
  if (!soul || !soulExists(soul) || !message) {
    log.error('用法: agent ask <soul> <消息...>');
    process.exit(1);
  }
  assertRunnableSoul(soul);
  process.env.AGENT_SOUL = soul; // names the DB file (.agent/<soul>.db)
  const agent = new Agent(soul, { journal: false });
  const reply = agent.respond({ message });
  process.stdout.write(reply + '\n');
}

async function cmd_run(argv: string[]): Promise<void> {
  const soul = argv[1];
  if (!soul || !soulExists(soul)) {
    log.error(`找不到 soul【${soul ?? ''}】。可用：${listSouls().join(', ') || '(无)'}`);
    process.exit(1);
  }
  assertRunnableSoul(soul);
  const channelName = getFlag(argv, 'channel') || 'cli';
  if (channelName !== 'cli') {
    log.error('run 仅支持 --channel cli（飞书请用 agent serve）');
    process.exit(1);
  }
  process.env.AGENT_SOUL = soul; // names the DB file (.agent/<soul>.db)
  const agent = new Agent(soul);
  const channel: Channel = new CliChannel();
  await channel.run(agent);
}

async function cmd_report(argv: string[]): Promise<void> {
  const period = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
  if (period !== 'daily' && period !== 'monthly' && period !== 'weekly') {
    log.error(
      '用法: agent report daily|monthly|weekly [--date YYYY-MM-DD] [...options]\n' +
        '      daily/monthly: [--lark-user <open_id>] [--lark-chat <chat_id>] [--no-narrative]\n' +
        '      weekly: [--dry-run] [--no-narrative] [--space-id <id>] [--wiki-token <token>]',
    );
    process.exit(1);
  }
  const dateArg = getFlag(argv, 'date');
  const ref = dateArg ? new Date(dateArg) : new Date();
  if (isNaN(ref.getTime())) {
    log.error(`无效日期【${dateArg}】，请使用 YYYY-MM-DD 格式。`);
    process.exit(1);
  }
  // Mirror logs to Telegram so this one-shot CLI's activity appears in the log channel.
  enableLogSink();
  process.on('exit', () => { try { flushTelegramSync(); } catch { /* best-effort */ } });
  try {
    if (period === 'daily') {
      // Optional Feishu delivery: --lark-user for P2P preview, --lark-chat for group post.
      const targets = {
        larkUser: getFlag(argv, 'lark-user'),
        larkChat: getFlag(argv, 'lark-chat'),
        narrative: hasFlag(argv, 'no-narrative') ? false : undefined,
      };
      await generateAndSendDailyReport(ref, targets);
    } else if (period === 'monthly') {
      const targets = {
        larkUser: getFlag(argv, 'lark-user'),
        larkChat: getFlag(argv, 'lark-chat'),
        narrative: hasFlag(argv, 'no-narrative') ? false : undefined,
      };
      await generateAndSendMonthlyReport(ref, targets);
    } else {
      // weekly: --dry-run skips all wiki writes and notification; --no-narrative omits AI section;
      // --no-notify creates the wiki page but skips the group notification.
      // --space-id and --wiki-token override the configured wiki coordinates for testing.
      const weeklyOpts = {
        dryRun: hasFlag(argv, 'dry-run'),
        narrative: hasFlag(argv, 'no-narrative') ? false : undefined,
        notify: hasFlag(argv, 'no-notify') ? false : undefined,
        spaceId: getFlag(argv, 'space-id'),
        parentNodeToken: getFlag(argv, 'wiki-token'),
        reuseDocumentId: getFlag(argv, 'reuse-doc'),
        reuseNodeToken: getFlag(argv, 'reuse-node'),
      };
      await generateAndSendWeeklyReport(ref, weeklyOpts);
    }
    console.log('运营报告已生成并发送。');
  } catch (e) {
    log.error('运营报告失败：', (e as Error).message);
    process.exit(1);
  }
}

async function cmd_tg_test(argv: string[]): Promise<void> {
  if (!isTelegramConfigured()) {
    log.error('未配置 Telegram：请在 .env 设置 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID 后重试。');
    process.exit(1);
  }
  const msg = argv.slice(1).join(' ') || '城邦土地神 Telegram 日志通道测试：连接正常。';
  try {
    await sendTelegramMessage(msg);
    console.log('已发送测试消息到 Telegram。');
  } catch (e) {
    log.error('发送失败：', (e as Error).message);
    process.exit(1);
  }
}

// ── heartbeat CLI ─────────────────────────────────────────────

async function cmd_heartbeat(argv: string[]): Promise<void> {
  const soul = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
  if (!soul) {
    log.error(
      '用法: agent heartbeat <soul> [--dry-run] [--test]\n' +
        '      --dry-run 只预览 prompt 和闸门状态，不调用 LLM\n' +
        '      --test    调用 LLM 但注入测试指令（只发给操作者本人 P2P）'
    );
    process.exit(1);
  }
  if (!soulExists(soul)) {
    log.error(`找不到 soul【${soul}】。可用：${listSouls().join(', ') || '(无)'}`);
    process.exit(1);
  }
  assertRunnableSoul(soul);
  process.env.AGENT_SOUL = soul;

  // Resolve lark profile from the first enabled agent (same pattern as cmd_event).
  let larkProfile: string | undefined;
  try {
    const cfg = loadConfigs();
    for (const id of listAgents(cfg)) {
      if (cfg.agents.agents[id]?.enabled) {
        larkProfile = resolveAgent(id, cfg).larkProfile;
        break;
      }
    }
  } catch {
    /* ignore */
  }

  const dryRun = hasFlag(argv, 'dry-run');
  const testMode = hasFlag(argv, 'test');

  // Mirror to Telegram so this one-shot CLI's log appears in the log channel.
  enableLogSink();
  process.on('exit', () => {
    try {
      flushTelegramSync();
    } catch {
      /* best-effort */
    }
  });

  const modeTag = dryRun ? 'dry-run' : testMode ? 'test 模式' : '手动触发';
  log.info(`心跳${modeTag}【${soul}】…`);
  try {
    const { heartbeatTick } = await import('../core/heartbeat.js');
    await heartbeatTick(soul, { larkProfile, dryRun, testMode });
    console.log(`心跳${modeTag}完成：soul=${soul}`);
  } catch (e) {
    log.error(`心跳${modeTag}失败：${(e as Error).message}`);
    process.exit(1);
  }
}

// ── activity meetup CLI ──────────────────────────────────────
// Operator-facing subcommands for managing community activity meetups.
// These run as one-shot CLI invocations; all Feishu calendar writes use --as user.

/** Format unix seconds as "YYYY-MM-DD HH:mm" in local time. */
function fmtSec(sec: number): string {
  return new Date(sec * 1000).toLocaleString('sv-SE', { hour12: false }).slice(0, 16).replace('T', ' ');
}

/** Parse "YYYY-MM-DD HH:mm" or ISO 8601 into unix seconds. Returns NaN on failure. */
function parseDateTimeArg(s: string): number {
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'));
  return Number.isFinite(t) ? Math.floor(t / 1000) : NaN;
}

/** Return the BYDAY weekday token for a JS Date (0=Sun→SU … 6=Sat→SA). */
function weekdayToken(d: Date): string {
  return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getDay()]!;
}

async function cmd_meetup(argv: string[]): Promise<void> {
  const sub = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;

  if (!sub || sub === 'help') {
    console.log([
      '用法:',
      '  agent meetup create --title <标题> --start <YYYY-MM-DD HH:mm> --end <YYYY-MM-DD HH:mm>',
      '                       [--tags <tag1,tag2>] [--recur <RRULE|false>] [--desc <说明>]',
      '  agent meetup edit   <id> [--title <标题>] [--start <dt>] [--end <dt>] [--rrule <RRULE>] [--tags <t1,t2>]',
      '  agent meetup cancel <id>',
      '  agent meetup digest [--date <YYYY-MM-DD>] [--to <chat_id>]',
      '  agent meetup list',
    ].join('\n'));
    return;
  }

  process.env.AGENT_SOUL = DEFAULT_SOUL;

  // Resolve lark profile from the first enabled agent.
  let larkProfile: string | undefined;
  let activityCalendarId: string | undefined;
  let activityWikiDocId: string | undefined;
  try {
    const cfg = loadConfigs();
    activityCalendarId = cfg.lark.activityCalendarId;
    activityWikiDocId = cfg.lark.activityWikiDocId;
    for (const id of listAgents(cfg)) {
      if (cfg.agents.agents[id]?.enabled) {
        larkProfile = resolveAgent(id, cfg).larkProfile;
        break;
      }
    }
  } catch {
    /* ignore config errors; some fields will fall back to defaults */
  }

  // ── meetup create ───────────────────────────────────────────
  if (sub === 'create') {
    const title = getFlag(argv, 'title');
    const startStr = getFlag(argv, 'start');
    const endStr = getFlag(argv, 'end');
    if (!title || !startStr || !endStr) {
      log.error('--title、--start、--end 均为必填项。示例：\n  agent meetup create --title 社区共学 --start "2026-07-09 20:00" --end "2026-07-09 21:00"');
      process.exit(1);
    }
    const startSec = parseDateTimeArg(startStr);
    const endSec = parseDateTimeArg(endStr);
    if (isNaN(startSec) || isNaN(endSec)) {
      log.error('日期格式无效，请使用 YYYY-MM-DD HH:mm 或 ISO 8601 格式。');
      process.exit(1);
    }

    const tagsArg = getFlag(argv, 'tags');
    const tags = tagsArg ? tagsArg.split(',').map((t) => t.trim()).filter(Boolean) : [];
    const desc = getFlag(argv, 'desc') ?? '';

    // Build RRULE: if --recur false → one-off; if --recur <RULE> → use it; else default weekly×10.
    const recurArg = getFlag(argv, 'recur');
    let recurrence = '';
    if (!recurArg || recurArg.toLowerCase() === 'true') {
      const byday = weekdayToken(new Date(startSec * 1000));
      recurrence = `FREQ=WEEKLY;BYDAY=${byday};COUNT=10`;
    } else if (recurArg.toLowerCase() !== 'false') {
      recurrence = recurArg;
    }

    if (!activityCalendarId) {
      log.error('configs/lark.json 缺少 activityCalendarId，请先填入 Ricky 的 primary calendar id。');
      process.exit(1);
    }

    log.info(`创建会议【${title}】${fmtSec(startSec)} → ${fmtSec(endSec)}${recurrence ? `（循环：${recurrence}）` : '（单次）'}…`);
    const result = createCalendarEvent({
      calendarId: activityCalendarId,
      title,
      startTimeSec: startSec,
      endTimeSec: endSec,
      description: desc,
      recurrence: recurrence || undefined,
      withVc: true,
      profile: larkProfile,
      organizerOpenId: userOpenIdForProfile(larkProfile),
    });

    if (!result) {
      log.error('飞书日历创建失败，请检查日志。');
      process.exit(1);
    }

    const meetupId = insertMeetup({
      larkEventId: result.eventId,
      title,
      description: desc,
      recurrence,
      startTime: startSec,
      endTime: endSec,
      meetupUrl: result.meetupUrl,
      appLink: result.appLink,
      shareLink: result.shareLink,
      calendarId: activityCalendarId,
      createdBy: larkProfile ?? '',
    });
    if (tags.length > 0) setMeetupTags(meetupId, tags);
    refreshMeetupWiki({ profile: larkProfile }); // mirror to the "SeeDAO 活动日历" wiki page

    console.log(`✅ 会议已创建：id=${meetupId}  event_id=${result.eventId}`);
    if (result.shareLink) console.log(`   日历链接：${result.shareLink}`);
    if (result.meetupUrl) console.log(`   VC 入会链接：${result.meetupUrl}`);
    if (result.appLink) console.log(`   日程链接：${result.appLink}`);
    if (tags.length > 0) console.log(`   标签：${tags.join('、')}`);
    return;
  }

  // ── meetup edit ─────────────────────────────────────────────
  if (sub === 'edit') {
    const idStr = argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined;
    if (!idStr) { log.error('用法: agent meetup edit <id> [--title ...] [--start ...] [--end ...] [--rrule ...] [--tags ...]'); process.exit(1); }
    const id = Number(idStr);
    const mtg = getMeetupById(id);
    if (!mtg) { log.error(`找不到会议：id=${id}`); process.exit(1); }
    if (mtg.status === 'cancelled') { log.error(`会议【${mtg.title}】已取消，无法编辑。`); process.exit(1); }

    const newTitle = getFlag(argv, 'title');
    const newStart = getFlag(argv, 'start');
    const newEnd = getFlag(argv, 'end');
    const newRrule = getFlag(argv, 'rrule');
    const newTagsArg = getFlag(argv, 'tags');

    // Update Feishu calendar event.
    const startIso = newStart ? new Date((parseDateTimeArg(newStart)) * 1000).toISOString() : undefined;
    const endIso = newEnd ? new Date((parseDateTimeArg(newEnd ?? '')) * 1000).toISOString() : undefined;
    const larkOk = updateCalendarEvent({
      eventId: mtg.larkEventId,
      summary: newTitle,
      startIso,
      endIso,
      rrule: newRrule,
      profile: larkProfile,
    });

    // Update local DB.
    const dbUpdates: Parameters<typeof updateMeetup>[1] = {};
    if (newTitle) dbUpdates.title = newTitle;
    if (newStart) dbUpdates.startTime = parseDateTimeArg(newStart);
    if (newEnd) dbUpdates.endTime = parseDateTimeArg(newEnd);
    if (newRrule !== undefined) dbUpdates.recurrence = newRrule;
    updateMeetup(id, dbUpdates);
    if (newTagsArg !== undefined) {
      setMeetupTags(id, newTagsArg.split(',').map((t) => t.trim()).filter(Boolean));
    }
    refreshMeetupWiki({ profile: larkProfile }); // mirror the edit to the "SeeDAO 活动日历" wiki page

    console.log(larkOk ? `✅ 会议【${newTitle ?? mtg.title}】已更新。` : `⚠️  本地已更新，但飞书日历更新失败，请手动检查。`);
    return;
  }

  // ── meetup cancel ───────────────────────────────────────────
  if (sub === 'cancel') {
    const idStr = argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined;
    if (!idStr) { log.error('用法: agent meetup cancel <id>'); process.exit(1); }
    const id = Number(idStr);
    const mtg = getMeetupById(id);
    if (!mtg) { log.error(`找不到会议：id=${id}`); process.exit(1); }
    if (mtg.status === 'cancelled') { console.log(`会议【${mtg.title}】已经是取消状态。`); return; }

    let calId = mtg.calendarId || activityCalendarId || '';
    const larkOk = calId ? cancelCalendarEvent(calId, mtg.larkEventId, { profile: larkProfile }) : false;
    storeCancelMeetup(id);
    refreshMeetupWiki({ profile: larkProfile }); // mirror the cancellation to the "SeeDAO 活动日历" wiki page
    console.log(larkOk ? `✅ 已取消会议【${mtg.title}】（飞书日历已删除）。` : `⚠️  本地已标记取消，飞书日历删除${calId ? '失败' : '跳过（无 calendarId）'}，请手动检查。`);
    return;
  }

  // ── meetup digest ───────────────────────────────────────────
  if (sub === 'digest') {
    const dateArg = getFlag(argv, 'date');
    const toChatId = getFlag(argv, 'to');
    const ref = dateArg ? new Date(dateArg) : new Date();
    if (isNaN(ref.getTime())) { log.error(`无效日期：${dateArg}`); process.exit(1); }

    const dayStart = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 0, 0, 0, 0);
    const dayEnd = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + 1, 0, 0, 0, 0);
    const { meetupsOnDate } = await import('../core/store/meetups.js');
    const meetups = meetupsOnDate(Math.floor(dayStart.getTime() / 1000), Math.floor(dayEnd.getTime() / 1000));

    if (meetups.length === 0) {
      console.log(`${fmtSec(Math.floor(dayStart.getTime() / 1000)).slice(0, 10)} 没有安排会议，不发送播报。`);
      return;
    }

    const { sendPost } = await import('../core/lark.js');
    const { resolveChatTarget } = await import('../core/configs.js');
    const chatId = toChatId ?? resolveChatTarget('运营小天地');
    if (!chatId) {
      console.log('未指定目标群（--to <chat_id>），且 configs 中找不到运营小天地 chat_id，跳过发送。');
      console.log('以下是播报内容预览：');
    }

    const lines: import('../core/lark.js').PostElement[][] = [];
    const dateSlash = fmtSec(Math.floor(dayStart.getTime() / 1000)).slice(0, 10).replace(/-/g, '/');
    const weekday = '日一二三四五六'[dayStart.getDay()];
    lines.push([{ tag: 'text', text: `📅 ${dateSlash} (${weekday}) 今日活动` }]);
    for (let i = 0; i < meetups.length; i++) {
      const m = meetups[i]!;
      if (i > 0) lines.push([{ tag: 'text', text: '' }]); // blank line between meetings
      const timeRange = `${fmtSec(m.startTime).slice(11, 16)}–${fmtSec(m.endTime).slice(11, 16)}`;
      lines.push([{ tag: 'text', text: `• ${m.title}  ${timeRange}` }]);
      const calLink = m.shareLink || m.appLink; // prefer the calendar share link
      if (calLink) {
        lines.push([{ tag: 'text', text: `会议日程：${calLink}` }]);
      } else if (m.meetupUrl) {
        lines.push([{ tag: 'text', text: `加入视频会议：${m.meetupUrl}` }]);
      }
      for (const tag of m.tags) {
        lines.push([{ tag: 'text', text: `要追踪后续活动请输入【@城邦土地神 follow ${tag}】` }]);
      }
    }

    console.log('播报内容：');
    for (const line of lines) console.log('  ' + line.map((e) => ('text' in e ? e.text : '')).join(''));

    if (chatId) {
      try {
        const res = sendPost({ chatId }, { content: lines }, { as: 'bot', profile: larkProfile });
        console.log(`✅ 已发送到群 ${chatId}（message_id=${res.messageId ?? '?'}）`);
      } catch (e) {
        log.error('发送失败：', (e as Error).message);
        process.exit(1);
      }
    }
    return;
  }

  // ── meetup list ─────────────────────────────────────────────
  if (sub === 'list') {
    const meetups = listUpcomingMeetups();
    if (meetups.length === 0) {
      console.log('（暂无即将举行的会议）');
      return;
    }
    console.log(`即将举行的会议（共 ${meetups.length} 场）：`);
    for (const m of meetups) {
      const tagsStr = m.tags.length ? `  [${m.tags.join(', ')}]` : '';
      console.log(`  [${m.id}] ${m.title}  ${fmtSec(m.startTime)}${tagsStr}`);
      if (m.meetupUrl) console.log(`        VC: ${m.meetupUrl}`);
    }
    return;
  }

  log.error(`未知子命令：${sub}。用 agent meetup help 查看用法。`);
  process.exit(1);
}

// ── memory management CLI ─────────────────────────────────────

async function cmd_memory(argv: string[]): Promise<void> {
  const sub = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
  if (!sub || sub === 'help') {
    log.error([
      '用法:',
      '  agent memory list [--namespace <ns>] [--user <openId>] [--chat <chatId>] [--limit N]',
      '  agent memory inspect <id>',
      '  agent memory add --namespace <ns> --content <text> [--key k] [--visibility v] [--sensitivity s] [--expires <unixsec>]',
      '  agent memory set --namespace <ns> --key <k> --content <text> [--visibility v] [--sensitivity s] [--expires <unixsec>]',
      '  agent memory rm <id>',
      '  agent memory clear --namespace <ns>',
      '  agent memory preview --chat <chatId> --user <openId> [--admin]',
      '  agent memory summarize --chat <chatId> --user <openId> [--soul <soul>]',
      '  agent memory aggregate [--chat <chatId>]',
      '  agent memory purge',
    ].join('\n'));
    process.exit(1);
  }

  const {
    listMemories,
    getMemoryById,
    insertMemory,
    upsertMemory,
    deleteMemory,
    deleteNamespace,
    getFilteredMemories,
    purgeExpiredMemories,
    listKnownChatIds,
  } = await import('../core/store/memory.js');

  if (sub === 'list') {
    const ns = getFlag(argv, 'namespace');
    const user = getFlag(argv, 'user');
    const chat = getFlag(argv, 'chat');
    const limitStr = getFlag(argv, 'limit');
    const limit = limitStr ? Number(limitStr) : 50;
    const items = listMemories({ namespace: ns, userOpenId: user, chatId: chat, limit });
    if (items.length === 0) { console.log('（无记录）'); return; }
    for (const m of items) {
      const expiry = m.expiresAt ? ` expires=${m.expiresAt}` : '';
      console.log(`[${m.id}] ns=${m.namespace} key=${m.key ?? '—'} vis=${m.visibility} src=${m.source}${expiry}`);
      console.log(`       ${m.content.slice(0, 120)}${m.content.length > 120 ? '…' : ''}`);
    }
    console.log(`共 ${items.length} 条记录。`);
    return;
  }

  if (sub === 'inspect') {
    const idStr = argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined;
    if (!idStr) { log.error('用法: agent memory inspect <id>'); process.exit(1); }
    const m = getMemoryById(Number(idStr));
    if (!m) { log.error(`找不到记录：id=${idStr}`); process.exit(1); }
    console.log(JSON.stringify(m, null, 2));
    return;
  }

  if (sub === 'add') {
    const ns = getFlag(argv, 'namespace');
    const content = getFlag(argv, 'content');
    if (!ns || !content) { log.error('--namespace 和 --content 为必填项'); process.exit(1); }
    const key = getFlag(argv, 'key');
    const visibility = getFlag(argv, 'visibility') as import('../core/store/memory.js').MemoryVisibility | undefined;
    const sensitivity = getFlag(argv, 'sensitivity') as import('../core/store/memory.js').MemorySensitivity | undefined;
    const expiresStr = getFlag(argv, 'expires');
    const id = insertMemory({
      namespace: ns, content, key, visibility, sensitivity,
      expiresAt: expiresStr ? Number(expiresStr) : undefined,
      source: 'manual',
    });
    console.log(`已写入：id=${id}`);
    return;
  }

  if (sub === 'set') {
    const ns = getFlag(argv, 'namespace');
    const key = getFlag(argv, 'key');
    const content = getFlag(argv, 'content');
    if (!ns || !key || !content) { log.error('--namespace、--key 和 --content 为必填项'); process.exit(1); }
    const visibility = getFlag(argv, 'visibility') as import('../core/store/memory.js').MemoryVisibility | undefined;
    const sensitivity = getFlag(argv, 'sensitivity') as import('../core/store/memory.js').MemorySensitivity | undefined;
    const expiresStr = getFlag(argv, 'expires');
    const id = upsertMemory({
      namespace: ns, key, content, visibility, sensitivity,
      expiresAt: expiresStr ? Number(expiresStr) : undefined,
      source: 'manual',
    });
    console.log(`已写入（upsert）：id=${id}`);
    return;
  }

  if (sub === 'rm') {
    const idStr = argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined;
    if (!idStr) { log.error('用法: agent memory rm <id>'); process.exit(1); }
    const ok = deleteMemory(Number(idStr));
    console.log(ok ? `已删除：id=${idStr}` : `找不到记录：id=${idStr}`);
    return;
  }

  if (sub === 'clear') {
    const ns = getFlag(argv, 'namespace');
    if (!ns) { log.error('--namespace 为必填项'); process.exit(1); }
    const n = deleteNamespace(ns);
    console.log(`已清除命名空间 ${ns}：共删除 ${n} 条记录。`);
    return;
  }

  // Show the exact memory block a given (chat, user) would receive, after the policy filter.
  // Mirrors prepare()'s caller context and per-scope budgets so the output equals what is injected
  // into the prompt at reply time — the authoritative way to confirm cross-user isolation.
  if (sub === 'preview') {
    const chat = getFlag(argv, 'chat');
    const user = getFlag(argv, 'user');
    if (!chat || !user) {
      log.error('用法: agent memory preview --chat <chatId> --user <openId> [--admin]');
      process.exit(1);
    }
    const { allowedNamespaces } = await import('../core/memory-policy.js');
    const { isAdmin, getChatTier } = await import('../core/configs.js');
    const admin = hasFlag(argv, 'admin') || isAdmin(user);
    const ctx = { chatId: chat, userOpenId: user, isAdmin: admin };
    const namespaces = allowedNamespaces(ctx);
    const memories = getFilteredMemories(ctx, { namespaces, groupCharLimit: 500, userCharLimit: 300 });
    const tier = getChatTier(chat);
    console.log(`视角：chat=${chat} user=${user} admin=${admin}`);
    console.log(`群层级：${tier}`);
    console.log(`可读命名空间：${namespaces.join('、')}`);
    if (memories.length === 0) { console.log('注入记忆：（无）'); return; }
    console.log('注入记忆（即实际进入 prompt 的【背景记忆】区块）：');
    for (const m of memories) {
      console.log(`  - [ns=${m.namespace} vis=${m.visibility}] ${m.content}`);
    }
    return;
  }

  // Manually trigger the rolling per-user memory summary for one (chat, user) without waiting for
  // the reply-count threshold. Invokes the same code path the bot uses on a live conversation.
  if (sub === 'summarize') {
    const chat = getFlag(argv, 'chat');
    const user = getFlag(argv, 'user');
    if (!chat || !user) {
      log.error('用法: agent memory summarize --chat <chatId> --user <openId> [--soul <soul>]');
      process.exit(1);
    }
    const soul = getFlag(argv, 'soul') ?? DEFAULT_SOUL;
    if (!soulExists(soul)) { log.error(`找不到 soul：${soul}`); process.exit(1); }
    const agent = new Agent(soul, { journal: false });
    await agent.summarizeUserMemory(chat, user);
    console.log(`已触发记忆摘要：soul=${soul} chat=${chat} user=${user}（结果用 memory preview / list 查看）`);
    return;
  }

  // Manually run group topic aggregation without waiting for the daily maintenance schedule.
  // With no --chat, aggregates every chat that has recorded messages.
  if (sub === 'aggregate') {
    const { aggregateGroupTopics } = await import('../core/group-intel.js');
    const chat = getFlag(argv, 'chat');
    const chats = chat ? [chat] : listKnownChatIds();
    if (chats.length === 0) { console.log('（无已知群组）'); return; }
    for (const c of chats) {
      const summary = aggregateGroupTopics(c);
      console.log(summary ? `[${c}] ${summary}` : `[${c}]（消息不足，未生成）`);
    }
    return;
  }

  // Manually run the TTL sweep that removes expired memory rows.
  if (sub === 'purge') {
    const n = purgeExpiredMemories();
    console.log(`已清理过期记忆：共删除 ${n} 条。`);
    return;
  }

  log.error(`未知子指令：${sub}`);
  process.exit(1);
}

// ── command registry + dispatch ───────────────────────────────

type CommandHandler = (argv: string[]) => void | Promise<void>;

// Backfill / repair the visitor-count milestone ledger for a chat: for each hundred up to the current
// present count, freeze the milestone-th present member (arrival order) into the DB + JSON ledger and
// refresh the "访客里程碑" wiki page. Idempotent — already-recorded milestones are left untouched, so it
// is safe to re-run. Records without re-announcing (no fire), which is exactly what backfill needs.
async function cmd_visitors(argv: string[]): Promise<void> {
  process.env.AGENT_SOUL = DEFAULT_SOUL;
  const { resolveChatTarget } = await import('../core/configs.js');
  const { isMilestoneRecorded, recordMilestone, refreshVisitorMilestonesWiki } = await import('../core/visitor-milestones.js');

  const sub = argv[1] && !argv[1].startsWith('--') ? argv[1] : 'backfill';
  const chatId = getFlag(argv, 'chat') ?? resolveChatTarget('围观群');
  if (!chatId) { log.error('无法解析围观群 chat_id（configs/lark.json knownInternalChats 缺「围观群」）'); process.exit(1); }

  let larkProfile: string | undefined;
  try {
    const cfg = loadConfigs();
    for (const id of listAgents(cfg)) {
      if (cfg.agents.agents[id]?.enabled) { larkProfile = resolveAgent(id, cfg).larkProfile; break; }
    }
  } catch { /* use default profile */ }

  if (sub !== 'backfill') { log.error('用法: agent visitors backfill [--chat <oc_id>]'); process.exit(1); }

  const present = store.presentMemberCount(chatId);
  const top = Math.floor(present / 100) * 100;
  console.log(`围观群在群人数 ${present}，回填里程碑至 ${top}…`);
  let recorded = 0;
  for (let m = 100; m <= top; m += 100) {
    if (isMilestoneRecorded(DEFAULT_SOUL, chatId, m)) { console.log(`  第 ${m} 人：已记录，跳过`); continue; }
    const person = store.nthPresentMemberByArrival(chatId, m);
    if (!person) { console.log(`  第 ${m} 人：在群人数不足，跳过`); continue; }
    // Use the visitor's first_seen as the reached-at time (≈ when the milestone was hit).
    recordMilestone(DEFAULT_SOUL, chatId, m, person, person.firstSeen);
    recorded += 1;
    console.log(`  第 ${m} 人：${person.name || '(无名)'}（${person.openId}）已记录`);
  }
  const wikiOk = refreshVisitorMilestonesWiki(chatId, { profile: larkProfile });
  console.log(`完成：新记录 ${recorded} 个里程碑；wiki【访客里程碑】${wikiOk ? '已更新' : '未更新（检查 visitorMilestoneWikiDocId / scope）'}`);
}

// ── TC CLI ──────────────────────────────────────────────────
// Operator-facing subcommands for managing TC (betting-survey) proposals.
// These run as one-shot CLI invocations.

async function cmd_tc(argv: string[]): Promise<void> {
  const sub = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;

  if (!sub || sub === 'help') {
    console.log([
      '用法:',
      '  agent tc list             — 列出所有 active 提案',
      '  agent tc list --all       — 列出最近 20 个提案（含已结算/撤销）',
      '  agent tc show <num>       — 查看提案详情 + 投注分布',
      '  agent tc cancel <num>     — 撤销提案并退还所有投注 LP',
      '  agent tc settle <num>     — 强制立即结算（测试/运维用）',
      '  agent tc create --title <标题> --type <discrete|continuous>',
      '                  --options <A,B,C 或 min-max>',
      '                  [--end <YYYY-MM-DD HH:mm>] [--max-bet <N>]',
    ].join('\n'));
    return;
  }

  process.env.AGENT_SOUL = DEFAULT_SOUL;

  const { listActiveTcs, listAllTcs, getTcByNum, getTcBets, cancelTcProposal,
          getUnrefundedBets, markBetRefunded, insertTcProposal, updateTcTopMessageId } = await import('../core/store/tc.js');
  const { grantPt } = await import('../core/store/gamification.js');
  const { settleTc } = await import('../core/tc-settlement.js');

  let larkProfile: string | undefined;
  try {
    const cfg = loadConfigs();
    for (const id of listAgents(cfg)) {
      if (cfg.agents.agents[id]?.enabled) {
        larkProfile = resolveAgent(id, cfg).larkProfile;
        break;
      }
    }
  } catch { /* use default */ }

  // ── tc list ───────────────────────────────────────────────
  if (sub === 'list') {
    const all = hasFlag(argv, 'all');
    const proposals = all ? listAllTcs(20) : listActiveTcs();
    if (proposals.length === 0) {
      console.log(all ? '暂无提案记录。' : '暂无 active 提案。');
      return;
    }
    for (const p of proposals) {
      const endStr = new Date(p.endTime * 1000).toLocaleString('sv-SE').slice(0, 16);
      console.log(`TC-${p.num}  [${p.status}]  ${p.title}  截止:${endStr}`);
    }
    return;
  }

  // ── tc show ───────────────────────────────────────────────
  if (sub === 'show') {
    const numStr = argv[2];
    const num = numStr ? parseInt(numStr, 10) : NaN;
    if (isNaN(num)) { log.error('用法: agent tc show <编号>'); process.exit(1); }
    const p = getTcByNum(num);
    if (!p) { log.error(`找不到 TC-${num}`); process.exit(1); }
    const bets = getTcBets(p.id);
    const activeBets = bets.filter(b => !b.isRefunded);
    const totalLp = activeBets.reduce((s, b) => s + b.lpAmount, 0);
    console.log(`TC-${p.num}: ${p.title}`);
    console.log(`  状态: ${p.status}  类型: ${p.optionType}`);
    console.log(`  选项: ${JSON.stringify(p.options)}`);
    console.log(`  截止: ${new Date(p.endTime * 1000).toLocaleString('sv-SE').slice(0, 16)}`);
    console.log(`  投注上限: ${p.maxBetLp} LP  topMsgId: ${p.topMessageId || '(未发送)'}`);
    console.log(`  参与人数: ${new Set(activeBets.map(b => b.userOpenId)).size}  总投入: ${totalLp.toFixed(1)} LP`);
    if (activeBets.length > 0) {
      const byOpt: Record<string, number> = {};
      for (const b of activeBets) byOpt[b.optionValue] = (byOpt[b.optionValue] ?? 0) + b.lpAmount;
      for (const [opt, lp] of Object.entries(byOpt).sort((a, b) => b[1] - a[1])) {
        console.log(`    【${opt}】${lp.toFixed(1)} LP`);
      }
    }
    if (p.status === 'settled') {
      console.log(`  结算结果: value=${p.settledValue}  option=${p.settledOption}`);
    }
    return;
  }

  // ── tc cancel ─────────────────────────────────────────────
  if (sub === 'cancel') {
    const numStr = argv[2];
    const num = numStr ? parseInt(numStr, 10) : NaN;
    if (isNaN(num)) { log.error('用法: agent tc cancel <编号>'); process.exit(1); }
    const p = getTcByNum(num);
    if (!p) { log.error(`找不到 TC-${num}`); process.exit(1); }
    if (p.status !== 'active') { log.error(`TC-${num} 状态为 ${p.status}，不可撤销`); process.exit(1); }
    const pending = getUnrefundedBets(p.id);
    let refunded = 0;
    for (const bet of pending) {
      try {
        markBetRefunded(bet.id);
        grantPt(bet.userOpenId, bet.lpAmount, 'tc_refund_cancel', p.topMessageId);
        refunded++;
      } catch (e) {
        log.warn(`退款失败（bet.id=${bet.id}）：${(e as Error).message}`);
      }
    }
    cancelTcProposal(p.id);
    console.log(`TC-${p.num}【${p.title}】已撤销，退款 ${refunded} 笔。`);
    return;
  }

  // ── tc settle ─────────────────────────────────────────────
  if (sub === 'settle') {
    const numStr = argv[2];
    const num = numStr ? parseInt(numStr, 10) : NaN;
    if (isNaN(num)) { log.error('用法: agent tc settle <编号>'); process.exit(1); }
    const p = getTcByNum(num);
    if (!p) { log.error(`找不到 TC-${num}`); process.exit(1); }
    if (p.status !== 'active') { log.error(`TC-${num} 状态为 ${p.status}，无法结算`); process.exit(1); }
    log.info(`强制结算 TC-${p.num}【${p.title}】…`);
    await settleTc(p, larkProfile ?? '');
    console.log(`TC-${p.num} 结算完成。`);
    return;
  }

  // ── tc create ─────────────────────────────────────────────
  if (sub === 'create') {
    const title = getFlag(argv, 'title');
    const typeArg = getFlag(argv, 'type') as 'discrete' | 'continuous' | undefined;
    const optionsArg = getFlag(argv, 'options');
    const endArg = getFlag(argv, 'end');
    const maxBetArg = getFlag(argv, 'max-bet');
    if (!title || !typeArg || !optionsArg) {
      log.error('--title、--type、--options 均为必填项。\n示例（离散）：agent tc create --title 标题 --type discrete --options "A,B,C"\n示例（连续）：agent tc create --title 标题 --type continuous --options 1-100');
      process.exit(1);
    }
    let options: string[] | [number, number];
    if (typeArg === 'discrete') {
      options = optionsArg.split(',').map(s => s.trim()).filter(Boolean);
      if (options.length < 2) { log.error('离散型至少需要 2 个选项'); process.exit(1); }
    } else {
      const parts = optionsArg.split(/[-–]/).map(s => parseFloat(s.trim()));
      if (parts.length < 2 || parts.some(isNaN)) { log.error('连续型 --options 格式：min-max，例如 1-100'); process.exit(1); }
      options = [parts[0]!, parts[1]!];
    }
    const endSec = endArg
      ? Math.floor(Date.parse(endArg.includes('T') ? endArg : endArg.replace(' ', 'T')) / 1000)
      : Math.floor(Date.now() / 1000) + 86400;
    if (!Number.isFinite(endSec)) { log.error('--end 日期格式无效'); process.exit(1); }
    const maxBet = maxBetArg ? parseFloat(maxBetArg) : 10;
    const { id, num } = insertTcProposal({ title, optionType: typeArg, options, endTime: endSec, maxBetLp: maxBet });
    console.log(`TC-${num} 已创建（id=${id}），topMessageId 待手动发送后回填。`);
    return;
  }

  log.error(`未知子命令【${sub}】。运行 agent tc help 查看用法。`);
  process.exit(1);
}

// ── Memory-fragment CLI ─────────────────────────────────────
// Operator- and /goal-facing subcommands for the SeeDAO history "memory fragment" store.
// Every write is DB-only (shared.db via the fragments store) with zero Feishu side effects,
// mirroring `tc create`, so an autonomous /goal loop can ingest Notion history without touching
// the outbound send path (and therefore never trips outbound-guard).

async function cmd_fragment(argv: string[]): Promise<void> {
  process.env.AGENT_SOUL = DEFAULT_SOUL;
  const sub = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;

  if (!sub || sub === 'help') {
    console.log([
      '用法（记忆碎片 · SeeDAO 历史 DB，写入共享库 shared.db，不发飞书）:',
      '  agent fragment add "<15-30字碎片>" [--source <url>] [--note <备注>] [--category <标签>] [--by <来源>]',
      '  agent fragment import <file.jsonl>  — 每行一个 JSON: {"content","sourceUrl?","sourceNote?","category?","addedBy?"}',
      '  agent fragment list [--limit N] [--offset N] [--status active|archived] [--category <标签>]',
      '  agent fragment search "<关键字>" [--limit N]  — 写入前查重用',
      '  agent fragment random [--category <标签>]     — 随机抽一条（验证用）',
      '  agent fragment count [--status active|archived]',
      '  agent fragment archive <id>                   — 软停用（不删除）',
    ].join('\n'));
    return;
  }

  const {
    insertFragment, listFragments, searchFragments, getRandomFragment,
    countFragments, archiveFragment,
  } = await import('../core/store/fragments.js');

  // ── fragment add ──────────────────────────────────────────
  if (sub === 'add') {
    const content = argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined;
    if (!content) { log.error('用法: agent fragment add "<碎片文字>" [--source <url>] [--category <标签>]'); process.exit(1); }
    const { inserted, id } = insertFragment({
      content,
      sourceUrl: getFlag(argv, 'source'),
      sourceNote: getFlag(argv, 'note'),
      category: getFlag(argv, 'category'),
      addedBy: getFlag(argv, 'by') ?? 'cli',
    });
    console.log(inserted ? `已写入碎片 #${id}` : `已存在等价碎片 #${id}（跳过）`);
    return;
  }

  // ── fragment import ───────────────────────────────────────
  if (sub === 'import') {
    const file = argv[2];
    if (!file || file.startsWith('--')) { log.error('用法: agent fragment import <file.jsonl>'); process.exit(1); }
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { log.error(`读取文件失败：${(e as Error).message}`); process.exit(1); }
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    let added = 0, dup = 0, bad = 0;
    for (const line of lines) {
      let obj: { content?: string; sourceUrl?: string; sourceNote?: string; category?: string; addedBy?: string };
      try { obj = JSON.parse(line); } catch { bad++; continue; }
      if (!obj.content || typeof obj.content !== 'string' || !obj.content.trim()) { bad++; continue; }
      const { inserted } = insertFragment({
        content: obj.content,
        sourceUrl: obj.sourceUrl,
        sourceNote: obj.sourceNote,
        category: obj.category,
        addedBy: obj.addedBy ?? 'jsonl-import',
      });
      if (inserted) added++; else dup++;
    }
    console.log(`导入完成：新增 ${added}，重复跳过 ${dup}，无效行 ${bad}，共 ${lines.length} 行。`);
    return;
  }

  // ── fragment list ─────────────────────────────────────────
  if (sub === 'list') {
    const limitArg = getFlag(argv, 'limit');
    const offsetArg = getFlag(argv, 'offset');
    const rows = listFragments({
      limit: limitArg ? parseInt(limitArg, 10) : 50,
      offset: offsetArg ? parseInt(offsetArg, 10) : 0,
      status: getFlag(argv, 'status') as 'active' | 'archived' | undefined,
      category: getFlag(argv, 'category'),
    });
    if (rows.length === 0) { console.log('（空）'); return; }
    for (const f of rows) {
      const tag = f.category ? ` [${f.category}]` : '';
      const st = f.status === 'active' ? '' : ` (${f.status})`;
      console.log(`#${f.id}${st}${tag} ${f.content}`);
    }
    console.log(`— 本页 ${rows.length} 条；active 总数 ${countFragments({ status: 'active' })}`);
    return;
  }

  // ── fragment search ───────────────────────────────────────
  if (sub === 'search') {
    const q = argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined;
    if (!q) { log.error('用法: agent fragment search "<关键字>" [--limit N]'); process.exit(1); }
    const limitArg = getFlag(argv, 'limit');
    const rows = searchFragments(q, limitArg ? parseInt(limitArg, 10) : 20);
    if (rows.length === 0) { console.log('（无匹配，可安全写入新碎片）'); return; }
    for (const f of rows) console.log(`#${f.id} ${f.content}`);
    return;
  }

  // ── fragment random ───────────────────────────────────────
  if (sub === 'random') {
    const f = getRandomFragment({ category: getFlag(argv, 'category') });
    console.log(f ? f.content : '（碎片库为空）');
    return;
  }

  // ── fragment count ────────────────────────────────────────
  if (sub === 'count') {
    console.log(String(countFragments({ status: getFlag(argv, 'status') as 'active' | 'archived' | undefined })));
    return;
  }

  // ── fragment archive ──────────────────────────────────────
  if (sub === 'archive') {
    const idStr = argv[2];
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (isNaN(id)) { log.error('用法: agent fragment archive <id>'); process.exit(1); }
    console.log(archiveFragment(id) ? `碎片 #${id} 已软停用。` : `碎片 #${id} 不存在或已非 active。`);
    return;
  }

  log.error(`未知子命令【${sub}】。运行 agent fragment help 查看用法。`);
  process.exit(1);
}

interface CliCommand {
  /** Command name plus any aliases. */
  names: string[];
  run: CommandHandler;
}

const COMMANDS: CliCommand[] = [
  { names: ['agents'], run: cmd_agents },
  { names: ['visitors'], run: cmd_visitors },
  { names: ['backfill'], run: cmd_backfill },
  { names: ['backfill-members'], run: cmd_backfill_members },
  { names: ['calendar-events'], run: cmd_calendar_events },
  { names: ['doc-views'], run: cmd_doc_views },
  { names: ['token-check'], run: cmd_token_check },
  { names: ['doctor'], run: cmd_doctor },
  { names: ['events'], run: cmd_events },
  { names: ['event', 'event-fire'], run: cmd_event },
  { names: ['unsend'], run: cmd_unsend },
  { names: ['badge'], run: cmd_badge },
  { names: ['memory'], run: cmd_memory },
  { names: ['daily-reset'], run: cmd_daily_reset },
  { names: ['reset-all-pt'], run: cmd_reset_all_pt },
  { names: ['lp-migrate'], run: cmd_lp_migrate },
  { names: ['link'], run: cmd_link },
  { names: ['serve'], run: cmd_serve },
  { names: ['update'], run: cmd_update },
  { names: ['cli'], run: cmd_cli },
  { names: ['souls'], run: cmd_souls },
  { names: ['ask'], run: cmd_ask },
  { names: ['run'], run: cmd_run },
  { names: ['report'], run: cmd_report },
  { names: ['tg-test'], run: cmd_tg_test },
  { names: ['heartbeat'], run: cmd_heartbeat },
  { names: ['meetup'], run: cmd_meetup },
  { names: ['tc'], run: cmd_tc },
  { names: ['fragment', 'fragments'], run: cmd_fragment },
];

const COMMAND_INDEX = new Map<string, CliCommand>();
for (const c of COMMANDS) for (const n of c.names) COMMAND_INDEX.set(n, c);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  const command = COMMAND_INDEX.get(cmd);
  if (!command) {
    log.error(`未知命令【${cmd}】`);
    usage();
    process.exit(1);
  }

  await command.run(argv);
}

main().catch((e) => {
  log.error((e as Error).message);
  process.exit(1);
});
