import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { remember, searchMemories } from '../core/memory.js';
import { sendText } from '../core/lark.js';
import * as store from '../core/store.js';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../core/paths.js';
import { listPeersInChat } from '../core/configs.js';

const PEER_BUS_DIR = path.join(REPO_ROOT, 'data', 'peer-bus');

// In-process rate limiter: prevent a single soul from flooding a chat.
const _chatBroadcastCounts = new Map<string, { hour: number; count: number }>();
// Max broadcasts per soul per chat within one hour.
const MAX_BROADCASTS_PER_HOUR_PER_CHAT = 3;

// ── Built-in framework tools (exposed via an MCP stdio server for kimi-cli to call) ─────
// Note: stdout is the JSON-RPC channel, so any logging must go through stderr.
// feishu_send reads LARK_PROFILE to send messages to the Feishu group of the correct enterprise/identity.

const SOUL = process.env.AGENT_SOUL || 'default';
const DEFAULT_CHAT = process.env.AGENT_FEISHU_CHAT || '';
const LARK_PROFILE = process.env.LARK_PROFILE || undefined;

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

const server = new McpServer({ name: 'agent-tools', version: '0.0.1' });

server.registerTool(
  'memory_remember',
  {
    title: '记住一件事',
    description: '把一件值得长期记住的重点（用户偏好、事实、决策）写进你的记忆。',
    inputSchema: { text: z.string().describe('要记住的内容，一句话') },
  },
  async ({ text }) => {
    remember(SOUL, text);
    return textResult(`已记住：${text}`);
  }
);

server.registerTool(
  'memory_search',
  {
    title: '搜索记忆',
    description: '用关键字搜索你过去记住的重点。回答前若不确定，先查记忆。',
    inputSchema: { query: z.string().describe('搜索关键字') },
  },
  async ({ query }) => {
    const hits = searchMemories(SOUL, query);
    return textResult(hits.length ? hits.join('\n') : '（没有相关记忆）');
  }
);

server.registerTool(
  'feishu_send',
  {
    title: '发送飞书消息',
    description: '主动发一条消息到飞书群。不给 chatId 则发到默认群。',
    inputSchema: {
      text: z.string().describe('消息内容'),
      chatId: z.string().optional().describe('目标群 chat_id（oc_xxx），省略则用默认群'),
    },
  },
  async ({ text, chatId }) => {
    const target = chatId || DEFAULT_CHAT;
    if (!target) return textResult('✗ 没有可用的 chatId（未设置默认群）');
    const res = sendText({ chatId: target }, text, { profile: LARK_PROFILE });
    return textResult(res.ok ? `已发送（message_id=${res.messageId}）` : '✗ 发送失败');
  }
);

server.registerTool(
  'profile_get',
  {
    title: '查询用户档案',
    description: '查询指定用户的 LP 余额与已获徽章列表。',
    inputSchema: { openId: z.string().describe('用户 open_id') },
  },
  async ({ openId }) => {
    const p = store.getProfile(openId);
    if (!p) return textResult(`用户 ${openId} 尚无档案。`);
    const badges = store.listBadges(openId);
    const badgeStr = badges.length
      ? badges.map((b) => `${b.emoji || ''}${b.name}`).join('、')
      : '（暂无）';
    return textResult(
      `用户：${p.name || openId}\nLP 余额：${p.ptBalance.toFixed(1)}\n徽章：${badgeStr}`
    );
  }
);

server.registerTool(
  'pt_grant',
  {
    title: '授予 LP',
    description: '向指定用户增加（或扣除）LP，并记录原因。',
    inputSchema: {
      openId: z.string().describe('用户 open_id'),
      amount: z.number().int().describe('增减数量（负数为扣分）'),
      reason: z.string().describe('积分变动原因'),
    },
  },
  async ({ openId, amount, reason }) => {
    const newBalance = store.grantPt(openId, amount, reason);
    return textResult(`已为 ${openId} ${amount >= 0 ? '增加' : '扣除'} ${Math.abs(amount)} LP，新余额：${newBalance.toFixed(1)}`);
  }
);

server.registerTool(
  'badge_award',
  {
    title: '授予徽章',
    description: '向指定用户授予某枚徽章（徽章需已通过 upsertBadge 创建）。',
    inputSchema: {
      openId: z.string().describe('用户 open_id'),
      badgeId: z.string().describe('徽章 ID'),
      ref: z.string().optional().describe('关联备注（可选，如消息 ID）'),
    },
  },
  async ({ openId, badgeId, ref }) => {
    const isNew = store.awardBadge(openId, badgeId, ref);
    return textResult(isNew ? `已向 ${openId} 新授予徽章 ${badgeId}` : `${openId} 已拥有徽章 ${badgeId}，未重复授予`);
  }
);

server.registerTool(
  'leaderboard',
  {
    title: '查看 LP 排行榜',
    description: '返回按 LP 降序排列的用户排行榜。',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('返回条数，默认 10'),
    },
  },
  async ({ limit }) => {
    const rows = store.leaderboard(limit ?? 10);
    if (rows.length === 0) return textResult('（排行榜暂无数据）');
    const lines = rows.map((r, i) => `${i + 1}. ${r.name || r.openId}  ${r.ptBalance.toFixed(1)} LP`);
    return textResult(['LP 排行榜', ...lines].join('\n'));
  }
);

