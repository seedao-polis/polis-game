# Workflow：端到端接入新 bot（onboard-new-bot）

<required_reading>
执行前先读：
- `references/lark-cli-and-console.md` — lark-cli profile 与飞书后台配置
- `references/ids-and-config.md` — 取 ID 与写 configs
</required_reading>

<process>

## 阶段 1：建 app + lark-cli profile
- 现场建 app：`lark-cli config init --name <profile> --new`（浏览器完成）。
- 或绑已有 app：`lark-cli config init --name <profile> --app-id cli_xxx --app-secret-stdin`。
- 确认：`lark-cli --profile <profile> config show`。

## 阶段 2：飞书后台配置（用户在浏览器做）
按 `references/lark-cli-and-console.md` 的 `<feishu_console>`：启用机器人、开「获取与发送单聊、群组消息」权限、订阅 `im.message.receive_v1`（长连接）、**创建版本并发布**。

## 阶段 3：登录
`lark-cli --profile <profile> auth login --domain im`（device flow，浏览器授权操作者本人）。

## 阶段 4：取 ID
`scripts/fetch-bot-ids.sh <profile> <soul> <botName>`，记下 userOpenId / botOpenId。

## 阶段 5：写 configs/lark.json
按 `references/ids-and-config.md` 的 `<write_profile>` 加一条 key = soul 名的 profile；`node -e "require('./configs/lark.json')"` 校验。确认 `configs/agents.json` 有 `<soul>-bot`。

## 阶段 6：拉群 + 起服务 + 验证
- 把 bot 拉进访谈群 / 在飞书搜 bot 名开私聊。
- 确认 `bot/v3/info --as bot` 的 `activate_status=1`（否则回阶段 2 发布）。
- 起服务：`pnpm agent serve <soul> --bot`；看日志 `auth 检查 profile=<profile>` + `启动 agent【<soul>-bot】`。
- 群里 @ bot 或私聊发一句，确认回应正确。

## 阶段 7：（回头客）归并身份，统一 LP
新 app 给每个人新的 open_id。若某成员在别的 agent 里已有 LP，跑 `pnpm agent link <新open_id> <canonical open_id>` 让 LP 跟过来（详见 `references/shared-lp-and-link.md`）。大多数人只用一个 bot，不用做。

</process>

<success_criteria>
- profile 已写、JSON 合法、key = soul 名。
- `activate_status=1`。
- serve 起来、走对 profile、bot 正常回应。
</success_criteria>
