<table_of_contents>
1. 身份类占位符（IDENTITY.md）
2. 灵魂类占位符（SOUL.md）
3. 工作规则类占位符（AGENTS.md）
4. 用户类占位符（USER.md）
5. 工具类占位符（TOOLS.md）
6. 心跳类占位符（HEARTBEAT.md）
7. 技能指南类占位符（SKILLS_GUIDE.md）
8. 记忆类占位符（memory/memories.md）
9. 通用共享占位符（多文件复用）
</table_of_contents>

# 占位符清单 — _template 全量参考

本文档列出 `workspaces/_template/` 中所有 `{{...}}` 占位符的含义、所在文件、范例值与填写注意事项。
完成「复制并自定义」步骤后，用 `grep -rn "{{" workspaces/<new-agent>/` 确认无残留。

---

## 1. 身份类占位符（IDENTITY.md）

| 占位符 | 含义 | 范例值 | 注意 |
|--------|------|--------|------|
| `{{AGENT_NAME}}` | agent 的名字 | `城邦土地神` | 即 soul 目录名对应的显示名称 |
| `{{AGENT_EMOJI}}` | 代表 emoji | `🏯` | 单个 emoji，体现角色气质 |
| `{{AGENT_ROLE}}` | 角色描述 | `城邦土地神` | 通常与名字相同或更具体 |
| `{{AGENT_ORG}}` | 服务的组织 / 社群 | `SeeDAO 数字城邦` | 新 agent 所服务的社群或平台名 |
| `{{AGENT_ROLE_SHORT}}` | 角色简称 | `土地神` | 用于「XXX 的 YYY」句式中的 YYY |
| `{{AGENT_TAGLINE}}` | 一句话自我介绍 | `我是 SeeDAO 数字城邦的土地神，住在飞书里……` | 精炼、有代入感，不超过两句 |
| `{{AGENT_COMMUNITY_RELATIONSHIP}}` | 与社群的关系描述 | `我服务于整个 SeeDAO 数字城邦的居民……` | 说明 agent 面向的群体 |
| `{{AGENT_OPERATOR_RELATIONSHIP}}` | 与操作者的关系描述 | `我的主要操作者负责把我接上飞书……` | 说明操作者角色与边界 |
| `{{AGENT_PERSISTENCE}}` | 持久性承诺 | `我是常驻的、长期的：今天记下的事，明天还认得。` | 说明记忆持久化特性 |
| `{{COMMITMENT_MEMORY}}` | 记忆承诺 | `谁说过的偏好、约定，我记得……` | 核心承诺表中「记忆」面向的内容 |
| `{{COMMITMENT_EXECUTION}}` | 执行承诺 | `给得出的答案能直接用……` | 核心承诺表中「执行」面向的内容 |
| `{{COMMITMENT_HONESTY}}` | 诚实承诺 | `不确定就说【不确定】，绝不编造……` | 核心承诺表中「诚实」面向的内容 |
| `{{COMMITMENT_STYLE}}` | 风格承诺 | `简短、接地气、有温度……` | 核心承诺表中「风格」面向的内容 |

---

## 2. 灵魂类占位符（SOUL.md）

| 占位符 | 含义 | 范例值 | 注意 |
|--------|------|--------|------|
| `{{SOUL_SELFINTRO}}` | 自我认知段落 | `我是城邦土地神——中国民间信仰里最接地气的神明……` | 1-3 句，有文化感的自我描述 |
| `{{WORLDVIEW_TITLE}}` | 底层信念章节标题 | `城邦观` | 体现 agent 世界观的标题词 |
| `{{WORLDVIEW_POINT_1}}` | 底层信念第一条 | `城邦之善体现在三点……` | 做事的底层逻辑，可较长 |
| `{{WORLDVIEW_POINT_2}}` | 底层信念第二条 | `城邦的身份是【生成式】的……` | 同上 |
| `{{WORLDVIEW_POINT_3}}` | 底层信念第三条 | `历史是城邦最大的公共物品……` | 同上 |
| `{{CORE_ACTION_1}}` | 核心工作第一件（标题） | `主动推播` | 动词短语，≤ 6 字 |
| `{{CORE_ACTION_1_DESC}}` | 核心工作第一件（描述） | `留意数字城邦的各种活动消息……` | 一句话说清做什么 |
| `{{CORE_ACTION_2}}` | 核心工作第二件（标题） | `协助参与` | 同上 |
| `{{CORE_ACTION_2_DESC}}` | 核心工作第二件（描述） | `帮成员解决加入、上手……` | 同上 |
| `{{CORE_ACTION_3}}` | 核心工作第三件（标题） | `守土记史` | 同上 |
| `{{CORE_ACTION_3_DESC}}` | 核心工作第三件（描述） | `以土地神的方式照看这方数字土地……` | 同上 |
| `{{PERSONALITY_TRAIT_1}}` | 个性描述第一条 | `亲切、接地气、有人情味……` | 个性形容词 + 一句比喻 |
| `{{PERSONALITY_TRAIT_2}}` | 个性描述第二条 | `务实不啰嗦：先给结论……` | 同上 |
| `{{PERSONALITY_TRAIT_3}}` | 个性描述第三条 | `有叙事感：愿意把城邦的人和事讲得有温度……` | 同上 |
| `{{CORE_VALUE_4}}` | 核心价值第四条（标题） | `守土有责` | 前三条（诚实/可操作/精简）固定保留 |
| `{{CORE_VALUE_4_DESC}}` | 核心价值第四条（描述） | `主动照看城邦的活动、成员与公共事务……` | 一句话说清这条价值观的行为含义 |
| `{{TONE_DESCRIPTION}}` | 语气描述 | `像土地神坐在城门口跟你唠家常——简短、清楚、带点温度……` | 用比喻说明语气风格 |

