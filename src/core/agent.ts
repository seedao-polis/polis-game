import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assembleSoul, soulExists } from './soul.js';
import { runKimi, runKimiAsync, KimiError } from './kimi.js';
import { resolveSessionDir, validateSession, quarantineSession, quarantineCorruptSessionsFor, healSessionFor } from './kimi-session.js';
import { skillsDirsForSoul } from './skills.js';
import { appendJournal } from './memory.js';
import { getProfile, recordError } from './store.js';
import { getFilteredMemories, upsertMemory, getRecentUserMessagesInChat } from './store/memory.js';
import { allowedNamespaces, resolveWriteScope } from './memory-policy.js';
import { log, newCorrId, writePostmortem } from './log.js';
import { MCP_SERVER_JS, RUNTIME_DIR, resolveLarkRun } from './paths.js';
import { isAdmin } from './configs.js';
import type { KimiProfile } from './configs.js';

/** Block the current thread for ms milliseconds (respond() is synchronous end-to-end). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable — skip the backoff rather than fail */
  }
}

/** Inputs to the self-heal loop (shared by the sync and async runners). */
interface HealArgs {
  prompt: string;
  workDir: string;
  useSession: boolean;
  chatId?: string;
  source?: string;
}

export interface RespondInput {
  /** User message */
  message: string;
  /** Recent conversation context (optional) */
  context?: string;
  /** Conversation session id (<agentId>-<chatId>, resumes kimi short-term memory) */
  session?: string;
  /** open_id of the user being replied to; injected into the prompt so the agent knows whom it is
   *  talking to and can query that user's profile / LP with the correct id instead of guessing */
  userOpenId?: string;
  /** Display name of the user being replied to (falls back to the stored profile name) */
  userName?: string;
  /** Chat id this message belongs to (recorded in the error ledger for self-heal diagnostics) */
  chatId?: string;
  /** Originating channel name (feishu-bot / feishu-user / cli), for the error ledger */
  source?: string;
}

export interface AgentOptions {
  /** soul / workspace folder name (workspaces/<workspace>/); falls back to the soul name */
  workspace?: string;
  /** lark-cli profile name, passed down to feishu_send via the MCP env */
  larkProfile?: string;
  /** Default Feishu chat id the framework tools (MCP) operate on */
  feishuChatId?: string;
  /** Whether to log every interaction to the journal */
  journal?: boolean;
  /** kimi runtime profile (timeout, extra flags, retry budget); drives self-healing */
  kimiProfile?: KimiProfile;
}

/**
 * Agent: a Kimi agent with a personality (Soul), tools (MCP), and memory (Memory).
 * Each respond() = assemble the personality -> write it + tools into the chat's .kimi-code/ config
 * -> call kimi-code (headless, per-chat session via --continue) -> return the reply.
 */
export class Agent {
  readonly name: string;
  private opts: AgentOptions;

  constructor(soulName: string, opts: AgentOptions = {}) {
    if (!soulExists(soulName)) {
      throw new Error(`找不到 soul【${soulName}】。可用：执行 agent souls 查看。`);
    }
    this.name = soulName;
    this.opts = opts;
  }

  /**
   * Resolve the working directory for a chat. kimi-code binds session continuity (--continue) and
   * project-local .kimi-code/ config to the cwd, so each chat gets its own isolated workDir.
   * Stateless one-offs (no session key) share a throwaway "work" dir and don't resume.
   */
  private workDirFor(sessionKey?: string): string {
    const base = path.join(RUNTIME_DIR, this.name);
    if (!sessionKey) return path.join(base, 'work');
    const safe = sessionKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'default';
    return path.join(base, 'chats', safe);
  }

  /** Build the MCP config (framework tools) attached to kimi. Returns undefined if not yet built. */
  private buildMcpConfig(): string | undefined {
    if (!fs.existsSync(MCP_SERVER_JS)) return undefined;
    const env: Record<string, string> = { AGENT_SOUL: this.name };
    if (this.opts.feishuChatId) env.AGENT_FEISHU_CHAT = this.opts.feishuChatId;
    if (this.opts.larkProfile) env.LARK_PROFILE = this.opts.larkProfile;
    const larkRun = resolveLarkRun();
    if (larkRun) env.LARK_RUN = larkRun;
    if (process.env.APPDATA) env.APPDATA = process.env.APPDATA;
    return JSON.stringify({
      mcpServers: {
        agent: {
          command: process.execPath, // use the same node
          args: [MCP_SERVER_JS],
          env,
        },
      },
    });
  }

