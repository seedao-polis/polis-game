import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SOULS_DIR, buildAgentMcpConfig } from './paths.js';
import { logicalDayIndex } from './time.js';
import { assembleSoul } from './soul.js';
import { runKimiAsync } from './kimi.js';
import { skillsDirsForSoul } from './skills.js';
import { log } from './log.js';
import type { KimiProfile } from './configs.js';

// ── Agent Heartbeat core module ───────────────────────────────────────────────
// Provides per-soul background tick logic: config loading, gate checks (silent hours /
// probability / daily limit), and an LLM invocation pipeline that uses a disposable
// workDir (continueSession:false) to avoid orphan-tool-call session poisoning.

export interface HeartbeatConfig {
  cadenceMinutes: number;
  enabled: boolean;
  silentHours?: [number, number];
  probability?: number;
  dailyLimit?: number;
}

export interface HeartbeatTickOptions {
  larkProfile?: string;
  kimiProfile?: KimiProfile;
  /** Preview only: log prompt and gate state, skip all gates, never call LLM. */
  dryRun?: boolean;
  /** Test mode: call LLM but inject instruction to send only to operator P2P. */
  testMode?: boolean;
}

const DEFAULT_CADENCE = 10;

/**
 * Load and validate the per-soul heartbeat configuration from HEARTBEAT_CONFIG.json.
 * Falls back to disabled defaults when the file is absent or unparseable.
 * Clamps probability to [0,1] and rejects non-positive dailyLimit values.
 */
export function loadHeartbeatConfig(soul: string): HeartbeatConfig {
  const file = path.join(SOULS_DIR, soul, 'HEARTBEAT_CONFIG.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<HeartbeatConfig>;
    const prob =
      typeof raw.probability === 'number' ? Math.min(1, Math.max(0, raw.probability)) : undefined;
    const limit =
      typeof raw.dailyLimit === 'number' && raw.dailyLimit > 0
        ? Math.floor(raw.dailyLimit)
        : undefined;
    return {
      cadenceMinutes: Math.max(1, raw.cadenceMinutes ?? DEFAULT_CADENCE),
      enabled: raw.enabled ?? false,
      silentHours:
        Array.isArray(raw.silentHours) && raw.silentHours.length === 2
          ? (raw.silentHours as [number, number])
          : undefined,
      probability: prob,
      dailyLimit: limit,
    };
  } catch {
    return { cadenceMinutes: DEFAULT_CADENCE, enabled: false };
  }
}

// In-process daily LLM-call counter per soul.
// Resets automatically when the logical day rolls over (logicalDayIndex changes).
// On supervisor restart the counter starts fresh at zero — acceptable since restarts are rare.
const _dailyCounts = new Map<string, { day: number; count: number }>();

/** Return how many LLM calls have been made for this soul in the current logical day. */
export function getDailyCount(soul: string): number {
  const today = logicalDayIndex(Date.now());
  const e = _dailyCounts.get(soul);
  return e && e.day === today ? e.count : 0;
}

/** Increment the in-process LLM call counter for this soul (resets when the logical day changes). */
export function incrementDailyCount(soul: string): void {
  const today = logicalDayIndex(Date.now());
  const e = _dailyCounts.get(soul);
  if (!e || e.day !== today) {
    _dailyCounts.set(soul, { day: today, count: 1 });
  } else {
    e.count += 1;
  }
}

/**
 * Return true when the current local hour falls inside the silent window.
 * Supports cross-midnight ranges: [22, 8] means 22:00 → next day 08:00 is silent.
 */
export function isInSilentHours([start, end]: [number, number]): boolean {
  const h = new Date().getHours();
  return start > end ? h >= start || h < end : h >= start && h < end;
}

// ── prompt helper ─────────────────────────────────────────────────────────────

/**
 * Compose the heartbeat prompt: scene signal + current time + workspace path + guard instruction.
 * When testMode is true, an additional line instructs the agent to send only to the operator P2P.
 */
