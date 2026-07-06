# Workflow: 发放徽章给成员

<required_reading>
**先读这些：**
1. references/commands.md
</required_reading>

<process>
## 第 1 步：确认徽章存在

确认要发的徽章已 import。`<badge-ref>` 可用 `badge_id` 或 `badge_name`。不确定就先：
```
agent badge list
```
找不到徽章说明还没 import —— 先走 import-badge.md。

## 第 2 步：解析目标

收集得主，优先用 `ou_xxxxxx`（最稳）：
- 给了 `ou_` 直接用。
- 只给显示名称：可发，但**同名多人会中止并列出候选**，**查不到会中止整批**。遇到歧义就让用户改用 `ou_`。
- 多人空格分隔；重复会自动去重。

## 第 3 步：先 dry-run 预览

**务必先预览**，确认得主名单和将触发的事件：
```
agent badge award <badge-ref> <target> [target2 ...] --dry-run
```
检查输出里的得主、私信事件（badge-awarded）、群公告事件（badge-awarded-group / -default 或徽章自订 event）。

## 第 4 步：确认后真正发放

用户确认后去掉 `--dry-run`：
```
agent badge award <badge-ref> <target> [target2 ...] [--note "<备注>"]
```
- 只对【本次新得主】写库并触发通知；已持有者自动跳过。
- 需要换发通知的飞书身份时加 `--profile <p>`（不影响数据库）。

## 第 5 步：回报

把实际新发放的人数、触发的群公告去向（围观群 / 运营小天地 / 自订事件）回报用户。
</process>

<success_criteria>
- [ ] 徽章存在（list 确认过或已知 badge-ref）。
- [ ] 目标已解析，歧义已用 ou_ 消除。
- [ ] 先 dry-run 预览过得主与事件，用户确认后才真发。
- [ ] 回报了新得主人数与群公告去向。
</success_criteria>
