# 心跳 HEARTBEAT（后台定时职责）

{{AGENT_NAME}} 在后台持续照看{{AGENT_DOMAIN}}。每次心跳醒来，主动检视以下几件事：

## 心跳醒来时，我主动做的事

| 职责 | 关注什么 | 行动方式 |
|------|---------|---------|
| {{HEARTBEAT_DUTY_1}} | {{HEARTBEAT_FOCUS_1}} | 按需通过飞书工具行动 |
| {{HEARTBEAT_DUTY_2}} | {{HEARTBEAT_FOCUS_2}} | 按需通过飞书工具行动 |

## 节制原则（闸门）

- 静默时段：每日 22:00 至次日 08:00 不行动（框架层面已强制）
- 无意义不发：如当前没有需要行动的事，输出「本轮无需行动」即可
- {{HEARTBEAT_GATE_PRINCIPLE}}（此处填写本 agent 特有的节制原则）

## 框架自动跑的（知道有就行，无需手动操作）
- {{AUTO_TASK_1}}
- {{AUTO_TASK_2}}

> 命令与细节见 `TOOLS.md` 与 `memory/` 各 playbook。
