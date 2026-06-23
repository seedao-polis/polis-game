# 事件系统 / 触发框架手册（城邦土地神工作区记忆）

> 做【经营管理游戏】的事件（发图 + 文案 + 游戏信息到群 / P2P）、改触发逻辑、改发图前先读这份。
> 命令、参数、JSON 字段、emoji_type、open_id 一律保留原文。2026-06-16 建立。

## 0. 最容易踩的坑（一句话版）

1. **lark-cli 发图：`--file` / `--image` 拒绝绝对路径**（沙箱化，绝对路径报 `cannot open file`）。必须传 **cwd 相对路径**（`uploadImage` 已自动转）。
2. **markdown 带不了真正的 @**。要 @ 人必须用 post 的 `at` element（`{tag:'at',user_id:<open_id>,user_name}`），不能写在 `md` 里。改 post 内容先用 `--dry-run` 验证 shape。
3. **【第一次互动】别用全局 profile 新建判断**：`feishu-user` 扫描频道也会 `recordInteraction`，会抢先建档。迎新闸门用【**这个人还没被迎新过**】(`hasSuccessfulDispatch`)，不是 `isFirstInteraction`。
4. 图按**真实像素**算百分比（`event-render.ts` 读底图实际宽高），所以换底图不用改坐标；9:25 只是名义比例。

## 1. 一个事件是什么

底图 + 文字叠加（百分比定位，可选）+ markdown 文案（标题 + 正文）+ 游戏信息（{{name}}/{{ap}}/{{level}}/{{badges}}）。`scope`：`global`（发到群 `targetChatId`）/ `personal`（P2P，`--user-id` = open_id）。一次发送 = **一条 post 消息**（一个 message_id，方便日后统计表情回应）。

## 2. 代码地图（2026-06-17 大改后的最终态）

- `src/core/event-render.ts` — `renderEventImage({baseImage, overlays, outPath, vars, outHeight})`：`@napi-rs/canvas` 读真实宽高 → 百分比转像素 → `fillRect`+搜字号 `fillText`；中文字体自动注册（mac PingFang）；`{{key}}` 替换。**`outHeight`**=先按原尺寸画好（叠字布局不变）再等比缩放输出。事件默认发 **128px 高**（`EVENT_IMAGE_HEIGHT=128`，每事件 `imageHeight` 可覆盖）：原图全分辨率留 `assets/`，发送小图自动生成到 `.agent/event-render/`，不用手动维护两个 folder。
- `src/core/lark.ts` — `uploadImage`(`im images create`，bot-only，回 image_key，自动转 cwd 相对路径) / `sendPost(target,{title,content},opts)` / `replyText` / `recallMessage(messageId,{as,profile})`(撤回，`im messages delete --message-id … --yes`，看 `code===0`) / `listChatMembers(chatId)`(花名册 open_id→name，含跨租户成员)。`PostElement`=`text`/`md`/`at`/`img`。
- `src/core/events.ts` — `EventTypeConfig`/`registerEvent`/`fireEvent(id,opts)`（prepare→渲染→上传→记 dispatch→**@降级**→发送→回写→afterSend，全程 try/catch）/`checkAndFireTriggers`（互动触发）/`rollScheduledEvent(id,profile)`（掷骰+发）/`listScheduledEvents`/`describeSchedule(sch)`/`getEventByRef(编号|id)`。
- `src/core/store.ts` — 事件相关：`upsertEventType`/`insertEventDispatch`/`updateEventDispatch`/`hasSuccessfulDispatch`/`hasFirstContact`；选人 `silentMemberReport`；名册 `syncChatMembers`/`memberName`/`recordChatMember`/`directoryStats`；排程态 `getScheduleState`/`planScheduleFire`/`resolveScheduleRoll`。
- `src/core/supervisor.ts` — 调度器：`scheduleEventDayPlanner`/`planAndArmEvents`/`isDueDay`/`logicalDayIndex`/`logicalDate`/`armMinuteEvents`。⚠️ **改调度器要完整重启 serve**（`pnpm agent update` 只热重载 worker、不重载 supervisor；见 `self-heal-playbook.md`）；改事件定义/prepare/文案/schedule 数值在 worker 里，热重载即可。
- `src/bin/agent.ts` — `agent events`（列编号/范围/排程，`describeSchedule`）；`agent event <编号|id> [--test] [--to oc_/ou_] [--actor ou_] [--dry-run]`（手动，仅 server 端）；`agent unsend <message_id> [--as bot|user]`（撤回）。`event-fire` 是 `event` 的别名。
- `src/core/db.ts` migration：**v6** event_types/event_dispatches/event_reactions；**v7** event_schedule_state(last_eval_at/last_fire_at/last_outcome)；**v8** 给它加 `next_fire_at`；**v9** `chat_members`(chat_id+open_id PK, name, present, first/last_seen)。

