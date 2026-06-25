---
name: create-agent
description: 新 agent workspace 创建向导。从 _template 复制出一个完整的 workspace 目录、替换占位符、配置 configs，直到 agent 可以 CLI 对话验收。当需要新增一个 agent（新增 workspace、新增 soul）时使用。
---

<essential_principles>
### 1. 从样板复制，不从头建立

所有新 agent 必须从 `workspaces/_template/` 复制，不手动建立空目录再逐个填写文件。
样板确保结构一致性，也确保所有必要文件都存在。

### 2. 新 agent 名称不可以下划线开头

下划线前缀（`_`）是工具型目录的命名约定（`_shared`、`_template` 均属此类）。
Runtime 的启动守卫会拒绝以 `_` 开头的 soul 名称——新 agent 名称若以下划线开头，将无法启动。

### 3. 建立 workspace 后，上飞书是另一步

建立目录只是第一步：
- **本地验证**：`pnpm agent cli <name>` 立即可跟它对话（不碰外部服务）。
- **上飞书当 bot**：在 `configs/agents.json` 加一个 `<soul>-bot` 条目，然后转共用 skill **`onboard-lark-bot`** 完成完整接入（建飞书 app、配权限与事件、发布、写 `configs/lark.json` profile、`serve` 起来）。

常驻服务用 `pnpm agent serve <soul> --bot`（`--bot` / `--user` / `--both` 选身份，**不再看 `enabled` 字段**）。
</essential_principles>

<intake>
你想做什么？

1. 建立全新 agent（从 _template 复制 + 完整配置）
2. 只替换占位符（已复制，跳过复制步骤）
3. 只配置 configs（已自定义，跳过前两步）
4. 验收现有 agent（确认 CLI 可用 + 服务可启动）

**先回应再继续。若已在指令中说清楚意图，直接按路由进对应 workflow。**
</intake>

<routing>
| 回应 | Workflow |
|------|----------|
| 1、「建立」「新增」「create」「全新」 | 依次执行 `workflows/gather-requirements.md` → `workflows/copy-and-customize.md` → `workflows/register-agent.md` → `workflows/verify-agent.md` |
| 2、「替换占位符」「自定义」「customize」 | `workflows/copy-and-customize.md` → `workflows/register-agent.md` → `workflows/verify-agent.md` |
| 3、「配置 configs」「register」「登记」 | `workflows/register-agent.md` → `workflows/verify-agent.md` |
| 4、「验收」「verify」「测试」「check」 | `workflows/verify-agent.md` |

**读完 workflow 后严格照它执行。**
</routing>

<reference_index>
领域知识在 `references/`：

- **agent-anatomy.md** — workspace 结构：各文件职责、装载顺序、memory/ 与 skills/ 的用途、双层 skill 机制。
- **placeholders.md** — 全部占位符清单：每个 `{{...}}` 的含义、范例值、填写注意事项。
- **configs-setup.md** — configs 配置：`agents.json` 字段说明、`lark.json` profile 配置、`AGENT_SOUL` 环境变量。
- **runtime-constraints.md** — Runtime 约束：`listSouls()` 行为、启动守卫、soul vs workspace 的区别、skill 生效时机。
</reference_index>

<workflows_index>
| Workflow | 用途 |
|----------|------|
| gather-requirements.md | 收集新 agent 的名字、人设、服务社群、语言等需求 |
| copy-and-customize.md | 从 _template 复制目录 + 逐文件替换占位符 |
| register-agent.md | 在 configs/agents.json 配置 agent 条目 + 确认 profile |
| verify-agent.md | CLI 对话测试 + 服务启动确认 + 验收 checklist |
</workflows_index>

<success_criteria>
一次成功的新 agent 建立：
- `workspaces/<new-agent>/` 目录已建立，所有文件中无残留 `{{}}` 占位符。
- `configs/agents.json` 中有对应 agent 条目（soul 和 workspace 均指向新目录名）。
- `pnpm agent cli <new-agent>` 可以正常对话，agent 能正确介绍自己。
- 未建立以 `_` 开头为 soul 名称的 agent。
- 新 agent 在 `pnpm agent souls` 列表中可见。
- （如需上飞书当 bot）转共用 skill `onboard-lark-bot` 完成 app / 权限 / 发布 / lark.json / serve。
</success_criteria>
