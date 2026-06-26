# 城邦土地神的重点记忆

> 本文件是工作区记忆的 **L0 入口**：先用下面的速查表定位到对应 playbook，再深入细节。各 `*-playbook.md` 才是完整操作经验，这里只做索引 + 重点。

## 速查表（先看这里）

| 想处理什么 | 去哪份 |
|-----------|--------|
| 飞书操作、命令速查、群消失处理 | `lark-cli-playbook.md` |
| 智能体执行器（大脑）、回复失败、非交互调用 | `agent-executor-playbook.md` |
| 会话中毒 / 自愈 / 错误分类 / 串行回复 + 表情 | `self-heal-playbook.md` |
| Skill 装载机制、改 skill 自动生效 | `agent-skill-playbook.md` |
| 写 / 审一个共用 skill（房规 + 中立化 + 验收） | `skill-authoring-playbook.md` |
| 新建并上线一个 agent（样板 + 飞书接入 + serve 模式） | `agent-onboarding-playbook.md` |
| serve vs CLI 对话场景、对面是居民还是操作者、一视同仁 | `serve-cli-identity-playbook.md` |
| 本地数据库选型、飞书消息字段真相 | `local-db-playbook.md` |
| 事件系统、推播、迎新、定时 + 随机触发 | `event-system-playbook.md` |
| 新建一个事件（填模板） | `event-creation-prompt-template.md` |
| LP 点数经济、评分机制（按交流判定）、每日签到 / 补底 | `pt-gamification-playbook.md` |
| 徽章导入 / 发放 / 查询 | `badge-system-playbook.md` |
| 社区推播里程碑事件（人数 / 报名 / 徽章公告） | `community-notify-events-playbook.md` |
| 运营数据日报 / 月报（深色图表） | `ops-report-playbook.md` |
| 心跳 Heartbeat（按节奏自动跑一轮、主动发飞书、闸门防刷版） | `heartbeat-playbook.md` |
| Agent 之间协作（飞书 bot 互不可听 → 暗线广播 + 群里表演、≤200字、用 A2A 换数据） | `a2a-peer-broadcast-playbook.md` |
| 多人多群记忆隔离、群组三级分类 | `memory-access-playbook.md` |
| 运维日志镜像、到期提醒 | `telegram-playbook.md` |

## 活跃状态（随时更新）

- **默认 soul**：tudigong（城邦土地神）。
- **数据库 schema**：已到 **v20**（启动自动迁移；各版本含义见对应 playbook）。
- **LP 经济**：初始 120、每条对话回复扣 0.1、每日 05:00 补底到 10。**LP 现在是全局共享库 `.agent/shared.db`、跨 agent 共用（2026-06-25）**，详见 `pt-gamification-playbook.md §9`。**LP 变动可按交流内容动态判定（per-soul `LP_STRATEGY.json`：一涵分访谈中/画重点/无关，tudigong 停用、维持固定扣分），详见 `pt-gamification-playbook.md §10`。**
- **serve 启动模式**：`pnpm agent serve <soul> --bot/--user/--both`（默认 --bot、不看 enabled、移除 --only）；新建 / 上线 agent 见 `agent-onboarding-playbook.md`。
- **采集回圈**：成员同步 / 活动报名每 5 分钟、文档访问每 1 小时。
- **心跳 Heartbeat（2026-06-26 上线）**：每个 agent 与生俱来的预设——挂在 **worker**，`serve <soul> --bot` 裸跑就有、**与 `--sup` 无关**（`--sup` 只管社区监督）；条件是有 bot 身份在跑且非 quiet。按 per-soul `HEARTBEAT_CONFIG.json` 的 cadence 自动跑一轮 LLM（基于 HEARTBEAT.md、抛弃式会话），可主动发飞书，靠闸门（静默时段 / 概率 / 每日上限）防刷版。tudigong 1 小时（60 分钟）、yihan 8 小时（480 分钟）、`_template` 默认 `enabled:false`。手动测试 `pnpm agent heartbeat <soul> --dry-run|--test`（不带旗标=真发）。详见 `heartbeat-playbook.md`。
- **Agent 之间协作（A2A 暗线广播，2026-06-26 上线）**：飞书 bot 互相听不到对方（`senderType==='app'` 在触发前被滤），所以走【双轨】——暗线 `data/peer-bus/<soul>/inbox.jsonl` 文件信箱做真实协调、明线飞书群做表演，让群里的人感觉 agent 在飞书上协作。真人 @ 起头（真人消息听得到），框架确定性广播 + 接话（**别赖 LLM 调工具**），LLM 只决定"说什么/要不要说（`[SILENT]`）"。开关 `configs/agents.json` 的 `peerCast`；广播**只发给 `peerCast && enabled !== false` 的同群 agent**（`listPeersInChat`）——所以现在只剩 yifan↔mira，tudigong/yihan（非 peerCast、被动监督者）和 avery/charlotte（enabled:false 未上架）都被排除。群里**只发最终消息、别外露思考、别自报家门**（模型爱把思考链整坨发出去）。防刷靠 `agentChainDepth≤6`+`budget=8`+每群每小时≤3。详见 `a2a-peer-broadcast-playbook.md`。
- 工作区目录与各文件职责总览见 `../WORKSPACE_GUIDE.md`；工具速查见 `../TOOLS.md`；skill 用法见 `../SKILLS_GUIDE.md`。

