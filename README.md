<p align="center">
  <img src="https://i.meee.com.tw/fZxY8RF.png" alt="城邦游戏 Polis Game" width="100%">
</p>

<h1 align="center">城邦游戏 Polis Game</h1>

<p align="center">
  <b>SeeDAO 数字城邦的社区运营游戏化框架</b><br>
  结合飞书 · Kimi CLI · Telegram
</p>

---

**城邦游戏 Polis Game** 是 SeeDAO 数字城邦的社区运营游戏化框架：结合**飞书**（社区身份与互动）、**Kimi CLI**（智能体大脑）与 **Telegram**（运维日志与提醒），把一个常驻 agent——城邦土地神——安置在飞书里：监听社区群、采集对话进知识库，被 @ 或符合触发条件时回应；同时持续采集运营数据（成员、活动报名、文档访问），并把日常的社区参与变成一套可玩的游戏化机制——生命点（LP）、徽章、等级、排行榜、里程碑推播，以及自动生成的运营数据报告。

## 快速开始

```bash
pnpm install
pnpm build                       # tsc 编译到 dist/
cp .env.example .env             # 按需填写（见下方【环境变量】）
# 配置（含真实飞书 ID/密钥，已 gitignore）：从模板复制后按需填写
for f in configs/*.example; do cp -n "$f" "${f%.example}"; done
pnpm agent serve                 # 启动常驻服务（监督者，支持热重启）
```

> `configs/*.json` 与 `.env` 含真实身份信息，已被 `.gitignore`；仓库只提供 `*.example` 模板。
> 未创建真实 `configs/*.json` 时，框架会自动回退读取 `*.example`（占位值），便于首次启动与跑测试。
> 每位开发者用各自的 `.claude/`（也已 gitignore），与本仓库无关。

改完代码热重启：`pnpm agent update`（重新编译 + 平滑重启运行中的 serve）。

## 命令

```
agent cli [soul]                              本地终端 REPL，直接跟 agent 对话（不碰飞书，有对话记忆）
agent serve [soul] [--bot|--user|--both] [--sup] [--quiet]  启动常驻服务；不带 soul 默认 tudigong；启动模式互斥、默认 --bot：--bot 只起 bot、--user 只起 user 采集、--both 都起；加 --sup 挂监督者（热重启 / 定时事件 / LP 补底）；--quiet 静默/观察模式：照常采集但不回复任何飞书消息
agent update [--pull]                         重新编译并热重启运行中的 serve（--pull 先 git pull）
agent agents                                  列出 configs 里的 agent 及其 identity / listen / trigger
agent run <soul> [--channel cli]              本地 REPL 测试
agent ask <soul> <消息...>                    一次性问答（非互动）
agent souls                                   列出可用的 soul（workspaces/）
agent backfill                                把旧 JSONL 采集记录迁移到 SQLite
agent backfill-members                        从历史日志补录群成员同步轮次
agent calendar-events                         列出追踪中的未开始活动及最新报名数
agent doc-views                               列出最近采集的文档访问记录（访问者 + 最近访问时间）
agent report daily|monthly [--date YYYY-MM-DD] [--lark-user <open_id>] [--lark-chat <chat_id>] [--no-narrative]   生成并发送运营数据报告（深色图表 + 日报 AI 洞察 → Telegram，可选飞书私聊/群；--no-narrative 只发图表）
agent token-check [--test]                    查看 user token 剩余有效期并按需推送到期提醒
agent daily-reset [--floor <n>]              立即执行每日 LP 补底
agent reset-all-pt [--to <n>]                把所有人 LP 重置为同一数值（默认 120；走共享库 shared.db）
agent lp-migrate [--from <soul>]             把某 soul 库的 LP/徽章迁入共享库 .agent/shared.db（默认 from tudigong）
agent link <from_open_id> <to_open_id>       跨 app 同一人的身份归并：from 的 LP 记到 to
agent doctor [--fix]                          扫描损坏的执行器会话（--fix 隔离损坏会话）
agent events                                  列出已定义的事件
agent event <编号|id> [--test] [--to <oc/ou>] [--dry-run]   手动触发一个事件
agent badge import <json_file>               导入徽章定义（JSON 单对象或数组；模板见 create-badge skill）
agent badge award <徽章> <对象...> [--note <文本>] [--dry-run]  给一个或多个成员发放徽章（对象=open_id 或飞书显示名）
agent badge list [对象]                       列出全部徽章定义，或某成员持有的徽章
agent memory list|inspect|add|set|rm|clear   长期记忆运维（增删查；list/inspect 为不过滤的运维视角）
agent memory preview --chat <c> --user <u> [--admin]   以某人在某群的视角，预览实际会注入 prompt 的记忆与群层级（验证记忆隔离）
agent memory summarize|aggregate|purge       手动触发个人记忆摘要 / 群组热词聚合 / 过期记忆清理
agent unsend <message_id> [--as bot|user]    撤回一条已发送的消息
agent tg-test [消息...]                       发一条测试消息到 Telegram
```

