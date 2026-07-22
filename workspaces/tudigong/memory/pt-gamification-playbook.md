# LP 经济 / 游戏化手册（城邦土地神工作区记忆）

> ⚠️ **更名（2026-06-22）**：用户可见的点数从 **AP 改名为 LP**（**LP = Life Point / 生命点**），图标从 🍎 改成 🌱（SEED），**初始发放 100 → 120**。
> - **标签只写【LP】，不要写【LP 积分】**——【积分】一词留给未来系统里另一种东西。
> - **每条 LLM 回复扣 0.1 LP**（原 -1），**回复尾部 footer 显示到小数第一位**（`toFixed(1)`，如 `120.0 → 119.9 (-0.1)`）。LP 余额因此是小数：DB 列 `ap_balance`/`ap_ledger.delta` 虽声明 INTEGER，但 SQLite 亲和性会把非整数存成 REAL，无需迁移。
> - 代码内部标识符（`FIRST_CONTACT_AP`、`ap_balance`、`ap_ledger`、`grantAp`/`spendAp`、`LLM_AP_COST`、reason 码）仍沿用 `ap` 旧名，**只改了展示字符串**。
> - **⚠️ 2026-07-07 更正**：上一条【内部标识符仍沿用 ap 旧名】**已过时**——DB 层后来把账本表 / 余额列 / 发放函数**迁移改名**成 `pt_ledger` / `pt_balance` / `grantPt`（`db.ts`：`ALTER TABLE ap_ledger RENAME TO pt_ledger` + `ALTER TABLE profiles RENAME COLUMN ap_balance TO pt_balance`；`store/gamification.ts` 现是 `pt_*` / `grantPt`）。**下文凡出现旧 `ap_ledger`/`ap_balance`/`grantAp` 一律读作对应 `pt_*`/`grantPt`**；查库认 `pt_ledger`/`pt_balance`（`ap_ledger` 表已不存在）。
> - **DB 文件名不再写死**：改成按 soul 命名 `.agent/<soul>.db`（`db.ts` 读 `AGENT_SOUL`，默认 `tudigong`）；每个 entry point（serve worker / supervisor / cli·ask·run）都会 pin `AGENT_SOUL`，MCP server 经 `Agent.buildMcpConfig` 的 env 拿到同一值 → 同 soul 各进程共用一个库。tudigong 用 `.agent/tudigong.db`。
> - **⚠️ LP / 游戏化已拆出共享库（2026-06-25，见 §9）**：积分 / 徽章 / profile 现在统一落 `.agent/shared.db`（`getLpDb()`），**所有 agent 共用一套 LP 经济**；`.agent/<soul>.db` 只剩对话记忆 / 消息 / 活动 / 名册等 per-agent 数据。下文凡说 LP 存在 `profiles`/`ap_ledger` 的，库已是 shared.db；命令也从 `reset-all-ap` 改名 `reset-all-pt`。
> - 下文凡提到【AP】均指现在的 LP。
> 玩家档案（profile）、LP 点数经济、每日签到、徽章/等级。动这块前先读这份。
> 完整研究：`thoughts/shared/research/2026-06-16-npc-agent-user-profile-ap-memory-architecture.md`；
> 施工总结：`thoughts/shared/coding/2026-06-16-npc-agent-ap-economy-profile-implementation.md`。
> 已落地 P0 + P1 + 每日签到；P2/P3 暂缓（见末尾）。

## 0. 拍板决策（操作者，AP 经济）

- **初始 120 LP**：新人首次互动发放（`FIRST_CONTACT_AP=120`，reason `first_contact`），同时发 `first_contact` 徽章。
- **每条 LLM 回复 -0.1 LP**（`LLM_AP_COST=0.1`，reason `llm_reply`）；**指令免费**（ping/profile/leaderboard/help/sign…不扣）。
- **余额 < 0.1 走 gating**：spendAp 扣不动就不调执行器，回固定文案【你的 LP 不足，明天 05:00 会自动补到 10，或完成任务赚取。】，不扣费；指令仍可用。
- **每天 05:00 floor reset**：把余额 < 10 的人补到 10（reason `daily_floor_reset`，不是补到初始 120）。由 **supervisor 内建定时器**触发（`scheduleDailyApReset`），另留手动 `pnpm agent daily-reset [--floor 10]`。
- **全员重置**：`pnpm agent reset-all-ap [--to <n>]`（默认 120）把每个人的余额设为同一数值（升降都做，走 `store.resetAllApTo` → 每人写一笔 `manual_reset` ledger，绝不裸 UPDATE）。2026-06-22 已对现有 9 人执行过一次 `--to 120`。
- **每日签到 +3**（reason `daily_checkin`，命令 `sign`，见 §5）。
- **任务奖励**：暂不做任务系统，只留接口 `store.rewardTask(openId, taskId, amount)`（reason `task:<id>`）。
- **退费**：LLM 出错时 `grantAp(+cost, 'refund_on_error')` 退回。
- **所有 AP 变动一律走 `grantAp` / `spendAp` / `checkIn`（内部 `tx()` + 写 `ap_ledger`），绝不直接 `UPDATE profiles`。**
- **身份按 `open_id` + 跨 app 别名（2026-06-25 大改，见 §9）**：早期假设「同一人同一 open_id」只在**同一个 app** 内成立。多 agent 各用独立飞书 app 后（如 一涵），同一人在不同 app 下 **open_id 不同**；**union_id 取不到**，改用别名表 `identity_links` + `pnpm agent link` 把多个 open_id 归并到一个 canonical 身份，LP 层每次读写先解析 canonical。
- 代码注释只写**静态功能描述**，不写日期/计划/改动历史；开发期**不 commit、不开 PR**。

