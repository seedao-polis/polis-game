# 社区预测（Community Prediction / BET-N）操作手册

> 城邦土地神的「社区预测」模块运维经验。仿 [[tc-betting-playbook]] 的意向调查（TC），但**仅离散选项** + **结果由持有【社区预测裁判】`predict_judge`⚖️ 徽章者人工宣布**（不自动加权结算）。模块全貌 / 落库经过见 `memories.md` 速查表「社区预测 + 公益宝箱」条 + `thoughts/shared/research|coding/2026-07-14-community-prediction-and-treasure-chest*`。本文只收**原帖版式 / 改文案 / CLI / 部署**这些高频运维。

## 1. 关键档案（改什么动哪个）

- **改原帖版式 / 文案 → 只动 `src/core/predict-post.ts`**：核心是 `buildActivePost(proposal, bets)`——**提案创建**（`buildPredictProposalPost`）和**每次投注原地重绘**（`buildPredictResultPost`）**共用它**，所以改一处两个场景同时变。另有 `buildPredictSettledPost`（裁判宣布后终版）、`buildPredictCancelledPost`（撤销终版）。
- **数据层 `src/core/store/predict.ts`（表在 per-soul `tudigong.db`，不是 shared.db）**：`predict_proposals` 存 `top_message_id`（om_xxx 原帖）+ `chat_id` + `options`(JSON) + `status`(active/settled/cancelled) + `settled_option`/`announced_by`；`predict_bets` **按 chat 关联**（事件流拿不到 thread_id，同 TC 教训 [[tc-betting-playbook]] §10）。LP 扣/退在 shared.db（`spendPt`/`grantPt`），投注明细在 per-soul db——**跨库**，失败要回滚。
- **投注解析 `predict-bet-parser.ts`**：`@城邦土地神 <选项> <N>LP` → 扣 LP + `insertPredictBet` + **原地重绘原帖**（`buildPredictResultPost` + `updateMessage(topMessageId,…,{as:'bot',profile})`）。
- **命令 `predict-command.ts`**：`宣布/announce`（需 `predict_judge` 徽章，`feishu-bot.ts` 里确定性 pre-intercept，走 `hasBadge`）、`撤销/cancel`、`查询/query`，全不走 LLM。
- **结算 `predict-settlement.ts`**：`settlePredict`——把选项判定换成裁判指定，分配沿用 TC 的 `distributePool`（两层分配 + ×1.05 + floor 0.1），并额外 `总投注池×1.05×0.10` 注入 owner 的公益宝箱。

## 2. CLI（`agent predict …`，`src/bin/agent.ts` 的 `cmd_predict`）

- `list [--all]` / `show <num>` / `cancel <num>` / `announce <num> <获胜选项> [--by <open_id>]` / `create --title … --options "A,B,C" [--end] [--max-bet]`。
- **`refresh <num>`（2026-07-15 加，2026-07-16 扩到 settled）**：用**当前模板原地重绘提案原帖**，不投注、不重算、不发 LP——专门用于「改了版式 → 同步已经发出去的消息」。
  - `status==='active'` → `buildPredictResultPost(p, getPredictBets(p.id))`。
  - `status==='settled'` → **从 LP 账本反查重建**，不重算：`store.ptGrantsForRef('predict_reward', topMessageId)` 拿获奖名单、`ptGrantsForRef('predict_chest_contribute', …)` 拿宝箱注资额，喂给 `buildPredictSettledPost`。**刻意不重算**——重绘旧帖只会复述当初真的发了什么，日后改分配公式也绝不会把历史帖子改成另一个数。（`ptGrantsForRef(reason, refMessageId)` 是 2026-07-16 加在 `store/gamification.ts` 的。）
  - 都是 `updateMessage(p.topMessageId, post, {as:'bot', profile:larkProfile})`；`cancelled` 仍拒绝。
- CLI 自己 `process.env.AGENT_SOUL = DEFAULT_SOUL`（→ `getDb()` 开 tudigong.db）；`larkProfile` 从首个 enabled agent 解析（tudigong = `jcnhe1etwt45`）。`updateMessage --as bot` 只能改**本 bot 发的**消息，原帖是 bot 发的所以 OK。SQLite WAL 下 CLI 只读 + 网络改帖，不与 serve 抢写。

## 3. ⚠️ 改模板后必须 `pnpm build` + 重启 serve（最容易翻车）