## 启动模式：bot 还是本人

`agent serve <soul>` 用 `--bot` / `--user` / `--both` 选要起哪些身份通道（互斥，**默认 `--bot`**）。启动模式由命令行旗标决定，不再依赖 `configs/agents.json` 的 `enabled`、也不再有 `--only`。`tudigong-user` 默认带 `collectOnly`（只采集不回复）。

- **只跑 bot（默认 · 推荐）**

  ```bash
  pnpm agent serve tudigong --bot --sup
  ```

  对外只有 bot 回复；`--sup` 会额外起一个 user 身份的【采集器】，只采集群成员 / 文档访问数据、**绝不回复**。要纯裸 bot（连采集与定时事件 / LP 补底都不要）：去掉 `--sup`，即 `pnpm agent serve tudigong --bot`。

- **bot + 本人都起**

  ```bash
  pnpm agent serve tudigong --both
  ```

  同时起 bot 身份与 user 身份。`--sup` 在场时 user 会被压成只采集（见下）。

- **只跑本人（user 身份）**

  ```bash
  pnpm agent serve tudigong --user
  ```

  只起 user 身份通道。注意 `tudigong-user` 默认 `"collectOnly": true`（只采集不回复）；若要本人身份**真的开口回复**，删掉它的 `"collectOnly": true`，并且**不要加 `--sup`**（`--sup` 会强制把 user 压成只采集）。

> **bot 与本人的区别**：`identity:"bot"` 以机器人身份发言（群里需先把 bot 拉进群，只收到【被 @】的消息）；`identity:"user"` 以操作者本人身份（impersonation）发言 / 采集，能看到本人可见的所有群，但以本人身份在外部群发消息会被飞书拦截，所以本人身份默认 `collectOnly`（只采集、不回复）。

## 新建一个 agent

从样板 `workspaces/_template/` 长出一个新 agent，全程有两个共用 skill 引导（`workspaces/_shared/skills/`）：

- **`create-agent`**：复制 `_template` → 替换占位符 → 登记 `configs/agents.json` → 本地 `pnpm agent cli <soul>` 验收。soul 名**不能以 `_` 开头**（启动守卫会拒绝）。
- **`onboard-lark-bot`**：把建好的 workspace 接上飞书当 bot（建飞书 app、配权限/事件、发布、写 `configs/lark.json` profile、`serve <soul> --bot`）。

详见 `workspaces/tudigong/memory/agent-onboarding-playbook.md`。

## serve 与 CLI 是两种对话场景

每个 agent 都区分两种对话场景，框架在每条 prompt 开头注入一行【对话场景】告诉它现在是哪种：

- **serve 模式**（飞书 p2p 私聊 / 群里被 @）：对面是**外部对话者**——按 agent 本职去服务 / 对待（土地神→城邦居民、一涵→受访者）。**即使对面正好是操作者本人，也一视同仁、不当操作者**，不切到运营 / 配置这类内部对话。
- **CLI 模式**（`agent cli` / `agent ask`）：对面才是**操作者本人**，这时才谈配置、运营、方向设定。

判定只看消息来源 channel（`feishu-*` → serve，其余 → CLI），不看对方身份。样板与 `create-agent` skill 已内置这套约定，新 agent 只需填一个"serve 对话者角色"（`{{SERVE_PARTY_ROLE}}`）。机制与各 agent 特化详见 `workspaces/tudigong/memory/serve-cli-identity-playbook.md`。

## Agent 之间的协作（A2A 暗线广播 + 飞书表演）

飞书平台让 bot 互相听不到对方发言（`senderType==='app'` 的消息在触发判断前就被丢弃），所以多个 agent 没法直接在群里对话。框架用【双轨】绕过：

- **暗线**（飞书外）：`data/peer-bus/<soul>/inbox.jsonl` 文件信箱。一个 agent 在群里发言后，框架把【cue】（谁、哪个群、说了什么摘要）广播给同群其它 agent 的信箱。
- **明线**（飞书群）：收到 cue 的 agent 经 `fs.watch` 唤醒，由框架把它的回复发到同一个群，并续播给其他 agent——群里看起来就是一场自然的多人讨论。

要点：真人 @ 起头（真人消息不被过滤），整条链路的广播 / 发群 / 续播都由**框架确定性执行**（不依赖模型记得调工具），模型只决定"说什么、要不要说"。这是 serve/CLI 之外的**第三种对话场景** `peer`。开关是 `configs/agents.json` 的 `peerCast`（默认 false）；防失控靠链深度（≤6）、预算（8）、每群每小时上限（3）。这类协作群可在 `configs/chat-policies.json` 标 `excludeFromOpsReport:true` 从运营报告整群剔除。完整机制与踩坑详见 `workspaces/tudigong/memory/a2a-peer-broadcast-playbook.md`。