## 我是谁
- 我是城邦土地神，SeeDAO 数字城邦的土地神，住在飞书里。名字即职称。
- 我做三件事：(1) 主动推播数字城邦的各种活动消息；(2) 帮成员解决社区参与问题；(3) 以中国传统土地神的方式守护这方数字土地、记得城里每个人的故事。
- 我会监听 SeeDAO 数字城邦的内部群、持续采集对话进知识库，被 @ 或符合触发条件才回应。
- SeeDAO 数字城邦：线上线下融合、由成员共建共治共享的网络社会；核心资产有声望积分 WANG 与勋章 NFT（对应本框架的 LP🌱 与徽章）。

- **【硬性 · 最高优先级】回复一律用简体中文 + 中国大陆用语；强调 / 书名统一用【】。**
- 主要操作者要求一律用简体中文 + 大陆用语回复；偏好精简、直接、可操作。
- **【硬性】serve（飞书 p2p / 群 @）里对面一律是城邦居民，哪怕是操作者本人也一视同仁、不当操作者；只有 CLI 里对面才是操作者，才谈配置 / 运营 / 内部指令。**每轮 prompt 开头有【对话场景】标 serve/CLI。机制与各 agent 特化见 `serve-cli-identity-playbook.md`。

## lark-cli / 飞书操作经验（简体）

- 操作飞书前先读 `memory/lark-cli-playbook.md`（lark-cli 踩坑经验与命令速查）。
- 对 SeeDAO 的每条 lark-cli 命令都要带 `--profile example_lark_profile`，否则回退旧应用、对 SeeDAO 群被 `230027` 拦。
- 返回结构：`im +xxx` 便捷命令看 `ok`；原生命令（`reactions` / `messages delete` 等）看 `code===0`。
- 话题群（如 AgentTasks）回复要用 `im +messages-reply --message-id om_xxx --reply-in-thread`，别用 `+messages-send`（会另开新话题）。
- **话题回复必须带 thread 上下文 + 会话键按话题隔离（2026-06-17 修，细节见 lark-cli-playbook §2）**：bot 只收被 @ 的消息，话题原帖（@ 别的 agent）收不到，直接回会丢上下文；回复前用 `store.getThreadContext(thread_id)` 把同话题历史灌进 `respondAsync` 的 `context`，会话键加 `-${threadId}` 避免话题串味。
- 【思考中】表情 emoji_type = `Status_PrivateMessage`（`Thinking` / `ThinkingFace` 无效）。
- 撤回消息用 `im messages delete --message-id <om_xxx> --as bot --yes`（原生命令、看 `code===0`、必须 `--yes`；只能由发送者身份撤回——事件是 bot 发的就 `--as bot`）；lark-cli 没有编辑消息的命令，发错只能撤回重发。已封装成 `lark.recallMessage(messageId,{as,profile})` + CLI **`pnpm agent unsend <message_id> [--as bot|user]`**。`pnpm agent event` 发送成功后会打印 `message_id=…` 和现成的 `撤回：pnpm agent unsend <id>` 命令。
- 在话题群建新话题：直接 `im +messages-send`（不带 reply）就会开一个新话题，标题写在内容首行（飞书没有单独设置话题标题的接口）；富文本用 `--markdown`。
- 给 SeeDAO 飞书群发帖 / 回复用简体中文 + 大陆用语；中文强调 / 书名 / 标签一律用【】。
- 多行 / emoji 内容通过临时 node 脚本用 `execFileSync` 当参数传，避开 shell 引号转义与编码问题。
- **群消失 / 被踢的智慧处理（2026-06-18，详见 lark-cli-playbook §7.5）**：`232009` = 群已解散（永久，立即停轮+标记）；被踢/无权限 = 不可访问（连续 3 次才停轮、被拉回会自动恢复）。两个根因坑：`larkExec` 的 `execFileSync` 要设 `stdio:['ignore','pipe','pipe']` 否则 lark-cli 错误信封漏到日志；`listChatMembers` 改成对确定性错误抛错（原本绝不抛错 → 解散检测是死代码），且空名册=临时失败要跳过别误判全员离开。