- **症状**：改完 `predict-post.ts`、`predict refresh` 手动改好原帖，**下一笔投注又把它变回旧样子**。
- **根因**：serve 跑的是 `dist`，进程内存里是**旧模板**；每笔投注的原地重绘用旧 `buildPredictResultPost` → **覆盖掉手改**。`predict refresh` 只是拿新 dist 打了一枪，救不了还在跑的旧进程。
- **修法**：`npx tsc -p tsconfig.build.json`（本机 `npm run build` 被 rtk 改写报 `Missing script`）重建 dist → **完整重启 serve**。重启后新模板长期生效；不放心可重启后再补一次 `AGENT_SOUL=tudigong node dist/bin/agent.js predict refresh <num>`。
- 手动改已发原帖的通用姿势：`predict refresh <num>`，或直接 `updateMessage(topMessageId, buildPredictResultPost(p, bets), {as:'bot', profile})`。改文案看 `predict-post.ts`，投注/查询/撤销文案看对应 `predict-*.ts`。

## 4. ⚠️ 5% 和 10% 是两笔不同的钱（2026-07-16 误报「+5% 算错了」的根因）

- **两个铸造率，别混**：**奖池 = 总投注 × 1.05**，多的 5%（参与激励）发给**赢家**；**公益宝箱 = 奖池 × 10%**（≈ 总投注的 10.5%）**额外铸造**、不从赢家奖金里扣、无输家也注资。飞书 wiki《社区预测》、`AGENTS.md:142`、`predict-settlement.ts:60,100` 三处口径**本来就一致**，代码从来没错。
- **误报经过**：BET-2 结算帖只有一行 `🔸总投注：33.0 LP （+5% 参与激励）`——**原始投注额**配**一个百分比**，既不显示奖池（34.65），获奖名单又因 floor 0.1 只加到 34.5，**三个数没一个对得上**；而设计里唯一的「10%」（宝箱）在群里**完全隐形**。于是「记得有个 10%、帖子上只看到 5%」＝ 以为常数写错。**结论：钱一直是对的，版式没把两笔钱摊开。**
- **定案版式**（`buildPredictSettledPost`，2026-07-16 起，已回填 BET-2）：`总投注`（原始额）/ `激励`（奖池绝对值 + 含 +5% 额外奖励）/ `获奖名单`（**不写「零头不分配」那句**）/ `公益宝箱：+X.XX LP （10% 奖励）`（`chestContribution===0` 即零投注时整行省略）。`settlePredict` 把已算好的 `chestContribution` 传进 builder。
- **护栏**：`predict-settlement.test.ts` 新增 `buildPredictSettledPost` 套件（用 BET-2 真实数字 33/23 LP）锁死这两行必须在、且获奖合计 ≤ 奖池。**改这块版式先看那三个测试**。
- **查数字先查账本、别先读帖子**：有人质疑结算金额，去 shared.db `pt_ledger` 按 `ref_message_id=<原帖 om_>` 捞——`predict_reward` 是实发、`predict_chest_contribute` 是宝箱。账本才是事实，帖子只是它的渲染。
- 同批修掉的 dust 日志精度问题（`distributePool` 是 TC 的函数、两边共用）见 [[tc-betting-playbook]] §5.1——**dust 只进日志、不影响发放**。

## 5. 版式排版

- 原帖是**飞书 post 富文本**（`PostElement[][]`，`sendPost`/`updateMessage` 把它直接透传成 `{zh_cn:{title,content}}`）。加/删/挪行 = 改 `buildActivePost` 的 `lines` 数组。
- **要「文字带超链接」（如 `了解更多 👉 社区预测` 让「社区预测」可点）用 `a` 标签**：`{ tag:'a', text:'社区预测', href:'…' }`，别塞裸 URL。`PostElement` 已支持 `text/md/a/at/img`——细节与其它 post 标签见 [[lark-cli-playbook]] §9。判成功一律 `isLarkOk`（[[lark-cli-playbook]] §11）。

相关：[[tc-betting-playbook]]（结构母版 / distributePool / 按 chat 关联）、[[pt-gamification-playbook]]（LP 跨库）、[[badge-system-playbook]]（`predict_judge`⚖️ / `chest_keeper`🧰 / `hasBadge`）、[[lark-cli-playbook]]（post 排版 §9 / 判成功 §11）。
