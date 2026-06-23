---
name: lp-usage-design
description: 设计与规划智能体的 LP（生命点）经济：初始发放、每次对话扣费、命令是否计费、每日补底与签到、出错退费与全员重置。当需要为某个智能体设定 LP 增减规则、决定一次交互扣多少分、命令要不要计费，或评估 LP 预算与续航时使用。这是一份参考指南，产出设计方案与落点清单，默认不直接改库。
---

<objective>
本技能帮助为一个智能体设计它的 LP（生命点，Life Point）经济：用户初次互动发多少、每次对话扣多少、哪些命令计费哪些免费、每天补底到几分、签到给多少、出错怎么退费、要不要全员重置。产出是一份可落地的设计方案（参数 + 落点 + 预算评估），而不是替用户直接改数据库。

LP 是一套【先扣后答、可补可退】的余额经济：每个用户一份档案（profile）记 `pt_balance`，每一笔增减都写进流水账 `pt_ledger`（带 reason），余额由流水驱动、绝不绕过流水直接改余额。设计 LP 就是在这套机制上选定几个数值与规则。
</objective>

<quick_start>
设计一个智能体的 LP 经济，按四步走：

1. 读 `references/lp-economy-model.md` 了解机制（档案 / 流水 / 扣费 / 补底 / 签到 / 退费 / 门槛）。
2. 用 `templates/lp-economy-spec.md` 把参数填好（初始发放、每次扣费、命令计费表、补底、签到、门槛、重置）。
3. 跑 `scripts/lp_runway.py` 用这组参数算【续航】——一次发放够聊多少次、每天补底后能聊多少次，验证数值合理。
4. 读 `references/apply-in-code.md` 拿到每个参数在代码里的落点（要改哪个常量 / 哪段逻辑），交给用户决定是否实施。

最小示例：每次对话扣 0.3、初始 120、每天补底到 10、签到 +3
```
python3 scripts/lp_runway.py --initial 120 --cost 0.3 --floor 10 --checkin 3
```
</quick_start>

<context>
当前默认配置（设计新经济时的参照基线）：

| 设计点 | 当前默认 | 流水 reason | 代码落点 |
|--------|----------|-------------|----------|
| 初次互动发放 | 120 | `first_contact` | `FIRST_CONTACT_PT`（store/gamification.ts），并发 `first_contact` 徽章 |
| 每次对话扣费 | 0.3（示例）/ 0.1（基线） | `llm_reply` | `LLM_PT_COST`（两个对话频道里的常量） |
| 每日签到 | +3 | `daily_checkin` | `DAILY_CHECKIN_PT`，命令 `sign` |
| 每日补底 | 余额 < 10 的补到 10 | `daily_floor_reset` | `resetDailyPtFloor(floor=10)`，05:00 由调度器触发 |
| 余额不足门槛 | 余额 < 单次扣费额 | —（不写流水） | `spendPt` 返回 false → 回固定文案、不扣费 |
| 命令是否计费 | 全部免费 | — | `commands.ts` 的命令各自不调 `spendPt` |
| 出错退费 | 全额退回 | `refund_on_error` / `refund_interrupted` | 频道的 try/catch 与重启重跑 |
| 全员重置 | 设为 120 | `manual_reset` | `resetAllPtTo(target)`，CLI `reset-all-pt` |
| 任务奖励 | 仅预留接口 | `task:<id>` | `rewardTask(openId, taskId, amount)` |

身份按 `open_id`：同一人就是同一 open_id，所有增减都记在他名下。余额会被格式化成一位小数（`.toFixed(1)`），所以扣费可以是小数（如 0.1 / 0.3）。
</context>

<process>
设计一份 LP 经济方案时：

1. **定位【每次交互扣多少】**——这是核心旋钮。先问清这个智能体希望【一次发放够聊多少次】，反推单次扣费 = 初始发放 ÷ 目标次数。例：想让 120 分聊约 400 次 → 单次 0.3；想聊约 1200 次 → 0.1。
2. **决定命令计费**——逐条过一遍命令（help / profile / 排行 / 签到 / 其它）。惯例是查询类、签到类**免费**（不消耗 LP，避免【想看余额还要花钱】的怪圈）；只有真正调用智能体生成内容的路径才扣费。要让某命令计费，就在该命令里调 `spendPt` 并加 footer。
3. **设每日补底与签到**——补底保证【没分的人第二天还能用】（决定每天的免费续航 = 补底值 ÷ 单次扣费）；签到是主动领的额外额度。两者叠加 = 一个耗尽用户每天的可聊次数。
4. **设余额不足时的行为**——默认门槛是【余额 < 单次扣费就不答】，回固定文案、不扣费、命令仍可用。可调高门槛或改文案。
5. **明确退费与重置**——出错是否退、是否提供一键全员重置（上线调参常用）。
6. **算续航验证**——把参数喂给 `scripts/lp_runway.py`，看【一次发放续航 / 每日续航 / 耗尽天数】是否符合预期，不合理就回到第 1 步调。
7. **给落点清单**——按 `references/apply-in-code.md` 列出每个参数要改的代码位置，交付方案；除非用户明确要求，不直接改库、不 commit。
</process>

<reference_guides>
详细知识在 `references/`：

- **lp-economy-model.md** — 机制全貌：档案 / 流水账 / `grantPt`·`spendPt`·`checkIn` / 初次发放 / 补底 / 签到 / 状态 footer / 门槛 / 退费；以及【一切增减走流水】的铁律。
- **design-parameters.md** — 每个可调参数的含义、取值权衡、续航计算公式、常见配方（高频低耗 / 低频高耗 / 仅签到补给）。
- **apply-in-code.md** — 每个参数在代码里的落点（常量名、文件、函数），以及 MCP `pt_grant`、CLI `daily-reset` / `reset-all-pt` 的用法。
- **reason-codes.md** — 流水 reason 取值表与命名约定（新增一种增减就配一个 reason）。

模板：`templates/lp-economy-spec.md`（填空式方案表）。
脚本：`scripts/lp_runway.py`（续航 / 预算模拟器，仅用标准库）。
</reference_guides>

<validation>
方案是否站得住，跑脚本核对三个数：

- **一次发放续航** = 初始发放 ÷ 单次扣费（门槛前能连续聊的次数）。
- **每日续航** = （补底值 + 签到值）÷ 单次扣费（一个耗尽用户每天能聊的次数）。
- **耗尽天数** = 初始发放 ÷（单次扣费 × 每日预估互动数）。

三者都落在设计意图的合理区间，参数才算定下来。命令若计费，再用脚本的 `--commands` 估一遍混合消耗。
</validation>

<success_criteria>
一份合格的 LP 设计方案：
- 单次扣费、初始发放、补底、签到、门槛、退费、重置都有明确取值，并说明了理由。
- 命令计费表逐条明确（哪些免费、哪些扣多少）。
- 用 `scripts/lp_runway.py` 验证过续航数值合理。
- 每个参数都给了代码落点（来自 apply-in-code.md），用户能照着改。
- 所有增减都走流水（reason 命名清晰），没有【绕过流水直接改余额】的设计。
- 除非用户明确要求，停在【方案 + 落点】，不直接改库、不发通知、不 commit。
</success_criteria>
