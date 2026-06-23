# 智能体执行器 Skill 系统适配手册（城邦土地神工作区记忆）

> 给每个 soul（角色）配自己的 Agent Skills，并在改 skill 后自动让会话生效。改 skill 相关代码、放新 skill、或排查“skill 没生效”前，先读这份。
> 执行器实测行为确立。命令 / 参数 / 字段保留原文。与 `agent-executor-playbook.md`（执行器）、`self-heal-playbook.md`（会话隔离 / 重置）配套。

## 0. 最容易踩的坑（一句话版）

1. **改了 skill，老聊天看不到**：执行器在**会话创建那一刻**就把 skill 集合 + 内容定死，`--continue` 续接**不重扫、不重读**（和 AGENTS.md 缓存同理，见 `agent-executor-playbook.md §3`）。改 / 加 / 删 skill 只对**新会话**生效。
2. **已自动兜底**：每次 worker（重）启动——`agent serve` 重启 + `agent update` 的 SIGHUP 热重启——都会跑 `reloadSkillsIfChanged(soul)`，skill 文件有变就隔离该 soul 的全部会话，相关群下一句话自动重建会话载入新 skill。**首次启动只记录指纹、不动会话**（避免一上线就清空所有人短期记忆）。
3. **`--skills-dir` 是“取代”不是“叠加”**：传了它，执行器就**不再**自动探索用户级 / 项目级 skill 目录；要同时有共用 + 专属，必须把两个目录都用 `--skills-dir` 列出来（可重复）。
4. **skills 目录根别放散落的 `.md`**：执行器会把 skills 目录下任意 `.md` 当成一个 skill（名字 = 去后缀文件名）。说明性文档要塞进子文件夹、或别叫 `.md`。

## 1. 执行器原生 skill 格式（已验证）

依执行器官方文档与实测确立。

- 一个 skill = 一个**文件夹**，主文件必须叫 `SKILL.md`（大写），带 YAML frontmatter。
- frontmatter 字段全部可选：
  - `name`：1–64 字符，只能小写字母 / 数字 / 连字符；省略时默认 = 文件夹名。
  - `description`：1–1024 字符（影响是否选用这个 skill，要写清“什么时候用”）。
  - `license`、`compatibility`（≤500 字符）、`metadata`（自定义键值）、`type`（设 `flow` 即流程型 skill，可内嵌 Mermaid/D2）。
- 文件夹式（官方推荐、本项目用法）：
  ```
  <skills-dir>/<skill-name>/
  ├── SKILL.md          必需
  ├── scripts/          可选：脚本
  ├── references/       可选：参考文档
  └── assets/           可选：素材
  ```
  SKILL.md 正文用**相对路径**引用素材（`scripts/foo.py`、`references/bar.md`）。
- 也支持扁平式（skills 目录里直接一个 `.md`，名字 = 文件名）；与同名文件夹冲突时**文件夹优先**。
- 调用：`/skill:<name>`、`/skill:<name> 补充文字`、`/flow:<name>`。

## 2. 目录探索与 `--skills-dir`

- `kimi --skills-dir <dir>`：从该目录加载 skill，**取代**自动探索的用户级 / 项目级目录；**可重复**多次叠加。本框架靠它给每个 soul 指定专属目录。
- 不带 `--skills-dir` 时执行器会自动探索项目级 / 用户级 / 配置指定（`config.toml` 的 `extra_skill_dirs`）/ 内置等约定目录；**本框架一律显式传 `--skills-dir`，不依赖自动探索**，所以这些默认目录不影响本项目。
- 其他相关参数：`--add-dir`（加工作目录、可重复）；`-p` / `--continue` / `--output-format` 见 `agent-executor-playbook.md §2、§3`。

## 3. 本框架的放法：两层目录 + 启动注入

- **两层目录**：
  - 共用（所有 soul）：`workspaces/_shared/skills/`
  - 专属（单个 soul）：`workspaces/<soul>/skills/`
- **启动注入链路**：`src/core/skills.ts` 的 `skillsDirsForSoul(soul)` → `src/core/agent.ts` 的 `resolveSkillsDirs()` → `healSetup()` → `src/core/kimi.ts` 的 `buildArgs()` 拼出重复 `--skills-dir`。最终执行器收到：
  ```
  kimi ... --skills-dir <repo>/workspaces/_shared/skills --skills-dir <repo>/workspaces/<soul>/skills ...
  ```
  共用层在前、专属层在后；**只有存在的目录才加**（`fs.existsSync` 过滤，共用层为空也不报错）。