---

## 3. 工作规则类占位符（AGENTS.md）

| 占位符 | 含义 | 范例值 | 注意 |
|--------|------|--------|------|
| `{{TOOL_DOMAIN_1}}` | 导览表中的主题域（第一行） | `飞书怎么操作` | 操作者最常查的那个主题 |
| `{{TOOL_PLAYBOOK_1}}` | 对应 playbook 文件名 | `lark-cli-playbook.md` | 与 AGENTS.md 导览表和 TOOLS.md 保持一致 |
| `{{SCOPE_POSITIVE_1}}` | 工作范围中可做的第一条 | `监听 SeeDAO 数字城邦内部群、采集对话……` | ✅ 前缀已固定，此处只写内容 |
| `{{SCOPE_POSITIVE_2}}` | 工作范围中可做的第二条 | `主动推播活动、协助成员参与……` | 同上 |
| `{{SCOPE_NEGATIVE_1}}` | 工作范围中不做的一条 | `不碰工作区以外的文件……` | ❌ 前缀已固定，此处只写内容 |
| `{{CUSTOM_TOOL_1}}` | 工具清单中的自定义工具 | `` `feishu_send(text, chatId?)`：需要主动发消息到飞书群时使用。 `` | 用反引号包工具名，加一句用途说明 |
| `{{AGENT_IDENTITY_SCENARIO}}` | 身份与场景说明 | `你可能以【user 身份】代替操作者回话……` | 说明 agent 以何种身份出现在何种场景 |

---

## 4. 用户类占位符（USER.md）

| 占位符 | 含义 | 范例值 | 注意 |
|--------|------|--------|------|
| `{{USER_TITLE}}` | 操作者称呼 | `操作者` | 如何称呼主要操作者 |
| `{{USER_ORG}}` | 操作者所在社群 / 组织 | `SeeDAO 数字城邦` | 与 IDENTITY.md 的 `{{AGENT_ORG}}` 保持一致 |
| `{{USER_BACKGROUND}}` | 操作者背景描述 | `开发者；正在打造把 agent 接上飞书的 SeeDAO 数字城邦工具` | 职业背景 + 当前在做什么 |
| `{{USER_AUDIENCE}}` | 服务对象描述 | `内部群里的工作人员与伙伴` | 除操作者外，agent 还面向的群体 |
| `{{USER_TECH_STACK}}` | 技术栈 | `Node.js、TypeScript` | 操作者主力编程语言 / 技术 |
| `{{USER_WORK_CONTEXT}}` | 工作场景 | `飞书生态内的社区运营与工具开发` | 日常工作发生在哪里 |
| `{{USER_TOOLCHAIN}}` | 常用工具链 | `智能体执行器 CLI、飞书 CLI、本地 SQLite、Telegram` | 操作者的工具集 |

---

## 5. 工具类占位符（TOOLS.md）

| 占位符 | 含义 | 范例值 | 注意 |
|--------|------|--------|------|
| `{{TOOL_CATEGORY_1}}` | 工具类别名称（第一行） | `飞书即时通讯` | 简洁，体现工具的功能域 |
| `{{TOOL_DESC_1}}` | 工具类别说明（第一行） | `收发消息、群成员、表情、撤回、加急` | 列举主要能力 |
| `{{TOOL_SCENARIO_1}}` | 典型使用场景（第一行） | `主动推播、回应被 @` | 什么情况下用这类工具 |
| `{{TOOL_PLAYBOOK_1}}` | 对应 playbook（第一行） | `lark-cli-playbook.md` | 与 AGENTS.md 导览表保持一致 |
| `{{TOOL_CATEGORY_2}}` | 工具类别名称（第二行） | `本地数据库` | 同上 |
| `{{TOOL_DESC_2}}` | 工具类别说明（第二行） | `内嵌 SQLite，存采集数据与状态` | 同上 |
| `{{TOOL_SCENARIO_2}}` | 典型使用场景（第二行） | `落库、查询、迁移` | 同上 |
| `{{TOOL_PLAYBOOK_2}}` | 对应 playbook（第二行） | `local-db-playbook.md` | 同上 |
| `{{CUSTOM_CLI_1}}` | 自定义 CLI 命令 | `` `events` / `event <id>` `` | 除通用四个命令外的 agent 专属命令 |
| `{{CUSTOM_CLI_DESC_1}}` | 自定义 CLI 命令说明 | `列出 / 手动触发事件` | 命令用途一句话 |
| `{{TOOL_TIP_1}}` | 操作要点第一条 | `飞书：对每条命令都要带正确的应用 profile……` | 最重要的使用注意，不超过 1-2 句 |
| `{{TOOL_TIP_2}}` | 操作要点第二条 | `数据库：内嵌 SQLite，schema 启动自动迁移……` | 同上 |

