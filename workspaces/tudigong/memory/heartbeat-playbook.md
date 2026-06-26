# 心跳 Heartbeat playbook（2026-06-26 加）

> 目的：让每个 agent 按固定节奏（cadence）在后台自动醒来，基于自己的 `HEARTBEAT.md` 跑一轮 LLM 推理、必要时主动给飞书的人/群发消息（招呼新人、推播活动、整理素材）。**主动代理 + 闸门**模型：能主动行动，但靠闸门（静默时段 / 概率 / 每日上限）防刷版。核心代码 `src/core/heartbeat.ts` + worker（`runWorker`）排程。研究/计划/施工：`thoughts/shared/research|plan|coding/2026-06-26-agent-heartbeat-and-cron-scheduler*.md`。

## 架构（一句话，**别踩**）

心跳挂在 **worker**（`runWorker`，`src/bin/agent.ts`），**不是** supervisor 的功能——所以**不论有没有 `--sup` 都有心跳**。`--sup` 只管社区整体监督（定时事件 / LP 补底 / 会话守护 / 热重启 / PID 锁 / ops 报表），跟心跳无关。心跳是每个 agent 与生俱来的预设。

- **裸跑就有**：`pnpm agent serve <soul> --bot`（不带 `--sup`）就会挂心跳；带 `--sup` 时心跳跑在 supervisor 拉起的 worker 子行程里。两种情况都只有一个 worker → 一次心跳，不重复。
- **挂载条件**：worker 里**有 bot 身份在跑 且 非 quiet** 才挂（`resolved.find(r=>r.identity==='bot')` + `process.env.AGENT_QUIET!=='1'`）。心跳是「bot 主动说话」，所以：`--user` 纯采集器不挂；`--quiet` 静默模式不挂；同一 soul 的 bot 和 user 分两个行程跑时，只有 bot 行程挂 → 不重复触发。绑的 soul 是 `botAgent.workspace`（本行程服务的那个）。
- ⚠️ **早期错误设计（已纠正，别回退）**：曾把心跳挂在 supervisor（变成 `--sup` 才有心跳，裸跑 `--bot` 没有——这是错的，心跳应是预设）；还曾用 `listSouls()` 全扫所有 soul 各挂 timer（`serve tudigong` 连带替 yihan 挂、多行程重复触发）。现在：心跳在 worker、绑本行程 soul、与 `--sup` 无关。
- 排程靠 `startHeartbeat(soul, {larkProfile, kimiProfile})`（`src/core/heartbeat.ts`），递归 `setTimeout` 固定节奏、返回 stop 函数；timer 是进程内变量，worker 退出 / 热重启时随进程死掉（无需手动清理）。

## 一次心跳做什么（`heartbeatTick(soul, opts)` 管线）

```
heartbeatTick
  ├─ loadHeartbeatConfig(soul)            每轮重读 HEARTBEAT_CONFIG.json（见下「热改生效」）
  ├─ 闸门（框架强制，仅常规触发时）：enabled → silentHours → probability → dailyLimit
  │   └─ 任一命中 → log.debug 跳过并 return（不调 LLM、不进 Telegram、省 token）
  ├─ dry-run：log.info 打印 cadence/闸门状态/prompt 前 300 字，return（不调 LLM）
  ├─ 计数 +1（incrementDailyCount，在调 LLM 前）
  ├─ assembleSoul(soul)                   组人格系统提示（含 HEARTBEAT.md）
  ├─ 抛弃式 workDir（mkdtempSync /tmp/heartbeat-<soul>-xxx）
  │   ├─ 写 .kimi-code/AGENTS.md           = soul.systemPrompt
  │   └─ 写 .kimi-code/mcp.json            飞书 MCP 工具（让 agent 自己决定发不发 / 发给谁）
  ├─ runKimiAsync({ continueSession:false, ... })   抛弃式、永远新会话
  └─ finally rmSync 清理临时目录
```

