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
