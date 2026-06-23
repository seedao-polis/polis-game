---
name: create-badge
description: SeeDAO 徽章管理专家。新增徽章定义、把徽章发放给一个或多个成员、查询徽章定义与持有情况。当需要创建/导入徽章、给成员发徽章、或查看有哪些徽章时使用。
---

<essential_principles>
## 徽章系统怎么运作

徽章分两步，互相独立，别混在一起：

1. **新增定义（import）**：把徽章【长什么样】写进数据库（headline、说明、角色、有效期……）。只产生定义，不发给任何人。
2. **发放（award）**：把某个已存在的徽章绑定到具体成员身上，并触发通知。

### 1. import 与 award 是两件事

【新增一枚徽章】≠【发给某人】。先 import 出定义，之后才能 award。用户说【新增徽章】默认只做 import；要发人，必须另外明确说【发给 &lt;名字/ou_&gt;】。

### 2. 默认安全、不乱写库

除非用户明确要求写库或发放，**默认只产出 JSON、不碰数据库**；要发放时**先 `--dry-run` 预览**再真的发。一次做完，不反问；不要 commit、不要开 PR（除非用户要求）。

### 3. badge_id 自动生成且幂等

`badge_id` 省略时，按 `headline|category|duration` 做内容哈希自动生成 `badge-xxxxxxxx`。同一份 JSON 重复 import 得到相同 id，是幂等 upsert（覆盖更新，不会重复）。想要稳定可控的 id 就自己填。

### 4. 数据库按 soul 隔离

徽章定义和发放记录写进【当前 soul】的数据库（`.agent/&lt;soul&gt;.db`），由环境变量 `AGENT_SOUL` 决定，默认 `tudigong`。`--profile` 只决定发通知用的飞书身份，**不**改数据库落点。在哪个 soul 下 import，就只在那个 soul 里能 award。
</essential_principles>

<intake>
你想做什么？

1. 新增 / 导入徽章定义（import）
2. 发放徽章给成员（award）
3. 查询徽章（list）

**先确认意图再动手。** 用户若已在指令里说清楚（如【新增并导入】【发给某某】），直接按下面路由进对应 workflow，不要再追问。
</intake>

<routing>
| 用户意图 | Workflow |
|----------|----------|
| 1、【新增】【导入】【创建徽章】【import】 | `workflows/import-badge.md` |
| 2、【发放】【发给】【award】【颁发】 | `workflows/award-badge.md` |
| 3、【查询】【列出】【看徽章】【list】 | `workflows/list-badges.md` |
| 其它 / 不清楚 | 先澄清是【新增定义】还是【发给人】，再选 |

**读完 workflow 后严格照它执行。**
</routing>

<reference_index>
领域知识都在 `references/`：

- **badge-fields.md** — import JSON 的字段清单、含义、必填与默认规则。
- **commands.md** — `agent badge` 命令速查、目标解析、发放时触发的事件与目标群。
</reference_index>

<workflows_index>
| Workflow | 用途 |
|----------|------|
| import-badge.md | 收集字段 → 生成 JSON → 按需导入数据库 |
| award-badge.md | 解析徽章与目标 → dry-run 预览 → 发放并触发通知 |
| list-badges.md | 列出全部徽章定义，或某成员持有的徽章 |
</workflows_index>

<templates_index>
- **templates/badge.json** — 单枚徽章 import JSON 模板（多枚改成数组）。
</templates_index>

<success_criteria>
一次成功的徽章操作：
- 分清了是 import 还是 award，没有把两步混做。
- import：JSON 字段合法、缺省字段补空字符串、写到 `assets/badges/` 下。
- award：先 dry-run 预览过得主与将触发的事件，确认后才真的发。
- 明确执行了用户要的【只产 JSON / 导入 / 发放】档位，没有越权写库或发通知。
</success_criteria>