## 开发规范（日志 / 注释）

- **日志一律不带 emoji**：`log.info/warn/error`、CLI 的 `console.log` 状态输出、`process.stderr/stdout.write` 都不要 emoji（去掉 ✓/✗/📅/🎲/↘/↗/🤖 这类前缀符号）。
- **日志用简体中文 + 中国大陆技术用语**（如用【判定】而不是英文 roll；用 保存 / 内存 / 并发 这类大陆叫法）。
- **代码注释必须用英文。**
- 用户可见内容（飞书回复、`🌱 LP` footer、事件正文、`🏯 城邦土地神：` 回复前缀、`sendText` 发的运维通知）可以保留 emoji——这条规则只针对【日志】。
- **日志分级**：`log.debug/info/warn/error`；阈值由环境变量 `LOG_LEVEL` 控制（默认 `info`，`debug` 默认不输出，设 `LOG_LEVEL=debug` 才显示）。**例行、无变化的周期性日志用 `log.debug`**（如成员同步【本轮新增 0、改名 0】就 debug，有变化才 info），避免每几分钟刷屏。

## 框架 / 架构记忆（开发相关）

- 我的大脑现在是**智能体执行器**（框架调用的本地推理 CLI）。改 `runKimi`、调执行器、排查"回复失败"前，先读 `memory/agent-executor-playbook.md`（旧版参数 `--quiet` / `--agent-file` 等已废弃；人格/工具改用项目本地 `.kimi-code/AGENTS.md` + `mcp.json`）。
- **会话中毒 / 自愈 / 串行回复 + 表情 / 错误日志**：先读 `memory/self-heal-playbook.md`。核心坑：一轮被打断会留下"孤儿工具调用"，`--continue` 之后**永久 400**（连"1+1"都答不出）；隔离损坏会话只能把文件夹**移出 `~/.kimi-code/sessions/`**（`--continue` 是扫目录认会话，就地改名会变 `Session not found`）。出问题先 `node dist/bin/agent.js doctor`。timeout 已调到 10 分钟；排队表情 `OnIt`、思考中 `Status_PrivateMessage`。
- **Skill + 人格档 自动重置会话（每 soul 配 Agent Skills；改 skill 或大写人格档自动生效，2026-06-25 扩展）**：先读 `memory/agent-skill-playbook.md`。核心坑：执行器在**会话创建当下**就把 skill 集合 + 组装好的 AGENTS.md（人格）定死，`--continue` 续接**不重扫不重读**，改 skill / 人格档只对**新会话**生效；已兜底——每次 worker（重）启动（`agent serve` 重启 + `agent update`）跑 `reloadSoulIfChanged(soul)`（原 `reloadSkillsIfChanged`、已改名），按**内容指纹**判断【共用 skill + 专属 skill + 大写人格档(IDENTITY/SOUL/AGENTS/TOOLS/USER/BOOT/HEARTBEAT)】有没有变、变了就隔离该 soul 全部会话让下次对话重建（**首跑只记基准不动会话**、state 存 `.agent/soul-state/`、`git pull` 只改 mtime 不误触发）。**`memory/` 故意排除**（playbook 按需现读、journal 每天变，不该触发重置）。**光重启、内容没变不会重置健康会话**；手动重置某 soul 全部会话用 `listSoulSessionDirs+quarantineSession`（见 playbook §5）。skill 两层放法 `workspaces/_shared/skills/`（共用）+ `workspaces/<soul>/skills/`（专属），启动用**重复 `--skills-dir`** 注入（"取代"非"叠加"，两个目录都要列）。
- **每轮 prompt 注入信号 + agent 读自己 workspace（2026-06-25）**：`prepare()`（`src/core/agent.ts`）每轮注入中性信号——`【对话场景】`serve/CLI、`【对话轮次】第 N 轮`（仅 serve、让 agent 掐节奏如访谈每几轮播报进度）、`【你的工作区目录】<绝对路径>`（让 agent 用文件工具读自己 workspace 的 `examples/`/`memory/` 等——agent 运行时 cwd 是 `.agent/<soul>/chats/<session>` 不是 workspace，相对路径解析不到才注入绝对路径）、`【当前对话者】`。详见 `serve-cli-identity-playbook.md §二`。
- **bot 回复不加 `replyPrefix` 前缀（2026-06-25）**：bot 在飞书本就显示自己名字、前缀多余；`replyPrefix`（`configs/agents.json` 字段）**只在 user 频道生效**（user 模式消息挂操作者账号下、需前缀区分）。改的是 `feishu-bot.ts` 发送链路。**注意土地公 bot 也因此不再加 `🏯 城邦土地神：`**（要保留得单独开例外）。
- **抓微信公众号文章（2026-06-25）**：WebFetch 服务会被微信"环境异常"墙挡；本机 `curl -A '<MicroMessenger UA>' <url>` 直取可成功（正文在 `id="js_content"` div、标题在 `og:title` meta）。一涵的历史人物志范文就是这么抓进 `workspaces/profile-writer-yihan/examples/` 的。
- **创作共用 skill（写 SKILL.md 的房规 + 中立化 + 验收）**：先读 `memory/skill-authoring-playbook.md`（与 agent-skill-playbook 分工：那份讲装载/生效，这份讲怎么写得规范中立可验收）。一句话要点：结构对齐 `create-badge`（文件夹式、纯 XML 骨架、路由型 essential_principles+intake+routing / 指南型 objective+quick_start+success_criteria、references>100 行配 TOC）；**中立化**=去厂商与大模型名 + 去外部产品代号 + 自包含（知识写进 skill 自己的 references、别叫读者翻 memory）+ 去项目史叙述 + 简体大陆用语，真实代码标识（如 `LLM_PT_COST`/`llm_reply`）可保留但旁注【与模型无关】；脚本放 `scripts/`、相对正斜杠路径、跑完清 `__pycache__`、浮点预算别用 `//`（用 `/+1e-9`）；`{{pt}}` 不是 `{{ap}}`、LP 标签别叫【积分】。现有共用 skill：`create-agent-skills`（元技能）、`create-badge`、**`create-event`**（事件设计→注册→配图→验收，对照 event-system 但自包含）、**`lp-usage-design`**（LP 经济设计指南，含 `scripts/lp_runway.py` 续航模拟器，对照 ap-gamification）、**`create-agent`**（从 `_template` 建新 workspace）、**`onboard-lark-bot`**（把 agent 接上飞书当 bot）。
- **新建并上线一个 agent（2026-06-25）**：从 `_template` + `create-agent` skill 建 workspace、`onboard-lark-bot` skill 上飞书、`serve <soul> --bot` 起，先读 `memory/agent-onboarding-playbook.md`。一句话要点：soul 名不能 `_` 开头（启动守卫 `isToolingWorkspace`）；飞书 `configs/lark.json` profile 的 **key=soul 名**否则回退 default（用错 bot 身份）；后台权限/事件要**发布**否则 `activate_status=2`；serve 选身份靠 `--bot/--user/--both`、**不看 enabled**、移除了 `--only`；p2p 直接回 / 群留话题（按 `chat_type` 自动）；互动事件（`welcome-party`）按 `events.ts` 的 `souls` 白名单隔离，**新 agent 不触发土地公的**；**LP 全局共享 `.agent/shared.db` + 跨 app 同一人 `pnpm agent link` 归并身份**（union_id 取不到才用别名表 `identity_links`，见 `pt-gamification-playbook.md §9`）。
- 本地数据库方案（选 `node:sqlite`）+ 飞书消息字段真相（话题用 `thread_id` 不是 root_id/parent_id；发送者 open_id 在 `sender.id`，且现有取值有 BUG）先读 `memory/local-db-playbook.md`；完整研究在 `thoughts/shared/research/2026-06-15-local-db-game-backend-selection.md`。
- **事件系统 / 触发框架**（发图 + 文案到群/P2P、迎新、定时+随机事件、回答前先检查触发）先读 `memory/event-system-playbook.md`（2026-06-17 大改）。**要新建事件**就用 `memory/event-creation-prompt-template.md`（让对方填那份模板，能给到最全信息）。一句话要点：
  - **手动触发**：`pnpm agent event <编号|id>`（`--test` 只发操作者本人 P2P、`--dry-run` 只预览、加 `pnpm agent unsend <message_id>` 撤回；手动一律 force、不受定时与概率限制）。
  - **来源 ≠ 目标、一次只发一个目标**（群或 P2P）；候选池=来源群名册（`sourceChatIds`），不是全部监听群；**只排除 bot、不排除操作者**。
  - **@ 不在目标会话的人自动降级成【@名字】文本**（230002）；要 post 到群得先把 bot 拉进群。
  - **定时+随机+时段**：5 种周期（每 N 分钟 / 每 X 天 / 每周礼拜 K / 每月几号 / 每年某月日，+时段+概率），逻辑日 05:00 锚点；调度器在 supervisor，改它要完整重启 serve。
  - **成员名册** `chat_members`（5 分钟同步所有监听群、含从没发言的人、改名会更新、离开保留），和 profiles 分开存。
  - 老坑：发图 `--file` 要 cwd 相对路径；图按真实像素算百分比（事件图默认缩到 128px 高）；迎新闸门用 `hasSuccessfulDispatch`；`messages.create_time` 是毫秒。