function buildHeartbeatPrompt(soul: string, workspaceDir: string, testMode?: boolean): string {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const testLine = testMode
    ? '【测试模式】这是人工触发的单次测试心跳。如果你决定发送飞书消息，请只发给操作者本人（使用 sendText 发 P2P 私信），不要发到任何群。\n\n'
    : '';
  return (
    `【心跳唤醒】当前时间：${now}。你是 ${soul}，工作区目录：${workspaceDir}/。\n\n` +
    `${testLine}` +
    `这是一次自动心跳巡检。请基于 HEARTBEAT.md 中描述的职责（已载入系统提示），` +
    `判断当前是否有需要主动采取的行动（如招呼新成员、推播活动提醒、整理素材等）。\n\n` +
    `如有需要，请通过飞书工具直接行动，行动后简短说明做了什么。` +
    `如当前无需行动，输出"本轮无需行动"即可，不要编造任务或强行发送消息。\n\n` +
    `【约束】严格遵守 HEARTBEAT.md 中的节制原则；只发有意义的消息，不刷版。` +
    `【回复要求】一律简体中文 + 中国大陆用语。`
  );
}

// ── heartbeatTick: full LLM-trigger pipeline ─────────────────────────────────

/**
 * Execute one heartbeat tick for a soul.
 *
 * Gate pipeline (framework-enforced, before any LLM call):
 *   1. enabled flag
 *   2. silent hours window
 *   3. probability roll
 *   4. daily LLM call limit
 *
 * When all gates pass, opens a disposable workDir, writes AGENTS.md + mcp.json,
 * calls runKimiAsync with continueSession:false, then cleans up.
 * Any error is logged and swallowed so the next scheduled tick is unaffected.
 */
