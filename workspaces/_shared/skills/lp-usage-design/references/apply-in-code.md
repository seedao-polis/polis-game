<table_of_contents>
- 参数 → 代码落点速查
- 改单次扣费
- 改初始 / 签到 / 补底
- 让某命令计费
- 余额不足文案与门槛
- 运维入口：MCP 与 CLI
- 生效方式
</table_of_contents>

<map>
## 参数 → 代码落点速查

| 参数 | 落点 | 形态 |
|------|------|------|
| 单次扣费 | 对话频道里的 `LLM_PT_COST` 常量（收发两个频道各一处） | 常量数值 |
| 初始发放 | `FIRST_CONTACT_PT`（store/gamification.ts） | 常量数值 |
| 每日签到 | `DAILY_CHECKIN_PT`（store/gamification.ts） | 常量数值 |
| 每日补底值 | `resetDailyPtFloor(floor=10)` 默认参数 / 调度器调用处 | 函数默认值 |
| 补底触发时间 | 调度器 `scheduleDailyPtReset`（05:00） | 定时逻辑 |
| 命令是否计费 | `commands.ts` 各命令实现 | 是否调 `spendPt` |
| 门槛文案 | 对话频道里 `spent === false` 分支的固定字符串 | 字符串 |
| 门槛值 | `spendPt` 的 cost 参数（默认 = 单次扣费） | 比较逻辑 |
| 退费 | 频道 catch / 重启重跑里的 `grantPt(+cost, 'refund_*')` | 函数调用 |
| 全员重置 | `resetAllPtTo(target)` / CLI `reset-all-pt` | 函数 / 命令 |
| 任务奖励 | `rewardTask(openId, taskId, amount)` | 预留接口 |
</map>

<change_cost>
## 改单次扣费

扣费常量在两个对话频道里各有一处（收消息频道、发消息频道），默认 `const LLM_PT_COST = 0.x`。改值要**两处一致**，否则两条路径扣费不同。

要让【不同智能体扣不同分】（如一个 0.3、另一个 0.1），把这个常量从写死改成按当前 soul / 配置取值：在频道初始化时读取该 soul 的扣费设定，赋给 `LLM_PT_COST`，其余【先扣后答 + footer + 退费】逻辑不动。设计方案里写清楚【这个智能体取值 = X】即可，具体接线由实施者完成。
</change_cost>

<change_constants>
## 改初始 / 签到 / 补底

- 初始发放：改 `FIRST_CONTACT_PT`。只影响**改动后新建档**的用户，不回溯老用户。
- 每日签到：改 `DAILY_CHECKIN_PT`。
- 每日补底：改 `resetDailyPtFloor` 的 floor（默认 10）或调用处传入值；补底时间在调度器 `scheduleDailyPtReset`（05:00 本地）。

这些是 `store/gamification.ts` 里的模块常量，改完按【生效方式】重载。
</change_constants>

<charge_command>
## 让某命令计费

命令默认免费。要让某命令计费，在它的实现里（`commands.ts` 的命令对象 `run` 内）：
1. 先 `const ok = store.spendPt(ctx.senderOpenId, 命令扣费, '<reason>')`。
2. `ok === false` → 返回门槛文案（不执行命令主体）。
3. `ok === true` → 执行命令，并在返回串尾部拼 `store.buildStatusFooter(ctx.senderOpenId, -命令扣费)`。

新 reason 记得登记进 `reference-codes` 思路（见 reason-codes.md）。注意命令能拿到 `ctx.senderOpenId`；没有它的上下文不要扣费。
</charge_command>

<gating_text>
## 余额不足文案与门槛

- 文案：对话频道里 `spent === false` 分支的固定字符串，按社区口吻改（提示补底时间 / 签到 / 任务）。
- 门槛值：默认就是单次扣费额（`spendPt` 的 cost）。若要【至少留 N 分】，把对话路径改成先判断 `getProfile(openId).ptBalance >= N + cost` 再扣。
</gating_text>

<ops>
## 运维入口：MCP 与 CLI

- **MCP `pt_grant(openId, amount, reason)`**：给某用户增减 LP（amount 负数为扣），返回新余额。供程序化 / 工具调用授予奖励或扣罚。
- **CLI `daily-reset [--floor n]`**：立即跑一次补底（默认下限 10）。
- **CLI `reset-all-pt [--to n]`**：把所有人余额设为同一值（默认 120）。开服 / 调参常用。

> 运维提示：serve 运行时尽量别用会打开同一个 soul 数据库的 agent 子命令（会和 serve 抢写锁）；需要时挑低峰，或走 MCP / 让 serve 自己的调度器执行。
</ops>

<reload>
## 生效方式

改了常量 / 逻辑后，要让运行中的服务换上新代码：build 后给 serve 发热重载信号（新 worker 打开数据库会自动跑迁移）。只编译不重载不会让运行中的 serve 换代码。改调度器本身（如补底时间）需完整重启 serve。数据库按 soul 隔离（`.agent/<soul>.db`），在哪个 soul 下设定就只在那个 soul 生效。
</reload>
