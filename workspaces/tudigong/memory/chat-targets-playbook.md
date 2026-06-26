# 群发送目标 · config 驱动 playbook（2026-06-26 加）

> 一句话：机器人"要发到哪个群"的 chat_id **绝不写死在源码**，一律放 `configs/lark.json` 的 `knownInternalChats` 别名，代码用 `resolveChatTarget(alias)` 解析。起因：运营报告每天报 `invalid receive_id`——`supervisor.ts` 里写死了脱敏占位符 `oc_example_ops_group`（不是真 id），发飞书必然失败。

## resolveChatTarget（`src/core/configs.ts`）
- `resolveChatTarget(alias, cfg?): string | null`：查 `lark.knownInternalChats[alias]`；若解析不到**真实** `oc_` id（未配置 / 仍是 `oc_example_*` 占位 / 别名本身不是 `oc_`）→ 返回 **null**，调用方据此**优雅跳过**（绝不把假 id 喂飞书、不报错）。
- 与旧的 `resolveAlias`（找不到就原样返回）**不同**——所有"发送目标"类一律用 `resolveChatTarget`，旧的 `resolveAlias` 只用于 listen 列表。
- 已改造（原本全是 `oc_example_*` 硬编码）：`supervisor.ts` 运营报告群（`opsReportTargets()` → 别名 运营小天地）、`ops-report.ts` `staffChatIds()`（红蓝着色，市政厅工作群+运营小天地）、`events.ts` ×4（徽章默认/群发、课程、访客里程碑、提案、潜水唤醒）、`feishu-user.ts` 访客监测群（围观群）。缺配置 → 对应功能静默跳过。
- 真实 id 放 **gitignored** 的 `configs/lark.json`；committed 的 `.example` 只放 `oc_example_*` 占位。别名键沿用中文名：运营小天地 / 城邦快报 / 围观群 / 市政厅工作群 / 工作人员 / AgentTasks / AgentNotify。

## 取真实 chat_id（运维）
- `lark-cli --profile <p> im +chat-list --as user --page-size 100 --format json` → `data.chats[]`（含 `chat_id`/`name`/`external`），按群名匹配填进 `configs/lark.json`。
- ⚠️ **同名群要分清**：运营小天地有两个同名群——**外部那个是活跃群（用它）**，内部同名的已解散别用（见 [community-notify-events-playbook.md] §7）。
- ⚠️ **`232011 "Operator can NOT be out of the chat"`** = 操作者已不在该群 → 你配的是**失效旧 id**（实测市政厅工作群旧 id 操作者已被移出）；换成 `im +chat-list` 里操作者仍在的活跃群 id。staff 着色靠 `listChatMembers --as user`，操作者不在就读不到、着色退化。
- 发群是 `--as bot` → **bot 必须在群里**（`im chat.members bots get --params '{"chat_id":"oc_…"}'` 查），否则 `230002`；运营小天地、城邦快报实测 bot 在内。

## 验证（serve 进程外、读真 config）
`node --import tsx -e "import {resolveChatTarget} from './src/core/configs.ts'; for (const a of ['运营小天地','城邦快报','围观群','市政厅工作群']) console.log(a, resolveChatTarget(a))"`

## 改动文件
`configs.ts`（`resolveChatTarget`）、`supervisor.ts`、`ops-report.ts`、`events.ts`、`feishu-user.ts`、`configs/lark.json(.example)`。配置改动是运行时读取、**不用 build**；但 `loadConfigs`/`loadChatPolicies` 进程内缓存 → 对常驻 serve 要**重启**才生效，一次性 CLI 即时生效。
