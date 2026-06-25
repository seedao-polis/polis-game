# LP 经济 / 游戏化手册（城邦土地神工作区记忆）

> ⚠️ **更名（2026-06-22）**：用户可见的点数从 **AP 改名为 LP**（**LP = Life Point / 生命点**），图标从 🍎 改成 🌱（SEED），**初始发放 100 → 120**。
> - **标签只写【LP】，不要写【LP 积分】**——【积分】一词留给未来系统里另一种东西。
> - **每条 LLM 回复扣 0.1 LP**（原 -1），**回复尾部 footer 显示到小数第一位**（`toFixed(1)`，如 `120.0 → 119.9 (-0.1)`）。LP 余额因此是小数：DB 列 `ap_balance`/`ap_ledger.delta` 虽声明 INTEGER，但 SQLite 亲和性会把非整数存成 REAL，无需迁移。
> - 代码内部标识符（`FIRST_CONTACT_AP`、`ap_balance`、`ap_ledger`、`grantAp`/`spendAp`、`LLM_AP_COST`、reason 码）仍沿用 `ap` 旧名，**只改了展示字符串**。
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
- `store.buildStatusFooter(openId, delta)`：读扣费后余额当【后】，`后 - delta` 回推【前】，三个数都过 `toFixed(1)`；频道传 `-LLM_AP_COST`（=-0.1）。**无条件加在 LLM 回复**（与有没有问 LP 无关）；纯指令不加（签到指令自己加）；gating 文案不加。
- 不同行为扣不同点数就传不同 delta，footer 自动适配。

## 5. 每日签到（命令 sign）

- 命令 `sign`，别名 `签` / `簽` / `签到` / `簽到` / `checkin`；纯 code 不走 LLM；触发是【整个 token 等于这些词】，不是【消息含『签』就触发】。
- `store.checkIn(openId)`：以**本地日历日**（`YYYY-MM-DD`）为键，`checkins` 表 `UNIQUE(user_open_id, checkin_date)` 在 DB 层防重；`INSERT OR IGNORE` 判断是否当天第一次。第一次 +3（写 `ap_ledger` reason `daily_checkin`），重复不动余额。
- 回复：第一次 `在 SeeDAO 数字城邦签到` + `🌱 LP : 119.9 → 122.9 (+3.0)`；重复 `今天 (MM/DD) 你已在 SeeDAO 数字城邦签到了` + `🌱 LP : 122.9`（不变时不带括号）。
- ⚠️ 签到【换日】用 00:00 本地日历日，跟 05:00 floor reset 的界不同；且 `localDateString` 吃**服务器本地时区**，serve 要跑在 `Asia/Taipei` 否则换日点会偏。

## 6. 数据模型与挂载点

- 迁移：v1 core（chats/messages+FTS5/profiles/ap_ledger/badges/user_badges/activities）；v2 `profiles.level` 默认 1 + `idx_messages_sender_time` + `idx_activities_actor_type` + 种 `first_contact` 徽章；v3 `checkins`。迁移机制在 `db.ts`，幂等、按 `schema_migrations` 记录。
- `store.ts` 关键函数：`recordInteraction`、`spendAp`、`grantAp`、`resetDailyApFloor`、`rewardTask`、`checkIn`、`getMessagesByUser`、`buildStatusFooter`、`ensureProfile(Raw)`、`getProfile`、`leaderboard`、`listBadges`、`awardBadge`。
- `tudigong-bot.capture` 已改 `true`；`feishu-bot.ts` 补了 `transcript.append`（存 `raw`），user+bot 双频道都收、靠 `messages.message_id` 主键 `INSERT OR IGNORE` 去重。
- 指令命中后频道写 `activities('command', {command,args})`（badge/level 的数据源）。
- 命令注册在 `commands.ts` 的 `COMMANDS` 数组（加一个对象即可，help 自动列出）；命令能拿 `ctx.senderOpenId`。

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
