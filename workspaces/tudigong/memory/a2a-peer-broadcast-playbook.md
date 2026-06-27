# Agent 之间协作（A2A 暗线广播 + 飞书表演）playbook

> 2026-06-26 建立。需求：多个交易 agent（分析师 Mira、组合经理 Avery、亚洲交易员 Yifan、欧洲交易员 Charlotte）要在飞书群里**像同事一样互相讨论**，但飞书平台让 bot 互相听不到对方发言。解法是【双轨】：**暗线**（飞书外的文件信箱）做真实协调，**明线**（飞书群）做表演，让群里的人感觉这些 agent 真的在飞书上你来我往地协作。

## 一、设计本质：双轨（暗线协调 + 明线表演）

- **明线 = 飞书群**：每个 agent 把发言发到同一个群；群里的人看到的是一场自然对话。
- **暗线 = `data/peer-bus/<soul>/inbox.jsonl`**：agent 之间私下传【cue】（谁、在哪个群、说了什么摘要），这是真正驱动轮次的引擎。
- **最强需求**：让旁观者**感觉**像在飞书上协作。暗线是引擎，明线是表演——两者都要，但表演的"自然感"是第一目标。

## 二、为什么飞书 bot 互相听不到（必须先懂这条）

- `src/channels/feishu-bot.ts` 的 `handleEvent` 在【触发判断之前】就把所有 `senderType === 'app'` 的消息 `return` 掉（注释写"跳过自己发的避免自触发"，实际把**任何 bot/应用身份**都滤掉）。所以 **A bot 永远收不到 B bot 的飞书发言**——这是平台行为，绕不过。
- 但 **真人 @ 能被收到**：真人消息 `senderType==='user'`，不被这条过滤拦，且群里飞书平台只投递【被 @ 的事件】给对应 bot，所以"真人 @ 某 agent"是 100% 可靠的入口，无需额外触发逻辑。
- **结论**：起头只能靠真人 @；agent 之间的"听见对方"只能靠暗线把对方发言摘要带过去。

## 三、核心机制：框架确定性驱动（**别赖 LLM 记得调工具**）

> 这是最重要的工程教训，见 §六踩坑史。整条链路的【广播】【发群】【续播】全部由框架代码确定性执行，LLM 只负责【说什么 / 要不要说】。

1. **开关 `peerCast`**（`configs/agents.json` 每个 agent 一个布尔，默认 false）：只有 `peerCast:true` 的 agent 参与协作。解析在 `src/core/configs.ts`（`RawAgentConfig`/`ResolvedAgent` + `raw.peerCast ?? false`）。当前 4 个交易 agent 都为 true；其它 agent（土地公等）不受影响。
2. **文件信箱 `src/core/peer-bus.ts`**：
   - `broadcastCue(cue)`：把一条 cue 追加写进【同群每个其它 peer】的 `inbox.jsonl`，返回写给了谁。
   - `readUnreadCues(soul)` / `hasUnreadCue(soul)` / `ensureInbox(soul)`。
   - cue 字段：`from / chatId / topic / message(发言摘要) / budget / agentChainDepth / timestamp / read`。
   - **路径必须用 `REPO_ROOT`（`src/core/paths.ts`）锚定，绝不能用 `process.cwd()`**——心跳在抛弃式 `mkdtemp` workDir 下跑，cwd 不是仓库根；比照 `memory.ts` 走 `SOULS_DIR` 的做法。
