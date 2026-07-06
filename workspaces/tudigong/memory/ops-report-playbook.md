# 运营数据报告 playbook（2026-06-20 加）

> 目的：每日 / 每月把社区运营数据画成图发出去。**目前发 Telegram + 飞书【运营小天地】群**，由 supervisor 定时触发。模块主体 `src/core/ops-report.ts` + Python 绘图 `scripts/`。三块数据：入口群人数、活动报名、知识库浏览热点。

## 架构（一句话）

Node 查 SQLite + 即时采集 wiki 节点树 → 组 JSON spec → `spawn` Python（matplotlib）渲染 PNG → 各别发 Telegram + 飞书富文本 post。**Node 管数据、Python 管画图，单向**；Python 端无状态（吃一份 spec.json、吐 PNG、stdout 印 `{key:path}`）。

## 时间口径：逻辑日 05:00 起算（核心，别踩）

- **逻辑日 = 当日 05:00 → 次日 05:00**（半开 `[起05:00, 迄05:00)`，即到次日凌晨 04:59）。`logicalDayStart()` / `logicalMonthStart()` 锚 05:00。
- daily = 当前逻辑日（capped at now）；monthly = 逻辑月（1 日 05:00 → 次月 1 日 05:00，capped at now，**无缺口**，含最后一日那个逻辑日）。
- **月报折线用 5 分钟原始点**（不要按日聚合成一点）；daily/monthly 折线都是原始 5 分钟点，差别只在时间范围与 x 轴格式（daily `%H:%M` / monthly `%m-%d`）。
- ⚠️ **日期标签/摘要一律本地时间**（`formatLocalDate` / `formatRangeLabel`），**别用 `toISOString()`**（UTC 会差一天/一月）。

## 三块数据来源（store.ts 末尾新增的辅助函数）

- **入口群人数**：`member_sync_rounds.present_external` 代理唯一围观群（`oc_example_public_group`）。`memberSyncRoundsBetween(from,to)`。⚠️ 偶有**单点读取故障凹陷**（如 201 夹在 267/269 之间）→ `dropMemberDips()` 过滤（同时低于前后邻点 85% 即剔除）；那一条 v 也可直接从 DB 删（已删过 `synced_at=1781885438`）。
- **活动报名**：`EXCLUDED_EVENT_KEYWORDS` 排除内部会议（含 `市政厅每周二`——⚠️ 真实日历标题是【市政厅每周二**晚**七点工作会】，用子串匹配，别写全名漏【晚】）。`accepted` 为报名主指标。**日报**：`upcomingTrackedEventIds(now)`（只取 `start>now` 未开始的）+ `calendarEventRsvpHistory(eventId,from,to)`（当天原始 5 分钟点，实时追踪未开始活动）。**月报（2026-07-01 改，之前是错的）**：不能用 `upcomingTrackedEventIds`——月报在次月 1 号跑，当月活动全部已过 `start<now` 会被**全部漏掉**（图里空白）。改用 `eventsStartingBetween(from,to)`（按 `start_time` 落在报告月内选活动，含已过的）+ `calendarEventRsvpAll(eventId)`（整段报名史）；每条线画【从报名到活动开始】（`syncedAt<=startTime`、末尾补一个 `startTime` 收尾点让线止于开始），并用 `bucketSignupPoints()` 按 **`SIGNUP_BUCKET_SEC=3600`（每小时）降采样**（月尺度原始 5 分钟点太密不可读）。标题月报=【各活动报名趋势（报名至活动开始）】。`bucketSignupPoints` 是纯函数、有单测（`ops-report.test.ts`）。
- **知识库浏览热点**：即时 `listWikiNodesDeep`（`WikiNode` 已加 `parentNodeToken`、`listWikiChildNodes` 已解析 `parent_node_token`）；space_id 从 `doc_view_events` distinct **动态取**（`wikiSpacesBetween`，无需配置 env）；`docViewersBetween(from,to)` 返回每文件 viewer open_id 列表。**剪枝**：只留 `readers>0` 的节点 + 其祖先路径（否则上千节点不可读）。**排除具体档案标题**（`.png/.gif/.jpg/.jpeg/.pdf/.md`，`isExcludedFileTitle`）。
- ⚠️ **树上的数字是【去重读者数】不是浏览次数（2026-07-01 澄清）**：`docViewersBetween` 是 `SELECT DISTINCT file_token, viewer_id`，所以每个节点圆圈的数字 = 该文档**去重读者数**（一人看多次只算一），`nonstaff` = 其中非工作人员去重读者数；标签 `(非工作人员读者数) 去重读者数`。**曾经的坑**：值本来就是去重读者，但副标题 / 标题误写成【总浏览次数】，让人以为是浏览次数——已把标题改【知识库阅读热点（去重读者数）】、副标题改【格式: (非工作人员读者数) 去重读者数】、TG caption 同步。日报月报同一条码路（`buildWikiTreeNodes` 与 period 无关），两边都是去重。文字摘要 `totalReaders` 是各文档去重读者**相加**=读者人次（一人看 N 篇算 N），措辞已改【累计 N 读者人次（去重读者），覆盖 M 份文档】别当成去重人头。

