# Workflow: 收集事件规格

<required_reading>
**先读这些：**
1. templates/event-spec.md
2. references/event-model.md（来源≠目标、prepare、选人规则）
</required_reading>

<objective>
把用户一句模糊的需求收敛成一份**完整、可实现**的事件规格，作为下一步 build-event 的输入。
</objective>

<process>
## 第 1 步：套规格表

用 `templates/event-spec.md` 的九节逐项对照用户需求。用户已给的直接填；没给但有合理默认的按默认填（并在小结里标出默认值）；真正影响实现、又无默认的才回头问。

## 第 2 步：把关键决定问清楚（只问真正缺的）

这几项决定实现形态，缺了无法落地：
- **scope**：发到群（global）还是某人 P2P（personal）？目标是**单一**的。
- **静态还是动态**：文案/对象/目标是否需要在触发时才算出（条件句、动态选人、DB 阈值）？需要 → 要写 `prepare`。
- **触发方式**：只手动，还是带 `schedule`（哪种周期 + 概率 + 时段）？
- **动态选人时**：候选来自哪些来源群、什么条件、随机一个还是最符合的、挑不到怎么办。
- **奖励**：发不发 LP / 徽章，什么条件，确认放在 `afterSend`（只在发送成功后）。

## 第 3 步：解析具体值

- 群名 → `chat_id`（`oc_...`），人名 → `open_id`（`ou_...`）。
- 底图：拿到链接先准备好（build 时下载存进 assets）。
- 确认 `eventTypeId`（kebab-case）；用户没给就起一个达意的。

## 第 4 步：回读小结

把填好的规格（含你补的默认值）简要复述给用户确认，特别点出：
- 单一目标是谁、来源是谁（两者可能不同）。
- 是否需要 `prepare`、是否带 `schedule`。
- 标注【待真发前会先 dry-run / test】。
</process>

<success_criteria>
- [ ] 九节规格填齐，默认值已标出。
- [ ] scope、静态/动态、触发方式、奖励都已明确。
- [ ] 群名/人名已解析成 id，底图来源已就位。
- [ ] 跟用户回读确认过，无遗留的阻塞性问号。
</success_criteria>

<next>
规格确认后 → `workflows/build-event.md` 实现。
</next>