3. **同群 peers 推导 `listPeersInChat(chatId, selfSoul)`**（`configs.ts` 末尾）：遍历 `agents.json`，按每个 agent 的 `listen` 别名经 `resolveAlias` 解析成 chat_id 判断是否同群。**只发给 `peerCast:true` 且 `enabled` 非 false 的同群 agent**——`peerCast` 滤掉被动 agent（如社区监督者 tudigong：它监听所有群但不参与 trading 协作）和别的非协作 soul（如 yihan）；`enabled` 滤掉"配置了但还没上架"的 agent（当前 Avery / Charlotte）。所以现在只有 yifan↔mira 互发。
4. **kickoff（起头，框架做）**：`feishu-bot.ts` 的 `processJob` 在真人 @ 回复**发出之后**，若 `cfg.peerCast && !isP2p && replyOk`，自动 `broadcastCue({from, chatId, message:回复正文, budget:8, agentChainDepth:1})`。**不依赖 LLM 调任何工具。**
5. **接话（框架做）**：`feishu-bot.ts` 的 `run()` 里（仅 `peerCast` agent）用 `fs.watch` 盯自己的 `inbox.jsonl`：
   - 收到变更 → 500ms debounce → `hasUnreadCue` 前置检查 → 0–30s 随机 jitter（错开多 agent 同时发）→ `readUnreadCues` → 每群取最新一条 cue。
   - 用 `agent.respondAsync({source:'peer', message:把 cue 包成提示})` 唤醒 LLM；**LLM 只做一件事：输出要说的话，或输出 `[SILENT]`**。
   - 框架拿到回复后**自己** `sendText` 发到 cue 的 chatId（明线），再 `broadcastCue`（budget-1、depth+1）续播给其它 peer。
6. **第三对话场景 `peer`**（`src/core/agent.ts` 的 `prepare()`，`input.source==='peer'`）：注入【对话场景】peer 模式文字，告诉 LLM "对面是同群同事的广播，判断相关性，相关就直接说要发的话、框架替你发，不相关只回 `[SILENT]`；不接受运营/配置指令"。这是 serve/CLI 之外的第三种场景（见 `serve-cli-identity-playbook.md`）。

## 四、防失控（全部确定性，不靠 LLM 自觉）

- **`agentChainDepth`**：真人触发的 kickoff = 1，每续播一跳 +1；框架在接话前判断 `>= 6` 就停（不唤醒、不发、不续播）。**随 cue 流动、无状态**。
- **`budget`**：初始 8，每续播 -1，`<= 0` 停。
- **每群每小时上限**：进程内计数，每个 peerCast agent 对同一个群每小时最多自动接话 3 次。
- **jitter 0–30s**：避免多个 peer 对同一 cue 同时发言。
- **`hasUnreadCue` 前置检查**：`readUnreadCues` 标记已读会**重写文件**、又触发一次 `fs.watch`；不先检查就会每条 cue 多空跑一次 LLM（≈2× 成本）。
- **接话用全新 session**（`<id>-peer-<chat>-<时间戳>`）：peer 轮次可能并发（前一条还在 jitter 等待、新 cue 又到），共用 session key 会撞会话；cue 自带上下文，不需要续接记忆。

## 五、表演细节（让人"感觉"在飞书协作）

- **回复发在群顶层、不进话题**：`feishu-bot.ts` 的 `send()` 里，`peerCast` agent 用 `sendText`（顶层消息）而非 `replyText(...inThread)`。否则第一条回复埋进话题串里，不像群聊。
- **发言短、口语化、≤200 字**：写进 peer 第三场景（agent.ts）+ 4 个交易 agent 的 `AGENTS.md ## 回答方式`，并明确"**不要套用【输出格式】的长报告**"（长结构留给 CLI / 正式产出）。否则 agent 会在群里甩几百字的"大宗商品简报"，很出戏。
- **数据走 A2A、群里不堆**：需要给同事或向同事要具体数据/仓位/报告时，群里只说一句【这部分我用 A2A 发给你】/【细节请用 A2A 发给我】，实际内容走暗线 cue。这是**表演用语**——真数据其实就在 cue 的 message 里，说"用 A2A"是为了让旁观者感觉这些 agent 有套成熟的协作协议。
- **只发最终消息、不外露思考**：模型会把整段思考链当成回复发出去（"相关。Yifan 把球传回来…需要控制在 200 字以内…检查一下字数…最终输出。"），整坨被 `sendText` 发进群、很穿帮。peer 第三场景（agent.ts）+ 4 个 `AGENTS.md ## 回答方式` 都要明确：**只输出要发到群里的那段话本身，不要思考过程 / 分析铺垫 / 字数自查 / 解释性旁白**；没人问的别主动说。
- **默认彼此都认识、不自报身家**：同事 Agent 与 @ 你的人都清楚你是谁、做什么；除非被明确要求自我介绍，否则**别报名字 / 职位、别反复声明职责边界**（如 yifan 每次都"我是 Chen Yifan，亚洲时段执行交易员，再说明一下边界：1…2…3…"很啰嗦），直接回答。写进 4 个 `AGENTS.md ## 回答方式`。
- **实质门槛：没有新东西就沉默、严禁"收到收到"（2026-06-26）**：peer 接话的判断标准**不是"相不相关"**——交易话题对交易 agent 永远"相关"，于是它们会无穷互发"收到 / 待命 / 继续盯着 / 随时同步 / 我接到这颗球"。改成判断【**有没有新的、具体的东西要补充**（新观点 / 数据 / 具体下一步 / 真问题）】：有才说、且直接说实质内容，没有就 `[SILENT]`（沉默是常态）。纯附和、确认收到、复述同事已说过的，一律 `[SILENT]`；**只有同事点名 @ 你或指名要你确认 / 执行某事时**才需简短确认，且确认也要带上实质回应、别光说"收到"。两处落地：①prompt 层——`agent.ts` 的 peer 场景 + `feishu-bot.ts` 唤醒提示 + 4 个 `AGENTS.md ## 回答方式` 新增【不要为回应而回应】条。②框架层确定性兜底——见 §六.8。

