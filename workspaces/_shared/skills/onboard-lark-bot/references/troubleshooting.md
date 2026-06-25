<table_of_contents>
- bot 收不到 / 发不出
- 起服务相关
- 登录到期
</table_of_contents>

<bot_send_receive>
- **`app_scope_not_applied`（99991672）/ `bot/v3/info` 的 `activate_status=2`**：权限或机器人能力没发布。回后台创建版本并发布，发布通过后 `activate_status` 变 `1`。
- **bot 收不到群消息**：① bot 没被拉进群；② 没订阅 `im.message.receive_v1`（长连接）；③ 缺 `im:message.group_at_msg:readonly`。群里 bot 只收到**被 @** 的消息（平台行为）。
- **私聊收不到**：缺 `im:message.p2p_msg:readonly`，或还没和 bot 开过会话。
- **`bot/v3/info` 报 `user access token not support`（99991668）**：少了 `--as bot`（bot 信息要应用身份，不是 user token）。
</bot_send_receive>

<serve_issues>
- **启动日志是 `auth 检查 profile=default` 而不是你的 profile**：profile 的 key 没等于 soul 名 → 回退 default。把 `configs/lark.json` 里的 profile key 改成 soul 名。
- **同一个 app 不能两个 serve 进程同时跑**：长连接事件流会被两个进程抢、导致双回复。给每个 bot 用独立 app，或先停掉另一个进程。
- **`没有可启动的 agent：soul=... 身份=bot`**：`configs/agents.json` 里没有该 soul 的 `-bot` 条目，先补上。
</serve_issues>

<token_expiry>
- user token 约 7 天到期（`auth status` 看 `refreshExpiresAt`）。到期重登：`lark-cli --profile <profile> auth login --domain im`（device flow、浏览器，无法全自动）。
- 只跑 `--bot` 不依赖 user token；但 `--user` / `--both` / `--sup` 的采集面需要它。
</token_expiry>
