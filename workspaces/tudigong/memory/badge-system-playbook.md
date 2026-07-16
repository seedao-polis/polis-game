# 徽章系统 playbook（2026-06-19/20）

给成员（含外部成员）发放带丰富语义的徽章；发放时触发事件系统通知。研究：`thoughts/shared/research/2026-06-19-badge-徽章系統-需求分析.md`；施工总结：`thoughts/shared/coding/2026-06-19-badge-徽章系統-實作總結.md`。

## 1. 数据模型（migration v17）

- 现有 `badges`/`user_badges` 表（v1 建）字段太少，v17 用 `ALTER TABLE ... ADD COLUMN` 扩充：
  - `badges` 加 9 列：`headline`、`file`、`title`、`type`、`role`、`endorser`、`duration`、`category`、`event`（全 `TEXT NOT NULL DEFAULT ''`）。
  - `user_badges` 加 `awarded_by TEXT`、`note TEXT`。
- **字段语义三件套别混**：`badge_id`=唯一稳定 ID（kebab-case）；`badges.name` 复用为 **badge_name**（发放时的名称查询键）；`headline`=显示名（如【第 12 季市政厅成员】）。
- `duration`/`role`/`category`/`event` 一律存 `TEXT` 整串（用 `/` 分隔），拆分/层级/触发逻辑放应用层。`duration` 两栏 `起始/结束`（YYYYMMDD，`00000000`=无开始、`99999999`=无结束）。`event` 前段=获得时事件、后段=失效时事件（**失效触发本期未做**）。
- `ALTER TABLE ADD COLUMN` 不能设 `NOT NULL` 无默认值，所以新列都 `DEFAULT ''`；`db.exec()` 能一次跑多条分号分隔的 ALTER。

## 2. store 函数（`src/core/store.ts`）

- `upsertBadge(b)`：支持全字段 upsert（冲突更新所有列）。
- `listBadges(openId?)`：回传带 `headline`/`type`/`file`；改了这个记得 `commands.ts` 的 `/profile` 调用端要能编译。
- `findOpenIdsByName(name)`：名称反查 open_id（查 `chat_members WHERE name=? AND present=1`，先精确再 `trim` 重试，`DISTINCT`、按 `last_seen DESC`）。
- `getBadge(ref)`：按 `badge_id` 或 `name` 取完整徽章行。
- `awardBadge(openId, badgeId, ref)`、`ensureProfile(openId, name?)` 沿用既有；`note` 目前走 `awardBadge` 的 `ref` 参数（`awarded_by` 列已建但暂未写）。

## 3. CLI：`pnpm agent badge ...`（`src/bin/agent.ts`，仿 `event` 命令）

```
agent badge import <json_file> [--profile <p>]
agent badge award <badge-ref> <target> [target2 ...] [--profile <p>] [--note <text>] [--dry-run]
agent badge list [target]
agent badge delete <badge-ref> [--profile <p>]     # 删定义+清持有，见 §6
agent badge wiki-sync [--profile <p>]              # 手动刷徽章列表 wiki，见 §6
```

- **import**：读 JSON（单对象或数组）逐条 `upsertBadge`。`badge_id` 缺省用内容哈希稳定生成 `'badge-' + sha1(headline|category|duration).slice(0,8)`（重导入幂等）；`badge_name` 缺省=`headline`。JSON 模板与字段说明在 **`create-badge` skill**（`workspaces/_shared/skills/create-badge/`，含 import/award/list 全流程；原 `assets/badges/IMPORT_PROMPT.md` 已并入并删除）。
- **award**：**支持多目标**（空格分隔）。每个 `ou_` 开头直用，否则查 `chat_members`（0 笔报错提示改用 `ou_`、多笔列出全部让人改 `ou_` 指定、1 笔采用）；**任一解析失败整批中止**（不半发），重复目标去重。`--dry-run` 只解析+预览不写库不触发。
- **list**：无参列全部定义；给 `ou_`/名称列该成员持有的。

## 4. 发放流程（award 成功后触发的通知）

对每个目标 `ensureProfile` → `awardBadge`（已持有跳过），收集本次【新发放】清单 `granted`，然后：

1. **逐人私信** `badge-awarded`（personal P2P 恭喜）发给每位 `granted`。
2. **一条群公告**：`badge.event` 首段优先；为空时 `granted` 2 人以上用 `badge-awarded-group`、否则 `badge-awarded-default`；`granted` 为 0（全已持有）则不发。

事件细节（标题/正文/底图/群 ID/@）见 `community-notify-events-playbook.md`。

## 5. 关键坑

