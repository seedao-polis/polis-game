# 每周社区动态周报 playbook（2026-07-02 加）

> 目的：每周四 21:00 触发，统计【上周四 21:00 → 本周四 21:00】共 7 天的社区动态，用 Kimi 生成【五个面向】的简体中文洞察，写成一个 **docx 页面挂到飞书 wiki 知识库**（S12 城邦工作台节点下）并自动发布。与运营日报互补：日报是图 + ≤500 字发群，周报是 Markdown 长文入 wiki。模块主体 `src/core/weekly-report.ts` + `src/core/weekly-narrative.ts`。

## 架构（一句话）

`weeklyReportRange(now)` 定 7 天窗 → 复用 `gatherDayData(range)`（日报那套、本就吃任意窗）+ `eventsStartingBetween` 取数 → `generateWeeklyNarrative`（Kimi map-reduce 产五面向 **Markdown**）→ 组整份 Markdown → **原生 lark-cli api 建 wiki 节点 + `docs +update` 写 docx（`--doc-format markdown`）** → 可选发单群通知带链接。全走 `--as user`（bot 加不进 wiki）、不过 MCP，所以**不受 outbound-guard 影响**。

## 五个面向 + 数据来源

1. 🗣️ 社区聊天主题（主动交流）— `messages` 文字，AI 话题聚类。
2. 🎨 成员分享与作品（被动展示）— **无结构化标记**，AI 从 `messages.text` 萃取"分享"语义；数据最稀疏。
3. 📈 社区运营动态 — 人数/活跃度（`member_sync_rounds`、`messages` 直接可捞）+ 知识库浏览（`doc_view_events`/`docReaderDigestBetween` 直接可捞）+ 治理状态（**无来源**、AI 从消息萃取提案/投票/决议）。
4. 📣 招募/CTA — **无来源**，AI 萃取。
5. 📅 本周活动 + 未来一周活动 — `eventsStartingBetween`（本周已发生）+ `upcomingTrackedEventIds`（未来），来自 `calendar_event_rsvp_rounds`（飞书日历采集）。

- 【首版决策】稀疏面向（2 / 3c / 4）一律 AI 萃取、数据不足写「本周暂无」，不阻塞上线。

## 时间窗：周四 21:00 锚点（别踩）

- `weeklyReportRange(ref)`（`src/core/time.ts`）：`to` = ≤ref 的最近一个【周四 21:00】，`from = to − 7×24×3600`（返回秒）。**本地时间**、禁 `toISOString()`（同日报）。
- ⚠️ **语义**：周四 21:00 之后跑 = 当周窗（本周四为 to）；周四 21:00 之前跑 = 上一周窗。所以【周四晚上触发排程】正好得到"上周四 → 本周四"。若要强制"截到现在"而非对齐周四，当前不支持（靠恰好周四 21:xx 触发；实跑就是周四 21:11 触发拿到 6/25→7/2 窗）。
- 7 天 = 604,800,000 ms < 2³¹−1 → **普通 `setTimeout` 即可，不需 `safeSetTimeout`**。
- 排程 `scheduleWeeklyOpsReport()`（`supervisor.ts`）算下一个周四 21:00、触发后自行 reschedule；**触发前先 `checkUserTokenExpiry(profile)` 提醒刷 token**（7 天 token 与 7 天周期正好卡在到期边界）。
- ⚠️ 部署时区须 `Asia/Shanghai`（UTC+8），否则"周四 21:00"偏移（本机 TST 也是 +0800、可行）。
- ⚠️ `messagesBetween` 吃**毫秒**（内部 ×1000）、其它 `*Between` 吃**秒**——周报 range 统一秒、各 store 函数按各自口径。

## 写飞书 wiki（最关键，全是踩坑）

### 走原生 api + `--as user`

- **bot 加不进 wiki 空间**（`+member-add --member-type appid` 无效）→ 建节点 / 写文档只能 user 身份。封装在 `src/core/lark.ts`：
  - `createWikiNode(spaceId, parentNodeToken, title, {profile})` → 原生 `api POST /open-apis/wiki/v2/spaces/{space}/nodes`（`obj_type:'docx'`、`node_type:'origin'`），看 `code===0`，返回 `{nodeToken, documentId}`（documentId = 响应的 `obj_token`）。
  - `appendDocxContent(documentId, content, {profile, overwrite, format})` → `docs +update --api-version v2 --command overwrite|append --content <md> [--doc-format markdown]`，看 `ok===true`；失败返回 false（**不抛**，管线优雅降级）。
  - `insertDocxImage(documentId, filePath, {profile})` → `docs +media-insert`（best-effort、never throw）；**目前主管线未接入图片（后续项）**。