## 1. ⚠️ 两个曾经致命、已修的 BUG（务必记住）

1. **bot 事件取不到发送者 open_id**：`im.message.receive_v1` 事件（lark-cli 扁平结构）发送者字段是 **`ev.sender_id`**（不是 `sender_open_id` / `sender.id` / `sender.sender_id.open_id`）。`feishu-bot.ts` 原解析链漏了它 → `senderOpenId` 一直是空 → `recordInteraction` 被跳过 → **`profiles` 全空、落库/扣 AP/补名/状态列全部静默失效**。修法：解析链最前面加 `ev.sender_id`。**以后排查【档案没建/AP 没动】第一个查这里。**
2. **执行器不知道在跟谁说话**：`profile_get` 等 MCP 工具要 `open_id`，但 `agent.respond` 从不告诉执行器当前对话者 → 执行器乱猜 open_id 回【尚无档案】。修法：`RespondInput` 加 `userOpenId`/`userName`，`respond()` 读 profile 在 prompt 最前注入【【当前对话者】姓名/open_id/AP 余额】，两个飞书频道调用时传 `senderOpenId`。

## 2. 名字回填（实测定案）

- bot 的 @ 事件**只带 open_id，没有任何 name 字段**。
- `contact +get-user --user-id <openId> --user-id-type open_id --as user` 能拿到 `data.user.name`；**`--as bot` 拿不到名字**（bot app 无通讯录权限）→ **名字解析固定用 user 身份**（serve 本来就跑 user 频道，现成可用），不给 bot 申请权限。
- `lark.getUserName(openId, profile)` 封装之；只在 `profiles.name` 为空时查一次，写回 `profiles.name` 缓存，别每条消息都打接口。
- user 列表接口（list API）本来就带 `sender_name`，所以 user 频道不用额外查。

## 3. profile 自动初始化（安全网）

- `ensureProfileRaw(openId)`（无 tx）/ `ensureProfile(openId)`（带 tx）：查不到档案就建，并种一笔 +120 `first_contact` ledger + 徽章；已存在则不动余额。
- **任何 LP 读/扣路径查不到 profile 都会先补 120**：`spendAp`、`buildStatusFooter`、`recordInteraction` 全走它（首次接触逻辑只一处，不会重复发 120）。状态列因此永远显示真实余额，不会出现假的 `🌱 LP : 0`。

## 4. 状态列 footer

- 每条**走 LLM 的回复**末尾，由 code（非 LLM）追加：`🌱 LP : <扣费前> → <扣费后> (<delta>)`，**数字一律 `toFixed(1)` 显示到小数第一位**，例 `🌱 LP : 120.0 → 119.9 (-0.1)`；delta=0 时**只显示余额、不带括号**：`🌱 LP : <余额>`（如 `🌱 LP : 119.9`）。（emoji 🌱、冒号前留一个空格、不变时不显示括号——格式承袭 2026-06-16 定案，仅把 🍎 AP 改成 🌱 LP 并加一位小数。）
- `store.buildStatusFooter(openId, delta)`：读扣费后余额当【后】，`后 - delta` 回推【前】，三个数都过 `toFixed(1)`。**无条件加在 LLM 回复**（与有没有问 LP 无关）；纯指令不加（签到指令自己加）；gating 文案不加。
- 不同行为扣不同点数就传不同 delta，footer 自动适配。
- ⚠️ **【前】是 `后 - delta` 回推出来的，不是查回来的**——所以 `delta` 只要漏算了本回合任何一笔异动，**连【前】都会跟着错**，不只是括号里的数字不准。这是 §4.1 那个 bug 的根源。

### 4.1 尾注＝整回合净变化（按 ref 回读账本，非手动累加）

**LLM 在回合中能自己动 LP**：MCP 工具 `pt_grant`（`src/tools/mcp-server.ts`）对所有 soul 开放，模型一轮内想调几次调几次，每次都真写 `pt_ledger`。旧版尾注的 `delta` 是频道里一个**手动维护的局部变量**（`category.grant - cost`），只认识框架自己记的两笔帐，**LLM 动的全部漏算** → 【前】【delta】双双失真。

