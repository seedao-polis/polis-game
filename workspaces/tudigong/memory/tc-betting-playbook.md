# 意向调查模块（TC）Playbook

> **TC = Temperature Check（连续投票 / 意向调查）**。任何社区成员都能发起一个「意向调查」，别人用 LP 投在某个选项（离散或连续范围）上，到期按加权平均（＝社区意向）结算、猜得最准的瓜分奖金池。2026-07-09 上线。
>
> 全流程走【框架确定性】——**建提案靠 LLM 尾行标记 `[TC_CREATE]`，投注 / 查询 / 撤销 / 结算完全不走 LLM**，跟 Meetup 模块（`[MEETUP_CREATE]`）同一套路子。动这个模块前先读本篇，再读代码。
>
> **用词（2026-07-09 改）**：面向居民的文案统一用「投注」「意向调查」「社区意向」「参与激励(5%)」「调查进度：已结束」；内部代号仍是 TC、`tc_*` 表 / 函数不改。本文档内文的「投注」＝「投注」同义。**投注按群关联、不按 thread（见 §10 实测更正）。**

---

## 1. 需求与规则（2026-07-09 需求方拍板，最终版）

- **编号**：`TC-<num>`，num 从 1 单调递增、撤销过的号**不重用**（独立计数器表 `tc_counter`）。
- **提案字段**：名称[必填]、选项[必填，离散列举 or 连续范围如 `1-500`]、结束时间（默认 24 小时）、每人投注上限（默认 1–10 LP，**下限 1 LP 不可改**、指单笔最少）。
- **投注**：`@城邦土地神 <选项> <金额>LP`（容错 `5` / `5LP` / `5lp` / `5 lp` / `5 LP`）。**每人可累计多次、可押不同选项**，累计不超过 `max_bet_lp`。
- **查询**：`@城邦土地神 TC-1` → 目前投注分布 + 最大选项（离散＝LP 最多选项；连续＝加权平均，四舍五入到**小数第 4 位**）。
- **权限**：只有**提案人**与 **admin** 能改；提案人**只能撤销、不能改内容**（撤销＝全额退还所有投注 LP，方便管理）；改内容限 admin。
- **结算规则（四条决策，务必记牢）**：
  1. **平手各半 → 两层分配**：奖金池 = 参与总 LP × 1.05。**层一**：所有与基准值等距的「平手赢家组」之间**均分**（两方各半、N 方各 1/N，**不看 LP**）；**层二**：同一赢家值 / 选项组内多人再按各自 **LP 占比**瓜分。每人所得**无条件舍去到小数第 1 位**。
  2. **单人 / 全押同一选项 → 不特判**：照通用公式跑（赢家组拿全池）。单人＝「自己赢自己」领回 `本金×1.05`；全同选项＝众人各领回约 `本金×1.05`。需求方认为合理（投注公开可见、他人可加入形成风险）。
  3. **Dust 丢弃**：舍去后的零头（如 `7.35−7.3`）不分配、不入池、不记账。
  4. **奖金池 = 参与总 LP × 1.05**：多的 5% 是**系统补贴、每场必发**（＝每场 TC 向经济注入约总 LP×5% 的新 LP，轻微通胀）。预留开关 `noBonusWhenNoLoser`（**默认 false**，在 gitignore 的 `configs/lark.json` 的 `tc` 字段下），日后被刷再切「无输家只退本金」。
- **结算基准值**：连续型＝加权平均 `Σ(value_i × lp_i)/Σlp_i` 四舍五入到第 4 位；离散型＝总 LP 最高选项（并列最高＝多个赢家组平手）。

---

## 2. 数据层（DB v29 / v30 + `src/core/store/tc.ts`）

