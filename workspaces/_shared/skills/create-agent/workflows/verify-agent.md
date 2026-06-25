# Workflow：验收（verify-agent）

<required_reading>
在执行本 workflow 前，先读：
- `references/runtime-constraints.md` — 了解启动守卫与 skill 生效时机
</required_reading>

<process>

## 步骤 1：确认新 agent 出现在 souls 列表

```bash
pnpm agent souls
```

确认输出中包含 `<new-agent>`。

## 步骤 2：运行 CLI 对话测试

```bash
pnpm agent cli <new-agent>
```

若命令被拒绝（提示「下划线开头目录」），说明 soul 名称违反命名约束，需重命名。

正常情况下会进入交互式对话（REPL）。

## 步骤 3：问身份确认问题

在 REPL 中输入：

```
你是谁？你能做什么？
```

确认 agent 能正确介绍自己的名字与角色，不再显示 `{{AGENT_NAME}}` 等未替换的占位符。

## 步骤 4：检查语言设置

确认 agent 的回复语言符合 `{{LANGUAGE_RULE}}` 中设置的语言要求。

## 步骤 5：退出并确认无残留占位符

退出 REPL（Ctrl+C 或输入 `/exit`），运行最终检查：

```bash
grep -rn "{{" workspaces/<new-agent>/
```

输出为空则通过。

## 步骤 6：完成验收 checklist

逐项确认以下内容：

- [ ] 目录 `workspaces/<new-agent>/` 存在且包含 9 个 .md 文件
- [ ] 无残留占位符（`grep -rn "{{" workspaces/<new-agent>/` 输出为空）
- [ ] `configs/agents.json` 中有对应 agent 条目
- [ ] `pnpm agent cli <new-agent>` 可以正常进入对话
- [ ] agent 能正确介绍自己的名字与角色
- [ ] agent 回复语言符合配置要求
- [ ] BOOT.md 顶部的 `⚠️` 样板警告已删除

</process>

<success_criteria>
- 以上验收 checklist 全部通过
- 新 agent 已就绪。本地用 `pnpm agent cli <new-agent>`；上飞书当 bot 用 `pnpm agent serve <new-agent> --bot`，完整接入走共用 skill `onboard-lark-bot`。
</success_criteria>
