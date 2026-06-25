<table_of_contents>
- lark-cli profile（建 / 绑 app）
- 飞书开放平台后台配置
- scope 速查
</table_of_contents>

<lark_cli_profile>
lark-cli 用「具名 profile」管理多个 app，每个 profile = 一个 app = 一个 bot 身份。全局参数 `--profile <name>` 选用哪个（放在子命令前面）。

**建新 app（浏览器里现场建）**：
```bash
lark-cli config init --name <profile> --new
```
阻塞、输出验证 URL，浏览器完成建 app 后返回。

**绑已有 app（已有 app_id / app_secret）**：
```bash
lark-cli config init --name <profile> --app-id cli_xxx --app-secret-stdin
```
secret 从 stdin 读，避免在进程列表里暴露。

**确认**：
```bash
lark-cli --profile <profile> config show
```
看 `appId` / `profile` / `users`（`(no logged-in users)` 表示还没 `auth login`）。

注：某些 Agent 运行环境里 `config init` 可能默认拒绝、提示改用 `config bind`；普通终端不受影响，需要时加 `--force-init`。
</lark_cli_profile>

<feishu_console>
进开发者后台（open.feishu.cn/app）打开对应 app：

1. **添加应用能力 → 启用机器人**；设 bot 名字与头像。
2. **权限管理**：开通「获取与发送单聊、群组消息」——一条就覆盖「发消息 + 群被 @ 读 + 私聊读」。需要「思考中」表情再加 `im:message.reactions:write_only`。
3. **事件与回调 → 事件配置**：订阅方式选 **长连接**，添加事件 `im.message.receive_v1`（接收消息）。长连接不用填回调 URL，对应框架的 `event consume` 收消息方式。
4. **版本管理与发布 → 创建版本 → 申请发布**。权限和事件必须发布通过后才对 bot（应用身份）生效。
</feishu_console>

<scope_cheatsheet>
按对话场景需要的关键 scope（后台「权限管理」搜英文名）：

- 群里被 @：`im:message.group_at_msg:readonly`
- 私聊：`im:message.p2p_msg:readonly`
- bot 发消息：`im:message:send_as_bot`（或「获取与发送单聊、群组消息」打包项已含）
- 表情（可选）：`im:message.reactions:write_only`

不确定某接口要什么 scope：`lark-cli --profile <profile> schema <service.resource.method>`（如 `im.message.create`），看 `_meta.scopes`（列出的任一满足即可）、`_meta.access_tokens`（bot / user 谁能调）。
</scope_cheatsheet>