**修法：不再手动累加，改从账本回读整回合净变化。**

- `netPtChangeForRef(refMessageId, openId)`（`store/gamification.ts`）＝ `SUM(delta) WHERE ref_message_id=? AND user_open_id=? AND reason != 'first_contact'`。频道 `feishu-bot.ts`/`feishu-user.ts` 用它取代 `netDelta`，**缺 `messageId` 时优雅退回旧算法**（降级不劣于现况）。
- **回合 ref 怎么传进 MCP 子进程**：`RespondInput.messageId` → `Agent.buildMcpConfig(turnRef)` → `buildAgentMcpConfig` 写 `mcp.json` 的 `env.AGENT_TURN_REF` → `mcp-server.ts` 模块顶层读 → `pt_grant` 拿它当 ref。**跟 `AGENT_SOUL`/`LARK_PROFILE` 同一套模式**。可行的前提是**执行器每轮重读 `mcp.json`**——已实测定案，见 [[agent-executor-playbook]] §4.1。
- **ref 由框架注入、不让 LLM 自报**：这样不管模型配不配合，这笔帐一定被正确标记。同「必须发生的步骤别赖 LLM」那条通用教训。
- **条件写入不残留**：`buildAgentMcpConfig` 用 `if (opts.turnRef)` 写 key，心跳 / peer / CLI 路径不传就不写，新进程读不到——**不会串到上一轮的 ref**。
- **⚠️ `reason != 'first_contact'` 这条过滤漏写会静默出错**：首见礼 +120 **带着同一个 ref**（`recordInteraction(openId,name,chatId,messageId)` → `ensureProfileRaw(…,messageId)` → `ledgerRaw(…,'first_contact',ref)`），天真 SUM 会把它算进去，新人第一轮尾注变成 `0.0 → 119.9 (+119.9)`。**运营方拍板：排除，维持 `120.0 → 119.9 (-0.1)`。** 漏写不报错、tsc 不挡、运行时无征兆——**只能靠单测钉住**（`store.test.ts` 已加，含 fail-then-pass 验证过）。
- 索引 **v37** `idx_ledger_ref`（`pt_ledger(ref_message_id) WHERE ref_message_id IS NOT NULL`）——每轮都按 ref 查一次，原本只有 `idx_ledger_user`。
- **设计取舍**：尾注**只显示净值不显示明细**（运营方拍板）。平常单笔回合显示与过去完全一样，只有 LLM 真的动过 LP 的回合数字才是复合的。
- **范围外**（刻意不做）：LLM 滥发 LP 的风控 / 每轮上限——本改动只让这些操作**被正确显示**，不限制它们；通知「被连动改分的第三人」——`user_open_id` 不是对话者的异动本就不该算进他的尾注，通知第三人是既有缺口、非本改动引入。
- 研究 / 计划 / 施工：`thoughts/shared/{research,plan,coding}/2026-07-16-lp-net-change-per-turn*.md`（研究附录 A 有执行器 env 每轮重读的实测与可重跑探针）。

## 5. 每日签到（命令 sign）

- 命令 `sign`，别名 `签` / `簽` / `签到` / `簽到` / `checkin`；纯 code 不走 LLM。精确触发是【整个 token 等于这些词】；**2026-07-08 起额外加了模糊判定**（短消息结尾是 `签`/`签到` 也算，见 §11），不再是【消息含『签』就触发】那么死，但仍有 15 字长度闸门防误吞。
- `store.checkIn(openId)`：以**本地日历日**（`YYYY-MM-DD`）为键，`checkins` 表 `UNIQUE(user_open_id, checkin_date)` 在 DB 层防重；`INSERT OR IGNORE` 判断是否当天第一次。第一次 +3（写 `ap_ledger` reason `daily_checkin`），重复不动余额。
- 回复：第一次 `在 SeeDAO 数字城邦签到` + `🌱 LP : 119.9 → 122.9 (+3.0)`；重复 `今天 (MM/DD) 你已在 SeeDAO 数字城邦签到了` + `🌱 LP : 122.9`（不变时不带括号）。
- ⚠️ 签到【换日】用 00:00 本地日历日，跟 05:00 floor reset 的界不同；且 `localDateString` 吃**服务器本地时区**，serve 要跑在 `Asia/Taipei` 否则换日点会偏。

## 6. 数据模型与挂载点

