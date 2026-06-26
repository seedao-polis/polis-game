import type { Agent } from '../core/agent.js';
import type { Channel } from './channel.js';
import type { ResolvedAgent } from '../core/configs.js';
import {
  sendText,
  replyText,
  addReaction,
  removeReaction,
  consumeEvents,
  getUserName,
  type EventConsumer,
} from '../core/lark.js';
import { log, preview } from '../core/log.js';
import { flushTelegramSync } from '../core/telegram.js';
import { dispatchCommand } from '../core/commands.js';
import * as store from '../core/store.js';
import { append as appendTranscript } from '../core/transcript.js';
import { checkAndFireTriggers } from '../core/events.js';
import { loadLpStrategy, judgeReply } from '../core/lp-strategy.js';
import fs from 'node:fs';
import {
  ensureInbox,
  hasUnreadCue,
  readUnreadCues,
  broadcastCue,
  MAX_AGENT_CHAIN_DEPTH,
  DEFAULT_CHAIN_BUDGET,
} from '../core/peer-bus.js';

// After a restart, only respond to messages sent after the startup time; allow some slack for clock skew to avoid replying to historical messages on restart.
const STARTUP_GRACE_MS = 5000;

// LP cost per LLM reply in this channel.
const LLM_PT_COST = 0.1;

/** A queued LLM reply awaiting its turn in the serial worker. */
interface BotJob {
  messageId?: string;
  chatId: string;
  text: string;
  senderOpenId: string;
  /** Thread (topic) id this message belongs to, if any; scopes both the session and the context. */
  threadId?: string;
  /** Captured conversation backstory (oldest→newest), fed to the agent so a topic reply has context. */
  context?: string;
  /** kimi session key (thread-scoped in topic chats), drives --continue short-term memory. */
  sessionKey: string;
  /** Which reaction is currently shown on the message ('coffee' = queued, 'thinking' = answering). */
  reaction: 'coffee' | 'thinking' | null;
  reactionId: string | null;
  /** Row id in pending_replies (for restart recovery); 0 if not persisted. */
  pendingId: number;
  /** True only on the sender's very first interaction (drives first-time event triggers). */
  isFirstInteraction: boolean;
  /** True when the message came from a 1:1 p2p chat (direct reply); false in groups (in-thread reply). */
  isP2p: boolean;
}

// A reply interrupted by restart is re-run at most this many times before we give up and ask the
// user to resend (guards against a message that crashes the worker every time).
const MAX_RECOVERY_ATTEMPTS = 2;

// ── Feishu bot identity channel ──────────────────────────────
// Uses a lark-cli long connection to consume im.message.receive_v1 (no public webhook needed), with --profile.
// In group chats the bot platform layer only delivers messages where it was @-mentioned, so the trigger is always mention.
// Events are first filtered to the internal-chat whitelist; self-identification uses sender_type==='app'; event_id deduplication; 3-second reconnect.
// On receiving a message → hand off to the agent → reply as the "bot identity" (the configured bot persona).

export class FeishuBotChannel implements Channel {
  readonly name = 'feishu-bot';
  private cfg: ResolvedAgent;

  constructor(cfg: ResolvedAgent) {
    this.cfg = cfg;
  }