## 工作人员归类（红蓝着色）

- 工作人员 = `STAFF_CHAT_IDS` = 市政厅工作群 `oc_example_work_group_old` ∪ 运营小天地 `oc_example_ops_group` 的成员。
- `resolveStaffOpenIds()` **每次产图前即时 `listChatMembers` 抓**（失败回退本地 `chatMemberOpenIds(DB)`）→ 每日 04:59 产图前自然更新一次。
- 每文件 `nonstaff = viewers 中不在 staff 集合的数量`，比例 → 节点颜色蓝↔红插值。⚠️ `doc_view_events.viewer_id` 与 `chat_members.open_id` 同为 `ou_`，可直接匹配。

## 图表（`scripts/`，深色 16:9）

- **比例 16:9（1920×1080）**，`figsize=(9.6,5.4)` `dpi=200`。（原需求【9:16 横图】自相矛盾，已拍板 16:9 横式。）
- **深色主题** `apply_dark_theme()`（`fonts.py`，`render_report.py` 启动时调）：深底 `#1a1b1e`、文字/轴/刻度/图例/格线浅色。中文字型 `setup_cjk_font()`（macOS PingFang / Linux noto-cjk）。
- **折线** `line_chart.py`：亮色调色盘；**图例永远显示（左上角，单线也显示）**，否则不知哪条线是哪个活动。标题含日期：【`2026/06/19` 当日围观群人数趋势】【`2026/06/19` 活动报名人数趋势】（月报【当月】、日期用斜线）。
- **树状** `tree_chart.py`（networkx）：画布**随树动态放大**（依层深 × 单层最大宽度，不固定 figsize，文字不挤；超大树降 dpi 收在通讯软件像素上限内）；圆圈半径在**本图 min~max 浏览次数线性映射**（敏感，资料夹固定小圆点 r=6）；圆圈左上角标 **`(非工作人员浏览) 总浏览次数`**（如 `(4) 8`）；颜色**中蓝 `#4a84c4` ↔ 中红 `#c45a5a`**（深色调校，中点柔和紫不过深，`_blend_staff_color`），资料夹中灰 `#868e96`，`alpha=1.0`；`suptitle` 标题 + subtitle 紧贴下方（固定小间距、不随画布高度放大），subtitle = `统计时间 起~迄　偏红=非工作人员浏览越多　次数格式: (非工作人员浏览) 总浏览次数`。
- graphviz `dot` 布局失败自动回退纯 Python BFS 层级（⚠️ **pygraphviz 在 Python 3.14 装不上，已不强装**，requirements 注释掉）。

## 发送 + 暂存目录（重要坑）

