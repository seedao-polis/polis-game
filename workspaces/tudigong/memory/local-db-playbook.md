# 本地数据库 / 游戏化后端手册（城邦土地神工作区记忆）

> 把飞书全量消息落地到本地库，并往"类游戏后端"（profile / AP 点数 / 徽章）演进。动数据存储前先读这份。
> 完整研究报告：`thoughts/shared/research/2026-06-15-local-db-game-backend-selection.md`。2026-06-15 定案。

## 0. 拍板决策（操作者）

- **数据库选 SQLite**；驱动用 Node 22 内建 **`node:sqlite`**（零依赖、自动跨平台、同步 `DatabaseSync`）。`better-sqlite3` 作可逆备援。
- 所有存取走 `src/core/db.ts` 抽象层（`getDb()` / `tx()` / run/get/all），切驱动只改这一个文件。
- 代价：`node:sqlite` 是实验性（import 时一行 `ExperimentalWarning`），且要把 `package.json` 的 `engines.node` 提到 `>=22`。
- **采集范围：内部群 + 外部群都存**（不是只内部）。
- B 类默认：DB 文件**按 soul 命名 `.agent/<soul>.db`**（2026-06-22 起不再写死；`db.ts` 读 `AGENT_SOUL` env，默认 `tudigong`，每个 entry point 都 pin，MCP server 经 `Agent.buildMcpConfig` env 拿到同值）。tudigong 用 `.agent/tudigong.db`；`AGENT_DB_PATH` 仍可覆盖整条路径（测试隔离用）。轮询游标暂留 JSON 文件；soul 记忆（markdown）与消息库分离；FTS5 用 `trigram` 分词器（支持中文子串）；LP（旧称 AP，Life Point）规则见 `pt-gamification-playbook.md`。

## 1. 实测：node:sqlite 在本机（Node 22.22.0）都能用

- `DatabaseSync` 是**同步**的（不是 async）。`FTS5`、`JSON1`、`PRAGMA journal_mode=WAL`、ACID 交易**全部可用**。
- 注意：`node:sqlite` 没有 `better-sqlite3` 的 `db.transaction(fn)` 和 `.pragma()`，要自己用 `db.exec('BEGIN'/'COMMIT'/'ROLLBACK')` 包交易、`db.exec('PRAGMA ...')` 下指令（已收进 `db.ts` 的 `tx()`）。

## 2. ⚠️ 飞书消息字段的真相（实测 lark-cli `+chat-messages-list`）

抽样话题群 AgentTasks 看原始字段名，结论会改实现：

- **没有 `root_id` / `parent_id` / `upper_message_id`**！话题关系由 **`thread_id`**（5/5 非空）+ `thread_message_position` 表达。所以"补话题字段"是补 **`thread_id`**，不是 root_id/parent_id。
- 返回字段：`message_id`、`chat_id`、`content`、`msg_type`、`create_time`、`message_position`、`sender`、`thread_id`、`thread_message_position`、`thread_replies`、`deleted`、`updated`、`message_app_link`。
- `sender` 结构是 `{ id, id_type, sender_type, tenant_key }`：
  - 发送者 open_id 在 **`sender.id`**（配合 `sender.id_type`），**不是** `sender.sender_id.open_id` / `sender.open_id`。
  - **列表接口不含显示名**：`sender_name` 取不到，要另调用户信息接口回填（建 profile 时做）。

## 3. ⚠️ 既有 BUG（落库前必须修）

- `src/channels/feishu-user.ts:232-234` 取 open_id 用的是 `sender.sender_id?.open_id ?? sender.id?.open_id ?? sender.open_id`，跟真实结构 `sender.id`（字符串）**全对不上** → `sender_open_id` 一直存成空字符串。
- `src/core/lark.ts:86-95` 的 `extractSenderName` 找的字段真实 `sender` 都没有 → `sender_name` 也是空。
- 修法：open_id 改取 `m.sender.id`；显示名走用户信息接口回填。

## 4. 采集 vs 互动要解耦（外部群）

- 现状 `tudigong-user` 已经是 `listen:"all"` + `capture:true`（`configs/agents.json`），`resolveListen` 对 `"all"` 不过滤 external → **采集已覆盖内部 + 外部群**。落库只要把 `chats.external` 如实写入。
- 但**外部群别自动回复**：以用户身份在外部群发消息会被 `230027` 拦。要解耦：`ResolvedChat` 加 `external` 旗标，采集照旧全收，触发回复时对 `external===true` 的群默认跳过（或加 `interactExternal` 配置，默认 false）。

## 5. 表结构与分阶段（要点）

