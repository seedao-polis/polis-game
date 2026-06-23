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
- **活动报名**：`calendarEventRsvpHistory(eventId,from,to)` + `upcomingTrackedEventIds(now)`（只取 `start>now` 未开始的）。`EXCLUDED_EVENT_KEYWORDS` 排除内部会议（含 `市政厅每周二`——⚠️ 真实日历标题是【市政厅每周二**晚**七点工作会】，用子串匹配，别写全名漏【晚】）。`accepted` 为报名主指标。
- **知识库浏览热点**：即时 `listWikiNodesDeep`（`WikiNode` 已加 `parentNodeToken`、`listWikiChildNodes` 已解析 `parent_node_token`）；space_id 从 `doc_view_events` distinct **动态取**（`wikiSpacesBetween`，无需配置 env）；`docViewersBetween(from,to)` 返回每文件 viewer open_id 列表。**剪枝**：只留 `readers>0` 的节点 + 其祖先路径（否则上千节点不可读）。**排除具体档案标题**（`.png/.gif/.jpg/.jpeg/.pdf/.md`，`isExcludedFileTitle`）。

## 工作人员归类（红蓝着色）

- 工作人员 = `STAFF_CHAT_IDS` = 市政厅工作群 `oc_example_work_group_old` ∪ 运营小天地 `oc_example_ops_group` 的成员。
- `resolveStaffOpenIds()` **每次产图前即时 `listChatMembers` 抓**（失败回退本地 `chatMemberOpenIds(DB)`）→ 每日 04:55 产图前自然更新一次。
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

- supervisor 挂 `scheduleDailyOpsReport`（每日 **04:55**）+ `scheduleMonthlyOpsReport`（每月 1 日 04:55），都 `{ larkChat: 运营小天地 }` + Telegram。
- ⚠️ **为什么 04:55 不是 05:00**：05:00 是逻辑日翻转点，**过了就翻到新（空）逻辑日**。04:55 用 `ref=new Date()`（现在）捕捉【即将收尾的当前逻辑日/月】。**别传 yesterday**（在 04:55 会 `logicalDayStart` 多退一天）。
- ⚠️ 排程**在 serve 启动时才挂上** → 改了代码要 `pnpm build` + **重启 serve**（最新构建）才生效；serve 没跑就不触发。从 repo 目录起。
- **CLI**：`pnpm agent report daily|monthly [--date YYYY-MM-DD] [--lark-user <open_id>] [--lark-chat <chat_id>]`。`--lark-user` 私聊预览（=群发格式，验收用）、`--lark-chat` 发群。一次性 CLI 已 `enableLogSink()`+退出 `flushTelegramSync()`。
- **log**：serve 的 log→Telegram 镜像（`[sup]` 标签，`TELEGRAM_LOG_LEVEL=info`）会显示【运营报告生成开始 / 渲染完成 / 已发送到飞书 / 发送完成】+ 失败时的 error（`Python渲染失败` / `发送飞书失败` / `发送图表失败` / `每日运营报告生成失败`），便于定位哪步出问题。

## Python 环境

`scripts/.venv`（专用 venv，已 gitignore）；`requirements.txt` = `matplotlib>=3.8`、`networkx>=3.2`（pygraphviz 选用、注释）。建：`python3 -m venv scripts/.venv && scripts/.venv/bin/pip install -r scripts/requirements.txt`。Linux 部署另需 `apt-get install fonts-noto-cjk`。`ops-report.ts` 优先用 `scripts/.venv/bin/python3`，缺失回退系统 `python3`。

## 改动文件

`src/core/ops-report.ts`（新，主管线）、`store.ts`（5 个区间/成员查询函数）、`lark.ts`（`WikiNode.parentNodeToken` + `listWikiChildNodes` 解析）、`supervisor.ts`（两个 04:55 排程 + `OPS_REPORT_CHAT_ID`）、`bin/agent.ts`（`report` 子命令 + `--lark-user/--lark-chat`）、`scripts/`（`render_report.py`、`charts/{fonts,line_chart,tree_chart}.py`、`requirements.txt`、`README.md`）、`.gitignore`（`scripts/.venv/`、`.ops-report-*`）。无 DB migration（不持久化 wiki 层级，每次报告即时采集）。