  run(agent: Agent): Promise<void> {
    const cfg = this.cfg;
    const profile = cfg.larkProfile;
    const internalChatIds = new Set(cfg.chats.map((c) => c.chatId));

    const seen = new Set<string>(); // deduplicate by event_id
    const startedAtMs = Date.now(); // startup time: only respond to messages sent after it
    const channelName = this.name;
    // 静默模式（serve --quiet → AGENT_QUIET）：照常采集消息、记录互动、触发同步等，但绝不回复任何
    // 飞书 p2p/群/@，也不调用 LLM（不耗 kimi、不扣 LP、不加表情）。CLI 频道是独立进程，不受影响。
    const quiet = process.env.AGENT_QUIET === '1';

    // Session key uniquely identifies a kimi working directory per (agent, chat, user), with an
    // optional thread suffix for topic chats. This ensures every user in a group maintains a
    // separate short-term memory context rather than sharing one session across all participants.
    const sessionKeyFor = (cid: string, senderOpenId: string, tid?: string): string =>
      tid
        ? `${cfg.id}-${cid}-${senderOpenId}-${tid}`
        : `${cfg.id}-${cid}-${senderOpenId}`;

    // Render captured history into a compact "name：text" transcript (oldest→newest) for the prompt.
    // sender_name in the DB is often empty, so fall back to the directory. Keep the newest messages
    // within a char budget so a long thread never blows up the prompt.
    const MAX_CONTEXT_CHARS = 2000;
    const renderContext = (rows: store.MessageRow[]): string => {
      const lines: string[] = [];
      let total = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const m = rows[i];
        const text = (m.text || '').trim();
        if (!text) continue;
        const name = m.senderName?.trim() || store.memberName(m.senderOpenId) || '某成员';
        const line = `${name}：${text}`;
        if (total + line.length > MAX_CONTEXT_CHARS && lines.length) break;
        total += line.length;
        lines.unshift(line); // keep chronological order while iterating newest→oldest
      }
      return lines.join('\n');
    };

    // ── serial reply worker ─────────────────────────────────────
    // Replies are generated one at a time (a kimi turn can run minutes). Receiving stays async, so a
    // message arriving while another is being answered is acknowledged immediately: it gets the
    // "queued" (coffee) reaction now, and switches to the "thinking" reaction when it's its turn.
    // A message that arrives while the bot is idle goes straight to "thinking" (the original UX).
    const queue: BotJob[] = [];
    let processing = false;

    // Per-(chat,user) reply counters for triggering the rolling memory summarizer.
    // Counter keys match sessionKey. Counters reset on restart, which is acceptable —
    // the summarizer runs every 8 replies per session, not every 8 replies globally.
    const replyCounts = new Map<string, number>();
    const SUMMARY_INTERVAL = 8;

    const setReaction = (job: BotJob, to: 'coffee' | 'thinking'): void => {
      if (!job.messageId || job.reaction === to) return;
      const emoji = to === 'coffee' ? cfg.queuedReactionEmoji : cfg.reactionEmoji;
      try {
        if (job.reactionId) {
          removeReaction(job.messageId, job.reactionId, { as: 'bot', profile });
          job.reactionId = null;
        }
        job.reactionId = addReaction(job.messageId, emoji, { as: 'bot', profile });
        job.reaction = to;
        // Persist the live reaction id so a restart can clear this orphaned reaction.
        if (job.pendingId) store.updatePendingReply(job.pendingId, { reactionId: job.reactionId });
      } catch {
        /* reactions are best-effort; never block a reply on them */
      }
    };

    const clearReaction = (job: BotJob): void => {
      try {
        if (job.messageId && job.reactionId) {
          removeReaction(job.messageId, job.reactionId, { as: 'bot', profile });
        }
      } catch {
        /* best-effort */
      }
      job.reactionId = null;
      job.reaction = null;
    };

    const send = (messageId: string | undefined, chatId: string, reply: string, isP2p: boolean): void => {
      if (!reply) return;
      if (quiet) { log.info(`quiet 模式：不发送回复（${preview(reply)}）`); return; }
      try {
        // p2p (1:1 DM): reply as a plain direct message — no thread, no quote.
        // group: reply within the original message's thread to stay in the topic; fall back to a plain
        // send when there is no message_id.
        // Bot identity already shows the agent's display name in Feishu, so a reply needs no name prefix
        // (replyPrefix is for the user channel, where messages appear under the operator's own account).
        if (isP2p) sendText({ chatId }, reply, { as: 'bot', profile });
        // peerCast agents post group replies at the top level (not inside the @-message thread) so the
        // cross-agent exchange reads as a normal group chat rather than a buried topic thread.
        else if (cfg.peerCast) sendText({ chatId }, reply, { as: 'bot', profile });
        else if (messageId) replyText(messageId, reply, { as: 'bot', profile, inThread: true });
        else sendText({ chatId }, reply, { as: 'bot', profile });
        const { body, footer } = store.splitStatusFooter(reply);
        log.info(`已回复：${preview(body)}`);
        if (footer) log.info(`尾部状态：${footer}`);
      } catch (e) {
        log.error('发送失败：', (e as Error).message);
      }
    };

