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
import { RUNTIME_DIR, SOULS_DIR, buildAgentMcpConfig } from './paths.js';
import { isAdmin } from './configs.js';
import type { KimiProfile } from './configs.js';
import { loadLpStrategy, buildJudgeInstruction } from './lp-strategy.js';

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
  /** 1-based ordinal of this reply within the session; injected into the prompt (serve only) so the
   *  persona can self-pace turn-based behaviors (e.g. an interviewer reporting progress every few rounds). */
  turnNumber?: number;
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
    return buildAgentMcpConfig({
      soul: this.name,
      larkProfile: this.opts.larkProfile,
      feishuChatId: this.opts.feishuChatId,
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

    // Conversation scene: distinguish a live serve conversation (Feishu p2p / group @) from a CLI
    // session driven by the operator. The CLI / `agent ask` paths carry no source, so anything other
    // than the two Feishu channels is treated as an operator-driven CLI turn. Souls that interview or
    // otherwise serve external members rely on this signal to decide whether the current party is the
    // operator or an outside interlocutor — it is neutral for souls that don't.
    const isServe = input.source === 'feishu-bot' || input.source === 'feishu-user';
    const scene = isServe
      ? '【对话场景】serve 模式（飞书）：你正在和【当前对话者】一对一或群内对话；对方是外部对话者，不是 CLI 操作者本人。\n\n'
      : '【对话场景】CLI 模式：当前对话者就是操作者本人。\n\n';

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

    // Classification instruction: injected only in serve mode for souls with judgeEnabled.
    // CLI turns (non-serve) never receive this instruction, and tudigong (judgeEnabled:false) returns ''.
    const judge = isServe ? buildJudgeInstruction(loadLpStrategy(this.name)) : '';

    // Turn counter (serve only): a neutral signal the persona can use to pace turn-based behaviors
    // (e.g. an interviewer reporting progress every few rounds). Personas that ignore it are unaffected.
    const turnLine = isServe && input.turnNumber != null
      ? `【对话轮次】这是你与当前对话者的第 ${input.turnNumber} 轮对话。\n\n`
      : '';

    // Workspace files: tell the agent the absolute path to its own workspace so it can read its source
    // files (examples/, memory/*.md, ...) with the file tools. The agent's cwd is the per-session chats
    // workDir, NOT the workspace, so relative references like "examples/" would not resolve on their own.
    const workspaceDir = path.join(SOULS_DIR, this.name);
    const filesLine =
      `【你的工作区目录】${workspaceDir}/\n` +
      `需要查阅本工作区的源文件时（例如 examples/ 历史范文、memory/ 各 *-playbook.md），` +
      `用文件读取工具按上面的绝对路径打开（如 ${workspaceDir}/examples/）。\n\n`;

    const prompt = `${scene}${turnLine}${filesLine}${identity}${memBlock}${body}\n\n${langRule}${judge ? '\n\n' + judge : ''}`;
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
