# 定时 + 随机 + 时段排程

给 `EventTypeConfig.schedule` 一个值，事件就能被调度器自动定时触发。不给 `schedule` = 只能手动触发。

<kinds>
## 5 种周期（discriminated union，按 `kind` 区分）

都带 `probability`（到点掷骰命中才发）和可选 `note`（在 `agent events` 里显示）。除 `minutes` 外都带可选时段 `windowStart`/`windowEnd`。

| kind | 字段 | 含义 |
|------|------|------|
| `minutes` | `everyMinutes` | 每 N 分钟（子日、无时段、递归定时、重启重新计时） |
| `days` | `everyDays` | 每 X 逻辑日 |
| `weekly` | `weekday` | 每周礼拜几（**1=周一 … 7=周日**） |
| `monthly` | `day` | 每月第几号（超月底自动 clamp 到当月最后一天） |
| `yearly` | `month`, `day` | 每年某月某日（闰日 clamp） |

示例：
```ts
schedule: { kind: 'minutes', everyMinutes: 30, probability: 1 }
schedule: { kind: 'days', everyDays: 7, windowStart: '10:00', windowEnd: '12:00', probability: 0.5 }
schedule: { kind: 'weekly', weekday: 1, windowStart: '19:00', windowEnd: '20:00', probability: 0.25, note: '每周一·19-20点随机·25%' }
schedule: { kind: 'monthly', day: 15, probability: 1 }
schedule: { kind: 'yearly', month: 6, day: 1, probability: 1 }
```
</kinds>

<window>
## 时段（window）

`windowStart` / `windowEnd` 是本地 `"HH:MM"`。到新的一天，调度器会在 `[start, end]` 内随机挑一个时刻当作当天的触发时间。缺省 `windowStart` = `10:00`，缺省 `windowEnd` = `windowStart`（单点）。`minutes` 没有时段。
</window>

<logical-day>
## 逻辑日

【一天】按**逻辑日**算：从本地 `DAY_START_HOUR = 05:00` 到次日 `04:59`（和每日 LP 补底同锚点）。day-based 周期（days/weekly/monthly/yearly）以逻辑日为单位判定。
</logical-day>

<scheduler>
## 调度器怎么跑

- day-based：每个逻辑日开始（05:00，启动即跑一次）→ 判定今天该不该触发 → 在时段内随机挑分钟写进 `next_fire_at` + 定时器 → 到点掷骰 `Math.random() < probability`，命中才真发。
- 扛重启（靠持久化的 `next_fire_at`）：重启后未到点的重新挂定时；刚过期一小段（宽限期内）补发；过期太久则作废本轮（不半夜乱发）；当天已结算过则不再排。
- `minutes` 周期是子日的固定间隔，重启后重新计时。
</scheduler>

<reload>
## ⚠️ 改了之后怎么生效

- 改**事件定义 / 文案 / `prepare` / 排程数值** —— 这些在 worker 里，**热重载**即可（运行 `agent update`，给 worker 发 SIGHUP）。
- 改**调度器本身**（新增/改排程种类、planner 逻辑）—— 必须**完整重启 serve**（`agent update` 只热重载 worker、不重载调度器）。

新建带 `schedule` 的事件属于【事件定义】，热重载即可被列出与手动触发；但要让它**自动定时**生效，调度器需要在 serve 启动时把它纳入规划 —— 稳妥起见重启 serve。
</reload>

<db-state-trigger>
## DB 状态触发（个人 P2P 类，可选扩展）

像【恭喜升级】【LP 破某阈值】这类，目标通常是那个人的 P2P，靠**监测 DB 状态变化**触发（类似互动触发，但看的是 DB 阈值跨越）。这类触发钩子按需新增，常配合【只发一次】的闸门（`hasSuccessfulDispatch`）。
</db-state-trigger>