- **migration**（`src/core/db.ts`）：**v29** 建 `tc_counter`（`id`/`next_num`，初值 1）+ `tc_proposals`；**v30** 建 `tc_bets`。改 migration 或核心档要**完整重启 serve**（不是 `agent update`）。
- `tc_proposals`：`id`/`num`/`proposer_open_id`/`title`/`option_type`(discrete|continuous)/`options`(JSON)/`end_time`(秒)/`max_bet_lp`/`status`(active|settled|cancelled)/`top_message_id`/`thread_id`(可空)/`settled_value`(连续赢家值)/`settled_option`(离散赢家选项 JSON 数组)。
- `tc_bets`：`id`/`proposal_id`/`user_open_id`/`option_value`/`lp_amount`/`is_refunded`/`created_at`。**不设** `UNIQUE(proposal_id,user)`（决策 4 允许多笔）。
- **业务数据存 per-soul `.agent/tudigong.db`**；**LP 账本在全局共享库 `.agent/shared.db`**（`pt_ledger`/`pt_balance`）。两库分开，见 [[pt-gamification-playbook]]、[[local-db-playbook]]。
- **store 关键函数**（`src/core/store/tc.ts`）：`nextTcNumUnsafe`（**必须在 `tx()` 内调**做原子取号）、`insertTcProposal`（回 `{id,num}`）、`updateTcTopMessageId` / `updateTcThreadId`（回填消息 id / thread_id）、`updateTcProposal`（admin 改内容）、`getTcByNum` / `getTcById` / `getTcByTopMessageId` / `getTcByThreadId`、**`listActiveTcsByChat(chatId)`**（**投注拦截实际用它**、按群取进行中提案）、`insertTcBet`、`getTcBets` / `getUserTotalBetLp`（累计上限校验）、`getUnrefundedBets` / `markBetRefunded`（退款幂等）、`cancelTcProposal` / `settleTcProposal`、`listExpiredActiveTcs`（重启补结）/ `listActiveTcs` / `listAllTcs`。

---

## 3. 消息层（`lark.ts` `updateMessage` + `src/core/tc-post.ts`）

- **发提案在群最上层（不进话题）**：走 `sendPost`（`--as bot`）。制式消息由 `tc-post.ts` 组版：`buildTcProposalPost`（初始，`buildActivePost` 空投注）、`buildTcResultPost`（每次投注后更新，同一「进行中」版式）、`buildTcSettledPost`（结束版）。第一条消息会被**不断原地编辑**刷新目前结果。**版式（2026-07-09 定）**：标题只放 post 的 `title` 字段、正文别再重复一行（否则飞书渲染两遍）；进行中用 🔸选项范围/投注上限/结束时间 + 💡投注方式 + 例 + 「投注后就不可取消，可重复投注…」+ 了解更多 wiki 链接 + 目前分布（空＝「暂无投注」）；结束版用「🔸调查进度：已结束 / 社区意向（加权均值 or 最高票选项）/ 总投注 …（+5% 参与激励）/ 获奖名单（**按 open_id 合并去重、按赢得 LP 降序**、`aggregateWinners`）/ 💡投注选项最接近社区意向即可瓜分总投注 LP」。
- **原地编辑靠 `lark.ts` 的 `updateMessage()`**：raw `api PUT /open-apis/im/v1/messages/<om_id> --as bot`。
  - **content 双重 JSON 序列化（写法已对）**：`content: JSON.stringify({ zh_cn: {...} })`，再整体 `JSON.stringify({msg_type:'post', content})`。**2026-07-09 实测 inline `--data <json>` 与 stdin `--data -` 都 `code:0`、原帖真被改**（本机 lark-cli 1.0.55）。
  - **只能编辑 bot 自己发的消息**；非 bot 发的、或群解散后编辑会失败 → `updateMessage` 静默返回 false（已加 `log.warn`），结算 LP 不受影响。
- 参照 [[lark-cli-playbook]] §9（飞书消息可原地编辑）。文案禁「」用【】、简体大陆用语、可保留 emoji（`🪐`）。**居民可见的投注发帖/回复/结算都不显示 `🌱 LP` 尾注（2026-07-09 去掉，`tc-post.ts`/`tc-bet-parser.ts`/`tc-settlement.ts` fallback 全清）。**

---

## 4. 触发路径（确定性，别赖 LLM 调工具）

