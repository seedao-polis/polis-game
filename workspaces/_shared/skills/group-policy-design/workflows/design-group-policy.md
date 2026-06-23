# 工作流：为一个群设定 / 调整应对策略

<required_reading>
**开始前先读：**
1. references/tier-policy.md（三级模型、单向向下保密、专属提示写作原则）
2. references/prompt-assembly.md（分级政策与专属提示如何进入系统提示）
3. references/apply-in-code.md（落点、listen、生效流程）
</required_reading>

<process>
## 第 1 步：收集规格

复制 `templates/group-policy-spec.md` 的〈填写区〉，跟用户把这些定下来：群名称、chat_id、群层级、受众、可讲、不可讲、语气、专属提示（选填）、是否已 listen。chat_id 不明就先描述群、帮用户查。

## 第 2 步：定层级

按 `tier-policy.md` 的三级模型选 `public` / `member` / `work`。把握【单向向下保密】：低密群不可透露高密群的事。拿不准就往保守选（更低密级）。未显式标的群会落到 `defaultTier`（通常 public）。

## 第 3 步：写群专属提示（若需要）

只有【本群跟同层级其他群不同】时才写 `systemPromptAppend`。遵守写作原则：开头点明情境 → 受众 → 可以讲 → 不可以讲 → 语气；不重复分级政策、不重复人格；≤100 字。没有特殊规则就留空，光靠分级政策即可。

## 第 4 步：产出配置条目 + listen 提醒

给出 `configs/chat-policies.json` 的群条目（name / tier / systemPromptAppend），并**明确提醒**确认 `configs/agents.json` 的 `listen` 包含此 chat_id——否则机器人收不到该群消息。

## 第 5 步：验证

离线：用 `scripts/preview_policy.py` 把该群条目放进规格、跑该群某个 open_id，确认【群层级】【群专属提示】如预期。
实测：`agent memory preview --chat <chat_id> --user <open_id>`，看【群层级】一行是否为预期层级。

## 第 6 步：交付 + 生效提醒

交付【配置条目 + listen 状态 + 验证命令】。提醒：改 `chat-policies.json` 要**重建 + 重启 serve**；已存在的会话重开后才带上新系统提示。除非用户明确要求，不直接改配置。
</process>

<anti_patterns>
- 在专属提示里重复分级政策或人格（见 anti-patterns.md）。
- 设了策略却忘了把群加进 `listen`。
- 改完配置不重启就以为生效。
</anti_patterns>

<success_criteria>
本工作流完成时：
- [ ] 层级选定，【可讲 / 不可讲】符合单向向下保密。
- [ ] 专属提示（若有）只写本群独有规则，≤100 字；否则留空。
- [ ] 给了 `chat-policies.json` 条目 + listen 确认 + 验证命令 + 重启提醒。
- [ ] 用模拟器或 `agent memory preview` 验证过群层级。
- [ ] 没有直接改配置（除非用户明确要求）。
</success_criteria>
