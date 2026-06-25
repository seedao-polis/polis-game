# Workflow：登记已建好的 app（register-existing-app）

<required_reading>
执行前先读：
- `references/ids-and-config.md`
</required_reading>

<process>

## 步骤 1：确认 lark-cli profile 与登录
- `lark-cli --profile <profile> config show`（appId 对、users 已登录）。
- 没登录：`lark-cli --profile <profile> auth login --domain im`。

## 步骤 2：取 ID
`scripts/fetch-bot-ids.sh <profile> <soul> <botName>`。

## 步骤 3：写 configs/lark.json
加 key = soul 名的 profile（见 `references/ids-and-config.md` 的 `<write_profile>`），`node -e "require('./configs/lark.json')"` 校验。

## 步骤 4：确认 agents.json + 发布态
- `configs/agents.json` 有 `<soul>-bot`。
- `bot/v3/info --as bot` 的 `activate_status=1`（否则去后台发布，见 `references/lark-cli-and-console.md`）。

## 步骤 5：起服务验证
转 `workflows/verify-bot.md`。

</process>

<success_criteria>
- profile 已登记、JSON 合法、`activate_status=1`。
- 可进入 `workflows/verify-bot.md`。
</success_criteria>