- **建提案（唯一走 LLM 的一步）**：有人 @ 土地神用自然语言请求建意向调查 → LLM 在回复正文**最后一行**附 `[TC_CREATE: {"title":..,"optionType":"continuous","options":[1,500],"endInMinutes":60,"maxBetLp":10}]`（**截止时间用相对分钟数 `endInMinutes`、不是绝对时间戳**——见下方坑）（教学写在 `workspaces/tudigong/AGENTS.md` 的「TC 意向调查」节）。`feishu-bot.ts`（约 373–403 行）正则拦截该标记、剥掉后 `insertTcProposal` + `sendPost` 发群顶层 + `updateTcTopMessageId` 回填 `top_message_id`。**跟 Meetup `[MEETUP_CREATE]` 同型**，见 [[activity-meetup-playbook]]。
- **投注 / 查询（完全不走 LLM）**：`feishu-bot.ts` 在进 LLM **之前**前置拦截——
  - 投注：**按群关联（chat-scoped，不是 thread）**——`listActiveTcsByChat(chatId)` 取该群进行中的提案（唯一一个直接用；多个则要求消息里带 `TC-N` 消歧），再 `src/core/tc-bet-parser.ts` 的 `tryParseTcBet` 解析 `<选项> <金额>LP`（会先剥 `@提及` 和可选 `TC-N` 前缀）；校验选项合法（离散在集合内 / 连续在范围内、连续非数字选项直接放行给 LLM 免误判）+ 累计上限（`getUserTotalBetLp`）+ 余额够；`spendPt` 扣款 + `insertTcBet` 入库 + `updateMessage` 原地刷新原帖。**为什么按群不按 thread：见 §10「实测更正」——事件流拿不到 thread_id。**
  - 查询：`commands.ts` 加了 `tc-N` 快捷（`@城邦土地神 TC-1`）。
- **LP 金额容错解析**：`commands.ts` 新增 `parseLpAmount()`（吃 `5` / `5LP` / `5lp` / `5 lp` / `5 LP`）。
- **⚠️ 选项和金额连写、无空格（2026-07-10 事故 + 修复）**：实测有人发 `@城邦土地神 法国3lp`——**选项和金额粘在一起没空格**（选项是中文/非数字时高频，大家习惯连着打）。初版 `tryParseTcBet` 靠空格切词，`法国3lp` 只切出 1 个 token → `parts.length < 2` → `return false` 落 LLM；LLM 嘴上说「已收到…框架会自动处理」**但根本没记账**，分布只显示别人的投注。修复：把纯解析抽成 `parseTcBetInput(rawText, proposal)`（**无副作用、可单测**），两策略按序：**策略 A**（现有，空格分词）；**策略 B**（新增，连写离散选项）——**触发门槛=消息末尾是 `lp`/`LP`**，然后**按 proposal 的已知选项列表做前缀 split（最长选项优先，避免 `法` 抢 `法国`）**，剩余部分交 `parseLpAmount` 解析金额。**只对离散型**（连续型 `675lp` 无法无歧义拆分、留给策略 A）；连写但选项非法（`巴西3lp`）或无 lp 后缀（`法国3`）→ 返回 null 落 LLM（安全）。`tryParseTcBet` 改调 `parseTcBetInput` + 原语义校验不变。单测在 `tc.test.ts` 的 `parseTcBetInput` 三个 describe。
- **⚠️ 顺带堵 LLM 的「假装投注成功」话术**：被框架识别的投注**根本不会流到 LLM**（框架直接回投注结果 return 掉）；所以一条像投注的消息流进 LLM，说明**没被识别成投注**（选项写错/格式不对）。`AGENTS.md` 的 TC 节新增硬性口径：LLM **没有替居民下注的能力**，这种情况只提示正确格式、**绝不能说「已收到你的投注」「框架会自动处理」**——否则账没记、居民却以为投中了，是最坏结果。
- **通用教训重申**：必须发生的步骤（建提案、扣款、发奖）走框架确定性，别让 LLM 决定要不要调工具（同 A2A / 心跳闸门那条，见 [[a2a-peer-broadcast-playbook]]、[[heartbeat-playbook]]）。
- **⚠️ 截止时间：别让 LLM 算绝对 Unix 时间戳（2026-07-09 事故）**：初版 `[TC_CREATE]` 让 LLM 出 `endTimeSec`（绝对 Unix 秒），实测 LLM **把年份算成 2025**（不知道当前准确时间、凭空编时间戳）→ end_time 落在过去 → 每分钟结算轮询**秒结束**提案。改成 LLM 出 **`endInMinutes`（相对分钟数）**，框架 `nowSec + endInMinutes*60`（clamp 1..43200 分钟、默认 1440=24h）；绝对 `endTimeSec` 仅当 `> now+60s` 才兜底接受、否则回退默认。代码在 `feishu-bot.ts` 的 TC_CREATE 分支、口径在 `AGENTS.md`。**通用教训：凡是「相对时间」需求，让 LLM 出时长/相对量、框架换算成绝对时间，别让 LLM 碰绝对时间戳。**（Meetup 的 `[MEETUP_CREATE]` 已做同样改造——改用 `startLocal`/`endLocal`/`durationMinutes` 本地字符串、框架 `Date.parse` 解析、坏/过去时间 fail-closed 跳过创建，见 [[activity-meetup-playbook]]。）