- 目标 wiki 坐标放 `configs/lark.json` 的 `weeklyReportWiki`（`spaceId` + `parentNodeToken`，S12 城邦工作台节点下），经 `configs.ts` 读，别写死。读节点用原生 `api GET /open-apis/wiki/v2/spaces/get_node --params '{"token":<node_token>}'`（`wiki:wiki:readonly` 即可、看 `code===0`）。

### ⚠️ scope 坑（核心：便捷命令卡更严 scope）

- 便捷命令 `+xxx` 常比原生 `api` 卡更严的 scope（同 `lark-cli-playbook §10`）：
  - `wiki +node-get` 硬卡 `wiki:node:retrieve`（没授）→ **读节点改原生 `get_node`**。
  - `docs +update --command append/overwrite` **写入前要先读文件**定位末块 → 需 `docx:document:readonly`（不只 `write_only`）。**首跑就栽在这**：节点建成但内容 `missing_scope` 写失败、留空页。
- **写周报实测需要的 6 个 user token scope**（都在 app 后台已开通、只是没授给 token）：`wiki:node:create`、`docx:document:create`、`docx:document:write_only`、`docx:document:readonly`、`docs:document.media:upload`、`drive:file:upload`。
- **授权是覆盖式**：`lark-cli --profile example_lark_profile auth login --scope "<现有全部 + 新增 的并集，含 offline_access>"`（device flow、浏览器核准）。**别只传新 scope**（会丢掉原有 im/calendar）。最省心：先 `auth status` 抓当前 `scope` 再拼并集去重。
- **不用改 token 代码**：`token-watch.ts` 的 `renewCommand` 读 live `scope` 自动延续，重登带上写 scope 后每周续期自动回放、不退回只读（首版研究一度误判要改 scope 清单，作废）。
- 查后台开通的 scope：`auth scopes`；查已授予的：`auth status` 的 `scope`；`auth check --scope "<a>"`（多个只认最后一个）。**写 wiki/docx 走 user 身份，不需给 bot 应用身份开 + 发版**（对比知识库采集也是 user）。
- user token 约 7 天过期（`refreshExpiresAt`），到期重登（已有 Telegram 提醒 + 周报触发前再查一次）。空间写入权是 OAuth scope 之外的一层：user 本人须对目标 wiki 空间有编辑/管理权（操作者是该节点 owner，已满足）。

## 内容形式 = Markdown（emoji + 多级标题 + 列点 + 链接）

- 【运营者要求，永久格式】多 emoji、尽量列点、充分用飞书多级标题分层、必要处加 link。
- **靠飞书 `docs +update --doc-format markdown`**：Kimi 直接产 Markdown、飞书转成原生 docx 区块——比手拼区块 XML 稳得多（原方案手拼 `<h1><ul>` XML，改 markdown 后 emoji/标题/列点/链接一次到位）。
- 飞书 Markdown 要点（`lark-cli skills read lark-doc references/lark-doc-md.md`）：**单一 `#` 一级标题且必须在开头**（多个 H1 会 Untitled）、正文从 `##` 起；`- ` 列点、`[名称](链接)`、`![alt](url)` 网络图片、`---` 分隔线、GFM `| |` 表格、`**加粗**`。
- ⚠️ 转义：`<` 会被当 XML 标签起始（裸 `<`/`>` 要避免或转义）；`#`/`-`/`+`/`>` **仅行首**要转义、`|` 在表格 cell 内要转义。代码里 `mdInline()` 对成员名 / 文档标题做行内转义。
- `weekly-narrative.ts` 的 analyst prompt 已要求：五面向各一个 `## <emoji> 面向N·标题`（**缺一不可**）、列点、`###` 细分、`**加粗**`、`[名称](链接)`、简体大陆用语、用【】《》不用「」；group-digest prompt 保留原文 URL 供引用。
- ⚠️ 大内容传参：`--content` 支持 `@file` / `-`(stdin) 绕 shell 转义，但 `larkExec` 走 `execFileSync`（无 shell）、直接把 markdown 当一个 argv 传即可（几 KB 没问题）。

## 字数：docx 无长度限制 → 别硬截断（别踩）

- ⚠️ 日报的 `≤500 字硬截断` 是**发群消息**的长度约束；周报**写 docx 没长度限制**。若沿用小上限（曾设 2000），Kimi 产 3000~6000 字时会把**尾端的面向四、五整段砍掉**（首版就这么丢了两个面向）。
- 现设 `WEEKLY_NARRATIVE_CHARS = 20000`（纯安全网、正常不触发），保证五面向完整。

## 手动写单篇文档到 wiki（不走周报管线，2026-07-03 加）

有时要**手写一篇文档挂到 wiki**（如把讨论沉淀成方案页），不必跑 `report weekly`。直接用 lark-cli 原生命令即可，**serve 运行时也安全**（不开 `.agent/<soul>.db`、不抢锁；也不过 outbound-guard）。真实 profile 是 `jcnhe1etwt45`（脱敏 memory 里写 `example_lark_profile`）。两步：

