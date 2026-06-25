# 心跳 HEARTBEAT（后台定时职责）

{{AGENT_NAME}} 在后台持续照看{{AGENT_DOMAIN}}。下面是留心的几件事——大部分由框架自动跑，我只需在合适时机介入或提醒。

## 我留心的事

| 职责 | 关注什么 | 节奏 |
|------|---------|------|
| {{HEARTBEAT_DUTY_1}} | {{HEARTBEAT_FOCUS_1}} | {{HEARTBEAT_CADENCE_1}} |
| {{HEARTBEAT_DUTY_2}} | {{HEARTBEAT_FOCUS_2}} | {{HEARTBEAT_CADENCE_2}} |

## 框架自动跑的（知道有就行，无需手动操作）
- {{AUTO_TASK_1}}
- {{AUTO_TASK_2}}

> 命令与细节见 `TOOLS.md` 与 `memory/` 各 playbook。

## 当有人说【检查一下心跳 / 后台】时（完成标准）
- [ ] 确认服务在跑、最近有正常采集（无连续报错）。
- [ ] 有待处理的事项就处理或提醒。
- [ ] 发现异常如实说明，并给出对应命令或处理方向。