- 玩家档案 / LP 点数经济（**LP = Life Point / 生命点**，旧称 AP，2026-06-22 更名为 LP / 🌱、初始 100→120、每条回复扣 0.1、footer 显示一位小数；标签只写【LP】不写【LP 积分】，积分另有它用）/ 每日签到 / 徽章 先读 `memory/pt-gamification-playbook.md`（LP 规则、状态列 footer `🌱 LP : 前→后 (delta)` 都 toFixed(1)（delta=0 只显示余额、不带括号）、签到、`ensureProfile` 安全网；两个曾经致命的 BUG：bot 事件发送者 open_id 在 `ev.sender_id`、agent 要把当前对话者 open_id 注入 prompt）。研究 / 施工：`thoughts/shared/research/2026-06-16-...md`、`thoughts/shared/coding/2026-06-16-...md`。**LP 评分机制（每条先扣 `cost`、大模型回复尾行输出 `LP_JUDGE:<类别>`、框架按 per-soul `LP_STRATEGY.json` 判定加分 / 标签，2026-06-25）见 `pt-gamification-playbook.md §10`；代码在 `src/core/lp-strategy.ts`。**
- **运营数据时序表 `member_sync_rounds`（2026-06-18，详见 local-db-playbook §7）**：每 5 分钟一轮存在群人数 / 增加 / 离开 / 改名（含 ou_id+名字明细）+ 去重人数（当前 / 内部 / 外部）+ 名册累计。**四种"人数"别混**：在群合计（相加含重复）≠ 当前去重 ≠ 内/外去重 ≠ 名册累计（曾经去重含已离开）。历史可 `pnpm agent backfill-members` 从日志补（去重数走假设模型）。
- **`pnpm agent serve --quiet` 静默 / 观察模式（2026-06-18）**：经 `AGENT_QUIET` 环境变量透传给 worker。照常采集对话、同步成员、记录数据、跑定时事件，但**不回复任何飞书 p2p / 群 / @**（LLM 与命令回复都不发、不调用 LLM、不扣 AP、不加表情、不重发被打断回复）；CLI 是独立进程不受影响。是**启动参数**，热重载不改它 → 要**重启 serve** 才生效。
- **群停服状态（2026-06-18，详见 local-db-playbook §8）**：`chats.dissolved_at` + `inactive_reason`（dissolved / inaccessible）；`store.markChatInactive/clearChatInactive/isChatInactive/listInactiveChats`；`agent doctor` 末尾列出已停服群。
- **活动报名时序表 `calendar_event_rsvp_rounds`（migration v14，详见 local-db-playbook §9）**：每 5 分钟随群成员同步一起轮询飞书日历 `primary` 的【尚未开始活动】，记录每个活动的报名(接受)/拒绝/待定/待回复人数成时序（对称 `member_sync_rounds`）。报名主指标=`accepted`（removed 不计）。封装在 `lark.ts` 的 `listUpcomingCalendarEvents`(`+agenda`，看 `ok`)/`listEventAttendees`(原生 `event.attendees list`，看 `code===0`、翻页)；采集函数 `syncCalendarEventRsvp` 挂在 `feishu-user.ts` 的 rescan；查看用 `pnpm agent calendar-events`。需 scope `calendar:calendar.event:read` + `calendar:calendar:read`（SeeDAO profile 已开通）。飞书日历 API 字段真相见 local-db-playbook §9（`start_time` 是 `{datetime,timezone}` 不是时间戳、`event_id` 是 `UUID_<unix秒>`、attendee 无 `is_optional`）。**重复事件只采最近一次（2026-06-19）**：`+agenda` 把周期事件展开成窗口内多个未来实例、报名数相同，采集时按 `recurringSeriesKey(eventId)` 系列归并、每组取最早未来实例（曾被 Telegram 日志里 4 行同名误判成【已过期】，其实全是未来重复，`>now` 拦不掉）。
- **Telegram 日志镜像（2026-06-19，详见 `telegram-playbook.md`）**：`pnpm agent serve` 的日志单向镜像到 Telegram（只发不收、非 webhook，就是 Bot API `sendMessage`）。在 `log.ts` 的 `emit()` 唯一收口加 sink，封装在新模块 `core/telegram.ts`；密钥走 `.env`（入口 `process.loadEnvFile`，项目原本无 dotenv）。坑：档位独立（`emit` 在本地 `LOG_LEVEL` 闸门**前**推、用 `TELEGRAM_LOG_LEVEL`）；批量限频（每 `flush_ms` 合并一条、单条 ≤4096、debug 洪流压头尾）；防递归（`telegram.ts` 绝不调 `log.*`、失败只写 stderr）；`[sup]`/`[wkr]` 双进程各推各的；退出用 `flushTelegramSync`（curl 同步、因 `process.exit` 打断 async）；只在 serve 启用、改 `.env` 要 `pnpm agent update`。`pnpm agent tg-test` 验证。发图 `sendTelegramPhoto` 已备好（阶段二人数曲线）。
- **文档访问记录事件表 `doc_view_events`（migration v15，详见 local-db-playbook §10）**：每 1 小时轮询【数字城邦 wiki 文档 + 操作者 个人云盘文档】的访问记录，记【谁/哪个文档/最近一次几时看】成事件流，只在有变化时落库+写 log（`UNIQUE(file_token,viewer_id,last_view_time)`+`INSERT OR IGNORE`）。封装 `lark.ts` 的 `listWikiSpaces`/`listWikiNodesDeep`/`listDriveFilesDeep`/`listFileViewRecords`/`isViewRecordForbiddenError`（全原生看 `code===0`）；采集 `syncDocViewRecords` 挂 `feishu-user.ts` 独立 1 小时回圈；查看 `pnpm agent doc-views`。**两个关键约束**：①view_records 必须文档 owner 或空间 admin 才读得到（edit/read 一律 forbidden 1069603），操作者 是【数字城邦】admin 故能读全空间；②**bot 加不进 wiki**，所以轮询身分只能用 user(操作者) token（约 7 天过期需重授）；个人【智慧记录】是 操作者 云盘 docx（非妙记，妙记无 view API）。scope 见 §10（user+应用身份各自开、要发版）。
- **user token 到期 Telegram 提醒（migration v16，详见 telegram-playbook）**：知识库访问采集只能用 user token（bot 加不进 wiki），约 7 天到期需人工重授；`token-watch.ts` 的 `checkUserTokenExpiry` 按 `refreshExpiresAt` 倒数，在到期前 3/2/1/当天各推一次 Telegram（共 4 次、正文带重授命令），发到 `TELEGRAM_ALERT_CHAT_ID`（回退 `TELEGRAM_CHAT_ID`）。去重存 `token_expiry_alerts(grant_key=profile+grantedAt, threshold)`，重新授权换 key 自动停。挂 `feishu-user` 6 小时回圈；CLI `pnpm agent token-check [--test]`。
- **徽章系统 + 社区推播事件（migration v17，2026-06-19/20）**：徽章先读 `memory/badge-system-playbook.md`（`badges`/`user_badges` v17 扩充丰富字段、`pnpm agent badge import|award|list` 多目标、发放→逐人私信 + 一条群公告流程、外部成员外键/无法私信坑、JSON 模板与全流程见 `create-badge` skill（`workspaces/_shared/skills/create-badge/`，原 `assets/badges/IMPORT_PROMPT.md` 已并入并删除））；推播事件先读 `memory/community-notify-events-playbook.md`（这次建的 `badge-awarded`×3 / `class-event-notify` 课程报名里程碑 / `visitor-num-notify` 围观群人数每满 100）。一句话要点：
  - **标题是纯文字、markdown 不渲染**（别用粗体/引号，所有事件标题统一纯文字）；**正文**粗体写 ` **内容** `（`**` 内侧不留空、外侧前后各留一个空格，否则 CJK 不渲染）；**数学占位符 fillTemplate 不会算**（`{{100-accept_num}}` 要代码先算成 `remaining` 再传）。
  - **里程碑触发用【上一轮 vs 本轮】比对跨越**（`floor(now/step)>floor(prev/step)`）免另存状态；都 fire-and-forget（`void fireEvent`）。`class-event-notify` 挂 `syncCalendarEventRsvp`（accept+待定、名称含【共学/课】、跨 10/25/40/50/60/75/90）；`visitor-num-notify` 挂 `syncMembers`（`store.presentMemberCount` 取在群数、跨 100 整数倍、首轮 `prev>0` guard）。
  - **@**：动态靠 `FireEventOptions.recipients` + `prepare()` 组 `{{@mN}}`；固定写死 `cfg.mentions` + `{{@key}}`；不在目标群自动降级【@名字】文本；`event --dry-run` 预览里 `{{@}}` 显示字面 token 属正常（看【@:】行确认）。
  - **日历网页分享链接** `https://www.feishu.cn/calendar/share?token=…` 用 `lark.getEventShareLink`（原生 `calendar events share_info`，`--event-id` 要完整 occurrence id `<uuid>_<ts>`、裸 uuid 报错），失败回退 `CalendarEvent.app_link`。配图默认 **128px** 高、`overlays:[]` 原图不叠字。
  - **sup 日志**：触发用 `log.info`（INFO 才进 Telegram），平时监测用 `log.debug`；`agent badge award`（非 dry-run）会 `enableLogSink()`+退出 `flushTelegramSync()` 让一次性 CLI 日志也进监督者频道。手动测带 `vars`/`recipients` 的事件：写临时 node 脚本 `import {fireEvent} from './dist/core/events.js'`，`node --env-file=.env` 跑。
  - 新增：`FireEventOptions.recipients`、`CalendarEvent.appLink`、`store.presentMemberCount`、`store.findOpenIdsByName`、`store.getBadge`。群 ID：运营小天地用外部那个 `oc_example_ops_group`（同名内部 `oc_example_ops_group_old` 已解散别用）、城邦快报 `oc_example_broadcast_group`、围观群 `oc_example_public_group`。