### 关键模型（这次定下来的）

- **一次事件 = 一个目标**（一个群 **或** 一个人 P2P），**不做 dual/fan-out**。target 优先级：`opts.target` > `prepared.target` > scope 默认（global→`targetChatId`、personal→actor P2P）。
- **来源 ≠ 目标**：**来源**=从哪些群/DB 状态挑对象；**目标**=发给谁。被挑中的人不一定在目标会话里（见 @ 降级）。
- **`prepare(opts)` 钩子**（动态事件，可 async）：返回 `null`=本次不发（干净跳过，`skipped=true`，不记失败）；`PreparedEvent` 可覆盖 `description`/`mentions`/`target`/`vars`（`vars` 也填**标题**占位符）+ `afterSend(res)`（发成功才跑，发 LP 等副作用）。
- **选人 `silentMemberReport(cutoffMs,{sourceChatIds,excludeOpenIds})`** → `{members,silent,chats,cutoffMs}`：候选 = **来源群（`sourceChatIds`）的 `chat_members` 成员**（省略才是全部名册），含从没发言的人；`last_spoke` 从 messages join（0=从未）；`silent`=`last_spoke<cutoff`（**含从未发言**=终极潜水）。整个名册（8 群）只是**数据底座**，不是默认候选池。
- **只排除 bot**（`excludeOpenIds:[SELF_BOT_OPEN_ID]`）——**所有 member-selection 事件的默认，不排除操作者/任何人**。（未来针对 bot 的事件再单独 opt-in。）
- **@ 不在目标会话的人 → 自动降级为【@名字】文本**：飞书 `at` 非会话成员会被拒（230002）；文本提及允许。`fireEvent` 发送前 `destinationMemberIds(target)`（群→花名册；P2P→{接收人,bot}）+ `downgradeAtNonMembers` 把不在里面的 `at` 换成文本。`--dry-run` 标 `[不在目标→降级为@文本]`。
- ⚠️ **230002 也可能是 bot 不在目标群**：要 post 到**群**，bot 必须先在群里（`im chat.members bots` 查，空=不在）。运营小天地当前 **bot 不在** → 生产发群会失败，要先拉 bot 进群；P2P 无此问题（bot 天然在）。降级 @ 解决不了【bot 自己不在群】。
- **`--test`**=验收模式：把目标**强制改成操作者本人 P2P**（lark profile 的 `userOpenId`，CLI 用 `opts.target` 覆盖，优先级最高）。`--test` > `--to`；可叠 `--dry-run`。被 @ 的人多半不在你 P2P 里 → 降级文本。
- **手动 `agent event` 一律 force**：`fireEvent` 收 `force:true`，**不受定时与概率限制**（定时只在 supervisor scheduled 路径查，概率只在 `rollScheduledEvent` 掷；手动直接 `fireEvent`）。`prepare` 收 `opts.force` 应放宽：lurker 在【无人潜水】时改选**最久未发言者**演示，scheduled（非 force）则 `return null`。`prepare` 一律 `log.info` 来源群 + 选人范围（共几人/几人潜水/cutoff），`--dry-run` 再列名单——排查【为何不发】看这些。
- **发完打印 + 撤回**：`agent event` 成功后打印 `message_id=…` 和现成 `撤回：pnpm agent unsend <id>`。

### 定时+随机+时段 = `schedule`（discriminated union）+ scheduler

- `EventTypeConfig.schedule` 按 `kind` 分 5 种（都带 `probability`/`note?`；除 minutes 外带可选 window `windowStart`/`windowEnd`，本地 `"HH:MM"`，缺省 10:00 单点）：
  - `{kind:'minutes', everyMinutes}` 每 N 分钟（子日、无 window、递归 `setTimeout`、重启重新计时）
  - `{kind:'days', everyDays}` 每 X 逻辑日
  - `{kind:'weekly', weekday}` 每周礼拜 K（**1=周一…7=周日**，内部 `weekday%7`）
  - `{kind:'monthly', day}` 每月 X 号（超月底 clamp）
  - `{kind:'yearly', month, day}` 每年 M 月 N 日（闰日 clamp）
