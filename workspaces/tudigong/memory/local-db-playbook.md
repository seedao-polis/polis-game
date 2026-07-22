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

- 表：`chats`（含 external）、`messages`（`message_id` 主键 → `INSERT OR IGNORE` 原生去重，可删掉 `transcript.ts` 的内存 Set + 重启扫档）、`profiles`、`pt_ledger`（append-only 点数账本，余额 `SUM(delta)` 或快取；**⚠️ 2026-06 前叫 `ap_ledger`，`db.ts` 有 `ALTER TABLE ap_ledger RENAME TO pt_ledger` + `RENAME COLUMN ap_balance TO pt_balance`；旧文档写 `ap_ledger`/`ap_balance`/`grantAp` 一律读作 `pt_ledger`/`pt_balance`/`grantPt`**）、`badges` + `user_badges`、`activities`；`messages.text` 建 FTS5。**⚠️ 2026-06-25 拆库**：`profiles`/`pt_ledger`/`badges`/`user_badges`（积分·徽章·profile）现落**全局共享库 `.agent/shared.db`**（`getLpDb()`），`.agent/<soul>.db`（`getDb()`）只剩 `messages`/`activities`/`chat_members`/`event_dispatches` 等 per-agent 数据；查 LP / 改积分认准 shared.db，见 `pt-gamification-playbook §9`。
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

## 11. SQLite → PostgreSQL 迁移（tudigong 专属；其余 soul 无限期留 SQLite）

> 完整细节（架构决策、逐档改法、ETL 脚本设计、正式割接手册）独立成册：`pg-migration-playbook.md`。这里只记本册该有的定位信息与关键结论，方便沿本册的表结构脉络查到"后来改去哪了"。

