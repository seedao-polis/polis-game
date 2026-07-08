# 活动 / Meetup 模块 playbook

> 社区成员 @ 城邦土地神（或自然语言）预约社区活动会议：用 **Ricky 的飞书身份**建飞书日历日程（自动带视频会议）、支持循环、打标签、按标签订阅、每天 08:00 在围观群播报今日活动并 @ 订阅者、每次增删改即时刷新知识库【SeeDAO 活动日历】页。

## 相关文件与关键定值

- 日历写操作封装：`src/core/lark.ts` → `createCalendarEvent` / `updateCalendarEvent` / `cancelCalendarEvent` / `getEventShareLink`
- 数据存储：`src/core/store/meetups.ts`（CRUD + 订阅），表见 `src/core/db.ts` migration v23/v24/v25
- 知识库渲染：`src/core/meetup-wiki.ts` → `generateMeetupWikiMarkdown` / `refreshMeetupWiki`
- 群指令：`src/core/commands.ts`（`follow`/`unfollow`/`follows`/`meetup`）
- CLI 子命令：`src/bin/agent.ts` → `cmd_meetup`（`meetup create/edit/cancel/digest/list`）
- 自然语言意图：`src/channels/feishu-bot.ts`（`[MEETUP_CREATE:{...}]` 标记拦截）+ 约定写在 `workspaces/tudigong/AGENTS.md`
- 排程：`src/core/supervisor.ts` → `scheduleDailyMeetupDigest`(08:00) / `scheduleDailyMeetupWikiUpdate`(08:01)

**关键定值**（在 gitignore 的 `configs/lark.json`，字段 `activityCalendarId` / `activityWikiNodeToken` / `activityWikiDocId`）：

- Ricky = `default` profile（`larkProfile jcnhe1etwt45`、app `cli_aaa53a18cf389cd8`、`userOpenId ou_9686d5436aaa04bde9953ef40b5bc4c3` = Ricky Wang）。建/改/删日程一律 `--as user`（默认 profile 就是它）。
- Ricky primary calendar id：`feishu.cn_oaQj70qrH2OMvArOOGBcrb@group.calendar.feishu.cn`
- 知识库【SeeDAO 活动日历】页：node_token `FoSDwbnWTiWxqXkCnoQcb66Anhh`、**docx obj_token `W5pNdEhSiowql2xhj40cbHQznnc`**、space `7641789411853372346`。

## 一、飞书日历 / 会议 API（实测经验）

- 建日程用 **native** `lark-cli calendar events create --calendar-id <id> --data '<JSON>' --as user`，看 `code===0`。**不能用便捷命令 `+create`**——只有 native 支持 `vchat`（视频会议）。
- **视频会议**：`data.vchat.vc_type:"vc"` 即自动建飞书 VC，回传 `data.event.vchat.meeting_url`（干净可分享的入会链接）。**不需要独立 `vc:*` scope**，owner 的日程编辑权就够（已实测）。
- **⚠️ 发起人要单独加成 attendee，否则 UI 显示「不参与」**：`events.create` 的 body **不吃 `attendees`**（塞进去无效、attendee list 仍是 0）；attendee list 为空时飞书 UI 把组织者显示成「不参与」。建完要再调 `event.attendees create --user-id-type open_id --data '{"attendees":[{"type":"user","user_id":"<组织者 open_id>"}],"need_notification":false}'`——加进去组织者 `rsvp=accept`、`is_organizer=true`。`createCalendarEvent` 现在收 `organizerOpenId`（由 `userOpenIdForProfile(profile)` 解析，= Ricky）自动补这步。
- **循环会议**：`data.recurrence` 用 RFC 5545 RRULE，如 `FREQ=WEEKLY;BYDAY=TU;COUNT=10`（COUNT 与 UNTIL 不能同时）。本模块默认每周 ×10（`--recur false` 转单次、`--recur <RRULE>` 自定义）。
- **event_id 有 `_0` 后缀**：循环日程 create 回传的 id 形如 `<UUID>_0`，`app_link` 里的 `key=` 才是裸 UUID。**入库用 `recurringSeriesKey()`（`lark.ts`，剥 `_<数字>`）存裸 UUID 作 `lark_event_id`**。
- **删除**：`calendar events delete --calendar-id <cal> --event-id <id> --as user`。⚠️ **必须传 occurrence 后缀 id（`<UUID>_0`），裸 UUID 会失败**（实测 `delete 裸UUID`→报错、`delete <UUID>_0`→code0）。传 master `<UUID>_0` 一次删掉整个循环系列；只删单场传该场 `<UUID>_<unix秒>`。因为入库存的是裸 UUID，`lark.ts` 的 `cancelCalendarEvent`/`updateCalendarEvent` 用 `occurrenceEventId()` 归一化（没 `_` 就补 `_0`）——否则群内/CLI 取消会「本地标记取消但飞书删除失败」。
- **编辑**：便捷命令 `calendar +update --event-id <id> --summary/--start/--end/--rrule/--add-attendee-ids/--remove-attendee-ids --notify --as user`，或 native `events patch`。
- **日历分享链接**（`https://www.feishu.cn/calendar/share?token=...`）：`calendar events share_info --calendar-id <cal> --event-id <id> --as user` 回 `data.share_link`。**用建立时回传的 `<UUID>_0` 就能取到**（已实测）。`createCalendarEvent` 现在会顺手取回并放进返回值 `shareLink`，存进 `activity_meetups.share_link`。
- `createCalendarEvent(opts)` 返回 `{ eventId(裸UUID), meetupUrl(VC), appLink, shareLink }`；`profile` 传 `undefined` 就用 lark-cli 默认 profile（= Ricky）。
- **bot 读不了日历**（app 没申请 calendar 读 scope）；本模块所有查询都从本地 DB 读，不回读日历，所以无碍。

