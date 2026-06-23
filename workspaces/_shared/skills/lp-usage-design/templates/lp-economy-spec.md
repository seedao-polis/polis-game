# LP 经济设计方案

> 为某个智能体设计 LP（生命点）经济用。逐项填好，缺的按【当前默认】处理或回头确认。填完用 `scripts/lp_runway.py` 核对续航，再按 `references/apply-in-code.md` 列落点。

<target>
## 一、对象
- **智能体 / soul**：____（这套经济属于哪个智能体）
- **设计目标**：____（如【轻量陪聊，单次便宜可高频】/【重度问答，鼓励想清再问】）
</target>

<core>
## 二、核心参数
| 参数 | 取值 | 当前默认 | 理由 |
|------|------|----------|------|
| 单次对话扣费 cost | ____ | 0.1 | ____ |
| 初始发放 initial | ____ | 120 | ____ |
| 每日补底 floor | ____ | 10 | ____ |
| 每日签到 checkin | ____ | 3 | ____ |
| 余额不足门槛 gating | ____ | = cost | ____ |
</core>

<commands>
## 三、命令计费表
逐条列出该智能体的命令，标免费或扣费额（查询 / 签到类建议免费）。
| 命令 | 免费 / 扣费 | reason（计费时） |
|------|-----------|------------------|
| help / 帮助 | 免费 | — |
| profile / 我的 | 免费 | — |
| 排行 leaderboard | 免费 | — |
| 签到 sign | 免费（反而 +checkin） | — |
| ____（自定义重命令） | ____ | ____ |
</commands>

<behaviors>
## 四、行为规则
- **余额不足时**：回什么文案？____（默认：【你的 LP 不足，明天 05:00 会自动补到 N，或完成任务赚取。】）；命令仍可用 ✔
- **出错退费**：退 / 不退？____（默认全额退，reason `refund_on_error` / `refund_interrupted`）
- **全员重置**：上线 / 调参时重置到？____（默认 120，CLI `reset-all-pt`）
- **任务奖励**（可选）：哪些任务给多少？reason `task:<id>` ____
</behaviors>

<runway>
## 五、续航核对（填脚本算出的数）
- 一次发放续航 = initial ÷ cost = ____ 次
- 每日续航（耗尽用户）= (floor + checkin) ÷ cost = ____ 次/天
- 耗尽天数（按每日预估 ____ 次互动）= ____ 天

命令：`python3 scripts/lp_runway.py --initial <I> --cost <c> --floor <f> --checkin <k>`
</runway>

<rollout>
## 六、落点清单（交付用）
按 `references/apply-in-code.md` 填每个参数要改哪里：
- 单次扣费 → 两个对话频道的 `LLM_PT_COST`（取值 ____）
- 初始 → `FIRST_CONTACT_PT`（____）
- 签到 → `DAILY_CHECKIN_PT`（____）
- 补底 → `resetDailyPtFloor` floor（____）
- 计费命令 → `commands.ts` 对应命令加 `spendPt`
- 门槛文案 → 频道 gating 分支字符串
- 重置动作 → 运维跑 `reset-all-pt --to ____`
</rollout>

<example>
## 附：填好的范例（中度配方）
- 对象：某问答智能体；目标：稳妥默认，单次适中
- 核心：cost=0.3、initial=120、floor=10、checkin=3、gating= cost
- 命令：help/profile/排行/签到 全免费；无计费命令
- 行为：余额不足回默认文案、命令仍可用；出错全额退；上线 `reset-all-pt --to 120`
- 续航：一次发放 400 次；每日续航约 43 次/天；按每日 30 次互动约 13 天耗尽
</example>