export async function heartbeatTick(soul: string, opts: HeartbeatTickOptions = {}): Promise<void> {
  const cfg = loadHeartbeatConfig(soul);

  // Gate checks are skipped in dryRun and testMode so operators can inspect state freely.
  if (!opts.dryRun && !opts.testMode) {
    if (!cfg.enabled) {
      log.debug(`心跳本轮跳过【${soul}】：未启用`);
      return;
    }
    const silentHours = cfg.silentHours ?? ([22, 8] as [number, number]);
    if (isInSilentHours(silentHours)) {
      log.debug(`心跳本轮跳过【${soul}】：静默时段`);
      return;
    }
    const prob = cfg.probability ?? 1.0;
    if (prob < 1.0 && Math.random() >= prob) {
      log.debug(`心跳本轮跳过【${soul}】：概率未命中（probability=${prob}）`);
      return;
    }
    if (cfg.dailyLimit !== undefined) {
      const count = getDailyCount(soul);
      if (count >= cfg.dailyLimit) {
        log.debug(
          `心跳本轮跳过【${soul}】：已达每日上限 ${cfg.dailyLimit}（当前 ${count}）`
        );
        return;
      }
    }
  }

  const workspaceDir = join(SOULS_DIR, soul);
  const prompt = buildHeartbeatPrompt(soul, workspaceDir, opts.testMode);

  // Dry-run: show gate state + prompt preview without calling LLM.
  if (opts.dryRun) {
    log.info(
      `心跳 dry-run【${soul}】cadence=${cfg.cadenceMinutes}min enabled=${cfg.enabled}`
    );
    log.info(
      `心跳 dry-run 闸门状态【${soul}】：enabled=${cfg.enabled} ` +
        `silentHours=${JSON.stringify(cfg.silentHours ?? [22, 8])} ` +
        `probability=${cfg.probability ?? 1.0} ` +
        `dailyLimit=${cfg.dailyLimit ?? '不限'} ` +
        `今日已触发=${getDailyCount(soul)}`
    );
    log.info(`心跳 dry-run prompt 预览【${soul}】（首 300 字）：${prompt.slice(0, 300)}`);
    return;
  }

  // Increment counter before the LLM call so a concurrent tick sees the updated count.
  log.info(`心跳触发【${soul}】（今日第 ${getDailyCount(soul) + 1} 次）`);
  incrementDailyCount(soul);

  const soulAssembled = assembleSoul(soul);
  const skillsDirs = skillsDirsForSoul(soul);
  // Throwaway session avoids cross-tick state poisoning (mirrors ops-narrative.ts pattern).
  const tmpBase = mkdtempSync(join(tmpdir(), `heartbeat-${soul}-`));

  try {
    const cfgDir = join(tmpBase, '.kimi-code');
    mkdirSync(cfgDir, { recursive: true });

    // Soul personality: AGENTS.md loaded by kimi-code as agent instructions (includes HEARTBEAT.md).
    fs.writeFileSync(join(cfgDir, 'AGENTS.md'), soulAssembled.systemPrompt, 'utf8');

    // Feishu MCP tools: lets the agent call sendText/sendPost/listChatMembers etc.
    // No fixed chat target: the agent itself decides recipients during the tick.
    const mcpConfig = buildAgentMcpConfig({ soul, larkProfile: opts.larkProfile });
    if (mcpConfig) fs.writeFileSync(join(cfgDir, 'mcp.json'), mcpConfig, 'utf8');

    const startedAt = Date.now();
    const result = await runKimiAsync({
      prompt,
      workDir: tmpBase,
      continueSession: false, // always fresh; each tick is an independent session
      timeoutMs: opts.kimiProfile?.timeoutMs,
      extraArgs: opts.kimiProfile?.extraArgs,
      skillsDirs,
    });
    const durationMs = Date.now() - startedAt;
    const summary = result.replace(/\s+/g, ' ').slice(0, 150);
    log.info(`心跳推理完成【${soul}】，耗时 ${durationMs}ms，结果：${summary}`);
  } catch (e) {
    // Graceful degradation: log error, never re-throw so the next scheduled tick still fires.
    log.error(`心跳推理失败【${soul}】：${(e as Error).message}`);
  } finally {
    // Best-effort cleanup: the temp dir is cheap to leave but we clean up to avoid accumulation.
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ── recurring scheduler (lives in the worker process) ────────────────────────

export interface StartHeartbeatOptions {
  larkProfile?: string;
  kimiProfile?: KimiProfile;
}

/**
 * Arm the recurring heartbeat for a soul in the current process and return a stop function.
 * The heartbeat is intrinsic to an agent being served, so this is called from the worker — it runs
 * whether serve is bare or supervised. cadenceMinutes is read once here; the per-tick gates
 * (enabled / silentHours / probability / dailyLimit) are re-read on every tick inside heartbeatTick.
 * Returns a no-op stopper when the config is missing/unreadable or has enabled:false, so callers can
 * always invoke the result safely.
 */
export function startHeartbeat(soul: string, opts: StartHeartbeatOptions = {}): () => void {
  let cfg: HeartbeatConfig;
  try {
    cfg = loadHeartbeatConfig(soul);
  } catch (e) {
    log.warn(`心跳配置读取失败【${soul}】：${(e as Error).message}`);
    return () => {};
  }
  if (!cfg.enabled) {
    log.debug(`心跳未启用【${soul}】，跳过排程`);
    return () => {};
  }
  const ms = Math.max(1, cfg.cadenceMinutes) * 60_000;
  let timer: ReturnType<typeof setTimeout>;
  // Recursive setTimeout keeps a fixed gap between ticks regardless of how long a tick takes.
  const tick = (): void => {
    void heartbeatTick(soul, opts).catch((e: Error) =>
      log.error(`心跳排程异常【${soul}】：${e.message}`)
    );
    timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  log.info(`心跳已排程【${soul}】：每 ${cfg.cadenceMinutes} 分钟触发一次`);
  return () => clearTimeout(timer);
}
