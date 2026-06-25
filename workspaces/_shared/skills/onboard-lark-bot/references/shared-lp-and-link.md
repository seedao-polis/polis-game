<table_of_contents>
- LP 是全局共享
- 跨 app 同一人 → link
</table_of_contents>

<shared_lp>
积分（LP）、徽章、用户 profile 存在**共享库** `.agent/shared.db`，所有 agent 共用一套经济（不在各自的 `<soul>.db`）。新接入的 bot 自动读写这个共享库，**不用配**。对话记忆仍按 agent 隔离（各自 `<soul>.db`）。

首次启用共享库时，运维已用 `pnpm agent lp-migrate` 把基线数据（来源 db 默认 tudigong）种进去；新 agent 无需再迁。
</shared_lp>

<link_identities>
每个飞书 app 给同一个人**不同的 open_id**。所以一个回头客在新 app 下是一个新 open_id，他的 LP 会从默认值另起，而不是沿用他在别的 agent 里的真实 LP。

要让同一个人在所有 agent 里 LP 一致，运维跑一次归并：
```bash
pnpm agent link <此人在新app的open_id> <他的canonical open_id>
```
- `canonical` 一般是他在第一个 / 主 agent（如 tudigong）里的 open_id。
- 归并后 `from` 自己的 LP 作废，之后 `from` 的所有 LP 都记到 canonical。
- 大多数成员只跟一个 bot 说话，**不用 link**；只有跨多个 bot 的少数人需要。

取某人在某 app 下的 open_id：从消息事件、`lark-cli --profile <p> auth status`（本人）、或 `lark-cli --profile <p> contact +get-user`（按名字 / 别人）拿。
</link_identities>