- 迁移：v1 core（chats/messages+FTS5/profiles/ap_ledger/badges/user_badges/activities）；v2 `profiles.level` 默认 1 + `idx_messages_sender_time` + `idx_activities_actor_type` + 种 `first_contact` 徽章；v3 `checkins`。迁移机制在 `db.ts`，幂等、按 `schema_migrations` 记录。
- `store.ts` 关键函数：`recordInteraction`、`spendAp`、`grantAp`、`resetDailyApFloor`、`rewardTask`、`checkIn`、`getMessagesByUser`、`buildStatusFooter`、`ensureProfile(Raw)`、`getProfile`、`leaderboard`、`listBadges`、`awardBadge`。
- `tudigong-bot.capture` 已改 `true`；`feishu-bot.ts` 补了 `transcript.append`（存 `raw`），user+bot 双频道都收、靠 `messages.message_id` 主键 `INSERT OR IGNORE` 去重。
- 指令命中后频道写 `activities('command', {command,args})`（badge/level 的数据源）。
- 命令注册在 `commands.ts` 的 `COMMANDS` 数组（加一个对象即可，help 自动列出）；命令能拿 `ctx.senderOpenId`。

### 6.1 账本 = 事实来源（按 ref 反查，2026-07-16）

`pt_ledger` 每行带 `ref_message_id`（发奖锚定的那条消息，如 TC/BET 原帖 `om_xxx`；**LLM 回复回合则是触发那条消息**，见 §4.1）。四个按 ref 的查法，用途别混：

- `hasPtGrantForRef(reason, ref)` → **幂等闸门**（这条消息发过这种奖没有）。
- `ptGrantsForRef(reason, ref)` → **回全部 `{openId, delta}`，按 id 排序**。用于**把已发生的发放读回来**而不是重算——`agent predict refresh <num>` 重绘已结算原帖就靠它（见 [[community-prediction-playbook]] §2）。**按 `(reason, ref)` 复合键**，服务「重绘某一种奖励」。
- `netPtChangeForRef(ref, openId)` → **某人在这个 ref 下的净变化总和，不分 reason（但排除 `first_contact`）**。服务 LLM 回合尾注（§4.1）。**别跟 `ptGrantsForRef` 搞混**：一个是「不分原因求和」、一个是「按原因取明细」，两者都要留。
- `recentPtLedger(openId, n)` → 某人最近流水。

**原则：帖子是账本的渲染，账本才是事实。** 有人质疑金额，先 `sqlite3 .agent/shared.db "select * from pt_ledger where ref_message_id='om_…'"` 再下结论——2026-07-16 BET-2 那次「+5% 是不是算错」就是这样 3 分钟证伪的（钱一直对，见 [[community-prediction-playbook]] §4）。重绘历史消息也一律从账本读，**别重算**：日后改公式才不会把旧帖改成另一个数。

## 7. 部署 / 注意

- **要生效跑 `pnpm agent update`**（build + 给 serve 发 SIGHUP 热重载；新 worker 开 DB 自动跑迁移）。`pnpm build` 只编译，不会让运行中的 serve 换代码。
- serve 运行时**别跑会打开 `.agent/<soul>.db`（tudigong 即 `.agent/tudigong.db`）的 agent 子命令**（会和 serve 抢写锁）；只用 `pnpm build` 验证类型。要操作非默认 soul 的库就带 `AGENT_SOUL=<soul>` 环境变量跑 CLI。
- profile 是在【部署后的下一次互动】才建，旧消息不回溯建档（如需回填可写小工具从 `messages` 反向建 profiles）。

## 8. 暂缓 / 待定

- **P2 per-user memory + 每日 distillation**：`workspaces/<soul>/users/<open_id>/`、`assembleSoul(userOpenId?)` 注入、`distill.ts`、`agent distill`、MCP `user_memory_*` 工具。distillation 的【活跃用户】定义 操作者 暂缓。串行跑即可。
- **P3 badge/level 引擎**：除 `first_contact` 外的徽章（`chatty`/`commander`/`loyal`）与升级公式仍是草案；`level` 列已就位（默认 1），升级逻辑待规则拍板。
- 语言：所有内容（含运行时回复、命令、签到、文档）一律用**简体中文 + 大陆用语**对齐 bot 既有语气。

## 9. LP 全局共享 + 跨 app 身份归并（2026-06-25 大改）

**背景**：多 agent 各用独立飞书 app 后，① 不想每个 agent 各算各的 LP；② 同一人在不同 app 下 open_id 不同。