    const processJob = async (job: BotJob): Promise<void> => {
      // Check interaction triggers BEFORE answering (e.g. first interaction → welcome event DM).
      // Best-effort: a trigger failure never blocks the reply.
      if (job.senderOpenId) {
        try {
          await checkAndFireTriggers({
            senderOpenId: job.senderOpenId,
            chatId: job.chatId,
            isFirstInteraction: job.isFirstInteraction,
            larkProfile: profile,
            soul: cfg.soul,
          });
        } catch (e) {
          log.error('事件触发检查失败：', (e as Error).message);
        }
      }

      let reply = '';
      let replyOk = false; // genuine LLM reply (not an LP-insufficient / error fallback)
      if (job.senderOpenId) {
        // LP gating: deduct before calling the LLM; refund on error; show balance in footer on success.
        const strategy = loadLpStrategy(cfg.soul);
        const cost = strategy.cost;
        const spent = store.spendPt(job.senderOpenId, cost, 'llm_reply', job.messageId ?? undefined);
        if (!spent) {
          reply = '你的 LP 不足，明天 05:00 会自动补到 10，或完成任务赚取。';
        } else {
          // Record the charge so a restart mid-reply can refund it before re-running.
          if (job.pendingId) store.updatePendingReply(job.pendingId, { ptSpent: true });
          try {
            // Turn number for this reply (1-based, per session); injected into the prompt so the
            // persona can pace turn-based behaviors (e.g. periodic interview-progress updates).
            const turnNumber = (replyCounts.get(job.sessionKey) ?? 0) + 1;
            reply = await agent.respondAsync({
              message: job.text,
              context: job.context,
              session: job.sessionKey,
              userOpenId: job.senderOpenId,
              chatId: job.chatId,
              source: channelName,
              turnNumber,
            });
            // Classify the reply, grant bonus LP if applicable, then build the footer with the net delta.
            const { category, reply: judged } = judgeReply(reply, strategy);
            if (category.grant > 0) {
              store.grantPt(job.senderOpenId, category.grant, category.reason, job.messageId ?? undefined);
            }
            const netDelta = category.grant - cost;
            reply = store.stripStatusFooter(judged) + store.buildStatusFooter(job.senderOpenId, netDelta, category.footerLabel || undefined);
            replyOk = true;

            // Fire-and-forget rolling user memory summary every SUMMARY_INTERVAL successful replies.
            // Never awaited — must not block the serial pump or delay the Feishu reply.
            replyCounts.set(job.sessionKey, turnNumber);
            if (turnNumber % SUMMARY_INTERVAL === 0) {
              void agent.summarizeUserMemory(job.chatId, job.senderOpenId);
            }
          } catch (e) {
            // Detail (classification, postmortem, ledger) is already logged inside respondAsync(); here
            // we only refund LP and hand the user a short, internal-detail-free notice.
            log.error('agent 回复失败（已回退通用回复）：', (e as Error).message);
            store.grantPt(job.senderOpenId, cost, 'refund_on_error', job.messageId ?? undefined);
            reply = '（抱歉，我这边出错了，请稍后再试。）';
          }
        }
      } else {
        try {
          reply = await agent.respondAsync({ message: job.text, context: job.context, session: job.sessionKey, chatId: job.chatId, source: channelName });
          replyOk = true;
        } catch (e) {
          log.error('agent 回复失败（已回退通用回复）：', (e as Error).message);
          reply = '（抱歉，我这边出错了，请稍后再试。）';
        }
      }
      send(job.messageId, job.chatId, reply, job.isP2p);
      // Peer kickoff: after a genuine group reply, broadcast a cue so same-chat colleague agents can
      // opt into the conversation. Deterministic (not LLM-driven) so collaboration reliably appears.
      if (replyOk && cfg.peerCast && !job.isP2p) {
        const body = store.splitStatusFooter(reply).body.trim();
        if (body) {
          const peers = broadcastCue({
            from: cfg.soul,
            chatId: job.chatId,
            topic: job.text.slice(0, 60),
            message: body.slice(0, 200),
            budget: DEFAULT_CHAIN_BUDGET,
            agentChainDepth: 1, // human-initiated chain starts at depth 1
          });
          if (peers.length) log.info(`peer kickoff 广播给：${peers.join('、')}`);
        }
      }
    };

