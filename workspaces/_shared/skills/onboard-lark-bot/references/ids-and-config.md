<table_of_contents>
- 取三个 ID
- 写 configs/lark.json profile
- 与 soul / agents.json 的关系
</table_of_contents>

<fetch_ids>
新 app 的 `userOpenId` / `botOpenId` 必须在该 app 下重新取（open_id 按 app 隔离）。`tenantKey` 标识企业、同企业可复用现有 profile 的值。

**一键取（推荐）**：
```bash
scripts/fetch-bot-ids.sh <lark-cli-profile> <profile-key（=soul 名）> <botName>
```
它读 bot 信息 + 登录态，打印一段可直接贴进 `configs/lark.json` 的 profile 块（appId / tenantKey 留占位、自己填）。

**手动取**：
- userOpenId：`lark-cli --profile <profile> auth status` → `identities.user.openId`。
- botOpenId：`lark-cli --profile <profile> api GET /open-apis/bot/v3/info --as bot` → `bot.open_id`（需机器人已启用）。
- tenantKey：同企业复用现有 profile 的 `tenantKey`（它只作消息元数据，不是关键路由字段）。
</fetch_ids>

<write_profile>
往 `configs/lark.json` 的 `profiles` 加一条，**key 等于 soul 名**：
```json
"<soul>": {
  "larkProfile": "<lark-cli-profile>",
  "appId": "cli_xxx",
  "tenantKey": "<企业 tenant_key>",
  "userOpenId": "ou_...",
  "botOpenId": "ou_...",
  "botName": "<bot 显示名>"
}
```
- `larkProfile`：lark-cli 那个 `--profile` 名（可以和 key 不同）。
- `botOpenId`：bot agent 的 `selfOpenId`，用于防自触发，必须填对。

改完校验 JSON：`node -e "require('./configs/lark.json')"`。
</write_profile>

<relation_to_agents>
- `configs/agents.json` 里要有 `<soul>-bot`（identity=bot）条目；用 create-agent skill 建 workspace 时通常已生成。
- profile 解析顺序：agent 的 `lark` 字段 → soul 名 → 默认 → `default`。所以 profile key 用 soul 名就会自动命中；命中不到会**回退 default**（用错身份）。
- serve 选身份靠 `--bot` / `--user` / `--both`（不看 `enabled`）；`<soul>-bot` 的 `enabled` 设为 false 也能被 `--bot` 起。
</relation_to_agents>
