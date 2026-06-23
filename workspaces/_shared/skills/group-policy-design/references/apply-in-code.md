# 落点：每个设计点改哪里

<overview>
把策略落到实处时，每个设计点对应一个配置文件或一段代码。本文是【方案 → 落点】的对照表，交付方案时照这张表列出要改的位置；除非用户明确要求，不直接改、不提交。
</overview>

<config_files>
## 配置文件（改这些不用动代码）

| 设计点 | 文件 | 字段 |
|--------|------|------|
| 群的保密层级 | `configs/chat-policies.json` | 该群 `tier`（`public`/`member`/`work`） |
| 未标群默认层级 | `configs/chat-policies.json` | 顶层 `defaultTier` |
| 覆写分级政策文字 | `configs/chat-policies.json` | `tierPolicies`（逐级选填） |
| 群专属提示 | `configs/chat-policies.json` | 该群 `systemPromptAppend`（选填） |
| 群是否被监听 | `configs/agents.json` | 该智能体的 `listen` 清单 |
| 管理员名单 | `configs/admins.json` | `admins`（open_id 数组） |

**一个群条目的形状**：

```json
"oc_xxxxxxxxxxxxxxxx": {
  "name": "示例群",
  "tier": "public",
  "systemPromptAppend": "你现在在示例群，主要面向外部观察者。"
}
```

> ⚠️ **`listen` 是前提**：群没在该智能体的 `listen` 清单里，机器人根本收不到这个群的消息——策略再对也没用。设计完群策略，务必同时确认这一步。
</config_files>

<code_points>
## 代码落点（要改默认行为才动这些）

| 设计点 | 文件 | 函数 / 标识 |
|--------|------|-------------|
| 取群层级（兜底 defaultTier） | `src/core/configs.ts` | `getChatTier` |
| 取分级政策文字（覆写 → 内建） | `src/core/configs.ts` | `getTierPolicyText` / `BUILTIN_TIER_POLICY` |
| 取群条目 | `src/core/configs.ts` | `getChatPolicy` |
| 是否管理员 | `src/core/configs.ts` | `isAdmin` / `loadAdmins` |
| 系统提示组装（追加分级 + 专属） | `src/core/soul.ts` | `assembleSoul(name, { chatId })` |
| 命名空间白名单（跨人隔离根） | `src/core/memory-policy.ts` | `allowedNamespaces` |
| 可见性闸门（二道防御） | `src/core/memory-policy.ts` | `filterByPolicy` |
| 写入归属（自动摘要写去哪） | `src/core/memory-policy.ts` | `resolveWriteScope` |
| 每轮注入过滤后记忆 | `src/core/agent.ts` | `prepare()` 内取 `getFilteredMemories` |
| 会话键（对话隔离） | `src/channels/feishu-bot.ts` | `sessionKeyFor` |
| 记忆读写 store | `src/core/store/memory.ts` | `insertMemory`/`upsertMemory`/`getFilteredMemories`… |
</code_points>

<cli>
## 命令行（设计与验证用）

```
agent memory list [--namespace <ns>] [--user <openId>] [--chat <chatId>] [--limit N]
                                          # 运维视角列记忆，不过 Policy Filter
agent memory add --namespace <ns> --content <text> [--key k] [--visibility v]
agent memory set --namespace <ns> --key <k> --content <text> [--visibility v]
agent memory rm <id>
agent memory clear --namespace <ns>
agent memory preview --chat <chatId> --user <openId> [--admin]
                                          # ★ 站在某人视角过 Policy Filter，打印实际会注入的记忆 + 群层级
agent memory summarize --chat <c> --user <u> [--soul <s>]   # 手动触发个人自动摘要
agent memory aggregate [--chat <c>]                          # 手动跑群组热词
agent memory purge                                           # 手动跑过期清理
```

`agent memory preview` 的输出包含这些行（验证隔离最有用）：

```
视角：chat=<c> user=<u> admin=<bool>
群层级：public | member | work
可读命名空间：global、group:<c>、user:<u>、group_user:<c>:<u>
注入记忆（即实际进入提示的【背景记忆】区块）：
  - [ns=… vis=…] …
```
</cli>

<effective>
## 生效流程与测试

- **配置在启动时载入并缓存**：改 `chat-policies.json` / `agents.json` / `admins.json` 后，必须**重建 + 重启 serve** 才生效。
- **会话级变更**：改了分级层级 / 群专属提示，已存在的会话要重开（或重启）才会带上新系统提示；记忆类变更（增删命名空间内容）下一轮即生效。
- **测试**：隔离相关有测试守（针对 `memory-policy` 的基础隔离、个人记忆恒跨群、写入归属、分级政策注入、管理员门控等）。改 Policy Filter 前先跑测试套件。
</effective>

<local_sandbox>
## 本地快速验证环（不碰生产库）

```bash
export AGENT_DB_PATH=/tmp/policy-test.db      # 指向临时库，隔离生产数据
agent memory add --namespace user:ou_A --content "A 的秘密" --visibility private
agent memory add --namespace user:ou_B --content "B 的秘密" --visibility private
agent memory preview --chat oc_X --user ou_A   # 只看到 A 的
agent memory preview --chat oc_X --user ou_B   # 只看到 B 的——眼见 B 读不到 A
```

或在完全不碰库的前提下，用 `scripts/preview_policy.py` 离线模拟同样的隔离检查（见 `workflows/verify-policy.md`）。
</local_sandbox>