    const pump = async (): Promise<void> => {
      if (processing) return;
      const job = queue.shift();
      if (!job) return;
      processing = true;
      try {
        setReaction(job, 'thinking'); // it's this job's turn now → switch queued(coffee) → thinking
        await processJob(job);
      } catch (e) {
        log.error('处理消息失败：', (e as Error).message);
      } finally {
        clearReaction(job);
        // Reply completed (success or handled error) → drop the recovery row.
        if (job.pendingId) store.removePendingReply(job.pendingId);
        processing = false;
        if (queue.length > 0) void pump();
      }
    };

    const handleEvent = (ev: Record<string, any>): void => {
      if (ev.type && ev.type !== 'im.message.receive_v1') return;
      if (ev.message_type && ev.message_type !== 'text') {
        log.info(`· 略过非文字消息（${ev.message_type}）`);
        return;
      }
      const eventId: string | undefined = ev.event_id;
      if (eventId) {
        if (seen.has(eventId)) return;
        seen.add(eventId);
      }
      const chatId: string = ev.chat_id;
      const messageId: string | undefined = ev.message_id ?? ev.id;
      const text: string = (ev.content || '').toString().trim();
      if (!chatId || !text) return;

      // Thread (topic) id: scopes both the session and the context window. The flat event-consume
      // envelope confirmed sender_id; thread_id field name is verified defensively here (debug log
      // surfaces the real shape on the first topic message).
      const threadId: string = ev.thread_id ?? ev.message?.thread_id ?? ev.thread?.thread_id ?? '';
      log.debug(`事件字段：thread_id=${ev.thread_id ?? '∅'} chat_type=${ev.chat_type ?? '∅'}`);
      // p2p (1:1 DM) vs group: a p2p reply goes out as a plain direct message; a group reply stays in the thread.
      const isP2p: boolean = ev.chat_type === 'p2p';

      // Chat whitelist: when listenAll is set, do not filter chats (reply to any @-mention); otherwise only serve chats in the whitelist.
      if (!cfg.listenAll && internalChatIds.size > 0 && !internalChatIds.has(chatId)) {
        log.info(`· 略过白名单外的群消息（${chatId}）`);
        return;
      }

      // Self-identification: skip messages from the app identity (sent by ourselves) to avoid self-triggering.
      const senderType = ev.sender_type ?? ev.sender?.sender_type;
      if (senderType === 'app') {
        return;
      }

      // Only respond to messages sent after startup: skip old messages from before startup (including backlog accumulated while offline and reconnect re-deliveries) to avoid replying to history on restart.
      const createMs = Number(ev.create_time);
      if (Number.isFinite(createMs) && createMs < startedAtMs - STARTUP_GRACE_MS) {
        log.info(`· 略过启动前的旧消息（${preview(text)}）`);
        return;
      }

      log.info(`收到 [${ev.chat_type ?? 'group'}] ${preview(text)}`);

      // Extract the sender open_id from the event envelope (field names vary by SDK version).
      const senderOpenId: string =
        ev.sender_id ??
        ev.sender_open_id ??
        ev.sender?.id ??
        ev.sender?.sender_id?.open_id ??
        ev.open_id ??
        '';

      // Write the message to the transcript database for knowledge-base and context purposes.
      if (cfg.capture && senderOpenId && messageId) {
        try {
          appendTranscript(chatId, {
            message_id: messageId,
            create_time: String(ev.create_time),
            sender_open_id: senderOpenId,
            sender_name: '',
            msg_type: ev.message_type ?? 'text',
            text,
            mentions: [],
            thread_id: threadId || undefined,
            raw: JSON.stringify(ev),
          });
        } catch { /* best-effort */ }
      }

      // Record the interaction best-effort; do not block reply on gamification errors.
      // isFirstInteraction (isNew) drives first-time event triggers (e.g. the welcome event).
      let isFirstInteraction = false;
      if (senderOpenId) {
        try {
          isFirstInteraction = store.recordInteraction(senderOpenId, '', chatId, messageId ?? '').isNew;
        } catch { /* best-effort */ }
        // Backfill the display name from the contact API when the profile has none yet (so event
        // placeholders like {{name}} resolve before the reply is processed).
        try {
          const prof = store.getProfile(senderOpenId);
          if (prof && !prof.name) {
            const fetchedName = getUserName(senderOpenId, cfg.larkProfile);
            if (fetchedName) store.upsertProfileRaw(senderOpenId, fetchedName);
          }
        } catch { /* best-effort */ }
      }

      // Command mode first (pure code, no kimi call): reply instantly, no queue / reaction needed.
      const dr = dispatchCommand(text, {
        agentName: agent.name,
        identity: cfg.identity,
        source: channelName,
        chatId,
        senderOpenId,
      });
      if (dr.handled) {
        log.info(`命令：${dr.command}`);
        try {
          store.recordActivity('command', senderOpenId || null, chatId, messageId ?? null, { command: dr.command, args: dr.args ?? [] });
        } catch { /* best-effort */ }
        send(messageId, chatId, dr.reply ?? '', isP2p);
        return;
      }

      // 静默模式：消息已采集 + 互动已记录（见上方），到此为止——不进入 LLM 回复队列。
      if (quiet) {
        log.info(`quiet 模式：已采集，略过 LLM 回复（${preview(text)}）`);
        return;
      }

      // Build conversation context from captured history so a topic reply knows the backstory. The
      // bot only receives @-mentioned events (the original post often @-mentions someone else and
      // never reaches this stream), but the user-poll path captured the whole thread into the DB.
      // Thread-scoped when in a topic; otherwise a small recent-chat window. Best-effort: context is
      // an enhancement, never block a reply on it.
      let context = '';
      try {
        const rows = threadId
          ? store.getThreadContext(threadId, { limit: 15, excludeMessageId: messageId })
          : store.getRecentChatMessages(chatId, { limit: 8, excludeMessageId: messageId });
        context = renderContext(rows);
      } catch { /* best-effort */ }

      const sessionKey = sessionKeyFor(chatId, senderOpenId, threadId);

      // LLM path → enqueue for the serial worker. React immediately so the sender knows they were
      // seen: "coffee" if they must wait behind another reply, "thinking" if they're up next.
      const job: BotJob = { messageId, chatId, text, senderOpenId, threadId: threadId || undefined, context, sessionKey, reaction: null, reactionId: null, pendingId: 0, isFirstInteraction, isP2p };
      // Persist BEFORE reacting/answering, so a crash at any point is recoverable on restart.
      job.pendingId = store.addPendingReply({
        agentId: cfg.id,
        channel: channelName,
        chatId,
        messageId: messageId ?? null,
        sessionKey,
        senderOpenId: senderOpenId || null,
        text,
        reactionId: null,
        ptSpent: 0,
        attempts: 0,
      });
      const mustWait = processing || queue.length > 0;
      setReaction(job, mustWait ? 'coffee' : 'thinking');
      queue.push(job);
      void pump();
    };