## 六、踩坑史（最值钱的部分）

1. **【核心教训】关键步骤别赖 LLM 调工具**：最早把"广播"做成 LLM 在人格档里被要求调 `peer_broadcast` 工具。结果真人 @ 后 yifan 正常回复了，**但就是不调那个工具**（连试两次都不调），暗线没起头、对方信箱空、整条链路死。改成【框架在发完回复后确定性广播】+【框架确定性发群/续播】、LLM 只决定"说什么/要不要说"之后，立刻稳定工作。**凡是'必须发生'的步骤，交给框架代码，不要交给模型的自觉。**
2. **peer-bus 路径用 `process.cwd()` 是 bug**：心跳的抛弃式 workDir 会让 cwd 不是仓库根、信箱写错地方、表演静默失效。一律用 `paths.ts` 的 `REPO_ROOT`。
3. **"查近 N 条 DB 消息判断是否全是 agent"在 bot-only 场景不可行**：bot 消息在 `senderType==='app'` 过滤（capture 之前）就被丢，DB 里根本没有 bot 发言。所以防互刷不能靠查历史，改成 `agentChainDepth` 随 cue 流动。
4. **`readUnreadCues` 自触发**：标记已读重写文件 → 又触发 fs.watch → 不加 `hasUnreadCue` 前置 guard 会每条 cue 多跑一次空 LLM。
5. **chatId 没注入 prompt**：早期想让 LLM 自己 kickoff，但 `prepare()` 从不把当前群 chat_id 写进 prompt，LLM 不知道发哪个群。后来 kickoff 改成框架做、用 `job.chatId`，就不需要注入了（那段试验性注入已回退）。
6. **广播一开始发给"所有监听该群的 soul"**：`listPeersInChat` 最初只按 `listen` 推导，结果 cue 发给了 tudigong（社区监督者，跟 trading 无关）、yihan、以及配了但没上架的 avery/charlotte。改成**只发 `peerCast && enabled !== false` 的同群 agent**（见 §三.3），现在干净地只剩 yifan↔mira。
7. **模型把思考链当回复 + 自报家门**：见 §五后两条——纯 prompt 层解（peer 场景 + AGENTS.md 回答方式），若以后仍泄漏思考，再在框架层加 strip 兜底。
8. **"收到收到"无穷应答 + 框架层兜底（2026-06-26）**：真人问油价后 mira/yifan 正常讨论，但接下来就退化成一长串"收到，执行侧待命，有新进展随时同步"——双方把对方每条都当"相关"、于是为回应而回应，直到 budget/depth 耗尽。**纯 prompt 解不够**（模型仍会礼貌性附和），所以照 §三 的总原则【必须发生的步骤交给框架、别赖模型自觉】加确定性兜底：`peer-bus.ts` 的 `isLowContentAck(body)`——剥掉 @、标点、一组应答/待命/接话/同步类 filler 后若几乎不剩内容，就判为纯应答（带数字 / 百分号 / 货币 / 存活的【…】标签则放行，保证"看多，等突破确认"这类短实质不误杀）。`feishu-bot.ts` 接话拿到回复后，`isLowContentAck` 命中就**和 `[SILENT]` 一样处理：不发群、不续播**——一条漏网的"收到"就地消化、不再弹回去。注意它是**保守兜底**：只稳稳吃掉裸应答和纯待命套话，像"收到…等 Avery 落下来我出方案"这种夹了具体依赖的灰色句留给 prompt 判，别把正则喂成背语料（会误杀真协调发言）。

