# Configs 配置参考

## 1. configs/agents.json

### 文件结构

```json
{
  "agents": {
    "<agent-id>": {
      "soul": "<soul-name>",
      "workspace": "<workspace-name>",
      "enabled": false,
      ...
    }
  }
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `soul` | string | 是 | 指向 `workspaces/<soul>/` 目录，决定从哪里读取人格文件 |
| `workspace` | string | 否 | 决定数据库文件路径 `.agent/<workspace>.db`；**省略时默认等于 soul** |
| `enabled` | boolean | 否 | 旧字段。**`serve` 选哪个身份现在靠 `--bot` / `--user` / `--both`，不再看 `enabled`**；留 false 即可 |
| `lark` | string | 否 | 指定使用 `configs/lark.json` 中哪个 profile（省略时按解析顺序回退） |
| `replyPrefix` | string | 否 | 回复前缀。**只在 user 频道生效**——user 模式下消息显示在操作者本人账号下，需要前缀来区分这是 agent 在说话。**bot 频道不加任何前缀**（bot 在客户端本来就显示自己的名字，前缀多余）。省略 / 留空即可 |

### soul 与 workspace 的区别

- **soul**：指向人格文件目录（`workspaces/<soul>/`），决定 agent 的身份与行为。
- **workspace**：指向数据库文件（`.agent/<workspace>.db`），决定记忆与数据的存放位置。

通常两者相同。以下情况可能需要分开设置：
- 多个 agent 共享同一份数据库（如同一 soul 的 bot 版本和 user 版本共享记忆）
- 测试环境使用独立数据库

### agent-id 命名惯例

`<soul-name>-<mode>`，其中 mode 常见值为 `bot`（机器人身份）或 `user`（以操作者身份运行）。
例：`myagent-bot`、`myagent-user`。

### 配置示例

```json
{
  "agents": {
    "myagent-bot": {
      "soul": "myagent",
      "workspace": "myagent",
      "enabled": false
    },
    "myagent-user": {
      "soul": "myagent",
      "workspace": "myagent",
      "enabled": false
    }
  }
}
```

---

## 2. configs/lark.json（飞书接入 → 详见 onboard-lark-bot skill）

飞书 bot 的完整接入（建 app、配权限与事件、发布、登录、取 ID、写 profile）是共用 skill **`onboard-lark-bot`** 的职责。这里只说明 create-agent 需要知道的最小事实。

### profile 的真实字段（不是 app_secret）

`configs/lark.json` 的每个 profile **不放 app_secret**（密钥在 lark-cli 自己的配置里）。字段是标识信息：

```json
"<soul>": {
  "larkProfile": "<lark-cli profile 名>",
  "appId": "cli_xxxx",
  "tenantKey": "<企业 tenant_key>",
  "userOpenId": "ou_...",
  "botOpenId": "ou_...",
  "botName": "<bot 显示名>"
}
```

### Lark Profile 解析顺序

框架按以下优先级查找用哪个 profile（来源：`src/core/configs.ts:resolveLarkProfileName()`）：

1. agent 配置中明确设置的 `lark` 字段
2. agent 的 `soul` 名称（若 `profiles` 中存在同名 profile）
3. agents.json `defaults` 的 lark
4. 固定字符串 `"default"`

**所以 profile 的 key 用 soul 名，就会自动命中**；命中不到会**静默回退到 `default`**（用错 app / bot 身份，最隐蔽的坑）。

> 只在本地 CLI 测试（`pnpm agent cli <soul>`）的话，不用配 lark profile。要上飞书，转 `onboard-lark-bot`。

---

## 3. AGENT_SOUL 环境变量

`AGENT_SOUL` 是框架设置的运行时环境变量，在 `src/bin/agent.ts` 的各启动路径（`cmd_cli`、`cmd_serve`、`cmd_ask`、`cmd_run`）中被设置：

```typescript
process.env.AGENT_SOUL = soul; // names the DB file (.agent/<soul>.db)
```

**作用**：
- 决定数据库文件路径：`.agent/<AGENT_SOUL>.db`
- 当 `configs/agents.json` 中 agent 的 `workspace` 字段省略时，框架也使用 soul 名称作为 workspace 名称，效果等同于 `AGENT_SOUL`

**CLI 测试时**：`pnpm agent cli <soul>` 会自动设置 `AGENT_SOUL=<soul>`，无需手动设置。

**常驻服务**：`pnpm agent serve [soul]` 同理；若不指定 soul，使用代码中的 `DEFAULT_SOUL` 默认值。
