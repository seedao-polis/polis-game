# Workflow：复制并自定义（copy-and-customize）

<required_reading>
在执行本 workflow 前，先读：
- `references/runtime-constraints.md` — 了解命名约束与启动守卫
- `references/placeholders.md` — 了解每个占位符的含义与填写规则
</required_reading>

<process>

## 步骤 1：再次确认 soul 名称不以下划线开头

**这是硬性约束**：新 agent 名称若以 `_` 开头，Runtime 启动守卫会拒绝启动，无法进入对话。
若操作者提供的名称以 `_` 开头，立即警告并要求重新命名。

合法示例：`my-agent`、`newsbot`、`helper-v2`
非法示例：`_myagent`、`_template`、`_test`

## 步骤 2：复制 _template 目录

```bash
cp -r workspaces/_template workspaces/<new-agent-name>
```

复制后验证目录结构（应包含 9 个 .md 文件 + `LP_STRATEGY.json` + memory/ + skills/）：

```bash
ls workspaces/<new-agent-name>/
```

## 步骤 3：逐文件替换占位符

按以下顺序处理每个文件，每处理完一个文件验证无残留：

1. **IDENTITY.md** — 替换：`{{AGENT_NAME}}`、`{{AGENT_EMOJI}}`、`{{AGENT_ROLE}}`、`{{AGENT_ORG}}`、`{{AGENT_ROLE_SHORT}}`、`{{AGENT_TAGLINE}}`、`{{AGENT_COMMUNITY_RELATIONSHIP}}`、`{{AGENT_OPERATOR_RELATIONSHIP}}`、`{{SERVE_PARTY_ROLE}}`、`{{AGENT_PERSISTENCE}}`、`{{COMMITMENT_MEMORY}}`、`{{COMMITMENT_EXECUTION}}`、`{{COMMITMENT_HONESTY}}`、`{{COMMITMENT_STYLE}}`、`{{LANGUAGE_RULE}}`、`{{EMPHASIS_STYLE}}`

2. **SOUL.md** — 替换：`{{SOUL_SELFINTRO}}`、`{{WORLDVIEW_TITLE}}`、`{{WORLDVIEW_POINT_1..3}}`、`{{CORE_ACTION_1..3}}`、`{{CORE_ACTION_1..3_DESC}}`、`{{PERSONALITY_TRAIT_1..3}}`、`{{CORE_VALUE_4}}`、`{{CORE_VALUE_4_DESC}}`、`{{SERVE_PARTY_ROLE}}`、`{{USER_TITLE}}`、`{{LANGUAGE_RULE}}`、`{{TONE_DESCRIPTION}}`

3. **AGENTS.md** — 替换：`{{LANGUAGE_RULE}}`、`{{EMPHASIS_STYLE}}`、`{{TOOL_DOMAIN_1}}`、`{{TOOL_PLAYBOOK_1}}`、`{{SCOPE_POSITIVE_1}}`、`{{SCOPE_POSITIVE_2}}`、`{{SCOPE_NEGATIVE_1}}`、`{{CUSTOM_TOOL_1}}`、`{{AGENT_IDENTITY_SCENARIO}}`、`{{SERVE_PARTY_ROLE}}`

4. **USER.md** — 替换：`{{USER_TITLE}}`、`{{USER_ORG}}`、`{{USER_BACKGROUND}}`、`{{USER_AUDIENCE}}`、`{{SERVE_PARTY_ROLE}}`、`{{USER_TECH_STACK}}`、`{{USER_WORK_CONTEXT}}`、`{{USER_TOOLCHAIN}}`、`{{LANGUAGE_RULE}}`、`{{EMPHASIS_STYLE}}`

5. **BOOT.md** — 替换：`{{LANGUAGE_RULE}}`、`{{SERVE_PARTY_ROLE}}`

6. **TOOLS.md** — 替换：`{{TOOL_CATEGORY_1..2}}`、`{{TOOL_DESC_1..2}}`、`{{TOOL_SCENARIO_1..2}}`、`{{TOOL_PLAYBOOK_1..2}}`、`{{CUSTOM_CLI_1}}`、`{{CUSTOM_CLI_DESC_1}}`、`{{TOOL_TIP_1..2}}`

7. **HEARTBEAT.md** — 替换：`{{AGENT_NAME}}`、`{{AGENT_DOMAIN}}`、`{{HEARTBEAT_DUTY_1..2}}`、`{{HEARTBEAT_FOCUS_1..2}}`、`{{HEARTBEAT_CADENCE_1..2}}`、`{{AUTO_TASK_1..2}}`

8. **SKILLS_GUIDE.md** — 替换：`{{AGENT_NAME}}`（路径中的 soul 名）

9. **WORKSPACE_GUIDE.md** — 替换：`{{AGENT_NAME}}`（所有路径与标题中的出现）

10. **memory/memories.md** — 替换：`{{AGENT_NAME}}`、`{{MEMORY_TOPIC_1..2}}`、`{{PLAYBOOK_1..2}}`、`{{DB_VERSION}}`、`{{ACTIVE_STATE_NOTE}}`、`{{SERVE_PARTY_ROLE}}`、`{{SOUL_SUMMARY_1..3}}`

11. **LP_STRATEGY.json** — 无占位符，默认随样板带「停用评分」版（每条固定扣 `cost`、不评分，等于老行为），一般不动。只有需要「按每次交流的内容给 LP 评分 / 加分」的 agent（如访谈类）才改 `judgeEnabled:true` 并定义 `categories`（含 `criteria` 判定标准）。字段与范例见 `references/lp-strategy.md`。

12. **HEARTBEAT_CONFIG.json** — 无占位符，直接随样板复制（`enabled:false` 预设停用）。
    - 如需调整节奏：改 `cadenceMinutes`（分钟数）
    - 如需调整闸门：改 `silentHours`、`probability`、`dailyLimit`
    - 确认 HEARTBEAT.md 内容写妥后再改 `enabled:true` 启动心跳

## 步骤 4：确认无残留占位符

```bash
grep -rn "{{" workspaces/<new-agent-name>/
```

若输出非空，列出所有残留项并逐一处理，直到输出为空。

## 步骤 5.5：确认 HEARTBEAT_CONFIG.json 存在

```bash
ls workspaces/<new-agent-name>/HEARTBEAT_CONFIG.json
```

文件应存在（从 _template 复制而来）。若不存在，手动从 `_template/HEARTBEAT_CONFIG.json` 复制一份。

## 步骤 5：删除 BOOT.md 顶部的样板警告

`_template/BOOT.md` 顶部有一段警告文字（以 `⚠️` 开头），这是针对样板的防误启动提示。
新 agent 的 BOOT.md 中**必须删除这段警告**，保留「# 启动 BOOT」及其后的内容。

</process>

<success_criteria>
- `workspaces/<new-agent-name>/` 目录存在，包含完整的 9 个 .md 文件 + `LP_STRATEGY.json` + `HEARTBEAT_CONFIG.json`
- `grep -rn "{{" workspaces/<new-agent-name>/` 输出为空（无残留占位符）
- BOOT.md 顶部的 `⚠️` 样板警告已删除
- 可以进入下一个 workflow：`register-agent.md`
</success_criteria>
