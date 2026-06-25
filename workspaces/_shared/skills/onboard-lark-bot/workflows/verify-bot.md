# Workflow：验证 / 排查 bot（verify-bot）

<required_reading>
执行前先读：
- `references/troubleshooting.md`
</required_reading>

<process>

## 步骤 1：确认机器人已生效
`lark-cli --profile <profile> api GET /open-apis/bot/v3/info --as bot` → `activate_status=1`。是 `2` → 后台发布没过（见 `references/troubleshooting.md`）。

## 步骤 2：起服务看日志
`pnpm agent serve <soul> --bot`：
- 应出现 `auth 检查 profile=<profile>`（**不是 default**，否则 profile key ≠ soul 名）。
- 应出现 `启动 agent【<soul>-bot】（identity=bot ...）`。

## 步骤 3：实测收发
- bot 已拉进群 / 已开私聊。
- 群里 @ bot 或私聊发一句，确认回应、语言、人设都正确。

## 步骤 4：对症排查
收不到 / 发不出 / 回退 default / token 到期 → 按 `references/troubleshooting.md` 对症处理。

</process>

<success_criteria>
- `activate_status=1`、serve 走对 profile、bot 实测能收能回。
</success_criteria>
