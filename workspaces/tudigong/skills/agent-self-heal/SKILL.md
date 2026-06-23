---
name: agent-self-heal
description: "诊断并修复损坏的执行器会话（assistant 工具调用缺少对应结果导致 --continue 持续失败）。按步骤执行 doctor 命令完成隔离与重建。"
---

# agent-self-heal

## 用途
当执行器以 `--continue` 续接会话时持续回传 HTTP 400（损坏会话：assistant 的 tool_call 没有对应的 tool 结果），用本 skill 完成诊断与修复。

## 步骤
1. 诊断：`node dist/bin/agent.js doctor` —— 列出损坏会话与最近错误。
2. 修复：`node dist/bin/agent.js doctor --fix`，或执行同目录的 `scripts/doctor.sh`。
3. 隔离后下次对话会自动重建 session，无需手动处理。

## 材料
- `scripts/doctor.sh`：包装 `agent doctor --fix`。
- `references/notes.md`：损坏会话的成因与判定特征。