- **抛弃式 session（`continueSession:false`）是关键**：每轮全新会话，彻底规避会话中毒（被打断留下孤儿工具调用 → `--continue` 后永久 400）。代价：agent **不记得上一轮做了什么**（拍板决议如此，目前不做跨轮记忆）。仿 `ops-narrative.ts` 的抛弃式模式 + 加 MCP 工具层。
- **agent 自己决定发送目标**：mcp.json 不带 `AGENT_FEISHU_CHAT`（没有固定 chat target），由 LLM 在推理中通过飞书工具决定发给哪个群/人——这就是「主动代理」。prompt 明确要求「无需行动就输出『本轮无需行动』，不要编造任务或强行发送」。
- **mcp.json 组装走共用函数** `buildAgentMcpConfig({soul, larkProfile?, feishuChatId?})`（在 `src/core/paths.ts`），`agent.ts`（channel 路径，传 feishuChatId）和 `heartbeat.ts`（心跳路径，不传）共用、单一真相来源。⚠️ 依赖 `dist/tools/mcp-server.js` 存在；**没先 `pnpm build` 就没工具**（`if (!fs.existsSync(MCP_SERVER_JS)) return undefined`，agent 仍能推理但发不了飞书）。正常 serve（先 build 再 serve）不受影响。

## 配置：per-soul `workspaces/<soul>/HEARTBEAT_CONFIG.json`

仿 `LP_STRATEGY.json` 惯例，每个 soul 一份。字段：

| 字段 | 含义 | 缺省 | 防御 |
|------|------|------|------|
| `cadenceMinutes` | 触发节奏（分钟） | 10 | 最小 1 |
| `enabled` | 是否启用心跳 | false | — |
| `silentHours` | 静默时段 `[起, 迄]`，**支持跨午夜**（`[22,8]`=22:00→次日08:00 不行动） | `[22,8]` | 须长度 2 数组否则忽略 |
| `probability` | 每轮触发概率 | 1.0 | 钳在 0–1 |
| `dailyLimit` | 每逻辑日触发 LLM 的**次数**上限 | 不限 | 取正整数，否则忽略 |

- `loadHeartbeatConfig(soul)`：文件不存在 / JSON 损坏 → 回退安全默认 `{cadenceMinutes:10, enabled:false}`（不会报错炸掉 worker）。
- **热改生效规则（重要、易混）**：
  - `heartbeatTick` **每轮重读 config**，所以改 `silentHours` / `probability` / `dailyLimit`、以及把 `enabled` 从 true 改 false（暂停）→ **下一轮自动生效，无需重启**。
  - 但 `cadenceMinutes` 和「启动时是否挂 timer」只在 worker 启动时读一次（`startHeartbeat`）→ **改 cadence、或把一个从没启用的 soul 从 false 改 true，需要重启 serve** 才挂上 timer。

## 闸门（Gating，框架在调 LLM 前强制执行）

- 顺序：`enabled → silentHours → probability → dailyLimit`，任一命中即 `log.debug` 跳过、**不调 LLM**（省 token、可靠，不靠 LLM 自律）。HEARTBEAT.md 里的「节制原则」段是第二层 LLM 提醒，不是强制层。
- ⚠️ **dry-run 和 test 模式会跳过所有闸门**（方便人工检视/测试），只有常规自动触发才过闸门。
- **dailyLimit 计的是「触发 LLM 的次数」**（不是飞书消息条数）。计数器 `_dailyCounts` 是**进程内内存 Map**，按 `logicalDayIndex`（逻辑日，05:00 锚点）自动滚动重置，**无 DB migration**。⚠️ 重启 worker 计数归零（重启罕见，可接受）。计数在调 LLM 前 `incrementDailyCount`。

## CLI 手动触发：`pnpm agent heartbeat <soul> [--dry-run] [--test]`

- `--dry-run`：只组 prompt + 打印闸门状态，**不调 LLM、不发消息**。最安全，验收首选。
- `--test`：调 LLM，但 prompt 注入「只发操作者本人 P2P（用 sendText 发私信），不要发任何群」。跳过闸门。
- ⚠️ **不带任何旗标 `pnpm agent heartbeat tudigong` = 真触发、真发送（仍受闸门约束）**，会真的让 agent 决定往真实群/人发消息。**测试一律用 `--dry-run` 或 `--test`**，别裸跑。
- 一次性 CLI 已 `enableLogSink()` + 退出 `flushTelegramSync()`，日志会进 Telegram 镜像。

## log 分级 + 文案（简体、无 emoji）

- 例行「本轮无动作 / 被闸门挡下」→ `log.debug`（默认不显示、不进 Telegram）；实际触发 LLM、完成、失败 → `log.info`/`log.error`（进 Telegram）。
- 启动时：`心跳已排程【<soul>】：每 N 分钟触发一次`（info）/ `心跳未启用【<soul>】，跳过排程`（debug）。
- 闸门跳过（debug）：`心跳本轮跳过【<soul>】：未启用` / `：静默时段` / `：概率未命中（probability=X）` / `：已达每日上限 N（当前 M）`。
- 触发（info）：`心跳触发【<soul>】（今日第 N 次）` → `心跳推理完成【<soul>】，耗时 Xms，结果：…`。
- 失败：`心跳推理失败【<soul>】：<msg>`（error）/ `心跳排程异常【<soul>】：<msg>`（error）。

