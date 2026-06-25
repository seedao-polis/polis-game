# 工作区结构指南 WORKSPACE_GUIDE

> 本指南描述 `workspaces/profile-writer-yihan/` 这个工作区的目录与文件职责。新接手时，读完这份就知道东西放哪、该先看什么。

## 目录树

```
workspaces/profile-writer-yihan/
├── IDENTITY.md          身份：名字、角色、与社群/操作者的关系、核心承诺
├── SOUL.md              灵魂：性格、人物志观、核心价值、安全红线与护栏
├── AGENTS.md            工作规则：回答方式、导览表、工作范围、话题边界、工具
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
├── examples/            历史 SeeDAO 人物志范文（写初稿 / 定文风时参考；非自动注入）
└── skills/              本角色专属技能（可 /skill: 触发）
    └── <skill>/         文件夹式：SKILL.md + scripts/ + references/
```

## 顶层文件（人格层，会被装载进每次对话）

| 文件 | 职责 | 何时读 |
|------|------|--------|
| `IDENTITY.md` | 我是谁、与社群/操作者的关系、核心承诺 | 调角色定位时 |
| `SOUL.md` | 性格、人物志观、核心价值、安全红线与工具护栏 | 调语气 / 红线时 |
| `AGENTS.md` | 回答规则、导览表、工作范围、话题边界、工具清单、When Lost | 不知道去哪找时先看它 |
| `USER.md` | 操作者背景与偏好、语言硬性要求 | 调沟通风格时 |
| `HEARTBEAT.md` | 后台定时职责、完成标准 | 被问【后台 / 心跳】时 |
| `BOOT.md` | 启动后的行为约定 | 启动时 |

## memory/ 目录

`memories.md` 是**主入口**：顶部速查表把【想处理什么】对应到具体 playbook，下面是分主题的重点记忆。先读它，再按需打开某份 playbook。

各 playbook（按需读取，一句话职责）：

| 文件 | 涵盖 |
|------|------|
| `interview-methodology-playbook.md` | 人物志理论、采访姿态、提问框架（以人为主）、追问技巧、进度告知、范文文风与提问取向、话题边界与婉拒 |
| `profile-deliverables-playbook.md` | 人物志产出清单、人物素材卡格式、人物志初稿写作要求与结构 |

`examples/`（工作区根目录、与 `memory/` 同级）存了 8 篇历史 SeeDAO 人物志范文，写初稿 / 定文风前可参考；黄金模板与提问取向见 `interview-methodology-playbook.md` 第七节。

`journal/` 按日存工作日志（`YYYY-MM-DD.md`），记录当天访谈了谁、整理了什么、留了哪些待确认。

## skills/ 目录

本角色专属技能，每个 skill 一个文件夹（`SKILL.md` 为主文件，可带 `scripts/` `references/` `assets/`），可用 `/skill:<名字>` 触发。撰写规范见 `SKILLS_GUIDE.md`。

## 使用惯例
- **启动顺序**：IDENTITY → SOUL → AGENTS → USER → HEARTBEAT → `memory/memories.md`（也是人读的推荐顺序）。
- **遇到问题**：先看 `memory/memories.md` 速查表 → 打开对应 playbook。
- **沉淀新知识**：访谈方法、产出经验写进 `memory/`（对应 playbook 或 journal）；可被 `/skill:` 触发的程序性能力做成 `skills/` 下的 skill。
- **保持新鲜**：playbook 是活文档，发现旧记录与现状不符就就地更新。
