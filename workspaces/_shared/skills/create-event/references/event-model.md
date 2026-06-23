# 事件核心模型

事件定义在 `src/core/events.ts`，用 `registerEvent(cfg: EventTypeConfig)` 注册。触发入口是 `fireEvent(eventTypeId, opts: FireEventOptions)`：`prepare` → 渲染图 → 上传 → 记 dispatch（pending）→ @ 降级 → 发送 → 回写状态/`message_id` → `afterSend`，全程 try/catch。

<one-target>
## 一次事件 = 一个目标

每次触发只发**一个**目标，不做一对多。目标按优先级解析：

1. `opts.target`（CLI `--to` / `--test` 设的，最高）
2. `prepare()` 返回的 `target`
3. `scope` 默认值：`global` → `cfg.targetChatId`；`personal` → 对象本人 P2P（`actorOpenId`）

`target` 形如 `{ chatId: 'oc_...' }`（群）或 `{ userId: 'ou_...' }`（P2P）。二选一。
</one-target>

<source-vs-target>
## 来源 ≠ 目标

- **来源**：事件从哪里【看出来】该发生 —— 哪些群的成员/消息、哪些 DB 状态阈值。是选对象的素材依据。
- **目标**：发给谁。

两者可以重合（如某事件来源群和目标群是同一个），但概念分开。来源逻辑写在 `prepare()`，目标用 `scope`+`targetChatId` 或 `prepare` 返回 `target` 决定。被挑中的对象**不一定**在目标会话里 —— 这是允许的，见 @ 降级。
</source-vs-target>

<prepare>
## prepare(opts) —— 动态解析钩子

可同步或 async。在渲染/发送前跑，用来算出一次触发的动态部分：挑对象、定 @、改写文案、决定奖励。返回值：

- `null` —— 本次不发（干净跳过，`skipped=true`，不记为失败）。例：没有符合条件的对象。
- `PreparedEvent` —— 每个字段覆盖/补充静态配置：
  | 字段 | 作用 |
  |------|------|
  | `vars` | 额外占位符（最后合并，覆盖内建 date/actor 变量）；也填**标题**里的占位符 |
  | `mentions` | 动态 @，叠加在 `cfg.mentions` 上（正文用 `{{@key}}` 引用） |
  | `description` | 覆盖正文模板（需在触发时才能算出的条件句） |
  | `target` | 覆盖单一目标（`opts.target` 仍优先） |
  | `afterSend(res)` | **仅发送成功后**跑一次，用于副作用（发 LP、记账等） |

纯静态事件（固定文案、固定目标、无条件句）不需要 `prepare`。
</prepare>

<at-downgrade>
## @ 自动降级

飞书 `at` 一个不在当前会话的成员会被拒（错误码 230002）；纯文本提及则允许。`fireEvent` 发送前会算出目标会话的成员名单（群 → 花名册；P2P → {接收人, bot}），把不在名单里的 `at` 自动换成【@名字】纯文本。

所以【个人针对类】事件（潜水被发现、恭喜某人）即便发到群里、对象不在群里，也能照常发出。`--dry-run` 会标注哪些 @ 被降级。

⚠️ 降级解决不了【**bot 自己不在目标群**】：要 post 到群，发送身份 bot 必须先在该群里，否则同样报 230002。P2P 无此问题（bot 天然在）。
</at-downgrade>

<member-selection>
## 选人与排除

动态选人用 `store.silentMemberReport(cutoffMs, { sourceChatIds, excludeOpenIds })`：

- 候选池 = `sourceChatIds` 这些**来源群**的成员（来自成员名册 `chat_members`，含从没发言的人）；省略 `sourceChatIds` 才是全部名册。整个名册只是数据底座，不是默认候选池。
- 返回 `{ members, silent, chats, cutoffMs }`：`silent` = 最后发言时间早于 `cutoff`（**含从未发言** = 终极潜水）。
- **默认只排除 bot 自己**（`excludeOpenIds: [SELF_BOT_OPEN_ID]`）。操作者和任何人都可被选中。针对 bot 的事件未来再单独 opt-in。

⚠️ `messages.create_time` 是**毫秒**，cutoff 也要用毫秒（`Date.now() - 天数*86400*1000`）。早期写成秒会导致【永远无人符合】。
</member-selection>

<fire-options>
## FireEventOptions（fireEvent 的入参）

| 字段 | 含义 |
|------|------|
| `triggerReason` | 触发原因，记在 dispatch（如 `manual` / `daily_cron` / `level_up`） |
| `actorOpenId` | 个人事件对象 open_id；也驱动 `{{name}}/{{pt}}/{{level}}/{{badges}}` |
| `recipients` | 批量收件人（多人公告，每个变成一个 @） |
| `target` | 覆盖目标（优先级最高） |
| `profile` | 飞书身份（identity / tenant） |
| `vars` | 额外占位符 |
| `dryRun` | 只跑 prepare + 渲染，**不**上传/发送/记 dispatch/发奖励 |
| `force` | 手动触发：跳过排程定时与概率，且 `prepare` 应放宽选人门槛 |

`FireEventResult`：`{ dispatchId, ok, messageId?, error?, skipped? }`。`skipped=true` = prepare 主动跳过（不是错误）。
</fire-options>

<force-behavior>
## force（手动触发）的语义

手动 `agent event` 一律 `force: true`：**不受排程定时与概率限制**（定时只在调度器路径查，概率只在排程掷骰时掷）。`prepare` 收到 `opts.force` 时应放宽门槛 —— 例如【无人潜水】时改选最久未发言者来演示；非 force（排程）则 `return null`。

`prepare` 建议一律 `log.info` 来源群与选人范围（共几人 / 几人符合 / cutoff），方便排查【为何不发】。
</force-behavior>

<interaction-triggers>
## 互动触发（即时事件）

除了定时排程，事件也可由【互动】即时触发：在机器人**生成回复前**先跑一遍触发规则（best-effort，触发失败不挡回答）。规则放 `events.ts` 的 `TRIGGERS` 数组，每条实现 `shouldFire(ctx)` 与 `fire(ctx)`。

`TriggerContext` 含 `senderOpenId` / `chatId` / `isFirstInteraction` / `larkProfile`。例：`first_interaction_welcome` 用【这个人还没被成功迎新过】（`hasSuccessfulDispatch('welcome-party', openId)`）作闸门，第一次 @ 机器人就发一次迎新。

⚠️ 别用【全局是否首次互动】当新人判断 —— 频道扫描也会建档抢先。闸门用【**还没被迎新过**】更稳、还能容错重试。
</interaction-triggers>
