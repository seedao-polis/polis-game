# 工作区结构指南 WORKSPACE_GUIDE

> 本指南只描述 `workspaces/tudigong/` 这个工作区的目录与文件职责。新接手时，读完这份就知道东西放哪、该先看什么。

## 目录树

```
workspaces/tudigong/
├── IDENTITY.md          身份：名字、角色、与城邦/操作者的关系、核心承诺
├── SOUL.md              灵魂：性格、城邦观、核心价值、安全红线与护栏
├── AGENTS.md            工作规则：回答方式、导览表、工作范围、工具、找不到时怎么办
├── USER.md              操作者：称呼、背景、沟通偏好、语言要求
├── HEARTBEAT.md         后台定时职责与【检查心跳】的完成标准
├── BOOT.md              启动行为
├── TOOLS.md             工具类别与常用命令速查
├── WORKSPACE_GUIDE.md   本文件
├── SKILLS_GUIDE.md      技能（skill）的使用与撰写指南
├── memory/              长期记忆与各主题操作手册
│   ├── memories.md      记忆 L0 入口（顶部有速查表）
│   ├── *-playbook.md    各主题操作手册（按需读取）
│   └── journal/         按日记录的工作日志（YYYY-MM-DD.md）
└── skills/              本角色专属技能（可 /skill: 触发）
    └── <skill>/         文件夹式：SKILL.md + scripts/ + references/
```

## 顶层文件（人格层，会被装载进每次对话）

| 文件 | 职责 | 何时读 |
|------|------|--------|
| `IDENTITY.md` | 我是谁、与城邦/操作者的关系、核心承诺 | 调角色定位时 |
| `SOUL.md` | 性格、信念、核心价值、安全红线与工具护栏 | 调语气 / 红线时 |
| `AGENTS.md` | 回答规则、导览表、工作范围、工具清单、When Lost | 不知道去哪找时先看它 |
| `USER.md` | 操作者背景与偏好、语言硬性要求 | 调沟通风格时 |
| `HEARTBEAT.md` | 后台定时职责、完成标准 | 被问【后台 / 心跳】时 |
| `BOOT.md` | 启动后的行为约定 | 启动时 |

## memory/ 目录

`memories.md` 是**主入口**：顶部速查表把【想处理什么】对应到具体 playbook，下面是分主题的重点记忆。先读它，再按需打开某份 playbook。

各 playbook（按需读取，一句话职责）：

| 文件 | 涵盖 |
|------|------|
| `lark-cli-playbook.md` | 飞书操作经验、命令速查、群消失 / 被踢处理 |
| `agent-executor-playbook.md` | 智能体执行器（大脑）：非交互调用、会话、人格 / 工具配置 |
| `self-heal-playbook.md` | 会话中毒、四层自愈、错误分类、串行回复 + 表情 |
| `agent-skill-playbook.md` | skill 装载机制、改 skill 自动生效 |
| `skill-authoring-playbook.md` | 写 / 审一个共用 skill 的房规、中立化、验收 |
| `local-db-playbook.md` | 本地数据库选型、飞书消息字段真相、各数据表 |
| `event-system-playbook.md` | 事件 / 触发框架：发图文、迎新、定时 + 随机 |
| `event-creation-prompt-template.md` | 新建事件时填的模板 |
| `ap-gamification-playbook.md` | LP 点数经济、每日签到 / 补底 |
| `badge-system-playbook.md` | 徽章导入 / 发放 / 查询 |
| `community-notify-events-playbook.md` | 社区推播里程碑事件 |
| `ops-report-playbook.md` | 运营数据日报 / 月报（深色图表） |
| `memory-access-playbook.md` | 多人多群记忆隔离、群组三级分类 |
| `telegram-playbook.md` | 运维日志镜像、到期提醒 |

`journal/` 按日存工作日志（`YYYY-MM-DD.md`），记录当天做了什么、踩了什么坑。

## skills/ 目录

本角色专属技能，每个 skill 一个文件夹（`SKILL.md` 为主文件，可带 `scripts/` `references/` `assets/`），可用 `/skill:<名字>` 触发。撰写规范与现有 skill 见 `SKILLS_GUIDE.md`。

## 使用惯例
- **启动顺序**：IDENTITY → SOUL → AGENTS → USER → HEARTBEAT → `memory/memories.md`（也是人读的推荐顺序）。
- **遇到问题**：先看 `memory/memories.md` 速查表 → 打开对应 playbook。
- **沉淀新知识**：背景知识、踩坑经验写进 `memory/`（对应 playbook 或 journal）；可被 `/skill:` 触发的程序性能力做成 `skills/` 下的 skill。
- **保持新鲜**：playbook 是活文档，发现旧记录与现状不符就就地更新。