- 【一天】= **逻辑日** `DAY_START_HOUR=5`（05:00→次日 04:59，跟每日 AP 补底同锚点）。
- day-based：`scheduleEventDayPlanner()` 每天 05:00（+启动即跑）→ `planAndArmEvents()`：`isDueDay()` 判定今天该不该触发 → window 内随机挑分钟当 `next_fire_at` 写库 + `setTimeout` 到点 → `rollScheduledEvent()` 掷 `Math.random()<probability` 命中才 `fireEvent`。
- 扛重启：`next_fire_at`（v8）。重启后 planner：未到点重 arm；过期 ≤2h（`CATCHUP_GRACE_SEC`）补发；过期太久作废本轮（不半夜乱发）；已结算当天不再排。

### 成员名册 directory（`chat_members`，v9）

- 和 `profiles` **分开存**（profiles 每日 AP 补底会给所有人补到 10，名册塞进去会给一堆没互动的人发 LP）。`feishu-user` 的 rescan（现 **5 分钟**一轮，`lark.json` 的 `discovery.refreshMinutes`）`listChatMembers` 同步**所有监听群（内外）**全部成员进名册：在群=`present=1`、新人 added、离开 `present=0` **保留不删**（回来翻回 1）。**改名也更新**（新名覆盖、计 `renamed`，并刷新**已存在的** profile 名、不新建）。
- 取名顺序：`chat_members` 名册（5 分钟刷新、反映改名）→ 采集 `sender_name`（会过时）→ profiles → open_id。`memberName(openId)` 取名册最新名。外部/跨租户成员名只能靠 `im chat.members get`（contact `+get-user` 只查本租户）；飞书对未公开真名的跨租户用户只给【用户XXXXXX】。

### 已实现事件 `lurker-discovered`【🐟 '名字' 在社区潜水被发现了】

- **来源**=运营小天地（`LURKER_SOURCE_CHAT_IDS=['oc_example_ops_group_old']`），**目标**=运营小天地 群（`LURKER_TARGET_CHAT_ID`，scope global）；`--test` 改发操作者 P2P。
- 周期 `{kind:'weekly', weekday:1, windowStart:'19:00', windowEnd:'20:00', probability:0.25}`；silent 窗口 `LURKER_SILENT_DAYS`（默认 3，env 可覆盖）。
- prepare：来源群里随机挑一个 `silent`（近 3 天没发言含从未发言）的人，**只排除 bot**；force（手动）无人潜水时挑最久未发言者。标题填 `vars.lurker_name`，正文 `> 此事件每周发生一次，发生概率 25%`（markdown 引用）。
- 奖励：对象**有 first_contact 才** +3 AP（`afterSend` 里 `grantAp`）且正文带【也给他 3 AP 鼓励！】，没有则两者都省。
- ⚠️ 运营小天地 **bot 不在** → 生产发群暂时失败，要先拉 bot 进群；现在用 `--test` 发 P2P 给自己验收（栗子等被 @ 的人降级成文本）。
- ⚠️ 群人数：运营小天地实测 **7 人**（含 操作者）；14 人是【市政厅工作群】，别混。

### 未来个人 P2P 事件（恭喜升级 / AP 破万）

- 来源=群活动 + DB 状态阈值，目标=那个人 P2P，靠 **DB 状态触发**（钩子按需补，类似 `checkAndFireTriggers` 但看 DB 阈值）。

### 坑（务必记住）

- ⚠️ **`messages.create_time` 是毫秒**（`larkTimeToMs` 转的，对比 `collected_at` 秒、比值正好 1000）。所有跟它比的时间窗都要用**毫秒**（`Date.now()-天数*86400*1000`）。早期写成秒 → 永远【无人符合】。
- ⚠️ **一个人可能多个 open_id**（飞书 open_id 跨租户不同；如 操作者 内部 `ou_example_operator`、外部 `ou_example_operator_overseas`，名字都【操作者】）。目前不按名字去重/排除。
- **日志**：不带 emoji、简体中文 + 大陆术语（【判定】不是 roll）、注释英文；`log.debug` 给例行无变化日志（`LOG_LEVEL=debug` 才显示）；用户可见内容可留 emoji。详见 `memories.md` 开发规范段。