## LP 是跨 agent 的共享经济

积分（LP）、徽章、用户 profile 存在**共享库** `.agent/shared.db`，所有 agent 共用一套经济；对话记忆仍按 agent 隔离在各自 `.agent/<soul>.db`。

- 每个飞书 app 给同一个人**不同的 open_id**，同一人跨多个 bot 时 LP 会分叉。用 `pnpm agent link <新open_id> <canonical open_id>` 归并身份（只用一个 bot 的成员不用做）。
- 首次启用共享库已用 `pnpm agent lp-migrate` 把现有 LP 种进去。
- **LP 变动可按交流内容动态判定**：每个 soul 可配 `workspaces/<soul>/LP_STRATEGY.json`——每条回复先扣 `cost`，agent 在回复尾行输出一行分类标记，框架按策略决定本回合加分与状态行标签（如一涵的访谈中 / 画重点 / 无关）；不配或停用即固定扣分（tudigong 如此）。
- 详见 `workspaces/tudigong/memory/pt-gamification-playbook.md` 第 9（共享库）、10（评分机制）节。

## 多 bot 与 Lark profile

每个 soul / bot 可以挂自己的一组 Lark 凭证（`configs/lark.json` 的 `profiles`），于是同一套代码能同时跑好几个不同的 bot。`agent serve <soul>` 启动时，为每个 agent 解析 Lark profile 的顺序是：

1. agent 上显式写的 `lark` 字段；
2. 与 **soul 同名** 的 profile（给某个 soul 配专属凭证，直接在 `profiles` 里加一个同名条目即可）；
3. `defaults.lark`；
4. 内置兜底 **`default`** profile。

第一个在 `lark.json` 里存在的就用它；都没有就回退 `default`。所以 `tudigong` 没有专属 profile 时就走 `default`。要再跑一个 bot：在 `lark.json` 的 `profiles` 里加一个以其 soul 命名（或在 agent 上设 `lark`）的 profile（各自的 app/身份），再 `agent serve <那个 soul>` 即可。

## 采集与数据

服务在后台持续采集，落地到本地 SQLite（`.agent/`，schema 自动迁移）：

- **群成员名册 / 同步时序**（每 5 分钟）：在群 / 新增 / 离开 / 改名、去重人数。
- **活动报名时序**（每 5 分钟）：飞书日历未开始活动的报名 / 拒绝 / 待定 / 待回复，变化才记。
- **文档访问记录**（每 1 小时）：知识库 wiki 文档 + 个人云盘文档【谁、看了哪个、最近一次几时看】。需对文档有 owner/可管理权限（详见知识库 `lark-cli §10` / `local-db §10`）。

## 运营数据报告

把采集的数据生成每日 / 每月运营图表——**入口群人数趋势、活动报名人数趋势、知识库浏览热点**——深色 16:9，发到 Telegram（及飞书【运营小天地】群）。图表由 Python 绘制（Node 取数 → JSON → 调 Python matplotlib/networkx），需先建虚拟环境：

```bash
python3 -m venv scripts/.venv
scripts/.venv/bin/pip install -r scripts/requirements.txt   # matplotlib + networkx
# Linux 另需中文字型：apt-get install -y fonts-noto-cjk
```

- **AI 社区运营洞察**（仅日报）：出图同时，Kimi 把当天采集的聊天 / 文档访问 / 成员 / 活动记录写成一段【社区运营日报】文字（今日概览 / 关键动态 / 运营建议，≤500 字），和图一起发出。**隐私分层**：只摘要公开群与会员群的内容，工作群仅计入指标（消息数、活跃人数），内部讨论不进分析。可用 `--no-narrative` 或环境变量 `OPS_REPORT_NARRATIVE=0` 关闭。
- **手动**：`agent report daily` / `agent report monthly`（`--date` 补发指定日/月——补发某个逻辑日请用当天中午，如 `--date "2026-06-25 12:00"`，避免 05:00 翻转导致差一天；`--lark-user <open_id>` 飞书私聊预览，`--lark-chat <chat_id>` 发指定群，格式同群发）。
- **自动**：监督者每日 **04:59**、每月 1 日 04:59 触发（发 Telegram + 飞书运营小天地）。改了报告代码需重新编译并重启 serve 才生效。
- **时间口径**：逻辑日 05:00 → 次日 05:00（排在 04:59 是为了在 05:00 翻转前抓完整当日）。
- 细节见 `workspaces/tudigong/memory/ops-report-playbook.md`、群发送目标见 `chat-targets-playbook.md`。

## 记忆与分群

