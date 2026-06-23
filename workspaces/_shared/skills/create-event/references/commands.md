# agent event 命令速查

事件触发是**服务端操作员命令**，只在 server 端跑，不暴露给聊天用户。命令在仓库根目录运行（需先 build；运行形式与项目一致，如 `pnpm agent ...`）。

<commands>
```
agent events
agent event <编号|事件id> [--test] [--to <oc_xxx|ou_xxx>] [--actor <ou_xxx>] [--reason <r>] [--profile <p>] [--dry-run]
agent unsend <message_id> [--as bot|user]
```
`event-fire` 是 `event` 的别名。
</commands>

<events>
## events —— 列出所有事件

`agent events` 打印每个事件的编号、id、范围（scope）、排程描述、标题。编号是 1-based，可直接喂给 `agent event <编号>`。
</events>

<event>
## event —— 手动触发一个事件

`agent event <编号|事件id> [flags]`。`<ref>` 可以是 `agent events` 里的编号，也可以是 `eventTypeId`。

手动触发一律 `force`：**不受排程定时与概率限制**，且 `prepare` 会放宽选人门槛（尽量挑到一个对象演示）。

| flag | 作用 |
|------|------|
| `--dry-run` | 只跑 prepare + 渲染预览，**不发送、不发 LP、不写库**。先跑这个看选谁、文案长啥样。 |
| `--test` | 把目标**强制改成操作者本人 P2P**（安全验收，不发到真实群/别人）。优先级高于 `--to`。被 @ 的人多半不在你 P2P → 自动降级成文本。 |
| `--to <oc_/ou_>` | 覆盖目标：`oc_` = 群，`ou_` = 某人 P2P。 |
| `--actor <ou_>` | 指定个人事件的对象 open_id（驱动 `{{name}}/{{pt}}/...` 占位符）。 |
| `--reason <r>` | 触发原因，记进 dispatch（默认 `manual`，`--test` 时 `manual_test`）。 |
| `--profile <p>` | 发送用的飞书身份。 |

`--test` 与 `--dry-run` 可叠加。发送成功后会打印 `message_id` 和现成的撤回命令。
</event>

<unsend>
## unsend —— 撤回已发消息

`agent unsend <message_id> [--as bot|user]`。事件是 bot 发的，默认身份 bot；要撤回 user 身份的消息加 `--as user`。
</unsend>

<verification-flow>
## 推荐验收顺序

1. `agent event <id> --dry-run` —— 看 prepare 选了谁、文案/标题、哪些 @ 会降级。
2. `agent event <id> --test` —— 真发但只发给操作者本人 P2P，肉眼确认排版/图。
3. 确认无误 → `agent event <id>`（或挂排程让它自动触发）。发到群前先确认 bot 已在目标群。
4. 发错了 → `agent unsend <message_id>`。
</verification-flow>

<soul-db>
## soul 与数据库落点

数据相关读写（dispatch 记录、选人、LP 等）落在【当前 soul】的数据库 `.agent/<soul>.db`，由环境变量 `AGENT_SOUL` 决定（默认 `tudigong`）。底图素材按 soul 放在 `workspaces/<soul>/assets/events/`。`--profile` 只切换发通知的飞书身份，不改数据库落点。
</soul-db>