server.registerTool(
  'message_search',
  {
    title: '搜索历史消息',
    description: '通过关键词全文搜索采集到的群消息，返回匹配消息的摘要列表。',
    inputSchema: {
      query: z.string().describe('搜索关键词'),
      limit: z.number().int().min(1).max(100).optional().describe('最多返回条数，默认 20'),
    },
  },
  async ({ query, limit }) => {
    const rows = store.searchMessages(query, limit ?? 20);
    if (rows.length === 0) return textResult('没有找到匹配的消息。');
    const lines = rows.map((r) => {
      const snippet = r.text.slice(0, 80) + (r.text.length > 80 ? '…' : '');
      return `[${r.chatId}] ${r.senderName || r.senderOpenId}: ${snippet}`;
    });
    return textResult(lines.join('\n'));
  }
);

server.registerTool(
  'peer_list',
  {
    title: '查询同群的其他 Agent',
    description: '列出正在监听同一个飞书群的所有其他 Agent soul 名称（用于广播前确认）。',
    inputSchema: {
      chatId: z.string().describe('飞书群 chat_id（oc_xxx）'),
    },
  },
  async ({ chatId }) => {
    const peers = listPeersInChat(chatId, SOUL);
    return textResult(peers.length
      ? `同群 Agent：${peers.join('、')}`
      : '（该群无其他 Agent）');
  }
);

server.registerTool(
  'peer_recv',
  {
    title: '读取暗线信箱',
    description:
      '读取本 Agent 信箱里未读的同事广播 cue。' +
      '读完后标记为已读。budget ≤ 0 或 agentChainDepth 过大时不应再广播。',
    inputSchema: {
      limit: z.number().int().optional().describe('最多读取条数，默认全部'),
    },
  },
  async ({ limit }) => {
    const inboxFile = path.join(PEER_BUS_DIR, SOUL, 'inbox.jsonl');
    if (!fs.existsSync(inboxFile)) return textResult('（信箱为空）');
    const lines = fs.readFileSync(inboxFile, 'utf8').split('\n').filter(Boolean);
    const unread = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && !e.read);
    const batch = limit != null ? unread.slice(0, limit) : unread;
    if (batch.length === 0) return textResult('（没有未读 cue）');
    // Mark all entries as read
    const updated = lines.map((l) => {
      try { const e = JSON.parse(l); e.read = true; return JSON.stringify(e); }
      catch { return l; }
    });
    fs.writeFileSync(inboxFile, updated.join('\n') + '\n', 'utf8');
    const summary = batch.map((e: Record<string, unknown>) =>
      `[来自 ${e.from}] 群：${e.chatId} | 话题：${e.topic} | 预算 ${e.budget} | 链深度 ${e.agentChainDepth ?? 1}\n${e.message}`
    ).join('\n---\n');
    return textResult(summary);
  }
);

server.registerTool(
  'peer_broadcast',
  {
    title: '广播暗线 cue 给同群所有同事 Agent',
    description:
      '把刚在飞书的发言摘要广播给同一群里所有其他 Agent 的信箱，' +
      '让他们可以选择 opt-in 接话。budget 递减到 0 后自动停止广播；' +
      'agentChainDepth 记录链深度（真人触发=1，peer 触发递增），达阈值时接收方自动降低接话概率。',
    inputSchema: {
      chatId: z.string().describe('我刚发言的飞书群 chat_id（oc_xxx）'),
      topic: z.string().optional().describe('本次讨论话题名（助接收方评估相关性）'),
      message: z.string().describe('我在飞书说了什么（摘要，≤150 字）'),
      budget: z.number().int().optional().describe('剩余对话预算（默认 8；接收方回复后应 -1 再广播）'),
      agentChainDepth: z.number().int().optional().describe('链深度（真人触发=1；peer 触发时传上游 depth+1；≥6 时接收方停止广播）'),
    },
  },
  async ({ chatId, topic, message, budget, agentChainDepth }) => {
    const effectiveBudget = budget ?? 8;
    const effectiveDepth = agentChainDepth ?? 1;

    // Budget-exhausted gate
    if (effectiveBudget <= 0) {
      return textResult('（budget 已耗尽，停止广播）');
    }

    // Per-chat hourly rate limit
    const hourKey = `${SOUL}-${chatId}-${Math.floor(Date.now() / 3_600_000)}`;
    const current = _chatBroadcastCounts.get(hourKey)?.count ?? 0;
    if (current >= MAX_BROADCASTS_PER_HOUR_PER_CHAT) {
      return textResult(`（已达本群每小时广播上限 ${MAX_BROADCASTS_PER_HOUR_PER_CHAT} 次，跳过）`);
    }
    _chatBroadcastCounts.set(hourKey, {
      hour: Math.floor(Date.now() / 3_600_000),
      count: current + 1,
    });

    const peers = listPeersInChat(chatId, SOUL);
    if (peers.length === 0) return textResult('（该群无其他 Agent，无需广播）');

    const entry = JSON.stringify({
      from: SOUL,
      chatId,
      topic: topic ?? '未指定',
      message,
      budget: effectiveBudget,
      agentChainDepth: effectiveDepth,
      timestamp: new Date().toISOString(),
      read: false,
    });

    let sent = 0;
    for (const peer of peers) {
      const dir = path.join(PEER_BUS_DIR, peer);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'inbox.jsonl'), entry + '\n', 'utf8');
      sent++;
    }
    return textResult(
      `已广播给 ${sent} 位同事：${peers.join('、')} | budget 剩余 ${effectiveBudget} | 链深度 ${effectiveDepth}`
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