1. **建节点**（挂到 S12 市政厅工作台下）：

   `lark-cli --profile jcnhe1etwt45 api POST /open-apis/wiki/v2/spaces/7641789411853372346/nodes --as user --data '{"obj_type":"docx","node_type":"origin","parent_node_token":"EEPKwDxzhi22BAksipac7vhLnUb","title":"<标题>"}'`

   看 `code===0`；从返回取 `data.node.node_token`（wiki 链接用）和 `data.node.obj_token`（= documentId，写内容用）。

2. **写内容**（Markdown、覆盖式、幂等）：

   `lark-cli --profile jcnhe1etwt45 docs +update --api-version v2 --doc <obj_token> --command overwrite --doc-format markdown --content - --as user < 内容.md`

   看 `ok===true`。

**三个实测坑**：
- **是 `--doc <obj_token>` 不是 `--doc-id`**（后者报 unknown flag）。
- **`--content` 的 `@文件` 必须是 cwd 相对路径**（绝对路径被沙箱拒）→ 直接用 **stdin `--content -`** 最省事，多行 / emoji / 【】都不用转义。
- **overwrite + markdown 会把 wiki 节点标题自动同步成正文首个 `#` H1**——所以正文第一行 H1 就是最终页面标题，建节点时的 title 会被它覆盖（想一致就让 title == H1）。
- 其余 scope / 授权 / Markdown 语法坑同下面各节（6 个 user scope、单一行首 `#`、`<` 转义等）。
- 读回校验：`api GET /open-apis/docx/v1/documents/<obj_token>/raw_content --as user`（`data.content` 是去格式纯文本，可比对首尾确认没截断）。

## 运行选项 & CLI

- `pnpm dev report weekly`（tsx 免编译）/ `pnpm agent report weekly`（要先 `pnpm build`）。
- `--dry-run`：采数据 + 生成 + 打印 Markdown，**不写 wiki 不通知**（注意：dry-run 不验证 wiki 写入路径，真实往返要非 dry-run）。
- `--no-narrative`：跳过 AI 洞察段（只发数据摘要）。
- `--no-notify`：建页写入但**不群发通知**（首次人工实跑用，先看过再决定昭告）。
- `--reuse-doc <docId> --reuse-node <nodeToken>`：把内容写进**既有**文档、跳过新建节点（失败重试不留空壳、不产生重复页）。
- `--space-id` / `--wiki-token`：覆盖目标坐标（测试用）。
- 写入一律 `overwrite:true`（幂等，重跑取代旧内容而非追加成重复）。
- 自动：serve 起后每周四 21:00 触发（改码要 `pnpm build` + 重启 serve）。

## 与运营日报的复用 & 边界

- **复用** `gatherDayData(range)`（`ops-narrative.ts`，本就吃任意窗）、map-reduce Kimi 架构、隐私分层（work 群仅指标、public+member 才进内容）、`excludeFromOpsReport` 整群剔除也生效。
- **不受 outbound-guard 影响**：写 wiki 走原生 api、不过 MCP `feishu_send`。
- 通知只发**单一群**（`运营小天地`）不群发（避免 `isFanoutFlood`）。

## 首次上线经过（2026-07-02，都实测）

1. 首跑：节点建成、内容因缺 `docx:document:readonly` 写失败（空页）→ 补授权 + `--reuse-doc` 把内容填进既有空页（不留空壳）。
2. 2000 字上限把面向四、五砍掉 → 提高到 20000。
3. 手拼区块 XML 换成 `--doc-format markdown`（满足 emoji / 多级标题 / 列点 / 链接需求）。
4. 加 `--no-notify` / `--reuse-doc` / `overwrite` 选项。

- 首份周报页面在【S12 城邦工作台】节点下（真实 nodeToken 见运行日志，坐标在 `configs/lark.json`）；本次以 `--no-notify` 未昭告。
- 未新增 DB migration（纯复用现有采集表）。lark-cli 版本 1.0.55（新版 1.0.63 未升，避免行为变动）。
- 研究 / 施工记录：`thoughts/shared/research/2026-07-02-weekly-community-ops-report.md`、`thoughts/shared/coding/2026-07-02-weekly-community-ops-report-implementation.md`。

## 通用教训重申

- **便捷命令比原生卡更严 scope**：报告 / 排程这类确定性管线优先走原生 `api` + 精确 scope，避免 `+xxx` 便捷命令临时索要额外 scope 导致运行时才炸。
- **别把发群的长度约束套到写文档上**：不同产出介质有不同限制，硬截断要看目标介质。
- 同其它 playbook 的老规矩：写 wiki 走 user、bot 加不进 wiki；日期标签本地时间别 `toISOString()`；`messages.create_time` 是毫秒。
