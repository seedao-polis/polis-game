# 多人多群组记忆管理 + 群组三级分类 playbook（2026-06-22）

让土地神对【每个人、每个群】都有独立记忆，并做硬性记忆管制：A 的记忆绝不泄漏给 B；不同群按保密层级限制回应。研究：`thoughts/shared/research/2026-06-22-tudigong-多人多情境記憶管理系統研究.md`；施工总结：`thoughts/shared/coding/2026-06-22-tudigong-多人多情境記憶管理系統-階段一實作.md`、`-階段二實作.md`、`2026-06-22-tudigong-群组三级分类改造.md`。

**改这块前先读本篇。** 自建方案（没引 LangGraph/Mem0/Zep）：现有 SQLite + TypeScript Policy Filter + per-(群,人) 会话键，零新依赖、完全可控。

## 1. 数据模型 `memory_items`（migration v18）

- 四层命名空间 namespace（决定【归谁/归哪】，做跨人隔离）：
  - `global`（公开知识）、`group:{chat_id}`（本群共享）、`user:{open_id}`（个人、**跨群通用**）、`group_user:{chat_id}:{open_id}`（本群本人）。
- 列：`namespace`（必填无默认）、`key`（可选语义键，配 upsert）、`content`、`visibility`（`private`/`group`/`public`/`admin_only`）、`sensitivity`（`normal`/`sensitive`/`confidential`，仅影响日志、不闸 LLM）、`source`（`manual`/`auto`）、`created_at`/`updated_at`/`expires_at`。两个索引（namespace、visibility）。
- store 在 `src/core/store/memory.ts`（barrel `store.ts` 导出）：`insertMemory`/`upsertMemory`（按 namespace+key）/`getFilteredMemories`/`getMemoryByKey`/`getMemoryById`/`listMemories`/`deleteMemory`/`deleteNamespace`/`purgeExpiredMemories`/`listKnownChatIds`/`getRecentMessagesForChat`/`getRecentUserMessagesInChat`。**写入必带 namespace，无默认，防误写全局。**

## 2. Policy Filter = 记忆管制核心（`src/core/memory-policy.ts`）

**绝不让 LLM 自己决定能不能看；代码层先过滤，LLM 只拿到过滤后结果。**

- `allowedNamespaces(ctx)`：依 caller 的 `{chatId,userOpenId}` 算出**恰好 4 个**白名单（global / group:本群 / user:本人 / group_user:本群本人）。**永远不含别人的 namespace** → 这就是 A 读不到 B 的根因。
- `filterByPolicy(items, ctx)`：二道防御——① namespace 不在白名单一律剔除（defence-in-depth）；② `admin_only` 仅 `ctx.isAdmin===true` 放行；③ `private` 仅本人（namespace 已保证）。
- `getFilteredMemories` 先在 SQL 层 `WHERE namespace IN (白名单)` + 排除过期，再过 `filterByPolicy`，再按每域字数预算裁剪（group≤500、user≤300 字）。
- `resolveWriteScope(chatId, userOpenId)`：自动摘要写入点的唯一决策处。**现在一律回 `user:{open_id}`/`private`**（个人记忆跨群通用）。

## 3. 群组三级分类（`configs/chat-policies.json` v2）—— 取代旧的内部/外部群

**未来几乎都是飞书外部群，所以群策略不看飞书内/外部，改用营运者手动标的三级**（分级以 操作者 说的为准）：

- `public`（公开群）→ 不可透露会员群、工作群的事；`member`（会员群）→ 不可透露工作群的事；`work`（工作群）→ 可讲全部。**单向向下保密。**
- 配置：每群 `{name, tier, systemPromptAppend?}`；顶层 `defaultTier`（设 `public`，**未标的群一律 public，最保守**）+ `tierPolicies`（三段可覆写的政策文字，内建默认在 `configs.ts` 的 `BUILTIN_TIER_POLICY`）。
- `configs.ts`：`getChatTier(chatId)`=群 tier ?? defaultTier ?? public；`getTierPolicyText(tier)`=覆写 ?? 内建。
- `assembleSoul(name,{chatId})`：先 push tier policy 文字、再 push 该群 `systemPromptAppend`（选填，疊在 tier policy 之后）。
- **关键观念**：tier **只驱动 prompt policy**（告诉机器人此群保密层级、不准讲上级群的事），**不对个人记忆做硬闸控**。个人记忆 `user:` 在任何群都注入（见 §6 已知限制）。这是 操作者 明确的决定。

## 4. 会话隔离（per-群×人）

- `sessionKey = ${agentId}-${chatId}-${senderOpenId}[-${threadId}]`（`feishu-bot.ts`）。同群每人各自一份执行器会话目录与 wire.jsonl，机器人分得清谁是谁。
- 破坏式变更落地：旧 per-群会话直接弃用，不迁移。执行器自愈/隔离机制不受影响（它认 workDir，不认 sessionKey 字串格式）。

## 5. 记忆注入（`agent.ts` 的 `prepare()`）