- **与 memory 的分工**：**程序性、可 `/skill:` 触发、带脚本 / 素材**的能力做成 skill；**背景知识、持续累积**的留在 `workspaces/<soul>/memory/`。
- 现有示例 skill：`workspaces/tudigong/skills/agent-self-heal/`（`SKILL.md` + `scripts/doctor.sh` + `references/notes.md`），把自愈流程包成可 `/skill:` 触发的能力。

## 4. `--continue` 缓存陷阱（实测过程）

隔离 cwd + 纯文本探针 skill（不带脚本、明令不执行任何工具）实验：

| 步骤 | 动作 | 结果 |
|---|---|---|
| 1 | 新会话，`--skills-dir` 只含 `alpha-probe`，调 `/skill:alpha-probe` | 成功输出标记 |
| 2 | 同一个 `--skills-dir` 新增 `beta-probe`，`--continue` 调 `/skill:beta-probe` | 执行器回【beta-probe is not available（current skills: alpha-probe、update-config）】——**新 skill 看不到** |
| 3（对照） | 同一个 `--skills-dir` 开**新会话**调 `beta-probe` | 成功——证明 skill 本身没问题，差别只在 `--continue` |
| 4 | 改 `alpha-probe` 内容再 `--continue` 调 | 返回**旧**内容——连改内容都不生效 |

结论：skill 注册表 + 内容在**会话创建当下**定格，`--continue` 沿用快照。和 `agent-executor-playbook.md §3` 说的 AGENTS.md 缓存是同一回事。

## 5. 自动重置机制（让改 skill 生效）

`src/core/skills.ts` 的 `reloadSkillsIfChanged(soul)`：

- **指纹**：`fingerprintSkills(dirs)` 对两层目录下所有文件做【相对路径 + 内容 SHA-1】汇总再 SHA-1。**用内容哈希不用 mtime**——所以 `git pull` 只改时间戳不会误触发，只有新增 / 删除 / 改内容才变。
- **基准保存**：每个 soul 一个 `.agent/skill-state/<soul>.txt`（runtime 目录、gitignore）。
- **首跑保护**：没有旧基准时只记录指纹、**不重置**任何会话；之后指纹不同才重置。
- **重置范围**：`src/core/kimi-session.ts` 的 `listSoulSessionDirs(soul)` 列出 workDir 落在 `.agent/<soul>/` 下的所有会话，逐一 `quarantineSession()`（移出 `~/.kimi-code/sessions/`、可逆、只丢短期记忆；长期记忆 `workspaces/<soul>/memory` 不动）。
- **触发时机**：挂在 `src/bin/agent.ts` 的 `runWorker` 启动流程（pin `AGENT_SOUL` 之后、channel 启动之前）。`agent update` 发 SIGHUP → 监督者杀掉旧 worker → 退出时重新 `spawn` 新 worker → 重跑 `runWorker`，所以 **serve 重启和 update 都覆盖**，且在任何消息处理前完成，不和进行中的 `respond()` 抢。
- 看 log：变更时打印【skill 有变更：已重置 N 个会话】；首跑打印【skill 基线已记录】。

## 6. 新增 / 修改一个 skill 的流程

1. 在 `workspaces/<soul>/skills/<名字>/`（或共用 `workspaces/_shared/skills/<名字>/`）建文件夹。
2. 写 `SKILL.md`（frontmatter `name` 用小写连字符、`description` 写清“什么时候用”）。
3. 按需加 `scripts/` `references/` `assets/`，正文用相对路径引用。
4. `pnpm agent update`（或重启 `serve`）→ 自动重置会话生效，log 会确认重置数。
5. 想单独验证某个 skill 能被加载：`kimi --skills-dir <该目录> --output-format stream-json -p "/skill:<名字>"`。
6. 想手动处理个别群仍可 `agent doctor --fix`（同一套 quarantine 机制）。

## 关键文件

- `src/core/skills.ts`：`skillsDirsForSoul` / `fingerprintSkills` / `reloadSkillsIfChanged`（含指纹读写、首跑保护）。
- `src/core/kimi-session.ts`：`listSoulSessionDirs`（+ 原有 `quarantineSession` / `scanCorruptSessions`）。
- `src/core/agent.ts`：`resolveSkillsDirs()` 委派 skills.ts。
- `src/core/kimi.ts`：`buildArgs()` 拼重复 `--skills-dir`、`KimiRunOptions.skillsDirs`。
- `src/bin/agent.ts`：`runWorker` 启动钩子 + log。
- 设计 / 施工 / 实验全记录：`thoughts/shared/research/2026-06-23-kimi-skill-框架設計與每soul-skills-dir.md`、`thoughts/shared/coding/2026-06-23-kimi-skill框架實作.md`。