---

## 5. 结算算法（`src/core/tc-settlement.ts` 的 `settleTc`，两层分配）

```
1. 基准值 settledValue：连续=加权平均四舍五入第4位；离散=总LP最高选项（并列=多赢家组）
2. 以「投注笔(bet row)」为单位算 |value - settledValue|，取最小距离 minDist
3. winnerBets = 距离==minDist 的所有投注笔，按 value 分成 G 个赢家组
4. pool = Σ(all lp) × 1.05
5. 层一：每个赢家组分 pool/G           // 平手各半/均分，不看LP
6. 层二：组内每笔分 (组份额)×(该笔lp/该组总lp)   // 按LP占比
7. 每笔 floor 到小数第1位（Math.floor(x*10)/10），dust 丢弃
8. grantPt 发给各赢家；无输家照样跑（决策2，不特判）；noBonusWhenNoLoser=true 时无输家只退本金
```

- **纯函数、可独立单测**（`src/core/tc.test.ts` 覆盖平手 / 单人 / 全同选项 / dust / 计数器原子性）。`distributePool`（层一层二 + floor + dust）**被社区预测共用**，改它两个模块一起动，见 [[community-prediction-playbook]]。

### 5.1 ⚠️ dust 精度：本篇旧结论是错的（2026-07-16 更正）

**旧版本这里写过**：「`5.25` 下舍后 dust=0、`7.35` 上进后 dust=0.1（**不是**直觉的 0.05）……测试预期值按实际浮点行为写，别照算术直觉」。**这条是错的，且正是 bug 活下来的原因**——它把缺陷描述成 JS 的固有行为、还叫后人别信算术直觉，于是 `tc.test.ts` 里三个用例把错值写成期望（有个用例名还自称 `(float rounding)`），bug 有测试覆盖却照样存活一年。

- **真正的根因不是浮点，是量化**：旧写法 `Math.round((pool-paid)*10)/10` 把零头**取整到 0.1**，而零头按定义就是 0.1 这个 floor 步长的**余数**——不管有没有浮点噪声都必然被磨平。浮点只决定磨向哪边：`7.35-7.3` 的真值 0.05 被进位成 0.1，`5.25-5.2` 的同样 0.05 被舍成 0。**直觉的 0.05 才是对的。**
- **现写法**：`Math.max(0, Math.round((pool-paid)*1e6)/1e6)`。**取整精度必须比 0.1 步长细**；`Math.max(0,…)` 保留原本想防的事（噪声让减法变 -1e-15），因为 payout 全 floor，distributed 不可能合法超过 pool。日志别再 `toFixed(1)` 二次四舍五入（直接 `${dust}`）。
- **教训（比 dust 本身重要）**：**测试跟着实现的观察值写，就只是把 bug 钉死**。期望值要从**规格**推（pool − Σpayout 该是多少），实现与规格不符时改实现、不是改期望。playbook 里写「别照直觉」之前先问：是直觉错了，还是实现错了。
- dust **只进日志、不影响任何发放**，所以这次修复不动任何人的 LP。

---

## 6. 排程 / 到期结算 / 重启补结（`src/core/supervisor.ts`）

- `scheduleTcSettlement()`（定义 `supervisor.ts:642`、启动时调 `:787`）：**每分钟轮询** `listExpiredActiveTcs()`（`status='active' AND end_time<=now`）→ 逐个 `settleTc` → `grantPt` 发奖 + `status→settled` + 原帖更新最终结果。
- **重启不漏结算**：靠状态机——重启后轮询照样扫到过期的 `active` 提案补结；`settled` 状态幂等防重复发奖。跟访客里程碑「持久化台账当闸门、别靠内存」同一教训，见 [[community-notify-events-playbook]] §14。
- 排程在 supervisor，改它要**完整重启 serve**。想立刻验证结算用 CLI 强制 `agent tc settle <num>`，或建提案时设 5 分钟后结束。