## 健康 / 超时兜底

- `runKimiAsync` 默认 10 分钟 timeout；抛弃式 session 本身规避中毒。
- 一轮 tick 失败：`catch` 记 `log.error` **不 re-throw**，`finally` 清理临时目录，**不影响下一次排程**（下个 cadence 照常触发）。

## HEARTBEAT.md（大写人格档，**现状**）

- HEARTBEAT.md 是大写人格档之一，被 `assembleSoul()` 组进系统提示（AGENTS.md），也被 `fingerprintSoul()` 纳入内容指纹。
- ⚠️ **改 HEARTBEAT.md 内容会触发会话重置**：下次 `pnpm agent update` 或重启 worker 时 `reloadSoulIfChanged` 检测到指纹变化，隔离该 soul 现有会话（现有群对话下次回应时自动重建）。预期行为，见 `agent-skill-playbook.md`。
- **写法已从「被动清单」改成「主动语境」**：现在 HEARTBEAT.md 写的是「心跳醒来时，我主动做的事」（职责 + 关注什么 + 行动方式）+「节制原则（闸门）」段（静默时段、无意义不发、频率节制、目标对号）。⚠️ 别改回「当有人说【检查一下心跳】时」那种被动清单，否则 LLM 拿到被动语境每轮都输出「本轮无需行动」、不会主动。

## enabled 默认约定 + 孵化端（create-agent / _template）

- **`_template` 给未来新 agent 的默认是 `enabled:false`**（沿用 `LP_STRATEGY.json` 的 `judgeEnabled:false`「新功能默认停用、客制填妥再开」惯例）——孵化出来先不自动心跳，避免带着未填好的 HEARTBEAT.md 就乱发飞书。既有 agent 配妥 HEARTBEAT.md 后才设 `enabled:true`。
- **create-agent skill 已接通**：`copy-and-customize` 随 `_template` 复制带入 `HEARTBEAT_CONFIG.json`；`gather-requirements` 会问 cadence + 闸门参数；`verify-agent` 有验收项（确认 HEARTBEAT_CONFIG.json 存在、HEARTBEAT.md 是主动语境）。
- ⚠️ `_template/HEARTBEAT.md` 新增了 `{{HEARTBEAT_GATE_PRINCIPLE}}` 占位符，`create-agent/references/placeholders.md` 暂未收录该项，后续补。

## 当前各 soul 设定（2026-06-26）

- **tudigong**：`cadenceMinutes:60`（1 小时）、`enabled:true`、`silentHours:[22,8]`、`probability:0.8`、`dailyLimit:20`。
- **profile-writer-yihan**：`cadenceMinutes:480`（8 小时）、`enabled:true`、`silentHours:[22,8]`、`probability:1.0`、`dailyLimit:10`。
- **_template**：`enabled:false`（其余 10 / [22,8] / 1.0 / 20）。

## 改动文件

`src/core/heartbeat.ts`（新，核心：config / 闸门 / LLM 管线 + `startHeartbeat` 排程）、`src/core/paths.ts`（新增共用 `buildAgentMcpConfig`）、`src/core/agent.ts`（`buildMcpConfig` 改委派共用函数）、`src/bin/agent.ts`（`runWorker` 末尾挂 `startHeartbeat`（bot 身份 + 非 quiet 才挂）+ `heartbeat` 子命令）、`workspaces/{tudigong,profile-writer-yihan,_template}/HEARTBEAT.md`（改写主动语境）、`workspaces/{tudigong,profile-writer-yihan,_template}/HEARTBEAT_CONFIG.json`（新）、`workspaces/_shared/skills/create-agent/workflows/{gather-requirements,copy-and-customize,verify-agent}.md`。**`src/core/supervisor.ts` 不再涉及心跳**（早期版本曾挂在这、已移除）。**无 DB migration**（dailyLimit 走内存）。

## 关联

- 抛弃式 LLM 触发的范本：`ops-report-playbook.md` 末节（ops-narrative 04:59）。
- 会话中毒 / 自愈 / timeout：`self-heal-playbook.md`。
- 人格档指纹重置机制：`agent-skill-playbook.md`。
- serve 双进程 / 启动模式：`agent-onboarding-playbook.md`、`serve-cli-identity-playbook.md`。
- 发群 chat 目标解析（resolveChatTarget）：`chat-targets-playbook.md`。
