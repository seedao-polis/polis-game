<table_of_contents>
1. LP_STRATEGY.json 是什么、放在哪
2. 运作机制（先扣 cost → 评分 → 状态行）
3. 字段说明
4. 范例一：停用评分（默认，等同样板）
5. 范例二：启用评分（按交流内容加分）
6. 硬性约束与注意事项
</table_of_contents>

# LP 评分策略 — LP_STRATEGY.json 参考

> 本文档自包含，无需翻阅其他记忆即可配置一个 agent 的 LP 评分策略。

## 1. LP_STRATEGY.json 是什么、放在哪

每个 soul 的 LP（生命点）计费策略，放在 `workspaces/<soul>/LP_STRATEGY.json`。它决定：**每条对话回复扣多少点**，以及**要不要让 agent 按这一轮交流的内容给 LP 评分 / 加分**。

- 是 **soul 层级**的配置（跟人格文件同级、放工作区里），不放 `configs/`（那是连线 / 身份层）、也不写进人格文件（人格文件给大模型读，这份给框架读）。
- **缺这个文件、或 `judgeEnabled:false` 时，行为等于「每条回复固定扣 `cost`、不评分」**——也就是没有此功能前的老行为。样板 `_template` 默认带的就是停用版，新 agent 不动它即维持老行为。

## 2. 运作机制（先扣 cost → 评分 → 状态行）

一条走大模型的回复，LP 流程如下：

1. **先扣 `cost`**：回复前先扣 `cost` 点（也是「点数不足就不回复」的闸门——余额不够直接回固定文案、不调用大模型）。
2. **大模型在回复尾行输出分类标记**（仅当 `judgeEnabled:true`）：框架把各 `categories` 的判定标准注入提示，要求大模型在回复**最后另起一行**输出 `<marker>: <类别>`（如 `LP_JUDGE: 画重点`）。
3. **框架解析 + 加分**：解析出类别 → 若该类别 `grant > 0`，再加 `grant` 点（写一笔账本）。**找不到标记 / 类别不认得 → 归 `isDefault` 类别**（保守兜底）。
4. **剥除标记 + 组状态行**：标记行被自动从回复里**剥除、不会发给对话者**；回复末尾追加 LP 状态行，显示**本轮净变动 = `grant - cost`** 以及该类别的 `footerLabel` 标签。

状态行三种样式（净值由「前余额 → 后余额」自动推算，`cost` 浮动时会自动跟着变）：

```
🌱 LP : 120.0 (访谈中)            净 0（cost 0.1 + grant 0.1），无箭头、带标签
🌱 LP : 120.0 → 120.3 (画重点, +0.3) 净 +0.3（cost 0.1 + grant 0.4），标签 + 数值
🌱 LP : 120.0 → 119.9 (-0.1)      净 -0.1（只有 cost），无标签
```

> 分类标记仅在 **serve 模式（对外对话）** 注入与解析；CLI（操作者本人）不注入。判定**只针对当前对话者这一轮发言**，不吃其他群成员上下文，避免多人群里 LP 归错人。

## 3. 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | number | 配置版本号，目前填 `1` |
| `judgeEnabled` | boolean | `true` = 让大模型按交流内容分类、可加分；`false` = 只按 `cost` 固定扣、不评分 |
| `marker` | string | 标记行前缀（如 `LP_JUDGE`）；大模型按 `<marker>: <类别>` 输出，框架据此解析后剥除 |
| `cost` | number | 每条回复**先扣**的点数（成本线 / 闸门）。浮动旋钮：日后调它不必动各类别 `grant` |
| `categories[]` | array | 所有可能的评分类别，见下 |

`categories[]` 每一项：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 类别 token，**大模型在标记行里输出的就是它**（要与 `criteria` 对应） |
| `grant` | number | 命中此类别时**额外加**的点数；`0` 表示不加分（不写账本） |
| `reason` | string | 加分写入账本的理由码（如 `judge_interview`）；`grant` 为 0 时留空串 |
| `footerLabel` | string | 状态行括号里显示的标签；**空串 = 不显示标签**（只显示数字） |
| `isDefault` | boolean | 兜底类别标记：无标记 / 类别不认得时归到这一类。**必须恰好一个为 `true`** |
| `criteria` | string | 注入给大模型的判定标准（简体中文一句话）；只在 `judgeEnabled:true` 时用到 |

## 4. 范例一：停用评分（默认，等同样板）

新 agent 若不需要「按交流内容加分」，保持样板默认即可——每条回复固定扣 `0.1`、无评分、无标签：

```json
{
  "version": 1,
  "judgeEnabled": false,
  "marker": "LP_JUDGE",
  "cost": 0.1,
  "categories": [
    { "name": "default", "grant": 0.0, "reason": "", "footerLabel": "", "isDefault": true }
  ]
}
```

## 5. 范例二：启用评分（按交流内容加分）

以一个「访谈 / 资料收集」类 agent 为例：正常作答不扣净点（访谈中）、提供关键有价值信息时加分（画重点）、跑题或无意义则只扣成本（无关、兜底）：

```json
{
  "version": 1,
  "judgeEnabled": true,
  "marker": "LP_JUDGE",
  "cost": 0.1,
  "categories": [
    { "name": "访谈中", "grant": 0.1, "reason": "judge_interview", "footerLabel": "访谈中", "criteria": "对方在正确回答问题、对采集目标有帮助。" },
    { "name": "画重点", "grant": 0.4, "reason": "judge_highlight", "footerLabel": "画重点", "criteria": "对方提供了与目标高度相关的关键信息。" },
    { "name": "无关", "grant": 0.0, "reason": "", "footerLabel": "", "isDefault": true, "criteria": "与采集目标无关、没有意义或恶意的对话。" }
  ]
}
```

- 访谈中：`cost 0.1` + `grant 0.1` = 净 0，状态行 `… 120.0 (访谈中)`。
- 画重点：`cost 0.1` + `grant 0.4` = 净 +0.3，状态行 `… → 120.3 (画重点, +0.3)`。
- 无关（也是兜底）：只有 `cost`，净 -0.1，状态行 `… → 119.9 (-0.1)`，无标签。

## 6. 硬性约束与注意事项

- **`isDefault` 必须恰好一个**：它是无标记 / 解析失败时的兜底。设计时把「最保守 / 跑题」那一类设为兜底（如上例的「无关」）。
- **`footerLabel` 空串 = 无标签**：希望状态行只显示数字（如 `(-0.1)`）就留空串。
- **`grant` 为 0 的类别不写账本**：只有 `cost` 那一笔；`grant > 0` 才额外写一笔加分账（净变动 = `grant - cost`）。
- **`name` 要让大模型好输出**：用简短、互斥、能从 `criteria` 直接对上的词；token 不认得会自动归兜底。
- **标记行不会外泄**：`<marker>: <类别>` 在发送前被剥除，对话者看不到。
- **改了要重启才生效**：策略按进程级缓存，修改 `LP_STRATEGY.json` 后需重启服务（或热更新）才重新读取。