    // ── restart recovery ────────────────────────────────────────
    // Any pending_replies row that survived means a reply was interrupted by a restart/crash. Clear
    // its orphaned reaction, refund the LP it was charged, then re-run it (bypassing the startup
    // grace, since we explicitly owe this answer). The corrupt session the kill may have left is
    // cleaned by the startup sweep + inline self-heal, so the re-run starts clean.
    const recover = (): void => {
      // 静默模式不重发被打断的回复（保留 pending 行，等下次非静默启动再恢复）。
      if (quiet) return;
      let pendings: ReturnType<typeof store.listPendingReplies> = [];
      try {
        pendings = store.listPendingReplies(cfg.id, channelName);
      } catch {
        return;
      }
      if (!pendings.length) return;
      log.info(`恢复 ${pendings.length} 条被重启打断的回复…`);
      for (const p of pendings) {
        // 1) clear the leftover reaction on the original message
        if (p.messageId && p.reactionId) {
          try {
            removeReaction(p.messageId, p.reactionId, { as: 'bot', profile });
          } catch { /* best-effort */ }
        }
        // 2) refund the LP charged before the interruption (the re-run will charge again)
        if (p.ptSpent && p.senderOpenId) {
          try {
            store.grantPt(p.senderOpenId, LLM_PT_COST, 'refund_interrupted', p.messageId ?? undefined);
          } catch { /* best-effort */ }
        }
        // 3) give up after too many re-runs (a message that keeps killing the worker)
        if (p.attempts >= MAX_RECOVERY_ATTEMPTS) {
          log.warn(`放弃重试（已 ${p.attempts} 次）：${preview(p.text)}`);
          store.removePendingReply(p.id);
          if (p.messageId) {
            try {
              replyText(p.messageId, '（抱歉，刚刚的处理被打断了，请重新问我一次。）', { as: 'bot', profile, inThread: true });
            } catch { /* best-effort */ }
          }
          continue;
        }
        // 4) re-enqueue, reusing the same recovery row (attempts bumped, reaction reset)
        store.updatePendingReply(p.id, { attempts: p.attempts + 1, reactionId: null });
        const job: BotJob = {
          messageId: p.messageId ?? undefined,
          chatId: p.chatId,
          text: p.text,
          senderOpenId: p.senderOpenId ?? '',
          // Reuse the persisted (thread-scoped) session key so the re-run resumes the right topic
          // memory. Context isn't re-derived here — a rare restart-recovery path relies on --continue.
          sessionKey: p.sessionKey || `${cfg.id}-${p.chatId}`,
          reaction: null,
          reactionId: null,
          pendingId: p.id,
          isFirstInteraction: false, // recovered replies never re-fire first-time triggers
          isP2p: false, // chat_type isn't persisted; recovered replies keep the original in-thread send
        };
        const mustWait = processing || queue.length > 0;
        setReaction(job, mustWait ? 'coffee' : 'thinking');
        queue.push(job);
      }
      void pump();
    };