## 二、Scope（先开发者后台，再 auth login）

建/改/删会议、读 wiki 节点各需一个 user scope：

| Scope | 用途 |
|-------|------|
| `calendar:calendar.event:create` | 建会议 |
| `calendar:calendar.event:update` | 编辑会议 |
| `calendar:calendar.event:delete` | 取消/删除会议 |
| `wiki:node:retrieve` | 取知识库页 obj_token |

**核心坑**：这些 scope 如果 **app 未开通**，光 `auth login` 拿不到——会报 `app ... has not applied for the required scope(s)`，连 `--dry-run` 都被挡。必须**先到飞书开放平台开发者后台**（`https://open.feishu.cn/app/cli_aaa53a18cf389cd8/dev-config/permission`）申请对应权限、发版核准，Ricky 再 `auth login`。四个 scope 已于 2026-07-08 全部开通授权。

- 看 app 开通了哪些：`lark-cli auth scopes`（`userScopes` 列表）。
- 看当前 user token 已授权哪些：`lark-cli auth status`。
- 检查是否有某几个：`lark-cli auth check --scope "a,b,c"`。
- 增量授权（会与既有 scope 合并）：`lark-cli auth login --scope "calendar:calendar.event:create,calendar:calendar.event:update,calendar:calendar.event:delete,wiki:node:retrieve"`——device flow，要 Ricky 本人浏览器核准，**不能代跑**。

## 三、数据库（per-soul `.agent/tudigong.db`）

- **v23** `activity_meetups`（`lark_event_id` 裸UUID UNIQUE、title、description、recurrence、start_time、end_time、meetup_url、app_link、calendar_id、created_by、`status` 默认 `confirmed`、created_at、updated_at）+ `activity_meeting_tags` 改名后为 `activity_meetup_tags`（meetup_id+tag 多对多，`ON DELETE CASCADE`）。
- **v24** `meetup_subscriptions`（user_open_id+tag，UNIQUE，谁 follow 谁进这表）。
- **v25** `activity_meetups.share_link`（`ALTER TABLE ADD COLUMN`，存日历分享链接）。
- 取消是**软删**：`status='cancelled'`，进【SeeDAO 活动日历】的【过去活动】区，不实删行。
- store 函数在 `src/core/store/meetups.ts`：`insertMeetup`/`setMeetupTags`/`updateMeetup`/`cancelMeetup`/`getMeetupById`/`meetupsOnDate`/`listAllMeetupsForWiki`/`subscribeMeetupTag`/`unsubscribeMeetupTag`/`listMeetupSubscriptions`/`subscribersForTag`。

## 四、知识库【SeeDAO 活动日历】页（每次变更即刷新）

