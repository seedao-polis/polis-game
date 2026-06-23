# 技能指南 SKILLS_GUIDE

> 本角色可挂自己的技能（skill）：把程序性、可触发、带脚本 / 素材的能力封装起来。本指南讲怎么用、怎么写；装载机制的底层细节见 `memory/agent-skill-playbook.md`，撰写房规见 `memory/skill-authoring-playbook.md`。

## 目录结构

```
skills/
└── <skill-name>/
    ├── SKILL.md       必需：主文件，带 YAML frontmatter
    ├── scripts/       可选：可执行脚本
    ├── references/    可选：参考文档
    └── assets/        可选：素材
```

技能分两层放：本角色专属的放 `workspaces/tudigong/skills/`；所有角色共用的放共用层。本指南聚焦本工作区的 `skills/`。

## 如何调用 skill
- 触发语法：`/skill:<名字>`，可在后面补一句话说明意图。
- **生效时机**：技能在会话创建那一刻定格——新增 / 改 / 删 skill 只对**新会话**生效。
- **自动重载**：每次服务重启或热更新会按内容指纹检测 skill 变化，有变就重置受影响会话，下次对话自动载入新内容（首次启动只记基准、不动会话）。

## 现有技能

| 技能 | 用途 | 触发时机 |
|------|------|---------|
| `agent-self-heal` | 诊断并修复损坏的执行器会话（隔离 + 重建） | 续接会话持续报 HTTP 400 时 |

## 新增 / 修改一个 skill
1. 在 `skills/<名字>/` 建文件夹。
2. 写 `SKILL.md`：frontmatter 的 `name` 用小写连字符且等于目录名，`description` 用第三人称写清【做什么 + 何时用】。
3. 按需加 `scripts/` `references/` `assets/`，正文用相对路径引用。
4. 重启服务或热更新 → 自动重置会话生效。
5. 单独验证：开一个新会话调 `/skill:<名字>`。

## SKILL.md 格式规范
- 主文件必须叫 `SKILL.md`（大写）。
- 进阶式披露：`SKILL.md` 控制在 500 行内，细节拆进 `references/`。
- 两种骨架挑一个：**路由型**（多意图，问意图 → 路由到流程）/ **指南型**（一份参考，必带 objective + quick_start + success_criteria）。
- 脚本放 `scripts/`，相对正斜杠路径；bash 用 `set -euo pipefail`，别硬编码密钥。

## 中立化要求（写共用 skill 必守）
- 不出现任何外部产品代号、厂商或模型名。
- 自包含：知识写进 skill 自己的 `references/`，别让读者去翻 `memory/`。
- 去项目史叙述（人名拍板、日期、变更史）。
- 简体中文 + 大陆用语。
- 真实代码标识（常量 / 字段名）可保留，但旁注它与具体模型无关。

## 验收自检
进 skill 目录后：
- 厂商 / 外部代号扫描应为空。
- 繁体残留扫描应为空。
- 脚本能编译、能按样例参数跑出正确数值，跑完清掉编译产物。

> 完整房规与 grep 命令见 `memory/skill-authoring-playbook.md`。