  /**
   * Assemble the soul + write the per-chat .kimi-code/ config, then build the final prompt.
   * The soul is reassembled on every call so changes to persona files and chat policies are
   * picked up without a restart. Long-term memories from the DB are injected after the
   * identity context and before the user message, filtered by the caller's policy context.
   * Shared by the sync ({@link respond}) and async ({@link respondAsync}) entry points.
   */
  private prepare(input: RespondInput): { prompt: string; workDir: string; heal: HealArgs } {
    // Pass chatId so the soul assembler can append the per-group policy.
    const soul = assembleSoul(this.name, { chatId: input.chatId });

    const workDir = this.workDirFor(input.session);
    const cfgDir = path.join(workDir, '.kimi-code');
    fs.mkdirSync(cfgDir, { recursive: true });

    // Personality + memory: kimi-code loads project-local .kimi-code/AGENTS.md as its instructions.
    fs.writeFileSync(path.join(cfgDir, 'AGENTS.md'), soul.systemPrompt, 'utf8');

    // Framework tools: kimi-code loads project-local .kimi-code/mcp.json at session start.
    const mcpConfig = this.buildMcpConfig();
    const mcpPath = path.join(cfgDir, 'mcp.json');
    if (mcpConfig) fs.writeFileSync(mcpPath, mcpConfig, 'utf8');
    else fs.rmSync(mcpPath, { force: true });

    // Hard language requirement: pin it again at the end of every prompt to ensure replies always
    // use Simplified Chinese + mainland China wording (highest priority, not swayed by the other party's language).
    const langRule =
      '【回复要求】一律用简体中文 + 中国大陆用语回复；强调 / 书名统一用【】；代码、命令、JSON 字段、ID 等保留原文。' +
      '不要自己在回复里添加任何 “🌱 LP : …” 之类的积分 / 余额状态行，系统会自动在末尾追加。';
    const body = input.context
      ? `以下是最近的对话上下文（旧→新）：\n${input.context}\n\n用户最新消息：\n${input.message}`
      : input.message;

    // Identity context: tell the agent whom it is replying to so it can call profile / badge tools with
    // the correct open_id instead of guessing one. The LP balance is deliberately NOT injected here — the
    // framework appends the 🌱 LP status footer to the reply itself, and feeding the number in only tempted
    // the model to echo a (wrong) footer of its own. If asked, it can read the balance via the profile tool.
    let identity = '';
    if (input.userOpenId) {
      const p = getProfile(input.userOpenId);
      const name = input.userName || p?.name || '';
      identity =
        `【当前对话者】${name ? `姓名：${name}；` : ''}open_id：${input.userOpenId}。` +
        '查询或操作该用户的档案 / LP / 徽章时，请使用上面的 open_id。\n\n';
    }

    // Inject long-term memories from the DB. Memories are filtered through the policy layer so
    // only namespaces the current caller is allowed to read are included in the prompt. Each
    // namespace bucket is capped to avoid exhausting the context window (group ≤ 500 chars,
    // user ≤ 300 chars). This injection is skipped when there is no caller context (chatId +
    // userOpenId) — without both identifiers, the policy layer cannot compute allowed namespaces.
    let memBlock = '';
    if (input.chatId && input.userOpenId) {
      try {
        const ctx = {
          chatId: input.chatId,
          userOpenId: input.userOpenId,
          isAdmin: isAdmin(input.userOpenId),
        };
        const namespaces = allowedNamespaces(ctx);
        const memories = getFilteredMemories(ctx, {
          namespaces,
          groupCharLimit: 500,
          userCharLimit: 300,
        });
        if (memories.length > 0) {
          memBlock = `【背景记忆】\n${memories.map((m) => m.content).join('\n')}\n\n`;
        }
      } catch {
        // Memory retrieval is best-effort; never block a reply on it.
      }
    }

    const prompt = `${identity}${memBlock}${body}\n\n${langRule}`;
    return {
      prompt,
      workDir,
      heal: {
        prompt,
        workDir,
        useSession: Boolean(input.session), // resume the per-(chat,user) session for short-term memory
        chatId: input.chatId,
        source: input.source,
      },
    };
  }