- **共享库**：新增 `getLpDb()`/`lpTx()`（`db.ts`，指向 `.agent/shared.db`、带 `busy_timeout` 多进程并发写安全；活动库与共享库同文件时复用同一句柄）。LP 集群（`profiles`/`pt_ledger`/`checkins`/`badges`/`user_badges`）全落 shared.db；`getDb()` 仍是 per-agent（记忆 / 消息 / 活动 / 名册）。`gamification.ts` 的 LP 函数走 `getLpDb`/`lpTx`，但 `recordActivity*`（activities）/ `findOpenIdsByName`（chat_members）仍走 `getDb`；`recordInteraction` 因此拆成 `lpTx`(ensureProfile) + `tx`(activity) 两段（跨库不能同事务）。
- **别名表 `identity_links`**（schema v20，`open_id PRIMARY KEY → canonical_id`）：LP 每次读写先 `cid(openId)` 解析 canonical（`gamification.ts`，未链就是自己），导出 `canonicalId()` 供别处用。
- **为什么不用 union_id**：实测 `+get-user` 剥掉 union_id、raw `contact/v3/users` 缺 scope 报 `code:false`、事件 schema 无 union_id；且**两个独立自建 app 是否共享 union_id，在加 scope 前没法验证** → 放弃，改别名表（手动 link、可靠、不依赖飞书）。
- **命令**（已是 `pt` 名，非旧 `ap`）：
  - `pnpm agent lp-migrate [--from <soul>]`：把某 soul 库的 LP 集群 ATTACH + `INSERT OR IGNORE` 种进 shared.db（默认 from tudigong）。**首次已跑过**（土地公→shared.db，9 profiles / 49 ledger）。
  - `pnpm agent link <from_open_id> <to_open_id>`：把 from 归并到 to 的 canonical，**from 自己的 LP 作废**，之后 from 的 LP 都记到 canonical。**已链**：一涵的 Ricky `ou_0769…` → 土地公的 `ou_9686…`。
  - `reset-all-pt` / `daily-reset` 等仍在，作用对象现在是 shared.db。
- **谁要 link**：只有**跨多个 bot**的少数人（每接一个新 app 的 bot，回头客就多一个 open_id）。多数成员只用一个 bot，不用 link。
- **旧数据**：各 agent 单独库（`seealpha.db`/`profile-writer-yihan.db`）里的旧 LP **作废、以 shared.db 为准**（操作者拍板）。
- 详见共用 skill `onboard-lark-bot/references/shared-lp-and-link.md`。

## 10. LP 评分机制：按交流内容动态判定 + per-soul 策略（2026-06-25 大改）

**背景**：一涵（profile-writer-yihan）在 serve 里访谈居民，希望每条回复的 LP 变动**由 agent 按这轮交流内容判定**，而非固定扣 0.1；做成**框架级通用机制**，tudigong 也纳入同一套抽象（停用分类、维持固定扣分）。研究 / 决策定案：`thoughts/shared/research/2026-06-25-lp-judgement-generic-mechanism.md`；施工总结：`thoughts/shared/coding/2026-06-25-lp-judgement-generic-mechanism-implementation.md`。

- **机制一句话**：每条回复**先 `spendPt(cost)`**（成本线、gating 照旧）→ 大模型在回复尾行输出一行分类标记 `LP_JUDGE: <类别>` → 框架 `judgeReply` 解析类别 →（`grant>0`）`grantPt(grant, reason)` → 状态行 footer 显示「本回合净值 = `grant - cost`」+ 分类标签。`grant=0` 不调 `grantPt`，只留一笔成本线。
- **per-soul 策略文件 `workspaces/<soul>/LP_STRATEGY.json`**（soul 级配置，**不放 `configs/`**）。字段：`judgeEnabled`(是否要求分类) / `marker`(标记行前缀，`LP_JUDGE`) / `cost`(每条先扣的点数，浮动旋钮) / `categories[]`：`name`(模型输出 token) `grant`(加分) `reason`(入账理由码) `footerLabel`(状态行括号里的标签，**空串=不显示**) `isDefault`(兜底类别，**恰好一个**) `criteria`(注入给大模型的判定标准)。
- **一涵三类**（净变动）：**访谈中**（cost 0.1 + grant 0.1 = 0，两笔相抵、`(访谈中)`；**这是默认 / 兜底类别**，正常善意的访谈交流都归这里）、**画重点**（cost 0.1 + grant 0.4 = +0.3、`(画重点, +0.3)`，奖励**特别有价值/标志性的人物志素材**——动人故事、关键转折、深刻洞察、独特价值观；**已去掉"提到 SeeDAO 就 +0.3"的旧标准**，避免 prompt 每轮把 SeeDAO 标成高价值话题、诱导 agent 一直往 SeeDAO 引）、**无关/恶意**（只扣 cost = -0.1、无标签，仅明显跑题/恶意才给）。**tudigong**：`judgeEnabled:false`、单一 default、净 -0.1，与改动前完全一致。
- **判定标准（操作者拍板，2026-06-25 调优）**：**默认类别 = 访谈中（净 0、不扣）**——『正常善意的访谈交流』全归这里（打招呼、回顾上次、回答、追问、铺垫闲聊都算），`无关（-0.1）` 只在**明显跑题 / 灌水 / 恶意**时由模型显式标出；**fallback（没输出标记 / token 不认得 / 拿不准）也归访谈中、不扣**（早期曾设 fallback→无关，实测把善意开场也扣了 -0.1，故改成默认不扣，把 `isDefault` 从无关挪到访谈中）。分类**只看【当前对话者】这一轮发言**（群里多人不张冠李戴）；恶意对话就 -0.1、不额外处置；画重点走**两笔账本**——成本线浮动 + 奖励线固定，便于日后大模型价格变动只改 `cost`、奖励不动（净值由 footer「前→后」自动算）。
- **入账理由码**：访谈中 `judge_interview`、画重点 `judge_highlight`、无关沿用 `llm_reply`（成本那笔）。
- **代码落点**：
  - `src/core/lp-strategy.ts`（新）：`loadLpStrategy(soul)`（按 soul 读 + `Map` 缓存；**缺文件回退最简策略**=只扣 cost、不评分，等同改动前）、`judgeReply(reply, strategy)`（容错正则取最后一行标记、剥除所有标记行、**未命中回退 default**）、`buildJudgeInstruction(strategy)`、`defaultCategory(strategy)`。
  - `store/gamification.ts` 的 `buildStatusFooter(openId, delta, label?)` 加可选 `label`；三分支：delta=0 无标签→只显余额；delta=0 有标签→`120.0 (访谈中)`（无箭头）；delta≠0→`前 → 后 (…)`。`strip/splitStatusFooter` 正则**不用改**（`[^\n]*` 吃整行）；`commands.ts` 签到因 `label` 可选**不受影响**。
  - 两个 channel（`feishu-bot.ts` / `feishu-user.ts`）：`cost` 改读 `strategy.cost`；回复后 `judgeReply`→（`grant>0`）`grantPt`→footer 传净 delta + `category.footerLabel || undefined`。`refund_on_error` 用 `cost`；bot 的 `refund_interrupted` 仍用常数 0.1（边缘路径）。
  - `agent.ts prepare()`：**仅 serve 模式 + `judgeEnabled`** 才把 `buildJudgeInstruction` 接到 prompt 末尾（langRule 之后）；CLI 与 tudigong 得空串、prompt 不变。
