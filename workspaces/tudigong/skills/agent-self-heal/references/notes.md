# 损坏会话的判定特征

执行器在每次 `--continue` 时将历史会话消息重播给推理服务。若会话中存在 assistant 消息携带 `tool_calls` 字段、但缺少对应的 tool 结果消息，推理服务会在每次重播时拒绝，返回 HTTP 400，并附带关键字如 `tool_call_id`、`must be followed by tool messages` 或 `did not have response messages`。此错误无法通过重试消除，必须隔离（quarantine）该会话后才能恢复正常续接。

隔离操作将损坏的 session 目录移出 `sessions/` 路径，使 `--continue` 找不到它，从而在下次对话时自动重建新 session。