- 表：`chats`（含 external）、`messages`（`message_id` 主键 → `INSERT OR IGNORE` 原生去重，可删掉 `transcript.ts` 的内存 Set + 重启扫档）、`profiles`、`ap_ledger`（append-only 点数账本，余额 `SUM(delta)` 或快取）、`badges` + `user_badges`、`activities`；`messages.text` 建 FTS5。
- `@tudigong` 建 profile 的挂载点：`feishu-bot.ts:82`（`dispatchCommand` 之后、`agent.respond()` 之前）。游戏化工具仿照 `mcp-server.ts` 的 `registerTool` 加：`profile_get` / `ap_grant` / `badge_award`。
- 分三阶段：Phase 1 消息落库取代 JSONL（含上面 thread_id + sender 修正 + 外部群）→ Phase 2 profiles + AP 账本 → Phase 3 badges + activities/quests。

## 6. 已实测确认（原"残留待验"）

- bot 事件 `ev`（lark-cli event consume 扁平结构）发送者 open_id 在 **`ev.sender_id`**（实测；不是 `sender.id` / `sender_open_id` / `sender.sender_id.open_id`）。这跟列表接口的 `sender.id` 是两条不同路径，别混。
- 显示名回填用 **`contact +get-user --user-id <openId> --user-id-type open_id --as user`**（`--as bot` 无通讯录权限、拿不到名字），缓存进 `profiles.name`。
- 详见 `memory/pt-gamification-playbook.md`。

## 7. 运营数据时序表 `member_sync_rounds`（2026-06-18 加，migration v10–v11）

> 目的：每次周期性群成员同步（≈5 分钟一轮，`discoveryRefreshMs`）落一行做运营分析。一轮 = 一次跨**所有**监听群的 `syncMembers()`。落点在 `feishu-user.ts` syncMembers 末尾，**每轮都写**（含无变化轮，保证时序连续）；写库走 `store.recordMemberSyncRound`（best-effort、`INSERT OR IGNORE`、`synced_at` UNIQUE → 幂等）。

- **务必分清四种"人数"**（很容易混）：
  - `present_total` 在群合计 = 各群在场人数**相加**（一个人在 N 个群算 N 次，对应日志"在群合计"，会重复计）。
  - `present_distinct` 当前在群**去重**人数 = `directoryStats().present`（一个人算一次）。
  - `present_internal` / `present_external` 内部群 / 外部群各自**去重**在场（按 `chats.external` join；一个人同时在内外群则各算一次，所以 内+外 **可能 > present_distinct**）。
  - `roster_total` 名册累计 = `directoryStats().distinct` = 曾见过的去重人数（**含已离开的人**）。所以名册累计 ≥ 当前在群去重，差额=已离开的人。**名册累计也是去重的，但口径是"曾经"不是"当前"，别和 present_distinct 混。**
- `joined_count`/`left_count`/`renamed_count` 本轮增加/离开/改名人数（跨群相加）；对应 `*_detail` 列存 `(ou_id, 名字),(ou_id, 名字)` 逗号分隔字串（`store.formatMemberRefs`）。离开的人用最后已知名字，改名的人用新名字。`source` = `live` / `backfill`。
- **依赖改动**：`syncChatMembers` 现在除计数外还返回 `joinedMembers/leftMembers/renamedMembers`（`MemberRef[]`），syncMembers 跨群聚合后写一行。读取用 `store.recentMemberSyncRounds(limit)`。
- **历史补录 `pnpm agent backfill-members`**：解析 `logs/*.log` 的"群成员同步完成：…"行重建历史轮（每次先删旧 backfill 行按当前模型重算，**live 行不动**；只补到最早 live 轮之前，不重复）。明细列留空（旧日志没 ou_id）。去重人数用**假设模型**：假设历史没人离开 → `present_distinct = roster_total`；内部群恒按**当前**内部去重人数（`directoryStats().presentInternal`）为基准；`present_external = roster_total − present_internal`（clamp ≥0）。即"总 15/30/45、当前内部 10 → 外部 5/20/35"。

## 8. 群停服状态 `chats.dissolved_at` + `inactive_reason`（2026-06-18 加，migration v12–v13）

- 一个监听群被判定不再服务时，标记 `dissolved_at`（停服时间，列名沿用）+ `inactive_reason`：`'dissolved'`（解散 232009，永久）或 `'inaccessible'`（被踢/无权限，可能恢复），并把该群名册全部置 `present=0`（保留行）。
- store API：`markChatInactive(chatId, reason)`（幂等、保留首个原因）、`clearChatInactive`、`isChatInactive`、`chatInactiveReason`、`listInactiveChats`。
- 用法：`syncMembers` 与轮询 `startNew` 都先 `isChatInactive` 跳过；`agent doctor` 末尾列出已停服群（带原因）。
- **判别与停轮/恢复的完整逻辑见 `lark-cli-playbook §7.5`**（含两个极易踩的根因坑）。