---

## 7. 权限（`configs/admins.json` + `isAdmin`）

- 撤销 / 改内容前用确定性闸门校验：`senderOpenId===proposer_open_id`（提案人）或 `isAdmin(senderOpenId)`；空 sender fail-closed。跟 Meetup 的 `canManageMeetup` 同型（见 [[activity-meetup-playbook]]、[[memory-access-playbook]]）。
- 提案人身份存 `tc_proposals.proposer_open_id`（建提案时来自 `ev.sender_id` / 当前对话者 open_id）。

---

## 8. LP 对接与跨库一致性（重点风险）

- 投注扣款 `spendPt`（shared.db）、退款 / 发奖 `grantPt`（shared.db）；reason 用 `tc_bet` / `tc_refund_cancel` / `tc_reward`（对账靠这个）。见 [[pt-gamification-playbook]]。
- **跨库无法同事务**：`spendPt`（shared.db）与 `insertTcBet`（per-soul db）是两个独立 SQLite 事务。实现选「先扣款后入库、入库失败立即 `grantPt` 补回」；**若在补回前进程崩溃 → 用户 LP 白扣**，需手动查 `pt_ledger reason='tc_bet'` 配对没对应投注的账目补退。serve 日志要留意这类边界。
- 撤销退款用 `is_refunded` 标记做**幂等**：`getUnrefundedBets` → 逐笔 `markBetRefunded` + `grantPt`（防重启 / 重跑重复退）。

---

## 9. CLI（`src/bin/agent.ts` 的 `cmd_tc`，:1783）

```
agent tc list            列出 active 提案
agent tc list --all      最近 20 笔（含已结算/撤销）
agent tc show <num>      详情 + 投注分布（只读，安全）
agent tc cancel <num>    撤销 + 全额退款（会真动 shared.db 的 LP）
agent tc settle <num>    强制立即结算（测试/运维；会 grantPt 发奖 + 试图更新飞书原帖）
agent tc create --title <标题> --type <discrete|continuous> --options <A,B,C 或 min-max> [--end "YYYY-MM-DD HH:mm"] [--max-bet <N>]
```

- **⚠️ CLI `tc create` 只写 DB、不发飞书**（印「topMessageId 待手动发送后回填」）→ 这样建的提案**没有 thread 可投注、没有消息可更新**，只适合测 DB / 结算逻辑。**真正端对端一定走 @bot 的 `[TC_CREATE]` 路径。**
- `settle` / `cancel` 会实际改真实 LP，测试用**专门测试群**、测完清理或对账，别在正式群随手 settle。

---

## 10. 关键坑与风险 + 实测更正（2026-07-09 首测后重写）

> **⚠️ 实测更正（最重要）**：初版设计按 **thread 关联**投注，**上线首测直接失效**——DB 里 `tc_proposals.thread_id` 为空、`tc_bets` 一条没有，居民 @土地神投注只被扣了 0.1（普通回复成本、非 3 LP），LLM 还「腦补」了一句「已为你投注」。根因：**`lark-cli event consume` 的扁平事件信封只有 `type/event_id/message_id/create_time/chat_id/chat_type/message_type/sender_id/content`，完全没有 `thread_id` / `root_id` / `parent_id`**（3740 条消息只有 2 条带 thread_id、还是旧「测试」）；且**普通群里提案消息本身没有 thread**（`om_...` API 查 thread_id 也是 undefined），thread 要等有人回复才生成。所以 thread 关联行不通，已**改为按群关联（chat-scoped）**：`listActiveTcsByChat(chatId)`（`tc_proposals` 建提案时已存 `chat_id`）。`findActiveTcByThread` / `getTcByThreadFallback` 已弃用不再走。**通用教训：别假设事件信封字段齐全，先 dump `messages.raw` 看真实字段；`im +messages-mget <om>` 能补拿 thread_id/root_id 但要额外 API。**