- **外部成员外键**：`user_badges.user_open_id REFERENCES profiles`，外部成员 award 前必须先 `ensureProfile`，否则外键失败。
- **bot 私信外部账号会失败**：bot 无法主动私信从未与它建过 P2P 的账号（报 `发送 post 消息失败：Internal Error` 或 `Bot has NO availability to this user`），是优雅失败、不影响群公告。例：`操作者 (海外号)` 就发不进私信。
- **名称查不到**：`chat_members` 靠每 5 分钟 `syncChatMembers` 填，刚进群没同步的查不到 → 改用 `ou_xxxxxx`。
- **日志要进 sup**：award 全程用 `log.*`（非 `console.log`）；一次性 CLI 里 `enableLogSink()` + `process.on('exit', () => flushTelegramSync())`（非 dry-run）才能让发放/事件日志镜像到监督者 Telegram 频道。
- **徽章定义存哪**：决策=用 `badge import` 写 DB（不是代码 `registerBadge`、不是迁移种子）；徽章图片放 repo 根 `assets/badges/`（`file` 字段目前只存语义、未用于渲染）。

## 6. 徽章列表 wiki 自动同步（`badge-wiki.ts`）

飞书 wiki「徽章列表（自动更新）」= 徽章 catalogue 的纯投影，模式完全仿 `meetup-wiki.ts` / `visitor-milestones.ts`（deterministic render + overwrite，无 LLM）。

- **页面**：wiki node `XDu0wErFHi4ZdNkBQ9dcCVTYnkF`，docx obj_token `SATXdNGBwofXCixQK7Lc3REcn8e`。两个 token 都写进 `configs/lark.json`：`badgeWikiNodeToken`（构 URL）与 `badgeWikiDocId`（`appendDocxContent` overwrite 用的是 **docx obj_token**，不是 wiki node token；`configs.ts` LarkFile 接口 + `lark.json.example` 已同步）。
- **渲染**：`renderBadgeWikiXml(listBadgeDefinitions())` 出**文档 XML 子集**（非 Markdown——名称/事件格内 `<br/>` 换行 + id 灰字 `<span text-color="gray">`，Markdown 表格格子撑不住）。列顺序（7 栏）= **徽章 · 名称 · 类型 · 事件 · 说明 · 效果 · 期限**：名称=`name`+换行灰字 `badge_id`；类型=`type` 经 `TYPE_LABELS`（`role→身份`，未知非空原样，空则留白）；事件=`event` 首个 `/` 段经 `EVENT_LABELS`（event_id→中文名，如 `badge-awarded-default→徽章发放公告；badge-awarded/-group/morning_greeting/lurker-discovered/class-event-notify/visitor-num-notify/cityhall-proposal-voted-notify/like-maniac-notify/first-try-notify` 都有；未映射只显灰字 id，空则空格）+换行灰字 event_id；说明=`description`；效果先留空；期限=`duration`（起始/结束 YYYYMMDD，空或双端无界→「永久」，单边有界→`不限/长期`，如 `20260101/99999999→2026-01-01 ~ 长期`）。`EVENT_LABELS` 要跟 events.ts 注册表手动同步。`appendDocxContent(..., {overwrite:true, format:'xml'})` 会连 `<title>` 一起重写，所以 render 必须含 `<title>`。
- **触发点（命令层，别塞 store 层）**：仿 meetup——只在 CLI 动作层调 `refreshBadgeWiki()`，**不**放进 `upsertBadge`（否则迁移种子 first_contact 每次开库都发网络请求、测试也会打真站）。运行时唯一改徽章**定义**的路径就是 `agent badge import`（`predict_judge`/`chest_keeper` 当年也是这么 import 进生产的），所以钩在：`badge import` 收尾（`imported>0` 调 `syncBadgeWikiAfterChange`）、新增 `badge delete <ref>` 收尾、手动 `badge wiki-sync`。`badge award` **不刷**（表是定义投影、不含持有人）。
- **`deleteBadge(ref)`**（gamification.ts）：按 `badge_id`/`name` 解析，`lpTx` 里先删 `user_badges` 再删 `badges`（否则 FK 挡），是「整枚删除、持有一起没」语义。配套 `listBadgeDefinitions()` 出全字段（`listBadges()` 只投影少数列、**没有 duration**，wiki 渲染要用全字段的这个）。
- **落地状态**：已建 `src/core/badge-wiki.ts`，tsc 通过，import→自动刷（含 duration 区间 `2026-01-01 ~ 2026-12-31` 实测正确）/delete→自动刷 端到端验证过。CLI 触发路径 serve **无需重启**（无 serve 侧定义写路径）；CLI 改 src 记得 `pnpm build`。
- **每日 05:00 兜底刷新**（supervisor）：`scheduleDailyBadgeWikiUpdate()` 在 `src/core/supervisor.ts`，仿 `scheduleDailyMeetupWikiUpdate`（08:01）但改 05:00、调 `refreshBadgeWiki({profile:eventSendProfile()})`、自重排。仅兜底绕过 CLI 的直接改库漂移；CLI import/delete 已即时刷。⚠️**此调度器在 supervisor 进程里，必须完整重启 serve（`node dist/bin/agent.js serve --bot tudigong --sup`）才 arm**，光 build 不生效——与 CLI 触发不同。