- **Telegram**：三图各别 `sendTelegramPhoto` + 一条纯文字摘要 `sendTelegramMessage`。
- **飞书**：`sendReportToLark()` = **单则富文本 post**（`sendPost`，bot 身份），标题 `SeeDAO 每日/每月运营数据 · <日期>` + 摘要逐行 + 三图（`uploadImage` 取 image_key）；**每张图前插一个空行**避免三图太挤。P2P（`--lark-user`）与群发（`--lark-chat`）格式完全相同。
- ⚠️ **`uploadImage` 只接受 cwd 相对路径**（lark-cli 文件沙箱，绝对路径/`../` 逃逸会失败）→ 报告暂存目录必须在 **repo 内**（`mkdtemp(PROJECT_ROOT/'.ops-report-')`，已 `.gitignore`），发完 `finally` `rm` 清理。**别用 `os.tmpdir()`**。serve 从 repo 目录启动才保证 cwd 正确。
- **纯文字摘要**：`围观群人数：N（本日±Δ）`（月报【本月】）/ `活动报名：追踪 N 场，累计 M 人`（无追踪则【无进行中追踪活动】）/ `知识库浏览：K 位读者，覆盖 J 份知识库文档`（**已去掉 Top3**）。

## 排程 + 触发

- supervisor 挂 `scheduleDailyOpsReport`（每日 **04:59**，2026-06-26 从 04:55 改）+ `scheduleMonthlyOpsReport`（每月 1 日 04:59），都 `{ larkChat: 运营小天地 }`（经 `opsReportTargets()` 解析）+ Telegram。
- ⚠️ **为什么 04:59 不是 05:00**：05:00 是逻辑日翻转点，**过了就翻到新（空）逻辑日**。04:59 用 `ref=new Date()`（现在）捕捉【即将收尾的当前逻辑日/月】。**别传 yesterday**（在 04:59 会 `logicalDayStart` 多退一天）。
- ⚠️ 排程**在 serve 启动时才挂上** → 改了代码要 `pnpm build` + **重启 serve**（最新构建）才生效；serve 没跑就不触发。从 repo 目录起。
- 🩹 **月报无限循环根因（2026-07-01 修）**：`setTimeout` 的延迟上限是 `2^31-1` ms（≈24.8 天）；超过就**溢出 32 位、被钳成 1ms 立即触发**（并打 `TimeoutOverflowWarning`）。`scheduleMonthlyOpsReport` 每次重挂的延迟是【下月 1 号 04:59】≈28~31 天 > 上限 → 首次 04:59 正常出报后立刻再触发 → 出报（约 5~7s）→ 再溢出立刻触发 → **死循环**（实测 04:59→08:09 空转 1708 次，把飞书刷成 429、跨过 05:00 后逻辑月翻成新空月故 date 从 2026-06 变 2026-07=看起来"月份也错了"，其实首跑那次 date=2026-06 是对的）。日报重挂只 ≤24h 不受影响，所以只有月报中招。**根治**：`src/core/time.ts` 加 `safeSetTimeout(cb, delayMs)`（延迟 > `MAX_TIMEOUT_MS` 就分段链式重挂），月报排程改用它；日/年任何 >24.8 天的定时都该走它。回归测试在 `time.test.ts`（"overflow-loop regression"）。**排查手法**：日志里同一条 INFO 每几秒重复上千次 + `sed 去时间戳 | uniq -c | sort -rn` 看模板频率，即可锁定循环源。
- **CLI**：`pnpm agent report daily|monthly [--date YYYY-MM-DD] [--lark-user <open_id>] [--lark-chat <chat_id>]`。`--lark-user` 私聊预览（=群发格式，验收用）、`--lark-chat` 发群。一次性 CLI 已 `enableLogSink()`+退出 `flushTelegramSync()`。
- **log**：serve 的 log→Telegram 镜像（`[sup]` 标签，`TELEGRAM_LOG_LEVEL=info`）会显示【运营报告生成开始 / 渲染完成 / 已发送到飞书 / 发送完成】+ 失败时的 error（`Python渲染失败` / `发送飞书失败` / `发送图表失败` / `每日运营报告生成失败`），便于定位哪步出问题。