  /**
   * Generate a rolling LLM summary of a user's recent messages in a chat and write it to the
   * memory store. Uses a throwaway non-session workDir to avoid polluting the conversation
   * session. The write scope (namespace and visibility) is determined by resolveWriteScope,
   * which stores personal memory under the cross-group user: namespace.
   *
   * Best-effort: any failure is logged at warn level and swallowed. Never call this with
   * await from the reply path — always fire-and-forget.
   */
  async summarizeUserMemory(chatId: string, userOpenId: string): Promise<void> {
    try {
      const rows = getRecentUserMessagesInChat(chatId, userOpenId, 30);
      if (rows.length === 0) return;

      const corpus = rows.map((r, i) => `${i + 1}. ${r.text}`).join('\n');
      const prompt =
        '以下是某位用户最近在群组中发送的消息（编号排列，最新的在前）：\n' +
        corpus +
        '\n\n请从中萃取这位用户稳定的、长期的事实或偏好（跳过一次性闲聊），' +
        '用简体中文精简条列，不超过 280 字。只输出条列内容，不需要解释或额外说明。';

      // Use a per-call throwaway workDir so this never resumes or contaminates any chat session.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-summary-${this.name}-`));
      const cfgDir = path.join(tmpDir, '.kimi-code');
      fs.mkdirSync(cfgDir, { recursive: true });

      // Write a minimal AGENTS.md so kimi-code accepts the workDir.
      const soul = assembleSoul(this.name);
      fs.writeFileSync(path.join(cfgDir, 'AGENTS.md'), soul.systemPrompt, 'utf8');

      let summary: string;
      try {
        summary = await runKimiAsync({
          prompt,
          workDir: tmpDir,
          continueSession: false, // always a fresh, disposable session
          timeoutMs: this.opts.kimiProfile?.timeoutMs,
        });
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }

      if (!summary.trim()) return;

      const { namespace, visibility } = resolveWriteScope(chatId, userOpenId);
      upsertMemory({
        namespace,
        key: 'auto-summary',
        content: summary.trim(),
        visibility,
        source: 'auto',
      });
    } catch (e) {
      log.warn(`用户记忆摘要生成失败（chatId=${chatId} user=${userOpenId}）：${(e as Error).message}`);
    }
  }

  /** Append the interaction to the journal (best-effort; never affects the reply). */
  private writeJournal(message: string, reply: string): void {
    if (this.opts.journal === false) return;
    try {
      appendJournal(this.name, `使用者：${message.slice(0, 80)}`);
      appendJournal(this.name, `我：${reply.slice(0, 80)}`);
    } catch {
      /* journal logging failure must not affect the reply */
    }
  }

  /** Have the agent respond to a single message (synchronous; blocks the event loop). */
  respond(input: RespondInput): string {
    const { heal } = this.prepare(input);
    const reply = this.runWithHeal(heal);
    this.writeJournal(input.message, reply);
    return reply;
  }

  /**
   * Async twin of {@link respond}: generates the reply without blocking the event loop, so a
   * channel can keep receiving and reacting to new messages while this one is being answered.
   */
  async respondAsync(input: RespondInput): Promise<string> {
    const { heal } = this.prepare(input);
    const reply = await this.runWithHealAsync(heal);
    this.writeJournal(input.message, reply);
    return reply;
  }