## 9. 活动报名时序表 `calendar_event_rsvp_rounds`（2026-06-18 加，migration v14）

> 目的：每 5 分钟轮询飞书日历 `primary` 的【尚未开始活动】，记录每个活动的报名(接受)/拒绝/待定/待回复人数成时序，对称 `member_sync_rounds`。研究：`thoughts/shared/research/2026-06-18-event-signup-timeseries-polling.md`；施工：`thoughts/shared/coding/2026-06-18-event-signup-timeseries-implementation.md`。

- **报名主指标 = `accepted`**（`rsvp_status='accept'`）；`removed`（退出/被移出）不计入任何统计。`declined/tentative/needs_action` 各自记录、`signup_total`=全部非 removed（参考）。每活动每轮一行（长表），`UNIQUE(synced_at, event_id)` + `INSERT OR IGNORE` 冪等。
- **采集挂载**：`feishu-user.ts` 的 `syncCalendarEventRsvp()`，挂在 rescan 迴圈（`discoveryRefreshMs`，预设 5 分钟）+ 启动初始；**quiet 模式照常采集**（属数据采集，不受 `AGENT_QUIET` 影响）。只采 `start_time > now` 的活动；过了开始时间下一轮自然不采，无需停服标记。
- **重复事件只采最近一次（2026-06-19 修）**：`+agenda` 会把每周/每日重复事件**展开成窗口内每一次的实例**（同一系列 UUID、`_<时间戳>` 后缀不同、报名数完全相同），30 天窗口里一个周会就 4+ 行纯冗余（曾被误判成【很多已过期】，其实全是未来实例，`>now` 过滤拦不掉）。修法：过滤后**按系列 key 分组、每组取最早的未来实例**。系列 key 用 `lark.ts` 导出的 `recurringSeriesKey(eventId)`（剥掉尾部 `_<digits>`；UUID 无 `_`，单次活动 UUID 唯一→各自成组、不受影响）。
- **store API**：`recordCalendarEventRsvpRound` / `recentCalendarEventRsvpRounds` / `latestCalendarEventRsvpRound`（仿 `recordMemberSyncRound` 区块）。CLI：`pnpm agent calendar-events`。
- **采集日志带增量（2026-06-19）**：有变化才 info，**行首**显示与上一轮 `accepted` 的差额——增加 `新增 N`、减少 `取消 N`（首次见到=`新增 全量`），后接【报名(接受)/拒绝/待定/待回复】。
- **lark 封装**（`src/core/lark.ts`）：`listUpcomingCalendarEvents`（`calendar +agenda --start --end --as user`，Shortcut 看 **`ok`**）/ `listEventAttendees`（原生 `calendar event.attendees list`，看 **`code===0`**、翻页 `has_more`+`page_token`，仿 `listChatMembers`）。

### ⚠️ 飞书日历 API 字段真相（实测，跟初版研究的推测不一样，照实测写）

- **`+agenda` 的 `start_time`/`end_time` 是物件 `{datetime, timezone}`**，`datetime` 是 **ISO 8601 字符串**（如 `2026-06-18T20:00:00+08:00`），**不是** `{timestamp:"<秒>"}`。转秒：`Math.floor(new Date(datetime).getTime()/1000)`。
- **`event_id` 形如 `<UUID>_<unix秒>`**（如 `b31cfd9e-…-1fe_1782212400`），不是 `evt_xxx`；重复事件的每个实例共享 UUID、后缀是**该次开始的 unix 时间戳**（不是小序号 `_0/_1`）。系列归并用 `recurringSeriesKey()` 剥尾部 `_<digits>`。
- **`+agenda` 默认只列当天**，要未来必须带 `--start/--end`；日期用纯日期 `YYYY-MM-DD`（`.toISOString().slice(0,10)`）最稳（Z 格式有被拒风险）。`+agenda` 会**汇总用户可见的多本日历**（含他人建、邀请用户参加的共享日历），社区活动就这样抓到。
- **`primary` 不能直接当 attendees 的 `calendar_id`**：`calendar calendars primary` 解析出真实 ID `feishu.cn_…@group.calendar.feishu.cn`；attendees 用每个活动的 `organizer_calendar_id`（实测 primary 真实 ID 与 organizer_calendar_id 皆可、同一份名单）。
- **attendee item 字段**：`attendee_id / user_id(open_id) / display_name / type / rsvp_status / is_organizer`（外部成员多 `is_external`）；**没有 `is_optional`**。`rsvp_status` 枚举：`accept / decline / tentative / needs_action / removed`。
- **scope**：`calendar:calendar.event:read`（读日程+读参会人）+ `calendar:calendar:read`（解析 primary）。SeeDAO profile `example_lark_profile` 已开通。`auth login --scope` 会**覆盖**整份授权，重授权必须带【现有全部 scope + 两个 calendar scope】取并集（含 `offline_access`），否则 bot 失去 im/contact 能力。`auth login` 无 `--as` 旗标。

