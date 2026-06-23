# Workflow: 新增 / 导入徽章定义

<required_reading>
**先读这些：**
1. references/badge-fields.md
2. templates/badge.json
</required_reading>

<process>
## 第 1 步：确认执行档位（关键开关）

问清楚（用户没说就默认最安全档）：
- **只产 JSON**（默认，不碰数据库）
- **产 JSON + 导入数据库**（`agent badge import`）
- 用户若顺带提到要发放，提醒：发放是另一步，走 award-badge.md。

## 第 2 步：收集字段

按 badge-fields.md 收齐内容。一枚或多枚都行。常见来源是用户给的一段描述，按字段合理拆解：
- `headline`/`type`/`role`/`category`/`endorser`/`duration` 按内容填；
- 用户没提的字段补空字符串；
- `badge_id`/`badge_name` 一般留空（自动生成 / 默认等于 headline）；
- `event` 不确定就留空（留空 = 走系统默认群公告）。

## 第 3 步：写 JSON 文件

复制 templates/badge.json，填好后写到 `assets/badges/<有意义的档名>.json`：
- 单枚 → 单个对象；多枚 → 数组。
- 缺省字段保留空字符串。
- 占位 `<...>` 必须替换成真实值，别把尖括号写进去。

## 第 4 步：按档位执行

- 只产 JSON：到此为止，把文件路径与内容告诉用户。
- 要导入：运行
  ```
  agent badge import assets/badges/<档名>.json
  ```
  把导入结果（写入/更新的 badge_id）回报用户。

## 第 5 步：收尾

一次做完，不反问；不要 commit、不要开 PR（除非用户要求）。
</process>

<success_criteria>
- [ ] 跟用户确认了【只产 JSON / 导入】档位。
- [ ] JSON 字段合法、占位符已替换、缺省补空字符串。
- [ ] 文件写在 `assets/badges/` 下，单枚=对象、多枚=数组。
- [ ] 若要导入，已运行 import 并回报了 badge_id。
- [ ] 没有越权发放或 commit。
</success_criteria>
