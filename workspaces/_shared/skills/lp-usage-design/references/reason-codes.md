<overview>
每一笔 LP 流水（`pt_ledger.reason`）都带一个 reason，标明这笔增减【为什么发生】。它是审计、统计、排查的依据。设计新的增减规则时，给它配一个清晰、稳定的 reason。
</overview>

<existing_reasons>
## 现有 reason 取值

| reason | delta 方向 | 何时写入 |
|--------|-----------|----------|
| `first_contact` | + 初始发放 | 用户初次互动建档 |
| `llm_reply` | − 单次扣费 | 每次走智能体的对话扣费 |
| `daily_checkin` | + 签到值 | 当日首次签到 |
| `daily_floor_reset` | + 补差额 | 每日 05:00 补底，把低于下限的补到下限 |
| `refund_on_error` | + 单次扣费 | 生成失败退费 |
| `refund_interrupted` | + 单次扣费 | 进程中断、重跑前退费 |
| `manual_reset` | ± 到目标值 | 全员重置（`resetAllPtTo`） |
| `task:<id>` | + 奖励额 | 任务奖励（`rewardTask`，按任务 id 拼后缀） |
</existing_reasons>

<naming_conventions>
## 命名约定

- 用小写 + 下划线（`snake_case`），动作 / 来源能一眼看懂：`daily_checkin`、`refund_on_error`。
- 同类带参数的用冒号拼后缀：`task:<id>`（便于按前缀 `task:` 聚合统计）。
- 退费类统一 `refund_*` 前缀，方便和原扣费对账。
- 一个 reason 对应一种语义，不要复用同一个 reason 表达不同意图。
- reason 是稳定标识，定了别随意改名（历史流水会对不上）。
</naming_conventions>

<adding_a_reason>
## 新增一种增减

1. 想清这笔增减的语义，起一个稳定 reason。
2. 在对应路径调 `grantPt`/`spendPt`/（必要时新函数）并传该 reason —— **不要绕过流水直接改余额**。
3. 在方案文档里把新 reason 记进上面的取值表，方便后续统计与对账。
</adding_a_reason>