## 10. 文档访问记录事件表 `doc_view_events`（2026-06-19 加，migration v15）

> 目的：每 1 小时轮询【知识库 wiki 文档 + 操作者 个人云盘文档】的访问记录，把【谁、看了哪个文档、最近一次什么时候看】记成事件流。只在有变化时落库 + 写 log。

- **长表、改动检测靠唯一键**：`UNIQUE(file_token, viewer_id, last_view_time)` + `INSERT OR IGNORE`。view_records 回的是【每个访问者一条、附**最近一次**访问时间】（不是逐次访问流），所以同一人时间没变 → 被忽略（`changes=0`），出现新访问者或时间前进 → 插一行新事件。**一行 = 一次观测到的访问**（采集粒度），不是快照。`source`=`wiki`/`drive`，`space_id`/`title` 冗余存便于直接查。
- **采集挂载**：`feishu-user.ts` 的 `syncDocViewRecords()`，**独立 1 小时**回圈（`DOC_VIEW_REFRESH_MS`，与 5 分钟成员同步/重扫分开；首次延迟 `DOC_VIEW_INITIAL_DELAY_MS=8s`）。**quiet 模式照常采集**。单轮上限 `DOC_VIEW_MAX_TARGETS=600` 文档（execFileSync 同步阻塞，限单轮时长；超出会在 summary 里报候选总数）。
- **store API**：`recordDocViewEvent`（回 true=新事件）/ `recentDocViewEvents`（仿 calendar 区块）。CLI：`pnpm agent doc-views`（按 last_view_time 倒序列【文档 / 访问者 / 时间】）。
- **lark 封装**（`src/core/lark.ts`，全部原生命令看 `code===0`、翻页 `has_more`+`page_token`）：`listWikiSpaces` / `listWikiNodesDeep`（BFS 跟 `has_child` 递归，封顶 500 父节点/5000 节点）/ `listDriveFilesDeep`（云盘 BFS，封顶 200 文件夹/2000 文件）/ `listFileViewRecords`（失败抛 `LarkApiError`）/ `isViewRecordForbiddenError`。

### ⚠️ 飞书访问记录 API 真相（实测，关键约束）

- **view_records 必须是文档的【所有者或可管理(admin)】才读得到**，光 edit/read 一律 `forbidden`（错误码 **1069603**，包在 `{ok:false,error:{code}}` 信封里、`res.code!==0`）。实测：操作者 是【数字城邦】空间 admin（非 owner，owner 是某成员 `ou_example_member`）→ 读得到该空间所有节点；操作者 在【知识库/DAO世界】只有部门 edit → forbidden。采集器对 forbidden 的空间**第一次拒绝就短路整个空间**。
- **bot 加不进 wiki 空间**（飞书 wiki 成员只能是用户/部门，`+member-add --member-type appid` 实测 UI/调用都加不成 app）→ **知识库轮询身分只能用 user（操作者）token**，约 7 天过期、需定期重授（个人云盘的【智慧记录】docx 操作者 是 owner，本来就能读）。【智慧记录/文字记录】其实是录会议自动存进 操作者 云盘的**普通 docx**，不是妙记物件（妙记 `minutes minutes get` 无任何 view/统计字段，拿不到访问记录）。
- **view_records 返回字段**：`items[].viewer_id`(open_id)/`name`/`avatar_url`/`last_view_time`(unix 秒)；入参 `file_token`+`file_type`(doc/docx/sheet/bitable/mindnote/wiki/file)+`page_size`≤50+`viewer_id_type`。wiki 文档用节点的 `obj_token`+`obj_type`（不是 node_token+wiki）。聚合替代 `drive file.statistics get`：`uv/pv/今日新增/like`，**edit 权就能读**（不需 admin），但只有人数没有【谁】。
- **scope**（user + 应用身份各自要开、且要发版）：`drive:file:view_record:readonly`（读访问记录）+ `contact:user.base:readonly`（访问者名）+ `wiki:wiki:readonly`（枚举知识库，便捷命令 `+space-list` 硬卡 `wiki:space:retrieve`、改用原生 `wiki spaces list` 绕过）+ `drive:drive:readonly`（枚举云盘/statistics）。**user token 只 `auth login` 授权即可；bot/tenant 必须后台开【应用身份】+ 创建版本+发布**，否则 `--as bot` 报 `app_scope_not_applied`(99991672)。SeeDAO `example_lark_profile` 已全开。
