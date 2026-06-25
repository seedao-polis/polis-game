# Workflow：收集需求（gather-requirements）

<required_reading>
在执行本 workflow 前，先读：
- `references/agent-anatomy.md` — 了解 workspace 结构与九个人格文件的职责
- `references/placeholders.md` — 了解需要填写哪些占位符，以便有针对性地收集信息
</required_reading>

<process>

## 步骤 1：准备需求规格表

打开 `templates/agent-spec.md`，将它作为收集需求的引导框架。

## 步骤 2：向操作者提出以下问题（若未在指令中提供）

按规格表的分区逐一确认：

**基本身份**
- 新 agent 叫什么名字？（将成为 soul 目录名，用小写连字符，不可以 `_` 开头）
- 用什么 emoji 代表它？
- 一句话角色描述是什么？
- 服务哪个社群 / 组织？
- 操作者是谁、背景如何？

**核心工作**
- 主要做哪三件事？（对应 `{{CORE_ACTION_1..3}}` 与描述）

**语言与风格**
- 使用什么语言？（如「简体中文 + 中国大陆用语」）
- 语气是什么风格？（如「亲切、接地气」）

**工具环境**
- 主要使用哪些工具？（决定 TOOLS.md 的工具类别表）
- 有没有除通用四条（serve/update/cli/doctor）之外的专属 CLI 命令？

**后台职责（HEARTBEAT）**
- 有没有后台定时任务？若有，说明职责、关注点和节奏。
- 框架是否需要自动跑某些任务？

## 步骤 3：整理并确认信息

将收集到的信息填入规格表格式，返回给操作者确认。若有遗漏或模糊项，此时澄清。

## 步骤 4：确认 soul 名称合法

特别确认 soul 名称（新目录名）：
- 全部小写，只含字母、数字、连字符
- 不以 `_` 开头
- 在 `workspaces/` 下不与现有目录冲突（可用 `pnpm agent souls` 查看现有列表）

</process>

<success_criteria>
- 规格表中所有必填项均已填写，无空缺或「待定」
- soul 名称合法（小写连字符，不以 `_` 开头）
- 操作者已确认信息无误
- 可以进入下一个 workflow：`copy-and-customize.md`
</success_criteria>