1. **按群关联的取舍**：一个群同时多个进行中提案要靠消息带 `TC-N` 消歧（否则放行给 LLM）；连续型「非数字选项」直接 `return false` 放行 LLM，避免把「@土地神 我觉得是 100」误判成投注失败。离散型仍会对无效选项回「投注失败」提示（离散选项通常够独特）。
2. **跨库原子性**（见 §8）：扣款与入库、发奖与状态更新可能被崩溃切断，导致 LP 白扣或重复发。靠操作顺序 + `is_refunded` / `settled` 幂等标记兜。
3. **`updateMessage` 已实测可用**（见 §3）：inline `--data` 与 stdin `--data -` 两种都 `code:0`、原帖真被改。双重序列化写法正确（`content: JSON.stringify({zh_cn:...})` 再整体 stringify）。只能编辑 bot 自己发的消息；失败会静默返回 false（已加 `log.warn`）。**首测「原帖没更新」不是它的锅，是投注根本没触发（关联问题）。**
4. **飞书发送限流 429 退避重试（2026-07-09 加固）**：每笔投注要发 2 个请求（`updateMessage` 刷原帖 + `replyText` 回确认），密集投注 / 同 app 密集调 API（如同时写 wiki）会撞飞书 **HTTP 429（Too Many Requests）**——CLI 拿到非 JSON 限流页、SDK 报 `failed to parse TAT response (HTTP 429)`。**坑**：429 时投注其实已入库（`tc_bets`+`pt_ledger` 都有）、只是回复没发出去 → 用户以为失败**重发就重复扣款**。修法：`lark.ts` 新增 `larkExecSend`（`isRateLimited` 检测 429/frequency_limit → `Atomics.wait` 同步退避 1s/2.5s/5s、最多重试 3 次），包住 `sendText`/`sendPost`/`replyText`/`updateMessage`。**只重试 429**（429=请求被拒未处理、重试不会重复发）；超时/崩溃不重试（可能已送达、重试会重发）。检测逻辑有单测 `lark.test.ts`。

---

## 11. 验证 / 构建 / 文档

- **构建**：`npx tsc -p tsconfig.build.json`（**别用 `npm run build`**，本机 rtk 改写会报 `Missing script: "run"`）；serve 跑 `dist/`，改 `src/` 必重编 + 重启。见 [[identity-branding-playbook]]。
- **测试**：`node --import tsx --test "src/**/*.test.ts"`。上线时 205/205 通过（原 182 + TC 新增 23）。
- **端对端留待 serve 环境验证**（无网 / 无凭证环境测不了）：`[TC_CREATE]` 真发群、投注扣款 + 原帖更新、到期结算 `grantPt`、`updateMessage` 对真实飞书 API 的兼容性。
- **研究 / 计划 / 施工**：`thoughts/shared/{research,plan,coding}/2026-07-09-betting-survey-tc-module-*.md`（含完整需求决策、算法伪码、DDL、对接点总表）。
- **实现与计划的 3 处偏差**：① 测试放 `src/core/tc.test.ts`（非 `__tests__/`，跟随既有惯例）；② ~~dust 测试预期按浮点实际值修正~~ **这条已于 2026-07-16 撤销**——当时是把 bug 写成了期望值，dust 真值就是算术直觉的 0.05，见 §5.1；③ `noBonusWhenNoLoser` 配置路径是 `cfg.lark.tc`（非 `cfg.tc`）。

---

## 12. 改名沿革 + 居民说明页（飞书 wiki）+ 局部编辑技巧

### 12.1 CVP → TC 改名（2026-07-09）
- 模块曾叫 **CVP（Continuous Voting Proposal）**，后改名 **TC（Temperature Check / 意向调查）**。**大小写保留全改**：`CVP→TC`、`Cvp→Tc`、`cvp→tc`；`押注→投注`；标记 `[CVP_CREATE]→[TC_CREATE]`；CLI `agent cvp→agent tc`；编号 `CVP-N→TC-N`；ledger reason `cvp_*→tc_*`。文件重命名：`store/cvp.ts→tc.ts`、`cvp-post→tc-post`、`cvp-bet-parser→tc-bet-parser`、`cvp-settlement→tc-settlement`、`cvp.test→tc.test`、本 playbook `cvp-betting-proposal-playbook→tc-betting-playbook`。
- **DB 表改名走 migration v31**：`SCHEMA_V29/V30` 已直接建 `tc_*`；**新增 v31 = `DROP TABLE IF EXISTS cvp_*` + `SCHEMA_V29 + SCHEMA_V30`**（旧库 drop 掉 `cvp_*` 再建 `tc_*`、旧数据弃；新库 v29/v30 建 tc_* 后 v31 幂等空跑）。db.ts 里**故意保留** `cvp_*` 字样只在 v31 的 DROP 语句+说明注释里（删旧表必须引用旧名）。
- **改名坑（工具）**：本机 rtk 改写 `grep`/`perl -i` 都**不可靠**（假阴性、`perl -i` 静默不落盘）——批量查改校验一律用 **Python 文件读写**（`io.open` 逐个 replace，最可靠）；case-preserving 用三次 `str.replace('CVP','TC')/('Cvp','Tc')/('cvp','tc')`。见 [[identity-branding-playbook]]。

