# Agent 上线手册（新建 + 飞书接入，城邦土地神工作区记忆）

> 怎么从零长出一个新 agent 并让它在飞书当 bot 跑起来。两条共用 skill 是入口，别从头手搓：
> - **`workspaces/_shared/skills/create-agent`**：从 `_template` 复制出新 workspace 并替换占位符。
> - **`workspaces/_shared/skills/onboard-lark-bot`**：把建好的 workspace 接上飞书、起 serve、跨 app 身份归并。
> - 写 / 审共用 skill 本身见 `skill-authoring-playbook.md` 与 `create-agent-skills` skill。
> 落地：2026-06-25 用这套建了 `profile-writer-yihan`（人物志编辑 一涵）并接上独立飞书 app。

## 0. 样板与启动守卫

- 新 agent = `workspaces/<soul>/` 一组人格档（IDENTITY/SOUL/AGENTS/USER/BOOT/TOOLS/HEARTBEAT + SKILLS_GUIDE/WORKSPACE_GUIDE）+ `memory/`（memories.md + journal/）+ `skills/`。样板在 `workspaces/_template/`（占位符 `{{...}}`，BOOT.md 顶部有「这是样板别启动」警告，复制后要删）。
- **soul 名不能以 `_` 开头**：`src/core/soul.ts` 的 `isToolingWorkspace` + `assertRunnableSoul` 会在 cli/serve/ask/run 启动路径拒绝 `_` 开头的 soul（挡 `_shared`/`_template`）。`pnpm agent souls` 仍会列出它们（列举 ≠ 可启动）。
- 人格档装载顺序硬编码在 `src/core/soul.ts`（IDENTITY→SOUL→AGENTS→TOOLS→USER→BOOT→HEARTBEAT）；SKILLS_GUIDE/WORKSPACE_GUIDE 不注入 prompt，按需读。
- **新建后先本地验证**：`pnpm agent cli <soul>`（不碰飞书）。

## 1. 飞书 bot 接入（独立 app，详见 onboard-lark-bot skill）

让 agent 以**独立 bot 身份**上飞书（一涵实测的 6 阶段）：
1. **建 app + lark-cli profile**：`lark-cli config init --name <profile> --new`（浏览器建 app，阻塞）；或 `--app-id cli_xxx --app-secret-stdin` 绑已有。`lark-cli --profile <p> config show` 确认。lark-cli 自己的 config 在 `~/.lark-cli/config.json`——**app_secret 在那里，不进 `configs/lark.json`**。
2. **后台**（open.feishu.cn/app）：启用机器人 → 权限管理开「获取与发送单聊、群组消息」（含群@读 + 私聊读 + 发消息）→ 事件订阅选**长连接** + 加 `im.message.receive_v1` → **创建版本并申请发布**。不发布则 `--as bot` 报 `app_scope_not_applied`、`bot/v3/info` 的 `activate_status` 停在 `2`（发布后变 `1`）。
3. **登录**：`lark-cli --profile <p> auth login --domain im`（device flow、浏览器、约 7 天到期需重授）。
4. **取 ID**：`userOpenId` 看 `auth status` 的 `identities.user.openId`；`botOpenId` 看 `api GET /open-apis/bot/v3/info --as bot` 的 `bot.open_id`（**必须 `--as bot`**，user token 报 99991668）；`tenantKey` 同企业复用现有 profile 的值。onboard-lark-bot 的 `scripts/fetch-bot-ids.sh` 一键取。
5. **写 `configs/lark.json` profile**：key **必须 = soul 名**（框架按 soul 名匹配，命不中会**静默回退 `default`** = 用错 bot 身份，最隐蔽的坑）；字段 `larkProfile/appId/tenantKey/userOpenId/botOpenId/botName`。`configs/` 被 .gitignore（含密钥），改动在磁盘生效但不进 git。
6. **拉群 / 开私聊 + 起服务**：`pnpm agent serve <soul> --bot`，日志看 `auth 检查 profile=<p>`（不是 default）+ `启动 agent【<soul>-bot】`。

## 2. serve 启动模式（2026-06-25 改）

- `pnpm agent serve <soul> [--bot|--user|--both]`，**默认 `--bot`**，三者互斥；**移除了旧的 `--only`**。
- 选哪个身份**靠旗标、不再看 `configs/agents.json` 的 `enabled`**（`enabled` 成了旧字段，留 false 即可）。
- `--bot` 只起 bot（对外回复）；`--user` 只起 user 采集器（collectOnly、不回复）；`--both` 都起。`--sup` 仍会自动补一个 user-token 采集器（群成员 / 文档访问数据面）。
- 代码：`WorkerTarget = {soul, identities}`，`cmd_serve`/`runWorker`（`agent.ts`）、`runSupervisor`（`supervisor.ts`）。

## 3. 新 agent 默认的行为（框架自动，不用配）

- **回复方式**：私聊（p2p）**直接回**一条普通消息；群里**留在原消息话题**里。`feishu-bot.ts` 的 `send()` 按 `ev.chat_type` 自动区分（崩溃恢复路径默认走群行为）。
- **互动事件按 soul 隔离**：`src/core/events.ts` 的 `TRIGGERS` 数组按 `TriggerRule.souls` 白名单隔离 soul。**注意（2026-07-13）**：原唯一规则 `first_interaction_welcome`（首次 @ → 私信 `welcome-party` 迎新）**已删**，`TRIGGERS` 现为空、框架保留作扩展点；迎新改由围观群确定性群发（见 `community-notify-events-playbook.md §15`）。新 agent 要自己的互动事件，往 `TRIGGERS` 塞规则并用 `souls` 白名单圈定即可。
- **LP 跨 agent 共享 + 身份 link**：见 `pt-gamification-playbook.md §9`（LP 在共享库 `.agent/shared.db`、跨 app 同一人用 `pnpm agent link` 归并）。
- **对话场景信号 serve vs CLI（2026-06-25）**：`agent.ts` 的 `prepare()` 在每条 prompt 开头注入一行【对话场景】——`input.source` 是 `feishu-bot`/`feishu-user` → **serve（对面是外部对话者，不是操作者）**；其余（CLI、`agent ask` 不带 source）→ **CLI（对面就是操作者）**。判定靠 source、不靠 open_id。样板已写死 serve/CLI 段落，新 agent 只填 `{{SERVE_PARTY_ROLE}}`。**完整机制 + 各 agent 特化 + 改动注意事项见 `serve-cli-identity-playbook.md`。**

## 关键命令 / 文件速查

- `pnpm agent souls` 列举；`pnpm agent cli <soul>` 本地对话；`pnpm agent serve <soul> --bot` 起 bot。
- 守卫 `src/core/soul.ts`；serve `src/bin/agent.ts:cmd_serve`；回复线程 `src/channels/feishu-bot.ts`；事件 soul 隔离 `src/core/events.ts`。
- 共用 skill：`create-agent`、`onboard-lark-bot`、`create-agent-skills`（均 `workspaces/_shared/skills/`）。
- 研究：`thoughts/shared/research/2026-06-25-agent-template-and-create-agent-skill.md`。
