# Workflow：注册 Agent（register-agent）

<required_reading>
在执行本 workflow 前，先读：
- `references/configs-setup.md` — 了解 agents.json 字段说明、lark.json profile 解析顺序、AGENT_SOUL 环境变量
</required_reading>

<process>

## 步骤 1：在 configs/agents.json 中新增 agent 条目

打开 `configs/agents.json`，在 `agents` 对象中新增一个（或多个）条目：

```json
"<new-agent>-bot": {
  "soul": "<new-agent>",
  "workspace": "<new-agent>",
  "enabled": false
}
```

**字段说明**：
- `soul`：指向 `workspaces/<soul>/` 人格目录，填写新 agent 的目录名
- `workspace`：数据库路径 `.agent/<workspace>.db`，通常与 soul 相同
- `enabled`：旧字段，**`serve` 现在靠 `--bot` / `--user` / `--both` 选身份、不看它**，留 false 即可

**agent-id 命名惯例**：`<soul-name>-bot`（机器人身份）或 `<soul-name>-user`（以操作者身份运行）。若新 agent 同时需要两种身份，各建一个条目。

## 步骤 2：飞书接入交给 onboard-lark-bot

若新 agent 要上飞书当 bot，**不要在这里手配 lark.json**——完整流程（建飞书 app、配权限与事件、发布、登录、取 open_id、写 `configs/lark.json` profile）是共用 skill **`onboard-lark-bot`** 的职责。本 workflow 只把 agents.json 的 `-bot` 条目建好，飞书部分转过去。

要点（细节见 `references/configs-setup.md` 与 `onboard-lark-bot`）：
- lark.json 的 profile **key 用 soul 名**就会自动命中；命中不到会回退 `default`（用错身份）。
- profile 里**不放 app_secret**（密钥在 lark-cli 自己的配置）。

只在本地 CLI 测试（`pnpm agent cli <soul>`）的话，这步可跳过。

## 步骤 3：验证 configs 文件 JSON 格式

确认修改后 JSON 格式合法（无多余逗号、括号匹配）：

```bash
node -e "require('./configs/agents.json')" && echo "JSON OK"
```

</process>

<success_criteria>
- `configs/agents.json` 中有 `<new-agent>-bot`（或 `-user`）条目，`soul` 字段指向新目录名
- JSON 格式合法，无语法错误
- 上飞书的话：转共用 skill `onboard-lark-bot` 完成 app / 权限 / 发布 / lark.json profile
- 可以进入下一个 workflow：`verify-agent.md`
</success_criteria>