## 7. 徽章图片：行内嵌进 wiki 表（2026-07-15）

给徽章加图片（`predict_judge`/`chest_keeper` 各一张 500×500 PNG，放进【徽章】列）。**核心坑：飞书 docx 的 overwrite 与图片天然冲突**，摸清后定的方案：

- **飞书 docx 只能三种事实**（逐一实测于本徽章页 docx `SATXdNGBwofXCixQK7Lc3REcn8e`）：① `docs +update` 写 `<img href="网址">`（append 或 block_insert_after）**不会**生成图片——飞书这版不做服务端抓取，`ok:true` 但图被静默丢弃（外网 URL 和 wikimedia 都试过，全丢）；② overwrite 里写 `<img token="已上传token">` **也不生效**，且 **overwrite 会清掉页面所有图片**、token 不跨 overwrite 存活；③ **唯一能把字节塞进飞书的是 `docs +media-insert --file <本地相对路径>`**（progress 走 stderr、JSON 在 stdout 干净可 `larkExec` 解析，回 `block_id`+`file_token`，图**追加在文末**、进不了指定单元格）。
- **行内实现（`refreshBadgeWiki` 两段式，`badge-wiki.ts`）**：先 overwrite 建文字表（【徽章】列渲染空 `<td></td>`，飞书自动补成 `<td><p id></p></td>`）→ 再 `fetchDocxRawContent` 取回、`imageCellAnchorIds` 按 `<tbody>` 里 `<tr>` 顺序取每行首个 `<p id>`（就是该行图片单元格的空段落）→ 对每个有图的徽章 `insertDocxImageBlock`（media-insert，宽 36、height 自动）拿 block_id → `moveDocxBlocksAfter(anchor=该行图片格的 <p> id, [imgBlock])` 把图**移进单元格**（block_move_after 让 src 成为 anchor 的兄弟＝anchor 父节点的子＝进 cell，实测生效）。行序 = `listBadgeDefinitions()` 序，index i ↔ 第 i 行，稳定对号。lark.ts 新增 `insertDocxImageBlock`/`moveDocxBlocksAfter`/`fetchDocxRawContent` 三个封装。
- **图片源用本地 repo 资产**（`assets/badges/<badge_id>.png`），因为 overwrite 每次都清图、必须每次刷新**重新 media-insert**，只有本地文件能反复上传（媒体 token 会随 block 删除失效、不能复用）。`badgeImageRelPath(b)` 从 `badges.file` 取一个 **repo 相对路径**（形如 `assets/badges/predict_judge.png`）、校验在仓库内且文件存在才用；URL/裸 token 一律忽略。media-insert 要求路径相对 CWD，**05:00 兜底刷新时 serve 的 CWD 必须是仓库根**（否则 `badgeImageRelPath` 查不到文件→退化成只有文字表、不报错）。
- **`badges.file` 存什么**：本次存**本地相对路径**（渲染真正用它）。运营者本想存「上传到飞书的 file link path」，但**飞书 Drive 上传缺 scope `drive:drive.metadata:readonly`**（`drive:file:upload` 有、但 shortcut 还要前者，Ricky 未授权）；且飞书 docx 无法用「链接/token」渲染图片（见上），所以拿不到一个既稳定又可渲染的飞书链接。要真存 Drive 链接：先在开发者后台开 `drive:drive.metadata:readonly`、Ricky `auth login` 授权，再 `drive +upload` 拿 `file_token`/链接——但那只是元数据，渲染仍走本地资产。
- **幂等性实测**：连刷两次，页面稳定 2 张图（各在自己格里）、无累积——overwrite 清旧、重插新。first_contact 无 file → 空格。
- **重启**：CLI `badge wiki-sync` 用重建后的 dist 立即生效（已验证）；**05:00 supervisor 路径要 `pnpm build` + 完整重启 serve** 才用上新 `badge-wiki.ts`/`lark.ts`。
- **图片资产**（`assets/badges/*.png`）目前只在工作树、未 commit（遵开发默认不 commit）；serve 从工作树读盘即可用，但**建议后续纳入版本管理**，否则换机/清理会丢渲染源。TYPE_LABELS/EVENT_LABELS 同步注意见 §6。