- **多人多群组记忆管理 + 群组三级分类（migration v18，2026-06-22）**：让土地神对【每个人、每个群】都有独立记忆 + 硬性记忆管制（A 不泄漏给 B、按群保密层级限制回应），先读 `memory/memory-access-playbook.md`。一句话要点：
  - **四层命名空间** `memory_items`：`global`/`group:{chat}`/`user:{open}`（**跨群通用**）/`group_user:{chat}:{open}`；store 在 `src/core/store/memory.ts`。
  - **记忆管制核心** `src/core/memory-policy.ts`：`allowedNamespaces` 给恰好 4 个白名单（永不含别人 namespace = A 读不到 B），`filterByPolicy` 再过 visibility（`admin_only` 仅 admin、`private` 仅本人）。**代码层先过滤，LLM 只拿过滤后结果。** 跨人隔离有测试守（`memory-policy.test.ts`+`memory-governance.test.ts`）。
  - **群组三级分类**（`configs/chat-policies.json` v2，取代旧内/外部群）：`public`/`member`/`work` 单向向下保密，**手动标、未标一律 `public`（defaultTier）**；tier **只驱动 prompt policy**（`assembleSoul` 按 `getChatTier` 注入 `tierPolicies` 文字），不对个人记忆硬闸控。当前分级见 playbook §11。
  - **会话隔离** sessionKey 改 `agentId-chatId-senderOpenId`（per 群×人）；**自动摘要** `Agent.summarizeUserMemory` 每 8 回复 fire-and-forget（抛弃式 non-session workDir，不卡 pump）；**群组热词** `group-intel.ts` 确定性聚合写 `group:{chat}`；**TTL+维护** supervisor 每日 04:50 `scheduleDailyMemoryMaintenance`；**管理员** `configs/admins.json`+`isAdmin`。
  - **CLI** `pnpm agent memory list|inspect|add|set|rm|clear|preview|summarize|aggregate|purge`；`preview --chat --user` 最有用（看某人某群实际注入 + 群层级，验证隔离）。
  - **已知限制**：自动摘要可能把工作群对话浓缩进个人记忆、之后在公开群被注入；目前依 操作者 决定纯靠 prompt policy 软约束，未做记忆按来源层级硬闸控。
