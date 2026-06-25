# Runtime 约束参考

## 1. listSouls() 的行为

`src/core/soul.ts` 中的 `listSouls()` 函数扫描 `workspaces/` 目录下的**所有子目录**，不对目录名称做任何过滤：

```typescript
export function listSouls(): string[] {
  return fs.readdirSync(SOULS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}
```

因此 `pnpm agent souls` 会列出包括 `_shared`、`_template` 在内的全部子目录。这是预期行为——列举不等于可启动。

---

## 2. 启动守卫（isToolingWorkspace）

`src/core/soul.ts` 中导出了启动守卫函数：

```typescript
// Underscore-prefixed workspaces (e.g. _shared, _template) are tooling directories, not runnable agents.
export function isToolingWorkspace(name: string): boolean {
  return name.startsWith('_');
}
```

在 `src/bin/agent.ts` 中，以下四个命令的启动路径均会在解析 soul 名称后、调用 `assembleSoul()` 之前调用 `assertRunnableSoul()`：

| 命令 | 触发时机 |
|------|---------|
| `pnpm agent cli <soul>` | 解析 soul 参数后 |
| `pnpm agent serve <soul> [--bot/--user/--both]` | 解析位置参数 soul 后（不带位置参数时走 DEFAULT_SOUL，不受影响） |
| `pnpm agent ask <soul>` | 校验 soul 存在后 |
| `pnpm agent run <soul>` | 校验 soul 存在后 |

**拒绝行为**：若 soul 名称以 `_` 开头，打印简体中文错误提示并以 exit code 1 退出。

---

## 3. 新 agent 名称不可以下划线开头

基于以上启动守卫，新 agent 的 soul 名称**绝对不能以 `_` 开头**，否则：

- `pnpm agent cli <soul>` 会被守卫拒绝，无法进入对话
- `pnpm agent serve <soul>` 会被守卫拒绝，无法启动常驻服务

合法名称示例：`my-agent`、`assistant`、`newsbot`、`helper`

非法名称示例：`_myagent`、`_template`、`_shared`

---

## 4. soul vs workspace 的区别

| 概念 | 含义 | 配置位置 |
|------|------|---------|
| **soul** | 人格文件目录名（`workspaces/<soul>/`） | `configs/agents.json` 的 `soul` 字段 |
| **workspace** | 数据库文件名（`.agent/<workspace>.db`） | `configs/agents.json` 的 `workspace` 字段（省略时等于 soul） |

同一个 soul 可以有多个 agent 条目（如 `-bot` 和 `-user`）共享同一份数据库（相同 workspace），也可以各自使用独立数据库（不同 workspace）。

---

## 5. skill 在会话建立时定格

执行器在**会话创建的那一刻**固定 skill 集合与内容，`--continue` 续接**不重新扫描、不重新读取**。

因此：

- **新增 / 修改 / 删除 skill 只对新会话生效**
- 修改 `create-agent` skill 本身后，需要等到下一个新会话才能看到更新

框架每次服务重启或热更新（`pnpm agent update`）时，按内容指纹检测 skill 变化，自动重置受影响会话，使下次对话重建 session 以载入新内容。

---

## 6. 新 agent 默认继承什么（框架行为，不用配）

- **启动模式**：`pnpm agent serve <soul> --bot`（`--bot` 默认 / `--user` 只采集 / `--both`）。`enabled` 字段不再决定 serve 选哪个身份。
- **回复方式**：私聊（p2p）直接回；群里留在原消息的话题里。框架按 `chat_type` 自动区分，无需配置。
- **互动事件按 soul 隔离**：欢迎类等互动事件（如 `welcome-party`）只对白名单内的 soul 触发（见 `src/core/events.ts` 的 `souls`）。**新 agent 默认不会触发任何 tudigong 专属事件**；要给新 agent 自己的欢迎事件，得在代码里把它的 soul 加进对应 trigger 的 `souls`。
- **LP 是全局共享经济**：积分 / 徽章 / profile 存在共享库 `.agent/shared.db`，所有 agent 共用（不在各自的 `<workspace>.db`）。对话记忆仍按 agent 隔离。
- **跨 app 同一人要 link**：每个飞书 app 给同一个人不同的 open_id。新 agent 用自己的 app 时，回头客在新 app 下是新 open_id、LP 会另起。要让 LP 统一，运维跑 `pnpm agent link <新open_id> <他的canonical open_id>`（详见 `onboard-lark-bot`）。