土地神对【每个人、每个群】分别持有独立记忆，并做硬性记忆管制：

- **四层命名空间**（`memory_items` 表）：`global` 公开知识 / `group:{chat}` 本群共享 / `user:{open}` 个人（**跨群通用**）/ `group_user:{chat}:{open}` 本群本人。
- **记忆管制在代码层强制**：Policy Filter 只把当前提问者有权读的命名空间交给查询，**A 的记忆绝不会泄漏给 B**；`admin_only` 仅管理员（`configs/admins.json`）可见。LLM 只拿到过滤后的结果，无法自行越权读取。
- **会话隔离**：每个【群 × 人】各自一份独立的对话会话，互不串味。
- **群组三级分类**（`configs/chat-policies.json`，营运者手动标，**未标默认 `public` 最保守**）：`public` 公开群 / `member` 会员群 / `work` 工作群，**单向向下保密**（公开群不可透露会员群、工作群的事；会员群不可透露工作群的事）。分级驱动每群不同的 prompt 策略（`tierPolicies`），让回应按群受限。
- **自动维护**：每 8 次回复滚动生成个人记忆摘要（异步、不阻塞回复）；监督者每日 04:50 聚合群组热词并清理过期记忆。
- 要为某个群设定 prompt 策略，填 `configs/chat-policy-template.md` 的表；细节见 `workspaces/tudigong/memory/memory-access-playbook.md`。

## 技能（Skills）

每个 soul 可以挂自己的 **Agent Skills**（执行器原生机制）：把程序性、可 `/skill:` 触发、带脚本 / 素材的能力做成 skill，背景知识仍留在 `memory/`。

- **两层目录**：共用 `workspaces/_shared/skills/`，soul 专属 `workspaces/<soul>/skills/`；启动时按当前 soul 用重复 `--skills-dir` 注入（共用在前、专属在后；`--skills-dir` 是“取代”自动探索，所以两个目录都要列）。
- **文件夹式 skill**：每个 skill 一个文件夹，主文件 `SKILL.md`（YAML frontmatter：`name` 小写连字符、`description` 写清何时用），可带 `scripts/` `references/` `assets/`，正文用相对路径引用。
- **改 skill 或大写人格档自动生效**：执行器在会话创建时把 skill + 组装好的人格（AGENTS.md）定死、`--continue` 不重读，所以每次 `agent serve` 重启或 `agent update` 都会按**内容指纹**检测【skill + 大写人格档（SOUL/AGENTS/IDENTITY 等）】变化，有变就重置该 soul 的会话（相关群下次对话重建、载入新内容；首次启动只记基准、不动会话）。`memory/` 下的 playbook 是按需现读、不进会话缓存，所以改它们不触发重置。
- **现有共用 skill**（`workspaces/_shared/skills/`）：`create-agent-skills`（写 SKILL.md 的元技能）、`create-badge`（徽章导入/发放/查询）、`create-event`（事件设计→注册→配图→验收）、`lp-usage-design`（LP 经济设计参考指南，含续航模拟脚本）。
- 装载 / 生效机制见 `workspaces/tudigong/memory/agent-skill-playbook.md`；**创作共用 skill 的房规、中立化与验收清单**见 `workspaces/tudigong/memory/skill-authoring-playbook.md`。

## 环境变量（`.env`）

| 变量 | 用途 |
|------|------|
| `KIMI_BIN` / `LARK_RUN` | 智能体执行器 / 飞书 CLI 可执行文件路径（留空走默认解析） |
| `LARK_PROFILE` / `CHAT_ID` / `POLL_INTERVAL_MS` | 单次测试覆写（会盖过 configs） |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | serve 日志单向镜像到 Telegram（两个都填才启用） |
| `TELEGRAM_LOG_LEVEL` / `TELEGRAM_FLUSH_MS` | 推送档位（独立于本地 `LOG_LEVEL`）/ 批量冲刷间隔 |
| `TELEGRAM_ALERT_CHAT_ID` | 运维提醒（如 user token 到期）的目标会话；留空回退 `TELEGRAM_CHAT_ID` |

## 知识库 / 开发约定

项目的操作经验与踩坑沉淀在 **`workspaces/tudigong/memory/`**（默认 soul）。先读 `memories.md` 索引，再按需打开对应 playbook：lark-cli、执行器（agent-executor）、本地库、事件系统、LP（pt-gamification）、Telegram、**徽章系统（badge-system）**、**社区推播事件（community-notify-events）**、**运营数据报告（ops-report）**、**多人多群组记忆管理 + 群组三级分类（memory-access）**、**技能系统装载（agent-skill）**、**共用 skill 创作房规（skill-authoring）**。**改动飞书 / 数据 / 大脑相关代码前先读它。** 约定：日志用简体中文 + 大陆用语、不带 emoji；代码注释用英文。