## Python 环境

`scripts/.venv`（专用 venv，已 gitignore）；`requirements.txt` = `matplotlib>=3.8`、`networkx>=3.2`（pygraphviz 选用、注释）。建：`python3 -m venv scripts/.venv && scripts/.venv/bin/pip install -r scripts/requirements.txt`。Linux 部署另需 `apt-get install fonts-noto-cjk`。`ops-report.ts` 优先用 `scripts/.venv/bin/python3`，缺失回退系统 `python3`。

## 改动文件

`src/core/ops-report.ts`（新，主管线）、`store.ts`（5 个区间/成员查询函数）、`lark.ts`（`WikiNode.parentNodeToken` + `listWikiChildNodes` 解析）、`supervisor.ts`（两个 04:59 排程 + `opsReportTargets()` 经 `resolveChatTarget` 解析运营小天地）、`bin/agent.ts`（`report` 子命令 + `--lark-user/--lark-chat`）、`scripts/`（`render_report.py`、`charts/{fonts,line_chart,tree_chart}.py`、`requirements.txt`、`README.md`）、`.gitignore`（`scripts/.venv/`、`.ops-report-*`）。无 DB migration（不持久化 wiki 层级，每次报告即时采集）。

## AI 社区运营洞察（2026-06-26 加，**仅日报**）

> 目的：每日 04:59 出图的同时，让 Kimi 把当天采集的记录写成一份【社区运营日报】文字，**和图片一起**发到运营小天地 + Telegram。模块 `src/core/ops-narrative.ts`。月报不生成（聊天摘要按月太粗）。

- **数据采集 `gatherDayData(range)`**（纯函数、可测，只读 DB+config）：把一个逻辑日的 messages / member_sync_rounds / doc_view / RSVP 汇成结构化 `DayData`。隐私分层（**核心**）：公开+会员群（`getChatTier`）做**内容摘要**，工作群**只给指标**（消息数、活跃人数）、`lines=[]` 绝不进 prompt；**bot 自己的消息**（各 profile `botOpenId`）从活跃与内容里剔除。
- **新增 store 查询**：`messagesBetween(fromSec,toSec)`——⚠️ **`messages.create_time` 是毫秒**（Feishu，`larkTimeToMs`），函数内部把秒窗口 ×1000；**其它 `*Between` 全是秒**（doc_view.last_view_time、member synced_at、rsvp synced_at）。还有 `getChatMeta`、`docReaderDigestBetween`（标题+读者数、**无 viewer 身份**，隐私安全）。
- **map-reduce（"一次或多次"）`generateOpsNarrative(range)`**：内容字数 ≤ `singlePassCharLimit`(默认 6000) 或仅 1 个内容群 → **单次**（原文直进 reduce）；否则 **map**（每个公开/会员群单独 `runKimiAsync` 出摘要，**并发默认 3**，失败的群丢弃只留指标）→ **reduce** 汇总成日报。每次调用 throwaway workDir、`continueSession:false`、timeout 取 kimi profile（默认 600s）。**任何失败/空/未配置 → 返回 null 优雅降级**（只发图+机械摘要、不报错）。
- **可调 prompt**（改文案不用 build，缺失回退内置常量）：`workspaces/tudigong/prompts/ops-report-analyst.md`（reduce/分析师，**全文≤500字**、三块结构【今日概览】【关键动态】【运营建议】，2026-06-26 从 500~900字8段精简）+ `ops-report-group-digest.md`（map/单群摘要）。**字数硬约束已实现**（光靠 prompt 软约束会超——实测 ask 500 出 711）：reduce 出稿后若 >500 字（`MAX_NARRATIVE_CHARS`，可经 `NarrativeOptions.maxChars` 调）→ `enforceNarrativeLength` 先用 Kimi 压缩一遍（**强制保留【运营建议】**）→ 仍超则 `hardTruncate` 按句子边界截断（按 code point 计、中文一字算一个）。所以无论 LLM 怎么发挥都 ≤500。
- **投递**：复用 `sendReportToLark`（飞书富文本 post：文字=`洞察 + 【数据摘要】机械摘要`，附三图）+ Telegram（`splitForTelegram` 把长文切 ≤3500 字多条发）。目标群仍由 `opsReportTargets()` 取【运营小天地】。
- **开关**：`pnpm agent report daily --no-narrative`（CLI 跳过）/ `OPS_REPORT_NARRATIVE=0`（env 关）。验收：`pnpm agent report daily --lark-user <自己 open_id>` 发 P2P 预览（不打扰群）。
- ⚠️ **时序**：04:59 触发后多次 kimi 可能让报告推迟到 05:1x 才发出；但取数区间在**触发那一刻**就按 `ref=now` 锁定了逻辑日，发送过程跨过 05:00 不影响取数（同原有 04:55 的理由）。
- 改动文件：`ops-narrative.ts`(新)、`store/messages.ts`(`messagesBetween`/`getChatMeta`)、`store/analytics.ts`(`docReaderDigestBetween`)、`ops-report.ts`(集成+`splitForTelegram`+`narrative` 开关)、`bin/agent.ts`(`--no-narrative`)、`workspaces/tudigong/prompts/*`。无 DB migration。

