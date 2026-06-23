# 徽章 import JSON 字段

`agent badge import` 接受**单个对象**或**对象数组**（多枚徽章）。每个对象的字段如下；全部可选，缺省按表格规则处理，写库时缺省字段补空字符串。

<fields>
| 字段 | 必填 | 含义与规则 |
|------|------|-----------|
| `headline` | 建议填 | 徽章显示名称（如【第12季市政厅成员】）。也是 `badge_id` 自动哈希的输入之一。 |
| `description` | 选填 | 徽章说明文字。 |
| `type` | 选填 | 徽章类别（如【身份】【职务】）。 |
| `role` | 选填 | 角色，`/` 分隔且**有层级**（如 `研发部/硬件处/手机科/研究员`）。 |
| `category` | 选填 | 分类，`/` 分隔但**无从属关系**（如 `市政厅/第12季`）。 |
| `endorser` | 选填 | 背书者（如 `SeeDAO`）。 |
| `duration` | 选填 | 有效期 `起始/结束`，格式 `YYYYMMDD`；`00000000`=无开始，`99999999`=无结束。也是哈希输入之一。 |
| `title` | 选填 | 游戏内串接在名字前的称号（功能未做，先存着）。 |
| `file` | 选填 | 图片相对路径，建议放 `assets/badges/` 下。目前只语义保存，尚未用于通知渲染，填或留空都不影响发放。 |
| `emoji` | 选填 | 表情/图标字符。 |
| `event` | 选填 | 发放时触发的事件 ID（取 `/` 前第一段）。**留空 = 触发系统默认事件**（见 commands.md）。填了就覆盖默认，但该事件必须已在 `src/core/events.ts` 注册，未注册只会打印警告、不触发。 |
| `badge_id` | 选填 | 唯一 ID。**省略时**自动按 `headline\|category\|duration` 生成 `badge-` + SHA1 前 8 位；同内容重导入得相同 id（幂等 upsert）。想稳定可控就自己给。 |
| `badge_name` | 选填 | award 时可用来查的【名称键】。**省略时默认 = `headline`**。`award <ref>` 的 `<ref>` 可吃 `badge_id` 或这个值。 |
</fields>

<id_and_idempotency>
## badge_id 与幂等

- 不填 `badge_id` → `badge-` + `sha1(headline|category|duration)` 前 8 位。
- 改了 `headline`/`category`/`duration` 任一 → 自动 id 会变 → 变成【另一枚】徽章。要更新已有徽章而非新增，请**显式带上原 `badge_id`**。
- import 是 `ON CONFLICT(badge_id) DO UPDATE`：同 id 重导入会用新内容覆盖所有字段（`created_at` 保留）。
</id_and_idempotency>

<json_shapes>
## 单枚 vs 多枚

单枚（一个对象）：
```json
{ "headline": "第12季市政厅成员", "type": "身份", "category": "市政厅/第12季" }
```

多枚（数组）：
```json
[
  { "headline": "第12季市政厅成员", "type": "身份", "category": "市政厅/第12季" },
  { "headline": "第12季市政厅厅长", "type": "职务", "role": "市政厅/厅长", "category": "市政厅/第12季" }
]
```

完整字段模板见 `templates/badge.json`。
</json_shapes>