- **范围**：`.agent/shared.db`（LP 经济，全体 soul 共用）→ PostgreSQL `feishu_biz.shared` schema；`.agent/tudigong.db`（tudigong 专属对话/运营数据）→ `feishu_biz.soul_tudigong` schema。**其余 soul（analyst-mira/trader-yifan 等）的 `getDb()`/`tx()` 无限期留在 SQLite**，两种后端长期并存，不是过渡期产物。
- **驱动**：`pg`（node-postgres），未选 `postgres.js`。`src/core/db.ts` 新增 `SqlExecutor` 接口（`{query(sql, params): Promise<{rows, rowCount}>}`），`getDb()`/`getLpDb()` 都改回传 `Promise<SqlExecutor>`；SQLite 分支包一层 `sqliteExecutor()` 兼容层，让**同一份 SQL 文字**（`$N` 占位符、`ILIKE`）在两种后端上都能跑——兼容层做 `$N`→`?`（**每个出现位置各自展开**，同一个 `$N` 出现两次要各自映射到自己的绑定值，不是只替换一次）+ `ILIKE`→`LIKE`（SQLite 默认 ASCII 大小写不敏感，够用）。
- **切后端开关**：`lpUsesPg()` = `!!process.env.AGENT_PG_URL`（对所有 soul 生效，因为 LP 经济全局共用）；`soulUsesPg()` = `AGENT_SOUL==='tudigong' && !!process.env.AGENT_PG_URL`（只对 tudigong 生效）。`.env` 加 `AGENT_PG_URL`（连线字串）+ `AGENT_PG_POOL_MAX`（连线池上限，默认 5）；**留空则该功能维持 SQLite，两者可独立开关**（例如只上 shared 不上 soul，即目前的 Phase 2-only 中继态）。
- **双后端交易设计**：`AsyncLocalStorage` 包住"目前交易连线"（`lpTx()`/`tx()`）——PG 分支从连线池借一个 `PoolClient`、`BEGIN`/`COMMIT`/`ROLLBACK` 都在它上面跑、`ALS.run()` 让整棵嵌套 async 调用树共用同一个连线；`getLpDb()`/`getDb()` 交易内被调用会读到 `ALS.getStore()` 里的同一个连线（**可重入闸门**，交易内再嵌套调用不会误借第二个连线）。SQLite 分支完全不变（原本就是单一进程内的同步 `db.exec('BEGIN'...)`）。
- **`⚠️ pg` 驱动预设把 `NUMERIC`/`BIGINT` 读成 JS 字串，不是 number**——已在 `db.ts` 模块顶层做**一次性全局** `pg.types.setTypeParser(1700, parseFloat)`（NUMERIC，OID 1700）+ `pg.types.setTypeParser(20, v => parseInt(v,10))`（BIGINT，OID 20）。少了这步，`pt_balance.toFixed(1)` 这类下游调用会静默炸（字串没有 `.toFixed`），且时间戳比大小会退化成字典序比较。
- **型别对映**（照 SQLite 亲和性、非逐字翻译）：自增主键 `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGINT GENERATED ALWAYS AS IDENTITY`；LP/金额栏位（`pt_balance`/`pt_ledger.delta`/`checkins.pt_awarded`/`pending_replies.pt_spent`）一律 `NUMERIC(12,1)`（`tc_bets.lp_amount`/`predict_bets.lp_amount` 等下注金额 `NUMERIC(12,4)`），**绝不用 INTEGER/REAL**；0/1 布尔栏位维持 `SMALLINT`（不改 `BOOLEAN`，避免全面改写 `WHERE col = 1`）；unix 秒/毫秒时间戳一律 `BIGINT`，`DEFAULT` 用自订 `unixepoch()` 函式（`extract(epoch FROM now())::bigint`，模拟 SQLite 同名函式）；JSON 序列化栏位（如 `messages.mentions`）维持 `TEXT`，`JSON.parse`/`stringify` 边界不动。
- **FTS5 全文搜寻降级为 `ILIKE`**：目标伺服器不能装扩充套件，`messages_fts`（trigram）与 `memory_fragments` 的 LIKE 搜寻都改 `ILIKE ... ESCAPE '\'`（自写 `escapeLikePattern()` 逃脱使用者输入里的字面 `%`/`_`）。语意比 FTS5 trigram 略宽（子字串匹配、非分词），但**不会漏掉**既有结果——已定案接受，效能优化（如手写维护的 `tsvector` + GIN 索引）留后续工作。
- **`⚠️` PostgreSQL 参数型别推断是左到右、按第一个有型别语境的出现位置决定**（本次迁移实测发现、之前没人记过）：同一个 `$N` 被重复使用时（例如 `WHERE (message_id <> $2 OR $2 IS NULL)`），**必须把有型别的比较放在 `IS NULL` 检查前面**——反过来写（`$2 IS NULL OR message_id <> $2`）会在真实 PostgreSQL 上炸 `could not determine data type of parameter`（错误码 `42P08`），但**在 SQLite 上两种写法都能跑**（SQLite 没有这个限制），所以这个坑只有接上真的 PostgreSQL 才测得出来——纯 SQLite 测试套件测不出，这是新增 `*.pg.test.ts`（见下）的价值所在。别用 `$N::text`/`$N::bigint` 显式转型绕过（那样 SQLite 分支会因为不认得 `::` 语法直接报语法错误）。
- **SQLite 独有语法清单**（逐一替换）：`INSERT OR IGNORE`/`INSERT OR REPLACE` → `ON CONFLICT ... DO NOTHING`/`DO UPDATE SET ... = excluded.col`（两边都支援这个 upsert 语法，机械替换）；`.lastInsertRowid` → SQL 尾端加 `RETURNING id`（两边都支援），呼叫端改读 `result.rows[0].id`；隐式 `rowid` 作为 `ORDER BY` 次要排序键**没有 PostgreSQL 对应物**，一律拿掉（**已定案接受的行为变化**：同一秒内多笔时间戳相同的记录，谁排前面变成不保证——已把依赖这个次序的既有测试改成"断言笔数/去重/自洽"而非"断言精确顺序"，见 `store.test.ts` 的 `pinnedMessagesOldestBeyond` 测试）；`LIMIT -1`（SQLite 的"不设限"写法）在 PostgreSQL 是非法语法，改用足够大的哨兵值 `LIMIT 1000000000`（两边行为一致）。
- **测试**：既有 15 个 SQLite 隔离测试档（`AGENT_DB_PATH` 指向 `mkdtempSync` 临时档）维持不动、继续跑 SQLite 分支（照样是有效的回归覆盖，因为跑的是同一份 `SqlExecutor` 抽象）；另外新增 `*.pg.test.ts` 系列（`gamification.pg.test.ts`/`messages.pg.test.ts`）**专门**对着本机 Docker PostgreSQL（`docker-compose.test.yml`，`pnpm test:pg:up`/`down`）跑，专门覆盖上面几条"只有真 PostgreSQL 才会炸"的坑（型别推断顺序、`spendPt` 并发、`NUMERIC`/`BIGINT` 转型）。**`pnpm test` 现在隐含要求 Docker 跑着**（因为 glob 会连 `*.pg.test.ts` 一起吃进去），这是从 Phase 2 就定下的既有取舍，不是新引入。
- **实际迁移日期与验收结果**：详见 `pg-migration-playbook.md`（含金额分毫不差的具体数字、ETL 效能优化、正式割接执行状态）。**✅ 2026-07-22 已正式割接、tudigong 现跑 PG**。
- **⚠️ 割接后最大教训：同步阻塞调用是 async DB 的头号杀手**。SQLite 时代 `store.*` 同步返回、事件循环被别的同步调用堵住无所谓；换 PG 后 `store.*` 全 async、靠事件循环 resolve promise，而本代码库有大量故意的同步阻塞（`lark.ts` 的 `execFileSync` 调 lark CLI 每次 0.5-2 秒、轮询 14 群不停调），事件循环被占满导致**所有在途 PG 查询 resolve 不了**——profile 指令回复一度延迟 12 分钟。根治＝把 `larkExec`/`larkExecSend` async 化（`execFileSync`→`execFile`、`Atomics.wait`→`await sleep`，保留 429-only 重试语义）+ `syncChatMembers` 批次化（交易语句 ~1800→~9）。诊断靠 `db.ts` 的三段耗时归因日志（执行/池等待/事件循环阻塞）。剩 `kimi.ts` 的 `runFileSync` 未动（LLM CLI）。完整两台手术记录 → `pg-migration-playbook.md §7`。