- 页面本来就存在、标题【SeeDAO 活动日历】、docx。渲染器 `generateMeetupWikiMarkdown` 出两个表格：**即将举行**（标题/开始/结束/标签/循环/视频会议/日历链接）+ **过去活动**（含状态）。日历链接优先用 `share_link`、回退 `app_link`。
- `refreshMeetupWiki({profile})`：机械式（无 LLM）从 DB 快照全量覆写页面（`appendDocxContent(docId, md, {overwrite:true, format:'markdown'})`）。
- **每次 create / edit / cancel（无论 @ 还是 CLI）都立即调 `refreshMeetupWiki` 刷新**；外加每天 **08:01** 兜底再刷一次。所以页面永远镜像当前 DB。
- **坑：`wiki +node-get` 取 obj_token 要传完整 `/wiki/` URL**（token `FoSD…` 非 `wik` 开头，直接 `--node-token FoSD…` 会被误判成 raw obj_token 而要 `--obj-type`）：`lark-cli wiki +node-get --node-token "https://seedao2049.feishu.cn/wiki/FoSDwbnWTiWxqXkCnoQcb66Anhh" --as user` → `data.obj_token`。
- 写 wiki 的 scope（`docx:document:create/write_only/readonly`、`wiki:node:create`）此 app 已具备；bot 加不进 wiki，只能 `--as user`。详见 `weekly-report-playbook.md`。

## 五、@ 自然语言预约（框架确定性执行）

- 用户在群里自然语言说（如【@城邦土地神 帮我约下周三晚8点的共学，标签 共学】），LLM 理解后**在回复最末尾附一行 `[MEETUP_CREATE: {"title":...,"startTimeSec":...,"endTimeSec":...,"tags":[...],"recur":"..."}]`**（时间是 Unix 秒整数）。
- **框架在 `feishu-bot.ts` 拦截该标记 → 剥掉不给用户看 → 确定性调 `createCalendarEvent` + 入库 + 打标签 + 刷 wiki**。**核心教训重申：必须发生的步骤（建会议/存库/刷 wiki）走框架代码，别让 LLM 自己调工具**（同 A2A / 心跳那条）。仿 `lp-strategy.ts` 的 `LP_JUDGE:<类别>` 尾行解析模式。
- 建成后**框架自动给回复追加 footer**（真实数据、不靠 LLM 编）：`📅 日历链接` + `🎥 视频会议` + `🏷 标签：X（其他人发【follow X】即可订阅…）`。
- 约定写在 `workspaces/tudigong/AGENTS.md`【活动预约输出约定】节：怎么从用户话里提标签（明说【标签 X】就用，没说就按主题起个简短可复用标签并在回复里告知）、**别自己编日历/视频链接**（框架会补真的）、时间转 Unix 秒、信息不足就追问别输出标记。

## 六、指令

**群内 @ 城邦土地神**（框架确定性处理、不走 LLM、不扣 LP）：
- `follow <标签>`（别名 `订阅`）/ `unfollow <标签>`（`取消订阅`）/ `follows`（`我的订阅`）——按标签订阅活动。
- `meetup cancel <id>`（群内取消，删飞书日历 + 软删 + 刷 wiki）；`meetup edit <id>` 目前**引导去用管理员 CLI**（编辑字段多，群内只做取消）。
- 用 `sender open_id` 认订阅人。

**权限：取消/编辑只有发起人（或管理员）能做** —— **确定性 code 层**，不靠 LLM：
- `commands.ts` 的 `canManageMeetup(senderOpenId, createdBy)` 闸门：`senderOpenId === mtg.createdBy`（当初 create 的人）才放行，否则拒绝；管理员（`isAdmin`，admins.json，含 Ricky）可 override；空 sender fail-closed 拒绝。`meetup cancel` 和 `meetup edit` 都过这道闸。
- 为什么够：**LLM 没有任何日历工具**（MCP 只有 memory/feishu_send/profile/pt/badge/leaderboard/message_search/peer_*，无 calendar/meetup 变更工具）、**没有自然语言 cancel/edit 标记**（只有 `[MEETUP_CREATE]` 建会议）、群内 `edit` 只导去 CLI（operator-only）——所以居民能触到日历删除的**唯一路径就是 `meetup cancel` 指令**，守住它即守住全部。
- `created_by`：自然语言建的 = 发起人 `job.senderOpenId`（真 open_id）；CLI 建的 = larkProfile（operator 上下文，居民永不匹配 → 只有管理员/CLI 能取消，符合预期）。