    log.info(
      `${agent.name} 已上线（飞书 bot 频道，profile=${profile}${quiet ? '，quiet 静默模式：只采集不回复' : ''}）。` +
        (cfg.listenAll ? '在任何群 @它 即可对话' : `在白名单 ${internalChatIds.size} 群里 @它 即可对话`) +
        '。Ctrl+C 结束。'
    );

    const consumer: EventConsumer = consumeEvents(profile, handleEvent);

    // Re-run any replies a previous restart interrupted (clear orphaned reactions, refund LP, retry).
    recover();

    // ── Peer-bus inbox watcher (cross-agent group collaboration) ──────────
    // When a same-chat colleague broadcasts a cue into this soul's inbox, fs.watch fires. After a
    // debounce + random jitter (so peers don't post in unison), the framework reads the cue, asks the
    // LLM only to decide "say something or stay silent", then deterministically posts the reply and
    // relays the chain onward. Posting/relay live in the framework (not the LLM) so the collaboration
    // reliably appears in the group. Only peerCast agents take part.
    let peerWatcher: fs.FSWatcher | null = null;
    if (cfg.peerCast) {
      const peerInboxFile = ensureInbox(cfg.soul);

      // Per-chat hourly cap on auto-replies: an anti-flood backstop independent of the LLM.
      const peerReplyCounts = new Map<string, { hour: number; count: number }>();
      const PEER_MAX_REPLIES_PER_HOUR = 3;
      const peerRateOk = (chatId: string): boolean => {
        const hour = Math.floor(Date.now() / 3_600_000);
        const e = peerReplyCounts.get(chatId);
        return !e || e.hour !== hour || e.count < PEER_MAX_REPLIES_PER_HOUR;
      };
      const bumpPeerRate = (chatId: string): void => {
        const hour = Math.floor(Date.now() / 3_600_000);
        const e = peerReplyCounts.get(chatId);
        if (!e || e.hour !== hour) peerReplyCounts.set(chatId, { hour, count: 1 });
        else e.count += 1;
      };

      let peerDebounce: ReturnType<typeof setTimeout> | null = null;
      peerWatcher = fs.watch(peerInboxFile, (event) => {
        if (event !== 'change') return;
        if (peerDebounce) return; // collapse the burst of events from a single append
        peerDebounce = setTimeout(async () => {
          peerDebounce = null;
          if (quiet) return; // muted: never post

          // Cheap guard: reading cues marks them read by rewriting the file, which itself fires a
          // 'change' event; skip when nothing is unread so the self-induced rewrite is a no-op.
          if (!hasUnreadCue(cfg.soul)) return;

          const cues = readUnreadCues(cfg.soul);
          // Collapse to the latest cue per chat — a burst in one chat needs only one reply.
          const latestByChat = new Map<string, (typeof cues)[number]>();
          for (const c of cues) latestByChat.set(c.chatId, c);

          for (const cue of latestByChat.values()) {
            // Anti-loop: a chain too deep (no human rejoined) or out of budget winds down.
            if (cue.agentChainDepth >= MAX_AGENT_CHAIN_DEPTH || cue.budget <= 0) continue;
            if (!peerRateOk(cue.chatId)) { log.info(`peer 接话已达本群每小时上限，跳过（${cue.chatId}）`); continue; }

            // Jitter (0–30 s) so peers reacting to the same cue don't post in the same instant.
            await new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 30_000)));

            let reply = '';
            try {
              reply = await agent.respondAsync({
                message:
                  `【同群同事广播】${cue.from} 刚在本群说：\n${cue.message}\n\n` +
                  `（话题：${cue.topic}）请判断这段讨论是否和你的角色相关：` +
                  `相关就直接输出你要在群里说的话；不相关就只输出 [SILENT]，不要输出其它内容。`,
                source: 'peer',
                // Fresh session per turn: peer turns may overlap (a new cue can arrive during the
                // jitter wait), and the cue already carries the context, so no shared session is needed.
                session: `${cfg.id}-peer-${cue.chatId}-${Date.now()}`,
              });
            } catch (e) {
              log.error(`peer 接话失败【${cfg.soul}】：${(e as Error).message}`);
              continue;
            }

            const body = store.stripStatusFooter(reply).trim();
            if (!body || body.includes('[SILENT]')) { log.info(`peer 评估后沉默（话题：${cue.topic}）`); continue; }

            try {
              sendText({ chatId: cue.chatId }, body, { as: 'bot', profile });
              log.info(`peer 接话已发送（${cue.chatId}）：${preview(body)}`);
            } catch (e) {
              log.error(`peer 发送失败：${(e as Error).message}`);
              continue;
            }
            bumpPeerRate(cue.chatId);

            // Relay the chain onward (deeper, less budget) so other peers may join in turn.
            const nextDepth = cue.agentChainDepth + 1;
            const nextBudget = cue.budget - 1;
            if (nextDepth < MAX_AGENT_CHAIN_DEPTH && nextBudget > 0) {
              const peers = broadcastCue({
                from: cfg.soul,
                chatId: cue.chatId,
                topic: cue.topic,
                message: body.slice(0, 200),
                budget: nextBudget,
                agentChainDepth: nextDepth,
              });
              if (peers.length) log.info(`peer 续播给：${peers.join('、')}（depth ${nextDepth}, budget ${nextBudget}）`);
            }
          }
        }, 500); // debounce window
      });
    }

    const stop = (): void => {
      peerWatcher?.close();
      consumer.stop();
      log.info('已退出。');
      flushTelegramSync(); // best-effort: drain buffered logs to Telegram before exiting
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop); // the supervisor sends SIGTERM on hot restart

    return new Promise(() => {
      /* stays resident until SIGINT */
    });
  }
}
