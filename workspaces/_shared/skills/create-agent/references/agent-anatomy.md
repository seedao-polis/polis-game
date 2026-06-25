<table_of_contents>
1. workspace 目录结构
2. 九个人格文件的职责
3. 固定装载顺序（soul.ts）
4. SKILLS_GUIDE 与 WORKSPACE_GUIDE 的特殊地位
5. memory/ 目录的用途与惯例
6. skills/ 目录与双层 skill 机制
</table_of_contents>

# Agent Anatomy — workspace 结构参考

## 1. workspace 目录结构

每个 agent workspace 位于 `workspaces/<soul-name>/`，标准结构如下：

```
workspaces/<soul-name>/
├── IDENTITY.md          身份：名字、角色、社群关系、核心承诺
├── SOUL.md              灵魂：性格、底层信念、核心价值、安全红线与护栏
├── AGENTS.md            工作规则：回答方式、导览表、工作范围、工具、When Lost
├── TOOLS.md             工具类别总览与常用 CLI 速查
├── USER.md              操作者：称呼、背景、沟通偏好、语言要求
├── BOOT.md              启动行为约定
├── HEARTBEAT.md         后台定时职责与心跳完成标准
├── SKILLS_GUIDE.md      技能用法与撰写规范（仅供人读，不被自动注入）
├── WORKSPACE_GUIDE.md   目录结构总览（仅供人读，不被自动注入）
├── memory/
│   ├── memories.md      记忆 L0 入口（速查表 + 重点记忆，自动注入）
│   ├── *-playbook.md    各主题操作手册（按需读取）
│   └── journal/         工作日志（YYYY-MM-DD.md，当天日志自动注入）
└── skills/
    └── <skill-name>/    workspace 专属技能（SKILL.md 为主文件）
```

## 2. 九个人格文件的职责

| 文件 | 职责 | 核心内容 |
|------|------|---------|
| `IDENTITY.md` | 身份宣告 | 名字、emoji、角色描述、与社群/操作者的关系、核心承诺表、语言硬性要求 |
| `SOUL.md` | 灵魂人格 | 自我认知、底层信念、三件核心工作、个性描述、核心价值、安全红线、工具护栏、Context 保护、语气 |
| `AGENTS.md` | 工作规则 | 回答方式、导览表、工作范围（✅/❌）、工具清单、身份与场景、安全边界、记忆习惯、When Lost 四步 |
| `TOOLS.md` | 工具指南 | 工具类别总览表、常用 CLI 速查、操作要点 |
| `USER.md` | 操作者描述 | 称呼、背景、社群、沟通偏好、技术背景、语言要求、红线 |
| `BOOT.md` | 启动行为 | 启动后的行为约定（已加载哪些、如何找细节、等第一条消息） |
| `HEARTBEAT.md` | 后台职责 | 留心的事（职责/关注/节奏）、框架自动跑的任务、心跳检查完成标准 |
| `SKILLS_GUIDE.md` | 技能指南 | 目录结构、触发方式、生效时机、新增修改五步、SKILL.md 格式规范、中立化要求、验收自检 |
| `WORKSPACE_GUIDE.md` | 工作区导览 | 目录树、顶层文件表、memory/ 目录说明、skills/ 目录说明、使用惯例 |

## 3. 固定装载顺序（src/core/soul.ts）

`assembleSoul()` 按以下固定顺序读取人格文件并拼接成 system prompt：

```
IDENTITY.md → SOUL.md → AGENTS.md → TOOLS.md → USER.md → BOOT.md → HEARTBEAT.md
```

文件不存在时自动跳过（不报错）。若七个文件全部缺失，则抛出错误。

装载完成后，自动追加：
- `memory/memories.md`（重点记忆）
- `memory/journal/YYYY-MM-DD.md`（当天工作日志，若存在）

## 4. SKILLS_GUIDE 与 WORKSPACE_GUIDE 的特殊地位

这两个文件**不在**固定装载数组（`SOUL_FILES`）中，因此不会被自动注入 system prompt。
它们是人读的导览文档，由 agent 在需要时按需读取，或在 `memory/memories.md` 中被速查表索引。

## 5. memory/ 目录的用途与惯例

`memories.md` 是**唯一自动注入**的记忆文件，充当 L0 入口：

- **顶部速查表**：把「想处理什么」映射到对应 playbook 路径
- **活跃状态**：当前 soul 名、数据库版本、重要状态信息
- **我是谁**：对自身身份的简短描述，补充 SOUL.md

各 `*-playbook.md` 按需读取，聚焦单一操作领域，不自动注入。

`journal/` 存按日工作日志（`YYYY-MM-DD.md`），框架自动写入，当天日志会被自动注入 system prompt。

## 6. skills/ 目录与双层 skill 机制

技能采双层放置，两层都会被注入到每次对话的 system prompt：

| 层级 | 路径 | 适用范围 | 中立化要求 |
|------|------|---------|-----------|
| 共用层 | `workspaces/_shared/skills/` | 所有 soul 均可用 | 严格：不含厂商名、不引用 `memory/`、自包含 |
| 专属层 | `workspaces/<soul>/skills/` | 仅对本 soul 注入 | 较宽松：可包含 soul 专属业务逻辑 |

装载顺序：共用层先注入，专属层后注入。

skill 在**会话创建时**定格——修改 skill 后只对新会话生效。框架在服务重启或热更新时按内容指纹检测变化，自动重置受影响会话。