### 12.2 TC 居民说明页
- 制式消息「了解更多 👉」指向：`https://seedao2049.feishu.cn/wiki/LGK2wo8dGi2oDQkSsasc2i4Un0g`（doc_id `Y0Fid06yWoGABcxtMXUcDRoDnMf`）。结构：`背景`(H2) / `流程`(H2，下辖 5 个 H3：发起 / 投注选项 / 调查结束赢得投注 / 撤销 / 查询) / `投注策略`(H2)。2026-07-09 已把除【背景】外各节的居民向说明写好（社区意向=加权均值、平手平分、奖池×1.05 参与激励、按 LP 占比瓜分、无条件舍去到第 1 位、量力而为）。

### 12.3 局部编辑飞书 wiki 文档（可复用；「只补某些章节、不动其他」用这套，别用 overwrite）
- **别用** weekly-report 那套 `docs +update --command overwrite --doc-format markdown`（清空整篇重写、会丢图片/评论、还同步 H1 标题）——那套适合**新建 / 整篇重写**。
- **要保留大部分、只补几节** → 用 **lark-doc skill 的 block 级操作**：
  1. `lark-cli docs +fetch --api-version v2 --doc <url> --scope outline --detail with-ids --profile jcnhe1etwt45 --as user` 拿各标题 block id；要精确插到某段后，再不带 `--scope` 的 `--detail with-ids` 拿正文段落 id。
  2. `lark-cli docs +update --api-version v2 --doc <docId> --command block_insert_after --block-id <锚点id> --content - --profile jcnhe1etwt45 --as user`，XML 内容走 **stdin (`--content -`)** 避开转义；每节一次调用。
- **坑**：① `docs` 命令**必须带 `--api-version v2`**；② 内容是 HTML 子集 XML（`<p>/<ul>/<li>/<ol>/<callout emoji= background-color=>/<b>/<code>`…），**标签本身别转义、只转义文本里的 `<`/`&`/`>`**；③ `--content @file` 只吃相对路径，多行/中文/emoji 一律 stdin；④ 用 `jcnhe1etwt45` profile + `--as user`（bot 进不了 wiki）；⑤ 插入递增 revision，锚点 block id 插入后不变、可连续多次插。对照 [[weekly-report-playbook]]（整篇/新建）与 [[lark-cli-playbook]]。

---

## 13. 居民文案打磨（operator 逐条调，2026-07-09）

居民可见文案都是运营者逐条反馈调出来的，**改文案集中在 `tc-post.ts`（发帖/原帖/结算版式）+ `tc-bet-parser.ts`（投注回复）**。已定规则：
- **不显示 `🌱 LP` 尾注**（三处：投注发帖/进行中原帖、投注回复、结算 + 结算兜底消息全清）。
- **获奖名单按 `open_id` 合并去重 + 按赢得 LP 降序**（`aggregateWinners`，`tc-post.ts`；同一人多笔中奖只显示一行、金额相加）——发奖 `grantPt` 仍是逐笔（正确），只有**显示层**合并。正式结算帖和结算兜底新消息都用它。
- **投注成功回复格式**（`tc-bet-parser.ts`）：`{名字} 对 TC-{num}【{标题}】 投注成功！` / `本次投注选项【{选项}】投注 {N} LP` / `已累计投注：{累计} / {上限} LP`。
- 发送侧的 **429 限流退避重试** 见 §10 第 4 条（`larkExecSend`）。