### 运维 / 踩坑（2026-06-26，都实测过）
- **手动补发某逻辑日**：`pnpm agent report daily --date "YYYY-MM-DD 12:00" --lark-chat <运营小天地 id>`（发群目标见 [chat-targets-playbook.md]）。⚠️ `--date` 要给**当天中午**（逻辑日 05:00–次日04:59 内任意时刻）：05:00 之后 `ref=now` 会解析到**当天刚开始的空逻辑日**；只写 `--date YYYY-MM-DD`（=00:00、在 05:00 之前）会被 `logicalDayStart` 退到**前一天**逻辑日（off-by-one）。
- ⚠️ **`runKimiAsync` 的 workDir 必须先存在**：`generateOpsNarrative` 给每次 kimi 调用建 `freshWorkDir`（`mkdirSync recursive`）。漏建 → `execFileSync` 报 `spawn .../kimi ENOENT`，**误导**：错误指向 kimi 二进制，真因是 **cwd 不存在**。任何 `runKimiAsync` 调用方都要保证 workDir 存在。
- **隐私分层 + 重启坑**：内容摘要 tier = public+member（`DEFAULT_CONTENT_TIERS`）；work 群（市政厅工作群/运营小天地/AgentTasks/AgentNotify + **AI 秘密基地**）只计指标、内容不进 prompt。改 `configs/chat-policies.json` 的 tier 后**要重启 serve**（`loadChatPolicies` 进程内缓存一次），CLI 手动触发即时生效。
- **文字规范**：analyst prompt 已硬性要求**简体中文+大陆用语、禁用「」『』、强调/标题用【】、书名群名《》**。
- **改 / 撤已发报告**：撤回 `im messages delete --message-id <om> --as bot --yes`（留【已撤回】空记录）；**原地编辑不重发** 用 raw `api PUT /open-apis/im/v1/messages/<om> --as bot --data -`（详见 [lark-cli-playbook.md] §9），适合只改括号/错字。
- **冒烟（不发送）**：`AGENT_SOUL=tudigong` + `logicalDayStart` 算窗口 → 直接调 `gatherDayData`（查数据流/tier 分层）或 `generateOpsNarrative`（跑 Kimi 但不发）；量测已发叙事字数可 `listMessages` 取 post.content 按 `【数据摘要】` 切。
