# 共用 Skill 创作手册（城邦土地神工作区记忆）

> 在 `workspaces/_shared/skills/` 下创作【领域型】skill（被 `/skill:` 触发、带 references/scripts/templates 的参考指南或操作流程）的房规与验收清单。2026-06-23 建立。
> 与 `agent-skill-playbook.md` 分工：那份讲 skill **怎么被装载与生效**（`--skills-dir` 注入、`--continue` 缓存、自动重置）；这份讲 skill **怎么写得规范、中立、可验收**。
> 创作元技能：`workspaces/_shared/skills/create-agent-skills/`（写 SKILL.md 的专家，动手前先读它的 `references/skill-structure.md` 等）。

## 0. 最容易踩的坑（一句话版）

1. **skills 目录根别放散落 `.md`**：执行器会把它当成一个 skill（名=去后缀文件名）。说明文档要塞进子文件夹。
2. **引用素材一律相对路径 + 正斜杠**：`scripts/x.py`、`references/y.md`；不要绝对路径、不要反斜杠。
3. **脚本跑完清掉 `__pycache__`**：`py_compile` / 运行会生成 `scripts/__pycache__/*.pyc`，别让它进 skill（`rm -rf`）。
4. **浮点预算别用 `//` 整除**：`119.9 // 0.1` 会少算 1（得 1198 而非 1200）。改用 `int(x / cost + 1e-9) + 1`。
5. **LP 占位符是 `{{pt}}` 不是 `{{ap}}`**；用户可见标签写【LP】/【生命点】，**【积分】是保留词**（另有它用）别拿来当 LP 的名字。

## 1. 房规结构（对齐 `create-badge`）

文件夹式，主文件 `SKILL.md`，按需配套：
```
<skill>/
├── SKILL.md              纯 XML 骨架（无 markdown 标题当骨架；正文内可用 ## 作小节）
├── references/           领域知识（被读）；>100 行的顶部放 <table_of_contents>；只一层深
├── workflows/            多步流程（被照做）——路由型 skill 才需要
├── templates/            填空式产物（被复制填写）
└── scripts/              可执行脚本（原样运行）
```

**两种骨架挑一个**（按 skill 性质）：
- **路由型**（多意图任务，如 `create-badge`/`create-event`）：`<essential_principles>` + `<intake>`（问意图）+ `<routing>`（意图→workflow）+ `<reference_index>`/`<workflows_index>`/… + `<success_criteria>`。
- **指南/简单型**（一份参考，如 `lp-usage-design`）：**必带** `<objective>` + `<quick_start>` + `<success_criteria>`，按需加 `<context>`/`<process>`/`<reference_guides>`/`<validation>`。

进阶式披露：`SKILL.md` < 500 行；细节进 `references/`，每个 reference 也用纯 XML。

## 2. 执行器 skill 格式验收

- frontmatter：`name` 小写连字符且**等于目录名**（≤64）、`description` **第三人称**写清【做什么 + 何时用】（≤1024、无 XML 标签）。
- 指南型必备语义标签：`<objective>`/`<quick_start>`/`<success_criteria>`（缺一不可）。
- 脚本：放 `scripts/`；bash 用 `set -euo pipefail`；**别硬编码密钥**（走环境变量）；尽量幂等；顶部写用法注释；销毁/写数据类加 `--dry-run`。Python 优先只用标准库（免装依赖）。

## 3. 中立化清单（本项目硬性要求）

把一份内部经验改写成【独立中立】的共用 skill 时：
- **不出现任何大模型 / 厂商名**（不在此罗列示例，避免又写进去）。
- **真实代码标识可保留**：如常量 `LLM_PT_COST`、流水 reason `llm_reply` —— 它们是本仓库 API、指路必须照实写；但在 prose 里旁注一句【仅指『一次智能体回复』，与具体模型 / 厂商无关】，且 prose 不用裸 `LLM` / 【大模型】，改说【智能体回复 / 对话回复】。
- **移除任何外部产品代号**（按要求一律删）。
- **自包含**：知识沉淀进 skill 自己的 `references/`，**不要**叫读者去翻 `workspaces/*/memory/` 的 playbook；交叉引用只在 skill 目录内。
- **去项目史叙述**：人名拍板、日期、变更史这些对【中立指南】无用，删。
- **简体中文 + 大陆用语**（默认 / 数据库 / 函数 / 代码 / 判定 / 余额 / 内存 / 并发…）。

## 4. 验收自检（grep + 跑脚本）

进 skill 目录后：
```bash
# 厂商 / 外部代号扫描（应为空）
grep -rniE "<厂商与外部代号关键词>" .
# 裸 LLM 当 prose（代码标识 LLM_PT_COST / llm_reply 除外）
grep -rniE "LLM" . | grep -viE "LLM_PT_COST|llm_reply"
# 繁体残留（应为空）
grep -rnoE "預設|資料庫|程式|函式|單次|餘額|簽到|對話|腳本|參數|並" .
# 外部 memory/playbook 引用（自包含 → 应为空）
grep -rniE "memory/|playbook|thoughts/" .
# 保留词 积分（LP 不该叫积分）
grep -rn "积分" .
# 脚本
chmod +x scripts/*.py 2>/dev/null; python3 -m py_compile scripts/*.py
python3 scripts/<x>.py <样例参数>   # 核对数值正确
rm -rf scripts/__pycache__          # 清掉编译产物
```

## 5. 现有共用 skill 目录（`workspaces/_shared/skills/`）

| skill | 性质 | 覆盖 |
|-------|------|------|
| `create-agent-skills` | 元技能 | 怎么写 / 审 SKILL.md（写新 skill 前先读它）。 |
| `create-badge` | 路由型 | 徽章 import / award / list；房规样板（结构对照它）。 |
| `create-event` | 路由型 | 事件设计 → `registerEvent` 注册 → 配图 → dry-run/test 验收。对照 `event-system-playbook` 但**自包含**、用 `{{pt}}`/LP、资产路径写成 soul 相对 `workspaces/<soul>/assets/events/<id>/`。 |
| `lp-usage-design` | 指南型 | 设计某 soul 的 LP 经济（单次扣费 / 初始 / 补底 / 签到 / 命令是否计费 / 退费 / 重置）；含 `scripts/lp_runway.py` 续航模拟器（纯标准库）。对照 `pt-gamification-playbook`。 |

> 这两份（create-event / lp-usage-design）是从内部 memory（event-system / event-creation-prompt / ap-gamification）**中立化重写**而来：去厂商名、去外部产品 / 内部代号、自包含、简体化。要再做同类【把内部经验做成对外 skill】照本手册走。

## 6. 怎么验证一个新 skill 能用

1. **脚本立即可跑**（不必重启）：`python3 workspaces/_shared/skills/<skill>/scripts/<x>.py …`，核对输出数值。
2. **装载生效**：`pnpm agent update`（触发 `reloadSkillsIfChanged` 隔离旧会话）→ **开新会话**提一个对应需求，看 agent 是否加载该 skill。`--continue` 旧会话不重读（见 `agent-skill-playbook.md §4`）。
3. **单独探针**：`kimi --skills-dir <该目录> --output-format stream-json -p "/skill:<名字>"`。
4. （可选）`/audit-skill` 或 skill-auditor 子代理静态审 SKILL.md。
