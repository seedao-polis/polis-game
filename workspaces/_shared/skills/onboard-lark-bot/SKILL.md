---
name: onboard-lark-bot
description: 把一个已建好 workspace 的 agent 以独立 bot 身份接入飞书并跑起来：建或绑飞书 app 与 lark-cli profile、配权限与事件并发布、取 open_id、写 configs/lark.json、起 serve 验证。当需要给某个 soul 上线一个飞书 bot、新增一个 lark profile、或排查 bot 收发不通时使用。
---

<objective>
本 skill 把一个**已经建好 workspace** 的 agent（soul）接入飞书，让它以独立 bot 身份响应群里被 @ 和私聊消息，最终能用 `pnpm agent serve <soul> --bot` 跑起来。覆盖从「建飞书 app」到「serve 起来收发消息」的完整链路，并沉淀常见坑的排查方法。

前置：目标 soul 的 workspace 已存在（用共用 skill `create-agent` 建）。本 skill 只负责把它接上飞书。
</objective>

<quick_start>
已熟悉全流程时的最快路径（soul 记作 `<soul>`，lark-cli profile 记作 `<profile>`）：

1. 建 app + profile：`lark-cli config init --name <profile> --new`（浏览器里建 app）。
2. 飞书后台：启用机器人、开「获取与发送单聊、群组消息」权限、订阅 `im.message.receive_v1`（长连接）、**创建版本并发布**。
3. 登录：`lark-cli --profile <profile> auth login --domain im`。
4. 取 ID：`scripts/fetch-bot-ids.sh <profile> <soul> <botName>`，把输出的 profile 块贴进 `configs/lark.json` 的 `profiles`。
5. 起服务：`pnpm agent serve <soul> --bot`，群里 @ 或私聊验证。

任何一步不确定 → 走 `workflows/onboard-new-bot.md`。
</quick_start>

<essential_principles>
### 1. profile 的 key 要等于 soul 名

`configs/lark.json` 里新加的 profile，**key 必须等于 agent 的 soul 名**（如 soul `news-writer` → profile key `news-writer`）。框架按 soul 名匹配 profile；匹配不到会**静默回退到 `default` profile**（用错 app / bot 身份），这是最隐蔽的坑。

### 2. 权限和事件必须「发布」才生效

飞书后台加的权限（scopes）和事件订阅，要**创建版本并申请发布通过**后才对 bot（应用身份）生效。没发布 → `--as bot` 报 `app_scope_not_applied`，或 `bot/v3/info` 的 `activate_status` 停在 `2`（未真正启用）。

### 3. bot 身份 ≠ user 身份

bot 用应用（tenant）token，靠 app_id / app_secret 自动取、不需登录；群里只收到**被 @** 的消息。user 用本人 token，要 `auth login`（device flow、浏览器、约 7 天到期），用于采集与查成员名。`serve <soul> --bot` 只起 bot；要本人采集面再加 `--user` / `--both` 或 `--sup`。

### 4. open_id 按 app 隔离

同一个人在不同飞书 app 下的 open_id 不同。新 app 的 `userOpenId` / `botOpenId` 必须**在该 app 下重新取**，不能复用别的 app 的值。`tenantKey` 例外：它标识企业、同企业可复用。
</essential_principles>

<intake>
**问用户：**

你想做什么？
1. 端到端接入一个新 bot（建 app → 配后台 → 写 config → serve）
2. app 已建好，只把它写进 configs 并起服务
3. 验证 / 排查一个已配好的 bot（收发不通、起不来）

**先等用户回答再继续。**
</intake>

<routing>
| 回答 | Workflow |
|------|----------|
| 1、「新接入」「端到端」「new」 | `workflows/onboard-new-bot.md` |
| 2、「只写 config」「register」「已建好」 | `workflows/register-existing-app.md` |
| 3、「验证」「排查」「verify」「收不到」 | `workflows/verify-bot.md` |

**读完 workflow 后严格照它执行。**
</routing>

<reference_index>
领域知识在 `references/`：

- `lark-cli-and-console.md` — lark-cli profile（建 / 绑 app）与飞书后台配置（权限、事件长连接、发布）。
- `ids-and-config.md` — 取 userOpenId / botOpenId / tenantKey，写 `configs/lark.json` profile，及与 soul / `agents.json` 的关系。
- `troubleshooting.md` — 常见坑：activate_status、app_scope_not_applied、回退 default、user token 到期。
- `shared-lp-and-link.md` — LP 是全局共享库（`.agent/shared.db`）；跨 app 同一人用 `agent link` 归并身份。
</reference_index>

<workflows_index>
| Workflow | 用途 |
|----------|------|
| onboard-new-bot.md | 端到端 6 阶段接入新 bot |
| register-existing-app.md | app 已建好，只写 configs 并起服务 |
| verify-bot.md | 验证 bot 能收发 + serve 起得来 + 排查 |
</workflows_index>

<success_criteria>
一次成功的接入：

- `configs/lark.json` 有一条 key 等于 soul 名的 profile（larkProfile / appId / userOpenId / botOpenId 都已填）。
- 飞书后台机器人已启用、权限与 `im.message.receive_v1`（长连接）已发布，`bot/v3/info` 的 `activate_status=1`。
- `pnpm agent serve <soul> --bot` 启动日志出现 `auth 检查 profile=<profile>`（不是回退 default）和 `启动 agent【<soul>-bot】`。
- 群里 @ bot 或私聊，bot 用简体中文、以该 soul 的人设回应。
</success_criteria>