  /**
   * Run kimi with inline self-healing. On a recoverable failure we classify it, log richly,
   * record it in the error ledger, repair the session when corrupt, and retry within the
   * configured budget. Whatever happens, we never leave a poisoned session behind for the next
   * message: after exhausting retries we validate + quarantine the chat's session.
   *
   * The thrown error stays generic at the channel layer (users get a short, friendly notice);
   * all the detail lives in the logs / postmortem files / ledger.
   */
  private runWithHeal(args: HealArgs): string {
    const { timeoutMs, extraArgs, skillsDirs, maxRetries, corrId } = this.healSetup();
    let continueSession = args.useSession;
    let lastErr: KimiError | null = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        return runKimi({ prompt: args.prompt, workDir: args.workDir, continueSession, timeoutMs, extraArgs, skillsDirs });
      } catch (e) {
        const r = this.processAttemptError(e, args, corrId, attempt, maxRetries, continueSession);
        lastErr = r.err;
        if (!r.willRetry) break;
        continueSession = r.continueSession;
        if (r.backoffMs) sleepSync(r.backoffMs);
      }
    }
    this.finalHeal(args.workDir);
    throw lastErr ?? new Error('kimi-code 执行失败：未知错误');
  }

  /** Async twin of {@link runWithHeal}; identical policy, non-blocking. */
  private async runWithHealAsync(args: HealArgs): Promise<string> {
    const { timeoutMs, extraArgs, skillsDirs, maxRetries, corrId } = this.healSetup();
    let continueSession = args.useSession;
    let lastErr: KimiError | null = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        return await runKimiAsync({ prompt: args.prompt, workDir: args.workDir, continueSession, timeoutMs, extraArgs, skillsDirs });
      } catch (e) {
        const r = this.processAttemptError(e, args, corrId, attempt, maxRetries, continueSession);
        lastErr = r.err;
        if (!r.willRetry) break;
        continueSession = r.continueSession;
        if (r.backoffMs) await new Promise((res) => setTimeout(res, r.backoffMs));
      }
    }
    this.finalHeal(args.workDir);
    throw lastErr ?? new Error('kimi-code 执行失败：未知错误');
  }

  /** Resolve per-call self-heal settings + a fresh correlation id. */
  private healSetup(): { timeoutMs?: number; extraArgs?: string[]; skillsDirs?: string[]; maxRetries: number; corrId: string } {
    const kp = this.opts.kimiProfile;
    return {
      timeoutMs: kp?.timeoutMs,
      extraArgs: kp?.extraArgs,
      skillsDirs: this.resolveSkillsDirs(),
      maxRetries: Math.max(0, kp?.maxRetries ?? 1),
      corrId: newCorrId(),
    };
  }

  /** Skill roots for this soul: the shared layer followed by the soul-specific layer. Absent dirs are skipped. */
  private resolveSkillsDirs(): string[] {
    return skillsDirsForSoul(this.name);
  }

  /**
   * Classify + log + ledger + repair one failed attempt, and decide whether/how to retry.
   * Shared by the sync and async heal loops.
   */
  private processAttemptError(
    e: unknown,
    args: HealArgs,
    corrId: string,
    attempt: number,
    maxRetries: number,
    continueSession: boolean
  ): { err: KimiError; willRetry: boolean; continueSession: boolean; backoffMs: number } {
    const err =
      e instanceof KimiError
        ? e
        : new KimiError('unknown', (e as Error)?.message ?? String(e), {
            exitCode: null,
            signal: null,
            killed: false,
            sysCode: null,
            durationMs: 0,
            workDir: args.workDir,
          });
    err.corrId = corrId;

    const willRetry = attempt <= maxRetries && err.retryable;
    const healed = this.healSession(err, args.workDir);
    this.recordFailure(err, { chatId: args.chatId, source: args.source, attempt, healed, willRetry });

    let nextContinue = continueSession;
    let backoffMs = 0;
    if (willRetry) {
      // Corrupt (just quarantined) or missing session → next attempt must start fresh, not --continue.
      if (err.kind === 'corrupt-session' || err.kind === 'session-missing') nextContinue = false;
      // Network blips: brief linear backoff before the retry.
      if (err.kind === 'transient') backoffMs = 600 * attempt;
    }
    return { err, willRetry, continueSession: nextContinue, backoffMs };
  }

  /** Ensure the next inbound message never inherits a poisoned session (any failure kind). */
  private finalHeal(workDir: string): void {
    try {
      healSessionFor(workDir);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Repair the chat's kimi session when the failure implies it may be corrupt. Returns true if a
   * session was quarantined. corrupt-session is always reset; a timeout (which can leave a
   * half-written turn) is validated first and only reset if actually broken.
   */
  private healSession(err: KimiError, workDir: string): boolean {
    try {
      if (err.kind === 'corrupt-session') {
        // Quarantine every corrupt session bound to this chat — including an unindexed one left by an
        // interrupted turn, which resolveSessionDir (index-only) would miss.
        return quarantineCorruptSessionsFor(workDir) > 0;
      }
      if (err.kind === 'timeout') {
        const sdir = resolveSessionDir(workDir);
        if (!sdir) return false;
        if (validateSession(sdir).ok) return false;
        return quarantineSession(sdir);
      }
    } catch {
      /* repair is best-effort; fall through */
    }
    return false;
  }

  /** Log a classified one-liner + write a full postmortem file + append to the error ledger. */
  private recordFailure(
    err: KimiError,
    ctx: { chatId?: string; source?: string; attempt: number; healed: boolean; willRetry: boolean }
  ): void {
    const corrId = err.corrId ?? '------';
    const pm = writePostmortem(corrId, err.postmortem());
    const tail = ctx.willRetry ? `重试中（第 ${ctx.attempt} 次后）` : '已放弃，回退通用回复';
    log.error(
      `[${corrId}] ${this.name} 回复失败 · ${err.message}` +
        (ctx.healed ? ' · 已重置损坏会话' : '') +
        (pm ? ` · 详见 ${pm}` : '') +
        ` · ${tail}`
    );
    recordError({
      corrId,
      soul: this.name,
      chatId: ctx.chatId ?? null,
      source: ctx.source ?? null,
      kind: err.kind,
      summary: err.message,
      exitCode: err.exitCode,
      signal: err.signal,
      durationMs: err.durationMs,
      attempt: ctx.attempt,
      healed: ctx.healed,
      postmortem: pm,
    });
  }
}
