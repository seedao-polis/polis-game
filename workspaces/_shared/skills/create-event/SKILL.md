---
name: create-event
description: 事件系统专家。设计与实现【经营管理游戏】事件（底图 + 文案 + 游戏信息发到群或私聊），含动态选人、定时随机触发、配图与验收。当需要新建一个事件、改触发逻辑/排程、准备事件配图，或手动触发/验收已有事件时使用。
---

<essential_principles>
## 事件系统怎么运作

一个事件 = **底图** + 可选**文字叠加**（百分比定位）+ **markdown 文案**（标题 + 正文）+ 可选**游戏信息**占位符（`{{name}}`/`{{pt}}`/`{{level}}`/`{{badges}}`）。触发时：渲染图 → 上传 → 记一条 dispatch → 发送 → 回写状态与 message_id。一次发送 = **一条 post 消息**（一个 message_id）。

事件定义写在代码里（`src/core/events.ts`，类型安全），底图素材放 `workspaces/<soul>/assets/events/<id>/`。

### 1. 一次事件 = 一个目标

每次触发**只发一个目标**：一个群（`scope: 'global'`，发到 `targetChatId`）**或**一个人的私聊 P2P（`scope: 'personal'`）。不做一对多 / fan-out。目标优先级：`opts.target` > `prepare()` 返回的 `target` > scope 默认值。

### 2. 来源 ≠ 目标

**来源** = 这事件从哪些群 / 数据库状态【看出来】该发生（选对象的素材依据）。**目标** = 发给谁。被挑中的对象**不一定**在目标会话里，这是正常的（见原则 3）。来源逻辑写在 `prepare()` 里，目标用 `scope` + `targetChatId` 或 `prepare` 返回的 `target` 决定。

### 3. @ 不在目标会话的人会自动降级

飞书不允许 `at` 一个不在当前会话的成员（报 230002），但纯文本提及允许。框架发送前会把【不在目标会话】的 `@` 自动降级成【@名字】纯文本，照常发出。所以个人针对类事件（潜水被发现、恭喜升级）发到群里也没问题。

### 4. 静态模板 vs 动态 `prepare()`

文案 / @ / 目标 / 奖励若需在触发时才算出来（条件句、动态选人、按 DB 阈值），写在 `prepare(opts)` 钩子里：返回 `null` = 本次干净跳过（不记失败）；返回的字段覆盖静态配置；可带 `afterSend(res)` 在**发送成功后**才做副作用（发 LP 等）。纯静态事件（固定文案、固定目标）不需要 `prepare`。

### 5. 默认安全：先预览再真发

实现完先用 `agent event <id> --dry-run` 预览（不发送、不发奖励、不写库），确认选人与文案无误，再用 `--test`（只发给操作者本人 P2P）验收，最后才真发。改事件定义 / 文案 / prepare / 排程数值后热重载即可生效；改调度器本身要完整重启 serve。

### 6. 项目约定

日志一律简体中文、不带 emoji、用大陆术语（如【判定】而非【roll】）；代码注释用英文；用户可见的文案可保留 emoji。底图原图全分辨率留底，发送时自动等比缩放到 128px 高（小图缩略图风格），不用手动维护两份。
</essential_principles>

<intake>
你想做什么？

1. 新建一个事件（收集规格 → 在代码注册 → 配图 → 验收）
2. 手动触发 / 验收已有事件（dry-run、test、撤回）
3. 了解事件系统（字段 / 排程 / 配图 / 命令）

**先确认意图再动手。** 用户若已在指令里把需求说清楚，直接按下面路由进对应 workflow，按 `templates/event-spec.md` 把还缺的字段补齐后继续，不要逐条反问。
</intake>

<routing>
| 用户意图 | Workflow |
|----------|----------|
| 1、【新建】【做一个事件】【加个事件】 | 依次 `workflows/gather-spec.md` → `workflows/build-event.md` → `workflows/fire-event.md` |
| 2、【触发】【发一下】【验收】【dry-run】【撤回】 | `workflows/fire-event.md` |
| 3、【事件怎么写】【有哪些字段 / 排程】【了解一下】 | 读 `references/` 下对应文件后回答 |

**读完 workflow 后严格照它执行。**
</routing>

<reference_index>
领域知识都在 `references/`：

- **event-model.md** — 核心模型：来源≠目标、scope/target 优先级、`prepare`/`afterSend`、`FireEventOptions`、选人与排除规则、@ 降级。
- **config-fields.md** — `registerEvent({...})` 的 `EventTypeConfig` 字段、文字叠加 `overlays`、占位符清单、`mentions`、`imageHeight`。
- **schedule.md** — 5 种定时排程 + 概率 + 时段、逻辑日、调度器与重启规则。
- **image-and-post.md** — 配图（底图 / 128px / 叠字百分比定位）、飞书 post 消息结构、@ element、常见坑。
- **commands.md** — `agent events` / `agent event` / `agent unsend` 命令速查与参数。
</reference_index>

<workflows_index>
| Workflow | 用途 |
|----------|------|
| gather-spec.md | 把模糊需求收敛成一份完整事件规格（用 templates/event-spec.md） |
| build-event.md | 在 `src/core/events.ts` 用 `registerEvent` 实现 + 准备底图 + 挂排程 |
| fire-event.md | dry-run 预览 → test 验收 → 手动 / 真发 → 需要时撤回 |
</workflows_index>

<templates_index>
- **templates/event-spec.md** — 填空式事件规格表，收集需求时逐项填好。
</templates_index>

<success_criteria>
一次成功的事件工作：
- 分清了来源与目标，目标是单一的（一个群或一个 P2P）。
- 静态部分写进 `EventTypeConfig`，动态部分写进 `prepare()`，奖励等副作用放 `afterSend`。
- 底图就位、占位符可解析、文案与 @ 正确（不在目标会话的 @ 会自动降级）。
- 先 `--dry-run` 预览、再 `--test` 验收，确认无误后才真发；改调度器记得完整重启 serve。
- 没有越权真发、没有提前发奖励。
</success_criteria>