- **生效方式**：改 `agent.ts` / channel 要**重新编译 + 重启 serve worker**（`pnpm agent update` 需带 `--sup`，否则手动重启）。分类指令是**每条 prompt 即时注入**、不写进 `.kimi-code/AGENTS.md`，**不受 `--continue` 缓存影响**，重启后下条对话即套用、无需隔离会话。`LP_STRATEGY.json` 由 `loadLpStrategy` 行程级缓存，**改文件要重启 serve** 才重读。
- **新建 agent**：`_template/LP_STRATEGY.json` 默认带停用版（行为 == 固定扣分）；要做「按交流评分 / 加分」的 agent，把它改成 `judgeEnabled:true` + 定义 categories（含 criteria）。`create-agent` skill 已能配置这块（见该 skill 的 references）。

## 11. 模糊签到 + 自助改名（2026-07-08）

两件事都落在 `src/core/commands.ts`（命令层，纯 code、不走 LLM）。**群里都要先 @ 土地神**（bot 只收 @ 事件）、私聊直接说；`dispatchCommand` 在 cli / feishu-bot / feishu-user 三频道通用。

### 11.1 模糊签到（放宽签到判定）
- **原规则保留**：`签`/`签到`（及 `簽`/`簽到`/`checkin`）作为精确命令别名照旧（§5）。
- **新增**：消息（去掉 @ 前缀与 `/`!` 前缀后）**长度 < 15** 且**结尾正则 `/(签到|签)$/`** 也算签到 → 路由到 `sign`。例：`每日签到`、`8/12 签`、`打卡签到`。
- **15 字闸门**（`CHECKIN_MAX_LEN`）防长句误吞（如"…结尾恰好是签"）。判定函数 `isFuzzyCheckIn(raw)`，导出可测。
- 顺序：`dispatchCommand` 里先精确命令查表（保住 `签`/`签到`），miss 了再试模糊签到。

### 11.2 自助改名（本人 @ 土地神即可改名）
- 触发词 `改名`：`改名Vicky`（贴着）或 `改名 Vicky Huang`（空格分隔、名字本身可含空格）都行；取 `改名` 后字串、**去掉首尾半角/全角空白**（`trimEdgeSpaces`，正则含 U+3000）当新名。英文 `rename <名字>` 也行；`help` 里已列 `rename`（别名 `改名`）。
- **为什么单独解析不走 token 分词**：因为名字可能贴着 `改名` 或含空格，`parseCommand` 的空白分词处理不了；所以 `parseRename(raw)` 在 `dispatchCommand` **最前面**拦 `改名…`（返回新名 / 空串=光"改名"给用法 / null=不是改名）。
- **护栏**：空名→回用法；> 40 字或含换行→拒绝；**名字含问号 `?？`→当提问、返回 null 交给 LLM**（避免"改名怎么操作？"被改成名字）。
- **关键设计——按 open_id 存 override、渲染时套用（不是改抓来的名字）**：直接改 DB 里的 `chat_members.name`/`profiles.name` **没用**——每 5 分钟名册同步会用飞书原名覆盖回去（`syncChatMembers` 的 `freshenProfile` + upsert）。所以改名写进**新表 `name_overrides`（schema v27，共享库 `.agent/shared.db`，`open_id PRIMARY KEY`）**，在**显示时**套用，跨 agent 生效、重启/重同步不丢。正好符合"内部用 id 匹配、别用 name"。
  - `store.setPreferredName(openId, name)`（`store/gamification.ts`）：按 **raw open_id 和 canonical id 各写一行**（因为 `memberName` 用 raw、`getProfile`/`leaderboard` 用 `cid()` canonical，两条路都要命中）。
  - `name-overrides.ts` 现在是**两层**：`configOverride`（运营 `configs/name-overrides.json`，如 Fivea，进程级缓存）→ `selfServiceName`（读 `name_overrides` 表，**不缓存**保证多进程即时可见）。**优先级：运营配置 > 自助改名 > 原始名**（运营的硬性称呼不被本人改掉）。`applyNameOverride` 仍是唯一收口。
  - **旧名数据自动变新名**：凡走 `applyNameOverride` 的展示面都跟着变——`memberName`、`getProfile`、LP footer、订阅者名、ops 叙事、事件 `{{name}}` 与 @ 名字（`events.ts` 走 `memberName`/`getProfile`）。**顺手补了 `leaderboard` 原来漏套 override 的 bug**。
  - **不改的**：历史留痕快照（`member_sync_rounds` 明细、`visitor_milestones.name`、`messages.sender_name`、transcript）按设计保留当时的名，不回写。
- **测试**：`src/core/commands.test.ts`（模糊签到 + 改名端到端）、`name-overrides.test.ts` 补了自助层与优先级用例（都要 `AGENT_DB_PATH` 隔离，因 `applyNameOverride` 现在会读库）。
- **上线**：改了 `db.ts`（+migration v27）与核心命令层 → **要完整重启 serve** 才生效（`pnpm agent update`；新 worker 开库自动迁移）。
- **已知取舍**：模糊签到只看结尾是否 `签`/`签到`（`$` 锚定），所以带尾标点的"我要怎么签到？"**不会**被判成签到；但不带标点、结尾正好是"签到"的短句（如"我该怎么签到"）会——按操作者明确要求的启发式实现；如需再收紧告诉我。

## 12. LP 帐本迁移到 PostgreSQL

> 完整迁移细节（架构决策、驱动选型、双后端设计、逐档改法、ETL 脚本、正式割接手册）独立成册：`pg-migration-playbook.md` + `local-db-playbook.md §11`。这里只记 LP 经济这条主线该知道的结论。

- **`spendPt()` 原子化重写**：SQLite 时代靠单文件锁天然序列化"查余额→扣款"这两步；PostgreSQL 是真并发连线池，原本的 check-then-act 会有竞态（两笔并发的扣款都读到"够扣"，都真的扣下去，余额可能变负）。改法是**一条带条件的 UPDATE 顶到底**：
  ```sql
  UPDATE profiles SET pt_balance = pt_balance - $1
    WHERE open_id = $2 AND pt_balance >= $1
    RETURNING pt_balance
  ```
  这条 UPDATE 本身就是原子的（MVCC 下同一行的并发 UPDATE 会自动排队），`RETURNING` 有没有回到行就是"这笔扣款有没有成功"的唯一真相——不再需要额外查一次余额。**专属并发测试**：`gamification.pg.test.ts` 对一个 100 LP 的帐户并发跑两笔各 60 LP 的 `spendPt`，断言恰好一笔成功、余额精确落在 40（不会变负、不会双扣）。
- **§0 拍板决策"所有 LP 变动一律走 `grantPt`/`spendPt`/`checkIn`，绝不直接 `UPDATE profiles`"这条不变量在 PostgreSQL 版本下依然成立**——`ledgerRaw`（写 `pt_ledger`）仍是唯一的写入收口，`spendPt` 的原子 UPDATE 也只改自己的余额栏位、紧接着照样写一笔 `pt_ledger` 记录，帐本仍是唯一事实来源（呼应 §6.1）。
- **`cmd_lp_migrate`（原 `pnpm agent lp-migrate`）已废弃**：这个命令原本是靠 `node:sqlite` 的 `ATTACH DATABASE` 把某个 soul 库的 LP 集群整批 `INSERT OR IGNORE` 种进 `.agent/shared.db`（§9 提到的"首次已跑过"那次）。`ATTACH DATABASE` 是 SQLite 专属语法，PostgreSQL 没有对应物，也不再需要——LP 迁移到 PostgreSQL 后不会再有"新 soul 库要种进共享库"这种场景（新 soul 直接对着同一个 PostgreSQL `shared` schema）。现在这个命令一旦侦测到 `AGENT_PG_URL` 已设定就直接报错拒跑（防呆闸门），避免有人误跑对着 PostgreSQL 时代的帐本做一次性 SQLite 专属迁移操作。
- **`cmd_link`（`pnpm agent link`）重写后的新程式码形状**：原本直接用 SQLite `?` 占位符对 `getLpDb()` 拿到的原始 handle 下 `.prepare().run()`；现在改用 `lpTx()` 包住整段（`DELETE FROM pt_ledger/checkins/user_badges/profiles WHERE user_open_id = $1` + `UPDATE/INSERT identity_links` 这一串在同一笔交易里做完，同 PostgreSQL 也同 SQLite），SQL 文字全部改 `$N` 占位符、经由 `SqlExecutor.query()` 下达。行为不变（把 `from` 的 LP 归并到 `to` 的 canonical、`from` 自己的 LP 作废），只是底层执行路径换了。
- **实际验收数字**：ETL 脚本（`scripts/etl-shared-to-pg.mjs`）做金额分毫不差检查（`SUM(delta)` 与 `SUM(pt_balance)` 两边各自相等、且互相相等）。dry-run 当时是 5315.8、**正式割接（2026-07-22）当时是 5441.8**——都是当次跑的即时结果、不是写死的期望值（生产一直在写、金额随时间变，验证逻辑是"跟 SQLite 现况比对"而非"跟历史数字比对"）。
- **✅ 正式割接已执行（2026-07-22）**：LP 帐本现在跑在 PostgreSQL `shared` schema 上。**割接后踩到一个关键性能坑（同步 `execFileSync` 饿死事件循环、拖慢所有 async PG 查询）已根治**——完整经过、诊断日志、两台手术、回滚方式全在 `pg-migration-playbook.md §6/§7`（那份是 PG 迁移这条线的权威册，找命令/找教训去那份）。

## 13. 停机漏签的补签套路（2026-07-21 实战定案）

场景：tudigong 停机窗口内有人在签到话题里 `@城邦土地神 签到`，没回复也没入帐。重启后 G2 补扫**救不了**这种情况——它的扫描窗口是 `sinceMs = max(now-30min, epoch)`（防刷屏，见 `community-notify-events-playbook.md §17`），停机超过 30 分钟的漏 @ 不会自动补回，只能手动。原则：**完整复刻 `commands.ts` sign 命令的确定性流程**（LP 入帐 + 话题内回复 + activity + handled 标记四件套），不是只补 LP。

1. **确认没签过**（幂等前置）：`sqlite3 .agent/shared.db "SELECT 1 FROM checkins WHERE user_open_id='<ou_>' AND checkin_date=date('now','localtime')"` 空=没签。名字反查 open_id：`chat_members` 或 `profiles`。
2. **定位那条消息拿 message_id**：⚠️ 签到都发生在**话题串**里，`im +chat-messages-list`（容器视图）**看不到**话题内回复——实测漏签消息在容器列表完全不出现（同一人几分钟后发的顶层消息反而在），本地 `messages` 表也没有（停机期间采集同样断了）。套路：从话题根消息（当天第一条 `@土地神 签` 会出现在容器列表、带 thread_id `omt_...`）拿到 thread_id → `listThreadMessages(threadId)`（`im +threads-messages-list`）遍历找目标消息的 `message_id`。
3. **一次性脚本重放**（`AGENT_SOUL=tudigong node --env-file=.env <script>`，import `dist/core/store.js` + `dist/core/lark.js`）：
   ```js
   const r = await store.checkIn(openId);          // 幂等闸门：r.firstToday=false 就中止、别发消息
   const reply = '在 SeeDAO 数字城邦签到' + (await store.buildStatusFooter(openId, r.awarded));
   replyText(msgId, reply, { as: 'bot', inThread: true });  // 话题内 + bot 身份，格式与正常签到零差异
   await store.recordActivity('command', openId, chatId, msgId, { command: 'sign', args: [] });
   await store.markMessageHandled(msgId);          // 防未来 backfill 重回这条
   ```
4. **验证**：`pt_ledger` 多一笔 `daily_checkin +3`、`checkins` 当日恰一笔、`profiles.pt_balance` +3。

注意事项：
- **只能补"当天"的漏签**：`checkIn` 以执行当下的本地日历日为键（§5），跨日后再跑会记成新一天的签到而不是补昨天。真要补历史日期只能手动 `grantPt` + 手写 `checkins` 行，慎用。
- serve 正在跑也能直接补（SQLite WAL 并发无碍）；`replyText` 走 `larkExecSend` 自带 429 退避，不经过 outbound-guard（那是 MCP `feishu_send` 的闸门，CLI/脚本路径本来就不走）。
- 通用化：同样的"确定性命令重放"思路适用于所有纯 code 命令（sign/profile/follow 等）——查 DB 确认没处理过 → API 找 message_id → 调对应 store 函数 → 复刻回复文案 → 补 activity/handled 标记。订阅类的先例见 `community-notify-events-playbook.md §17` 手动补回段。
- 实战记录：Sean `ou_d393dd21d9777070ec86b4ea21c4fda4` 15:48 漏签，21:51 补，191.9 → 194.9，回复消息 `om_x100b6ac3dbc938acc445fe3dc030e18`。