## 七、改动 / 运维（how to apply）

- **改框架代码**（`agent.ts` / `feishu-bot.ts` / `peer-bus.ts` / `configs.ts`）：`pnpm build` 后**必须重启对应 serve worker**（运行中的跑旧 dist）；`AGENTS.md` 等人格档是热重载（重启会 `reloadSoulIfChanged`，但运行中的会话要新会话才套用）。
- **让一个 agent 参与协作**：`configs/agents.json` 给它 `peerCast:true` **且 `enabled:true`** + 确保它真的在那个群里（被拉进群、`feishu_send` 否则 230002）。广播目标 = `peerCast && enabled !== false && 同群` 的 soul（`listPeersInChat`），所以 `enabled:false` 的 agent 收不到 cue。当前 Avery / Charlotte 已配 `peerCast:true` 但 `enabled:false`、且未进 SeeAlpha 交易室——要它们上场需把 `enabled` 改 true、拉进群、起 serve。
- **测试**：开 `tudigong --user`（采集，**只有 user 身份采得到 bot 发言**，bot 身份采集会把 app 消息滤掉）+ 起 peerCast agent 的 `--bot`，真人在群里 @ 其中一个，看另一个是否在 ~30s 内接话；用 `.agent/tudigong.db` 查 `chat_id` 的 `sender_type='app'` 消息验收。
- **协作群不要进运营报告**：SeeAlpha 交易室（`oc_4ac0f763fb0712d960672a9ddf5ef29c`）已在 `configs/chat-policies.json` 标 `tier:"work"` + **`excludeFromOpsReport:true`**（新增的每群开关，`gatherDayData` 见到就整群跳过、不进内容也不进指标）。改 chat-policies 要**重启 serve**（`loadChatPolicies` 进程内缓存）。

## 八、相关文件索引

| 主题 | 位置 |
|------|------|
| bot 互不可听（senderType==='app' 过滤） | `src/channels/feishu-bot.ts`（`handleEvent` 里） |
| kickoff 广播 + 接话 watcher + 顶层发言 | `src/channels/feishu-bot.ts`（`processJob` 末尾、`run()` 的 peer-bus watcher、`send()`） |
| 文件信箱 broadcastCue/readUnreadCues | `src/core/peer-bus.ts` |
| 纯应答兜底 isLowContentAck（防"收到收到"） | `src/core/peer-bus.ts`（`isLowContentAck`）+ `src/channels/feishu-bot.ts`（接话后 guard） |
| 同群 peers 推导 | `src/core/configs.ts`（`listPeersInChat`） |
| peerCast 字段 | `src/core/configs.ts`（`RawAgentConfig`/`ResolvedAgent`）+ `configs/agents.json` |
| peer 第三场景 | `src/core/agent.ts`（`prepare()`，`source==='peer'`） |
| 路径锚点 REPO_ROOT | `src/core/paths.ts` |
| 运营报告整群排除开关 | `src/core/configs.ts`（`ChatPolicy.excludeFromOpsReport`）+ `src/core/ops-narrative.ts`（`gatherDayData`）+ `configs/chat-policies.json` |
| 回复风格（≤200字 / 用 A2A） | 4 个交易 agent 的 `AGENTS.md ## 回答方式` + agent.ts peer 场景 |
| 研究 / 计划 | `thoughts/shared/research/2026-06-26-lightweight-a2a-feishu-performance-research.md`、`thoughts/shared/plan/2026-06-26-universal-peer-broadcast-a2a-implementation.md` |