## 3. 发图到飞书（实测过的正确姿势）

- 上传：`im images create --data '{"image_type":"message"}' --file image=<cwd相对路径> --as bot --format json` → `{code:0,data:{image_key}}`。
- 发 post（图 + 标题 + markdown + @，一条消息）：
  `im +messages-send --chat-id oc_xxx|--user-id ou_xxx --msg-type post --content '<JSON>' --as bot --format json` → `{ok:true,data:{message_id}}`。
- post content 结构：`{"zh_cn":{"title":"...","content":[[元素],[元素]...]}}`，每个内层数组是一行（段落）。元素：`{tag:"img","image_key":"img_xxx"}`、`{tag:"md","text":"**markdown**"}`、`{tag:"text","text":"纯文字"}`、`{tag:"at","user_id":"ou_xxx","user_name":"名字"}`。
- **空行 = 空文字段落** `{tag:"text","text":""}`（用来在 标题→图→正文 之间留白，`gapLines` 控制）。
- 不确定 shape 就 `--dry-run`（只验证请求结构、不真发）。

## 4. 触发框架（事件怎么自动发生）

架构（你定的）：**LLM 回答前先检查事件是否触发 → 回答 → 尾部补信息（目前是 🍎 AP footer）**。

- `checkAndFireTriggers(ctx)` 在 `feishu-bot.ts` 的 `processJob` 里、**调用 `respondAsync` 之前**跑；best-effort，触发失败不挡回答。
- 规则放 `events.ts` 的 `TRIGGERS` 数组，可扩充（之后加 level-up / AP 门槛 / 徽章授予 都往这塞）。
- 现有规则 `first_interaction_welcome`：`shouldFire = senderOpenId && !hasSuccessfulDispatch('welcome-party', openId)` → 第一次 @ 机器人就发迎新、且只发一次（机器人只收得到 @，所以等同【首次 @ 触发】；闸门用【没发过】还能容错重试）。
- ⚠️ 副作用：既有成员第一次 @ 机器人也会收到一次迎新。要只对【真新人】发就给闸门加条件（如建档时间在最近 N 分钟内）。

## 5. 把某人重置成【新人】（测试触发用）

外键顺序：先删子表再删 `profiles`（`foreign_keys=ON`）。**还要删 `event_dispatches`(actor)**，否则迎新闸门 `hasSuccessfulDispatch` 会挡住重发。
```
DELETE FROM ap_ledger WHERE user_open_id=?;
DELETE FROM user_badges WHERE user_open_id=?;
DELETE FROM checkins WHERE user_open_id=?;
DELETE FROM activities WHERE actor_open_id=?;
DELETE FROM event_dispatches WHERE actor_open_id=?;
DELETE FROM profiles WHERE open_id=?;
```

## 6. 日后统计表情回应（已预留）

`event_dispatches.message_id` 已存；`event_reactions` 表已建。批次同步：`im reactions list --params '{"message_id":"<id>"}' --as bot --format json` → `data.items[].reaction_type.emoji_type` + `operators[].operator_id.open_id`，写进 `event_reactions`。可做成 MCP 工具 / 排程。

## 7. 还没做（TODO）

- ✅ 定时+随机+时段触发（5 种周期 + 逻辑日 + scheduler，见上）。✅ 成员名册同步（v9）。✅ @ 降级、`--test`、`--force`、`unsend`、事件图 128px、动态标题。
- **把 bot 拉进 运营小天地**，否则 lurker 生产发群报 230002（现用 `--test` 发 P2P 验收）。
- MCP 工具 `event_fire`（让执行器也能主动触发）。
- DB 状态触发钩子（个人 P2P 事件：恭喜升级 / AP 破万）。
- 表情回应批次同步；更多触发规则（level-up / AP 门槛 / 徽章）。

依赖：新增了 `@napi-rs/canvas`（预建二进位，免系统 libcairo）。相关 AP / 档案见 `memory/ap-gamification-playbook.md`，自愈 / 串行回复见 `memory/self-heal-playbook.md`。