- **DB migration 进度**：已到 **v18**（v10–11 member_sync_rounds 运营时序表、v12–13 chats 停服状态、v14 calendar_event_rsvp_rounds 活动报名时序表、v15 doc_view_events 文档访问记录事件表、v16 token_expiry_alerts token 到期提醒去重、v17 badges/user_badges 徽章丰富字段 + 发放溯源、v18 memory_items 多人多群组记忆表 + 四层命名空间隔离）。
- **运营数据报告模块 `src/core/ops-report.ts`（2026-06-20，详见 [ops-report-playbook.md]；2026-06-26 加 AI 社区运营洞察 `src/core/ops-narrative.ts`——**仅日报** 04:59 出图时 Kimi map-reduce 把当天采集记录写成日报文字、和图一起发运营小天地+TG；隐私分层：公开+会员摘要内容、工作群仅指标；⚠️ `messagesBetween` 的 `create_time` 是毫秒；开关 `--no-narrative` / `OPS_REPORT_NARRATIVE=0`；详见 playbook 末节）**：每日/月把入口群人数、活动报名、知识库浏览热点画成**深色 16:9** 图，发 **Telegram + 飞书运营小天地群**。Node 查 SQLite（`memberSyncRoundsBetween`/`calendarEventRsvpHistory`/`wikiSpacesBetween`/`docViewersBetween`/`chatMemberOpenIds`/`upcomingTrackedEventIds`，store.ts 末尾新增）+ 即时建 wiki 树（`listWikiNodesDeep`；`WikiNode.parentNodeToken` + `listWikiChildNodes` 已解析）→ JSON spec → spawn Python（`scripts/`，matplotlib+networkx）→ 各别 `sendTelegramPhoto` / 飞书 `sendPost`。**核心坑（全在 playbook）**：① 时间走【逻辑日 05:00 起算】、标签用本地时间别用 toISOString、月报折线用 5 分钟原始点；② supervisor 排 **04:59**（2026-06-26 从 04:55 改，仍 <05:00 否则翻进新空逻辑日）、`ref=now` 别传 yesterday；③ `uploadImage` 只吃 cwd 相对路径 → 暂存目录在 repo 内 `.ops-report-*`（gitignore + finally 清理）、serve 从 repo 起；④ 工作人员归类（红蓝着色）每次产图前即时 `listChatMembers`、staff = 市政厅工作群+运营小天地；⑤ 树剪枝只留 readers>0+祖先、排除档案标题、圆圈左上角 `(非工作人员) 总数`；⑥ pygraphviz 在 py3.14 装不上、tree 有纯 Python BFS fallback；⑦ 排程 serve 启动时才挂、改码要重启 serve。CLI：`pnpm agent report daily|monthly [--date] [--lark-user <id>] [--lark-chat <id>]`。
- **群发送目标 config 驱动 + 运营报告运维（2026-06-26，详见 [chat-targets-playbook.md] + ops-report-playbook 末节）**：发群 chat_id 一律不写死、放 `configs/lark.json` 别名用 `resolveChatTarget` 解析（起因运营报告 `invalid receive_id` 占位符）；取真 id 用 `im +chat-list --as user`，`232011`=操作者已不在该群=旧 id、同名运营小天地用**外部活跃**那个、发群 bot 须在群否则 230002。运营报告坑：手动补发 `--date "YYYY-MM-DD 12:00"`（中午、否则 off-by-one）、`runKimiAsync` 的 workDir 要先 `mkdirSync`（否则 ENOENT 误报成 kimi 找不到）、叙事 **≤500 字硬约束**（compress→`hardTruncate`）、内容只摘要 public+member（work 仅指标、含 AI 秘密基地）、改 chat-policies tier 要**重启 serve**、撤回 `im messages delete --as bot --yes`/**原地编辑** `api PUT /im/v1/messages/<om> --as bot --data -`、文字**禁「」用【】简体**。**整群排除运营报告（2026-06-26）**：`configs/chat-policies.json` 每群可加 `"excludeFromOpsReport": true`，`gatherDayData`（`ops-narrative.ts`）见到就整群跳过（不进内容、不进指标、不计数）；用于 agent 协作room（如 SeeAlpha 交易室，已标 `work`+排除），详见 `a2a-peer-broadcast-playbook.md §七`。