**CLI**（`pnpm agent meetup ...`，自身设 `AGENT_SOUL=tudigong`、从 config 解析 Ricky profile 与定值，直接跑）：
```
agent meetup create --title <标题> --start "YYYY-MM-DD HH:mm" --end "YYYY-MM-DD HH:mm" [--tags a,b] [--recur <RRULE|false>] [--desc ...]
agent meetup edit <id> [--title ...] [--start ...] [--end ...] [--rrule ...] [--tags ...]
agent meetup cancel <id>
agent meetup digest [--date YYYY-MM-DD] [--to <chat_id>]   # 手动触发播报，不带 --to 默认发【运营小天地】
agent meetup list
```

## 七、排程（supervisor，需 `--sup`）

- **08:00 `scheduleDailyMeetupDigest`**：查当天 `confirmed` 会议；无则**静默不发**；有则组富文本（标题/时间/VC 链接）发**围观群**（fallback【运营小天地】测试），文末 @ 【订阅了今日会议任一标签 **且在围观群内**】的成员（`subscribersForTag` ∩ `chatMemberOpenIds([围观群])`，去重）。**框架确定性直接 `sendPost`，不走 LLM/MCP，不过 outbound-guard**。
- **08:01 `scheduleDailyMeetupWikiUpdate`**：兜底再刷一次【SeeDAO 活动日历】。
- 模式仿 `scheduleDailyPtReset` 的 `setTimeout` 自递归。**改 supervisor 排程要完整重启 serve**（`pnpm agent update` 只热重载 worker、不重载 supervisor）。

## 八、回答"最近 / 今天有什么活动·会议"（上下文注入）

被人问活动 / 会议时，runtime 的 LLM（Kimi）**读不到 `activity_meetups` 表**，所以走**框架确定性注入**（不是让 LLM 调工具、也不是让它编）：

- `src/core/meetup-context.ts` → `buildMeetupContextBlock()`：读 `listActiveMeetupsForContext()`，把当前 / 近期活动渲染成【近期活动】背景块（每条含时间、循环标注、标签、视频链接、日历分享链接 + 知识库【SeeDAO 活动日历】页 URL）。
- `src/core/agent.ts` 的 `prepare()` **仅在 serve 模式**把这个块注入每轮 prompt（在 `body` 前）。**自动按 soul 自适应**：非本模块的 soul 查到空 → 返回 `''` 不注入，无需硬编 soul 名。
- `listActiveMeetupsForContext()`（`store/meetups.ts`）= `confirmed AND (end_time > now OR recurrence != '')`——**循环活动一行一系列、start_time 只记首次**，所以用 `recurrence != ''` 让它在首场过后仍留在列表；单次活动结束即掉出。
- `workspaces/tudigong/AGENTS.md`【回答"最近/今天有什么活动·会议"】节告诉 LLM：**以【近期活动】块为准、别编**；循环活动按"今天星期几"自己推算；**没有这个块就如实说近期暂无**、引导看【SeeDAO 活动日历】或 @ 预约。
- **已知局限**：循环会议不逐场展开（只存首场 + RRULE），"今天是第 N 场"靠 LLM 按频率推算；如需精确按天匹配要另做 RRULE 展开。

## 九、命名 / 文案 / 测试 / 重启

- **命名：`meeting` 全改成 `meetup`**（外部指令 + 内部代码 + 表/列 + `MEETUP_CREATE` 标记 + 文件 `store/meetups.ts`/`meetup-wiki.ts`）；**唯一保留**飞书原生字段 `vchat.meeting_url`（那是飞书契约、不是我们的命名）。`src/core/ops-report.ts` 里【internal meetings】是无关的既有概念、没动。
- **文案：面向用户一律简体中文 + 大陆用语；引用标题/标签/命令用【】、不用「」**（AGENTS.md 已写死这条约定）。
- **测试群**：`configs/lark.json` 的 `knownInternalChats` 里【运营小天地】【围观群】都已配真 chat_id。**测试建会议会真的建线上会议 + VC，测完记得 `meetup cancel <id>` 清理**。
- **重启注意**：动了 **DB migration（如 v25）或核心档（lark.ts/db.ts/store/meetup-wiki.ts）要完整重启 serve**（`serve tudigong --bot --sup`），不是 `agent update`；只改 worker 层（feishu-bot/commands）才可热重载。
