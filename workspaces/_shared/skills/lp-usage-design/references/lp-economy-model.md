<table_of_contents>
- 铁律：一切增减走流水
- 数据模型
- 核心函数
- 初次互动与档案初始化
- 每次对话的扣费流程
- 余额不足门槛（gating）
- 出错退费
- 每日补底
- 每日签到
- 状态 footer
- 身份与小数余额
</table_of_contents>

<iron_rule>
## 铁律：一切增减走流水

每一笔 LP 增减都必须经由 `grantPt` / `spendPt` / `checkIn`（内部统一走一个 `ledgerRaw`：写一行 `pt_ledger` + 把 delta 加到 `profiles.pt_balance`，同一事务内完成）。**绝不**直接 `UPDATE profiles SET pt_balance = ...` 绕过流水。这样流水账始终是余额的唯一真相来源，可审计、可回放。设计任何新的增减规则时也守这条：新增一种增减 = 调 `grantPt`/`spendPt` 并配一个 reason。
</iron_rule>

<data_model>
## 数据模型

- `profiles(open_id PK, name, pt_balance, level, first_seen, last_seen)` —— 每个用户一行，`pt_balance` 是当前余额。
- `pt_ledger(user_open_id, delta, reason, ref_message_id, created_at)` —— 流水账，每笔增减一行，`delta` 带符号（扣费为负），`reason` 标明原因。
- `checkins(user_open_id, checkin_date, pt_awarded, …)`，`UNIQUE(user_open_id, checkin_date)` —— 签到表，在数据库层防同日重复。

注意 `pt_balance` 列声明为 INTEGER，但 SQLite 按值的实际类型存储，**小数余额（如 119.7）能正常保存**；展示时统一格式化成一位小数。
</data_model>

<core_functions>
## 核心函数（store/gamification.ts）

| 函数 | 作用 |
|------|------|
| `grantPt(openId, delta, reason, refMessageId?)` | 增减 LP（delta 可正可负），写流水 + 更新余额，返回新余额；档案不存在先建。 |
| `spendPt(openId, cost, reason, refMessageId?)` | 扣费；**余额不足时不写任何数据、返回 false**；足够则记一笔负流水、返回 true。 |
| `checkIn(openId)` | 当日首次签到 +`DAILY_CHECKIN_PT`，重复当日不动余额；返回是否首次、本次发放、日期、余额。 |
| `resetDailyPtFloor(floor=10)` | 把余额低于 floor 的人补到 floor，每人记一笔流水，返回受影响人数。 |
| `resetAllPtTo(target=120, reason)` | 把**所有人**余额设成同一目标值（既能升也能降），仅对余额有变化的人写流水。 |
| `rewardTask(openId, taskId, amount)` | 任务奖励，转调 `grantPt`，reason 记为 `task:<id>`。 |
| `buildStatusFooter(openId, delta)` | 生成回复尾部的余额状态行。 |
| `getProfile` / `leaderboard` | 读余额 / 余额榜。 |
</core_functions>

<first_contact>
## 初次互动与档案初始化

用户第一次与智能体互动时，`ensureProfile`/`recordInteraction` 给他建档，并种一笔 `FIRST_CONTACT_PT`（默认 120）的 `first_contact` 流水 + 一枚 `first_contact` 徽章。**所有读/扣路径**（`spendPt` / `buildStatusFooter` / `recordInteraction`）查不到档案都会先走这条初始化，所以余额永远是真实值，不会出现假的【0】。初始化逻辑只有一处，不会重复发初始分。
</first_contact>

<charge_flow>
## 每次对话的扣费流程

对话频道里，**先扣后答**：
1. 调 `spendPt(openId, 单次扣费, 'llm_reply', messageId)` 先扣。
2. 扣成功 → 调用智能体生成回复 → 在回复尾部追加 `buildStatusFooter(openId, -单次扣费)`，显示扣费前后余额。
3. 扣失败（余额不足）→ 走门槛文案（见下），不调用智能体、不扣费。

> 说明：代码里这个扣费常量名是 `LLM_PT_COST`，仅表示【一次智能体回复】的成本，与具体模型 / 厂商无关。reason `llm_reply` 同理，只是这笔扣费的标签。
</charge_flow>

<gating>
## 余额不足门槛（gating）

`spendPt` 在余额 < 扣费额时返回 false 且不写库。频道据此回一句固定文案（默认：【你的 LP 不足，明天 05:00 会自动补到 10，或完成任务赚取。】），**不扣费、不调用智能体**。命令（查询 / 签到等）不受门槛限制，仍可用。门槛值默认 = 单次扣费额，可调高（如要求至少留 1 分才答）。
</gating>

<refund>
## 出错退费

扣费后若生成回复失败，频道在 catch 里 `grantPt(+单次扣费, 'refund_on_error')` 把钱退回，并回一句不暴露内部细节的提示。进程在回复中途被重启打断时，重启重跑逻辑会先 `grantPt(+单次扣费, 'refund_interrupted')` 退回再重跑（重跑会重新扣一次），保证不重复收费。设计扣费规则时记得：**任何先扣的地方都要想清楚失败如何退**。
</refund>

<floor_reset>
## 每日补底

调度器每天本地 05:00（逻辑日起点）触发一次 `resetDailyPtFloor()`：把余额低于补底值（默认 10）的人补到补底值，每人记一笔 `daily_floor_reset` 流水。**补底是【补到】不是【加上】**——已高于补底值的人不动。这保证耗尽的用户次日仍有最低额度可用。也可手动跑 CLI `daily-reset [--floor n]`。
</floor_reset>

<checkin>
## 每日签到

命令 `sign`（别名含【签】【签到】【checkin】等），纯命令、不调用智能体。`checkIn` 以**本地日历日**为键，当日首次 +`DAILY_CHECKIN_PT`（默认 3，reason `daily_checkin`），重复当日不发。回复带状态 footer（首次显示 `+3`，重复只显示余额不带括号）。

> 注意：签到【换日】用 00:00 本地日历日，与补底的 05:00 逻辑日界**不同**；且本地日期吃服务器时区，部署时区要与社区时区一致，否则换日点会偏。
</checkin>

<footer>
## 状态 footer

每条**走智能体的回复**末尾由代码（非模型）追加一行：`🌱 LP : <扣费前> → <扣费后> (<delta>)`，例 `🌱 LP : 120.0 → 119.7 (-0.3)`；`delta=0` 时只显示余额、不带括号。有用户名时前缀 `[名字]`。数值用一位小数。`buildStatusFooter(openId, delta)` 读扣费后余额当【后】、`后-delta` 回推【前】，所以**不同行为传不同 delta，footer 自动适配**。纯命令、门槛文案、退费提示都不加这个 footer（签到命令自己加）。

模型若把状态行抄进自己的回复，`stripStatusFooter` 会先剥掉，保证框架追加的是唯一一行。
</footer>

<identity>
## 身份与小数余额

- 身份按 `open_id`：同一人同一 open_id，所有增减记在他名下。
- 余额可为小数：扣费 0.1 / 0.3 都行，footer 用 `.toFixed(1)` 显示一位小数。若把单次扣费设成小数，确认补底值 / 初始值与之搭配后的续航是整齐的（见 design-parameters.md）。
</identity>
