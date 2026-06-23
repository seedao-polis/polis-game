# Workflow: 实现事件

<required_reading>
**先读这些：**
1. references/config-fields.md（EventTypeConfig 字段、占位符、scope 例子、动态骨架）
2. references/event-model.md（prepare / afterSend / 选人 / @ 降级）
3. references/image-and-post.md（底图、overlays 百分比定位）
4. 若带定时：references/schedule.md
</required_reading>

<objective>
按已确认的规格，在代码里 `registerEvent` 出这个事件，准备好底图，需要时挂上排程。
</objective>

<process>
## 第 1 步：准备底图

把底图存到 `workspaces/<soul>/assets/events/<eventTypeId>/base.png`（全分辨率原图）。给的是链接就先下载。发送时框架自动缩到 128px，不用手动做小图。

## 第 2 步：写 registerEvent

在 `src/core/events.ts` 加 `registerEvent({...})`。参照 config-fields.md 的骨架：

- 填 `eventTypeId` / `title` / `scope` / `baseImage` / `overlays`（不叠字给 `[]`）。
- **静态事件**：`description` 直接写最终文案；固定 @ 放 `mentions`；global 填 `targetChatId`。
- **动态事件**：`description: ''`，把动态部分写进 `prepare(opts)`：
  - 选人用 `store.silentMemberReport(cutoffMs, { sourceChatIds, excludeOpenIds: [SELF_BOT_OPEN_ID] })`；时间窗口用**毫秒**。
  - 无符合对象且非 `opts.force` 时 `return null`；`opts.force`（手动）时放宽门槛挑一个演示。
  - 返回 `vars`（填标题占位符）、`mentions`（`{{@key}}`）、`description`（条件句）、`target`（需覆盖时）。
  - 奖励放 `afterSend(res)` —— **只在发送成功后**才发 LP / 记账，并把对应文案句子配套加进 `description`（条件不满足就两者都省）。
- `prepare` 里 `log.info` 来源群与选人范围（共几人 / 几人符合 / cutoff），方便排查。

## 第 3 步：挂排程（若需要定时）

按 schedule.md 给 `schedule` 字段（5 种 kind 之一 + `probability` + 可选时段 + `note`）。

## 第 4 步：build / 重载

- build 项目。
- 改的是**事件定义 / 文案 / prepare / 排程数值** → `agent update` 热重载即可被列出和手动触发。
- 要让带 `schedule` 的事件**自动定时**生效，或改了**调度器本身** → **完整重启 serve**。

## 第 5 步：自检

- `agent events` 能看到新事件、scope 与排程描述正确。
- 占位符都有出处（内建 / mentions / prepare 的 vars）。
- 遵守日志规范：简体中文、无 emoji、术语用大陆说法；代码注释英文。
</process>

<success_criteria>
- [ ] 底图已存到 `workspaces/<soul>/assets/events/<id>/`。
- [ ] `registerEvent` 写好：静态部分在配置、动态部分在 `prepare`、奖励在 `afterSend`。
- [ ] 单一目标正确（来源与目标分清）；选人默认只排除 bot；毫秒时间窗。
- [ ] 需要定时的挂了 `schedule`，并知道要重启 serve 才自动生效。
- [ ] build 通过，`agent events` 能列出该事件。
</success_criteria>

<next>
实现完 → `workflows/fire-event.md` 验收。
</next>