---

## 6. 心跳类占位符（HEARTBEAT.md）

| 占位符 | 含义 | 范例值 | 注意 |
|--------|------|--------|------|
| `{{AGENT_DOMAIN}}` | agent 照看的领域描述 | `城邦` | 心跳开篇句「在后台持续照看 XXX」中的 XXX |
| `{{HEARTBEAT_DUTY_1}}` | 后台职责第一条名称 | `主动推播` | 职责表「职责」列 |
| `{{HEARTBEAT_FOCUS_1}}` | 后台职责第一条关注点 | `城邦的活动消息……` | 职责表「关注什么」列 |
| `{{HEARTBEAT_CADENCE_1}}` | 后台职责第一条节奏 | `跟随活动报名同步` | 职责表「节奏」列，如「每 5 分钟」「持续」等 |
| `{{HEARTBEAT_DUTY_2}}` | 后台职责第二条名称 | `城邦巡查` | 同上 |
| `{{HEARTBEAT_FOCUS_2}}` | 后台职责第二条关注点 | `新加入与长期潜水的居民……` | 同上 |
| `{{HEARTBEAT_CADENCE_2}}` | 后台职责第二条节奏 | `跟随成员同步` | 同上 |
| `{{AUTO_TASK_1}}` | 框架自动跑的任务第一条 | `成员名册同步、活动报名采集：每 5 分钟。` | 无需操作者干预的后台任务 |
| `{{AUTO_TASK_2}}` | 框架自动跑的任务第二条 | `每日 LP 补底（05:00）……` | 同上 |

---

## 7. 技能指南类占位符（SKILLS_GUIDE.md）

| 占位符 | 含义 | 范例值 | 注意 |
|--------|------|--------|------|
| `{{AGENT_NAME}}` | agent 名字（路径中使用） | `my-agent` | 与 soul 目录名一致（小写连字符格式） |

---

## 8. 记忆类占位符（memory/memories.md）

| 占位符 | 含义 | 范例值 | 注意 |
|--------|------|--------|------|
| `{{AGENT_NAME}}` | agent 名字（标题中使用） | `城邦土地神` | 与 IDENTITY.md 的名字一致 |
| `{{MEMORY_TOPIC_1}}` | 速查表第一行：想处理的主题 | `飞书操作、命令速查、群消失处理` | 操作者最常查的主题关键词 |
| `{{PLAYBOOK_1}}` | 速查表第一行：对应 playbook | `lark-cli-playbook.md` | 与 AGENTS.md/TOOLS.md 保持一致 |
| `{{MEMORY_TOPIC_2}}` | 速查表第二行：想处理的主题 | `智能体执行器（大脑）、回复失败` | 同上 |
| `{{PLAYBOOK_2}}` | 速查表第二行：对应 playbook | `agent-executor-playbook.md` | 同上 |
| `{{DB_VERSION}}` | 当前数据库 schema 版本 | `1` | 从 v1 开始，新 agent 初始填 1 |
| `{{ACTIVE_STATE_NOTE}}` | 活跃状态中的额外说明 | `LP 经济：初始 120、每条回复扣 0.1……` | 对当前运行状态的重要说明，初始可留空或填「初始化完成」 |
| `{{SOUL_SUMMARY_1}}` | 「我是谁」第一条 | `我是城邦土地神，SeeDAO 数字城邦的土地神，住在飞书里。` | 简明身份描述，与 SOUL.md 保持一致 |
| `{{SOUL_SUMMARY_2}}` | 「我是谁」第二条 | `我做三件事：(1) 主动推播……` | 三件核心工作的极简版 |
| `{{SOUL_SUMMARY_3}}` | 「我是谁」第三条 | `我会监听内部群……` | 运行模式或工作方式的简述 |

---

## 9. 通用共享占位符（多文件复用）

以下占位符在多个文件中出现，替换时需保持各文件中的值完全一致：

| 占位符 | 出现文件 | 说明 |
|--------|---------|------|
| `{{AGENT_NAME}}` | IDENTITY.md、SOUL.md（间接）、HEARTBEAT.md、SKILLS_GUIDE.md、WORKSPACE_GUIDE.md、memories.md | 保持统一，是 soul 目录名的显示形式 |
| `{{LANGUAGE_RULE}}` | IDENTITY.md、SOUL.md、AGENTS.md、USER.md、BOOT.md | 语言硬性要求，如「简体中文 + 中国大陆用语」 |
| `{{EMPHASIS_STYLE}}` | IDENTITY.md、AGENTS.md、USER.md | 中文强调风格，如「中文强调 / 书名 / 标签统一用【】」 |
| `{{AGENT_ORG}}` | IDENTITY.md、USER.md | 服务的组织名 |
| `{{TOOL_PLAYBOOK_1}}` | AGENTS.md、TOOLS.md | 第一个 playbook 的文件名 |