- 在 identity 上下文之后、user message 之前，注入过滤后的 `【背景记忆】` 块；ctx 带 `isAdmin: isAdmin(userOpenId)`；group≤500/user≤300 字。
- 无 caller 上下文（缺 chatId 或 userOpenId，如 CLI `ask`）则跳过注入。best-effort，取记忆失败绝不挡回复。

## 6. 自动摘要（`Agent.summarizeUserMemory`）

- 撈该 (群,人) 最近 30 条消息 → `runKimiAsync` 萃取【稳定的长期事实/偏好】（≤280 字、简体条列）→ `upsertMemory` 写 `user:`/private、固定 key `auto-summary`（**滚动一份、不增长**）。
- 触发：`feishu-bot` 闭包内 `replyCounts: Map<sessionKey,number>`，每 **8** 次成功回复 `void agent.summarizeUserMemory(...)`。
- **防阻塞三层**：① `void` 调用从不 await（不卡串行 pump）；② **抛弃式 non-session workDir**（`os.tmpdir()`、`continueSession:false`、finally 删目录），绝不污染对话会话；③ 全程 try/catch、`log.warn` 吞掉。

## 7. 群组热词聚合（`src/core/group-intel.ts`，确定性、不用 LLM）

- `tokenize`（中英混合：英数串小写≥2字 + CJK 逐字 unigram + 相邻 bigram）→ `topTokens`（频率、去停用词、top-8）→ `aggregateGroupTopics(chatId)` 组 `近期话题热词：…`，`upsertMemory` 写 `group:{chat}` key `topics` visibility `group`。经 §5 既有路径自动进群组 prompt。

## 8. TTL 清理 + 每日维护排程

- `purgeExpiredMemories()`：删 `expires_at` 已过期行。
- `supervisor.ts` 的 `scheduleDailyMemoryMaintenance()`：每日 **04:50**（ops report 04:55 之前）自我重排——先 purge，再对所有已知群（messages 表 + chat-policies）逐个 aggregate。在 `runSupervisor` 启动区挂载；**改码要重启 serve 才生效。**

## 9. 管理员（`configs/admins.json` + `isAdmin`）

- `{version, admins:[open_id,...]}`，种子 操作者 `ou_example_operator` + 管理员 `ou_example_admin`，可手工编辑。`configs.ts` 的 `loadAdmins`/`isAdmin`（载入快取）。
- `admin_only` 记忆仅 `isAdmin` 放行；判定在服务端 TS 层完成，**LLM 不能自提权**。

## 10. CLI：`pnpm agent memory ...`（`src/bin/agent.ts`）

```
list [--namespace <ns>] [--user <openId>] [--chat <chatId>] [--limit N]   # 运维视角，不过 policy
inspect <id> | add ... | set ... | rm <id> | clear --namespace <ns>
preview --chat <c> --user <u> [--admin]   # ★ 站在某人视角跑 Policy Filter，打印实际会注入 prompt 的【背景记忆】块 + 群层级；验证隔离最有用
summarize --chat <c> --user <u> [--soul <s>]   # 手动触发自动摘要，不必凑满 8 次
aggregate [--chat <c>]                          # 手动跑群组热词，不必等每日排程
purge                                           # 手动跑 TTL 清理
```

- **本地快速测试环**：`export AGENT_DB_PATH=/tmp/x.db` → `memory add user:ou_A …` / `user:ou_B …` → `memory preview --chat oc_X --user ou_A` 对 `--user ou_B` → 眼见 B 看不到 A。

## 11. 当前群组分级现况（2026-06-22，分级以 操作者 说的为准）

- **work**：市政厅工作群 `oc_example_work_group`（活跃）、运营小天地 `oc_example_ops_group`（活跃）、AgentTasks `oc_example_agent_tasks`、AgentNotify `oc_example_agent_notify`；两个废弃/解散同名副本（市政厅 `oc_example_work_group_old`、运营 `oc_example_ops_group_old`）也标 work 保持一致。
- **member**：求助广场 `oc_example_member_group`。
- **public**：围观群 `oc_example_public_group`（显式）+ 其余所有未标群（城邦快报 `oc_example_broadcast_group`、城邦游戏中 `oc_example_games_group` 等走 defaultTier）。

## 12. 关键坑 / 约束 / 已知限制

- **跨人隔离是硬保证**（代码层 namespace 白名单），有测试守：`memory-policy.test.ts`（基础隔离）+ `memory-governance.test.ts`（个人记忆恒跨群、resolveWriteScope、tier policy 注入、admin 门控、purge、aggregate）。改 policy 先跑 `npm test`。
- **个人记忆跨群 = 软性分层**：tier 只约束【回应】（prompt policy），不在记忆层硬过滤个人记忆。
- **已知限制（操作者 已选【纯靠 prompt 约束】）**：自动摘要可能把**工作群对话**浓缩成个人记忆，之后在公开群也会被注入 prompt——目前靠 tier prompt policy 软性约束，**未做个人记忆按来源层级硬闸控**。要硬化再说（给 memory_items 加 tier 列 + 读取按当前群 tier 过滤）。
- **配置在 serve 启动载入并快取**：改 `chat-policies.json`/`admins.json` 要重建 + 重启 serve。
- **typecheck 用 `npx tsc --noEmit`**（本机 hook 会改坏 `npm run typecheck`）。
