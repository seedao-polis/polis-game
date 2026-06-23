# lark-cli 操作手册（城邦土地神工作区记忆）

> 这是城邦土地神在飞书（lark-cli / @larksuite/cli）上操作的踩坑经验与命令速查。
> 在群里执行任何飞书操作前，先读这份文件。命令、参数、JSON 字段名、ID、emoji_type 一律保留原文。
> 当前身份：SeeDAO 租户，profile = `example_lark_profile`，应用 = 城邦土地神（app `cli_example_app_id`）。

## 0. 最重要的三条（最容易踩坑）

1. **对 SeeDAO 的每一条命令都要带 `--profile example_lark_profile`**（全局参数，放在子命令前面，例如 `lark-cli --profile example_lark_profile im +chat-list`）。不带就会悄悄回退到默认的旧应用，对 SeeDAO 群发消息会被 `230027` 拦截。环境变量（`LARK_PROFILE` 等）一律无效，只有 `--profile` 有效。
2. **返回结构分两种，判断成功的字段不一样**：
   - 带 `+` 的便捷命令（`im +messages-send` / `+messages-reply` / `+chat-list` / `+chat-messages-list`）返回 `{ "ok": true, "data": {...} }` → 看 `ok`。
   - 原生 OpenAPI 命令（`im reactions ...` / `im messages delete` / `im chat.members ...`）返回 `{ "code": 0, "data": {...} }` → 看 `code === 0`。
3. **破坏性操作要加 `--yes`**（例如撤回消息），否则报 "requires confirmation"。

## 1. 身份：`--as user` / `--as bot`

- `--as user`：以 操作者 本人身份发（impersonation），显示为 操作者；能看到 操作者 可见的所有群。
- `--as bot`：以城邦土地神机器人身份发，显示为城邦土地神；机器人必须先被拉进群才能收发，群聊里只收到【被 @】的消息。
- 发消息、加表情、撤回都接受 `--as`；删除/撤回/删表情只能操作【自己这个身份发/加的】。

## 2. 发消息 & 话题群回复（重点）

- 普通发消息：`im +messages-send --chat-id oc_xxx --as bot --text "..." --format json`（返回 `data.message_id`）。
- **话题群（`chat_mode=topic`，例如 AgentTasks）里不要用 `+messages-send` 直接发**——它会另开一个新话题。
- 要回在原消息所在的话题里：用 **`im +messages-reply --message-id om_xxx --reply-in-thread --as bot --text "..."`**。`--reply-in-thread` 让回复出现在话题流里，而不是主聊天区。
- 触发来源：`im.message.receive_v1` 事件体里带 `message_id`（`om_` 开头），直接拿它来 reply。
- **话题回复必须回灌 thread 上下文（2026-06-17 修）**：bot 走长连接，平台**只投递 @ 它的消息**——话题原帖若 @ 的是别的 agent，bot 事件流根本收不到，直接回会丢上下文（典型翻车：操作者 在【跨境电商开幕】话题里追问折扣，bot 反问【没看到上下文】）。修法：事件提取 `ev.thread_id`（flat 结构，和 `ev.sender_id` 同级；落库进 `messages.thread_id`），回复前用 `store.getThreadContext(threadId,{limit:15,excludeMessageId})` 取**同话题全历史**（含没 @ 的原帖——这些靠 `tudigong-user` 轮询采集进库），渲染成【名字：文本】旧→新传给 `respondAsync` 的 `context`。非话题群用 `getRecentChatMessages` 取最近 8 条兜底。取名字用 `store.memberName`（库里 `sender_name` 常空）。
- **会话键按话题隔离（2026-06-17 修）**：执行器会话键从 `${cfg.id}-${chatId}` 改成 `${cfg.id}-${chatId}-${threadId}`（有 thread 时）。话题群一个 `chat_id` 装所有话题，不隔离会让所有话题串进同一个 `--continue` 会话、互相串味。`pending_replies.session_key` 已持久化，重启 recover 直接复用。

## 3. 表情回复（"思考中" 指示）

- **"思考中" 用的 emoji_type = `Status_PrivateMessage`**（操作者 亲自选定的）。注意：`Thinking` / `ThinkingFace` 是无效值，会报 "reaction type is invalid"；`OnIt`、`THUMBSUP` 是有效的。
- 加表情：`im reactions create --params '{"message_id":"om_xxx"}' --data '{"reaction_type":{"emoji_type":"Status_PrivateMessage"}}' --as bot --format json` → 返回 `data.reaction_id`（删除时要用）。
- 删表情：`im reactions delete --params '{"message_id":"om_xxx","reaction_id":"yyy"}' --as bot --format json`。只能删自己加的。
- 典型用法：检测到要回答时先加表情当【处理中】指示，回复发出后再删掉。
- 需要权限 `im:message.reactions:write_only`（已开通并发布版本）。
- 不知道某个表情的 emoji_type？让人手动按一个，再 `im reactions list --params '{"message_id":"om_xxx"}' --format json`，从 `data.items[].reaction_type.emoji_type` 读出来。

## 4. 撤回消息

- `im messages delete --params '{"message_id":"om_xxx"}' --as bot --yes --format json`（成功 `code=0`）。
- **必须带 `--yes`**（高危操作确认），否则报 "im.messages.delete requires confirmation"。
- 机器人只能撤回自己发的；要撤别人的群消息得是群主 / 管理员 / 创建者。
- 撤回只是【收回内容】：历史里那条 `message_id` 还在，但内容变空（再列出来会显示 `[Invalid text JSON]`）。无法彻底抹掉历史记录。
- **关闭 / 删除话题没有 API**（`im threads` 只有 `forward`），只能在飞书 App 里手动关。

## 5. 监听消息（长连接）

- `event consume im.message.receive_v1 --as bot`：长连接，事件按 NDJSON 一行一条输出到 stdout；信息和错误走 stderr。
- 错误格式是 `{ "ok": false, "error": { "message": ..., "hint": ... } }`，最常见的是没在开发者后台订阅事件 → "requires event types not subscribed in console"。
- 前置：后台订阅 `im.message.receive_v1`（接收方式选【长连接】）+ 开 `im:message.group_at_msg:readonly`（群里被@）/ `im:message.p2p_msg:readonly`（单聊）+ 发布版本。
- 群聊里机器人只能收到【被 @】的消息（平台行为）；要拿到所有消息（知识库采集）得用 `--as user` 轮询。

## 6. 群列表 & 内部 / 外部

- `im +chat-list --as user --page-size 100 --format json`：群列表在 **`data.chats[]`**（注意键名是 `chats`，不是 `items`），每个群带 `external`（布尔）、`chat_mode`（group / topic）、`tenant_key`。
- **只服务内部群（`external=false`）**。外部群（`external=true`）：user 发消息被 `230027`；机器人加群被 `232033`（除非后台发布【允许加入外部群】）。
- 已知内部群：市政厅工作群、工作人员、AgentTasks（话题群）、AgentNotify。
- 【SeeDAO 2.0 社区群】是外部群（`external=true`）。注意 SeeDAO 的 `tudigong-user` 现在 `listen:"all"`，**内外群都监听 + 采集 + 同步名册**（框架默认 `all-internal` 只内部群，但当前配置是 all）。
- **取名字**：`contact +get-user --as user` 只能查**本租户**用户（外部 / 跨租户 open_id 返回空名）。要拿外部成员名字用群成员接口 **`im chat.members get --params '{"chat_id":"oc_xx","member_id_type":"open_id","page_size":100}' --as user`**（原生命令、看 `code===0`、`data.items[].name`、翻页看 `has_more`/`page_token`），它对跨租户成员也给名（飞书对未公开真名的跨租户用户只给【用户XXXXXX】式匿名名，这已是能拿到的极限）。`lark.listChatMembers(chatId)` 封装了它（回 open_id→name 的 Map）。
- **成员名册 directory（`chat_members` 表，migration v9）**：和 `profiles` **分开存**（profiles 是游戏化表，每日 AP 补底会给所有 profile 补到 10，所以**不能**把整个社区名册塞进 profiles，否则给一堆没互动的人发 LP）。`feishu-user` 的 `rescan`（现在 **5 分钟**一轮，`lark.json` 的 `discovery.refreshMinutes`）会 `listChatMembers` 同步**所有监听群**（不分内外）的全部成员（含从没发言的人）进 `chat_members`：`store.syncChatMembers(chatId, rosterMap)` 把在群的人 upsert 成 `present=1`、新人计 added、**离开的人 `present=0` 但保留不删**（回来再翻回 1，不算新增）。
  - **改名也会更新**：每轮同步拿的是当前花名册名字，`ON CONFLICT` 用新名覆盖旧名（非空才覆盖），改名计入 `renamed`（日志会报【改名 N 人】）。同步还会顺手刷新**已存在的 profile** 名字（`UPDATE ... WHERE open_id=? `，**只更新、不新建**，避免给非互动者建 profile 触发 LP），所以互动者改名后 `{{name}}`/AP footer/排行榜也跟着更新。
  - 显示名取名顺序（`silentMemberReport` 的 COALESCE）：**`chat_members` 名册（每 5 分钟刷新、能反映改名）排第一** → 采集 `sender_name`（消息发出时定格、会过时）→ profiles 名 → 最后 open_id。`store.memberName(openId)` 取名册里 `last_seen` 最新的名。事件实时查到的名缓存进 `chat_members`（`recordChatMember`，**不写 profiles**）。
  - **候选池 = 来源群名册（不是 messages、也不是全部名册）**：`silentMemberReport(cutoffMs,{sourceChatIds,excludeOpenIds})` 用 `sourceChatIds` 限定只看这些群的 `chat_members present=1`（省略才是全部名册），含从没发言的人；`last_spoke` 从 messages join（没发过=0），`silent`=`last_spoke<cutoff`（**含从未发言**=终极潜水）。所以【未发言 N 人】别只看发过言的——早期用 messages 当池子会得到假的【0 人】。report 回 `{members,silent,chats,cutoffMs}`，`chats`=搜了哪些来源群+人数（给日志）。lurker 的 `sourceChatIds=运营小天地`。
  - **选人只排除 bot**（`silentMemberReport` 的 `excludeOpenIds: [SELF_BOT_OPEN_ID]`）——这是**所有 member-selection 事件的默认**，**不排除操作者/任何人**（操作者 也可被选为潜水对象）。未来若有针对 bot 的事件再单独 opt-in。
  - ⚠️ 知识点：**一个人可能有多个 open_id**（飞书 open_id 跨租户不同；如 操作者 在内部群是 `ou_example_operator`、在外部群是 `ou_example_operator_overseas`，名字都【操作者】）。目前不按名字排除（已去掉 `excludeNames`）；若将来要【彻底排除某人的所有身份】再按名字处理。

## 7. 平台限制提醒

- 后台任何权限 / 事件变更，都要【建版本 → 申请发布】才生效。
- user token 大约 7 天过期（refresh），过期要人工重新 `auth login --domain im`（device flow 需要浏览器，无法全自动）。
- 改机器人名字没有 API，只能后台改名 + 发布版本。
- 在 Windows 上通过 `node <run.js>` 调 lark-cli，避开 `.cmd` 包装和中文 / emoji 参数的编码问题。
- **`code=2200 / "Internal Error"` 是飞书服务端瞬时抖动（≈5xx），不是群改名导致**：群改名不改 `chat_id`，轮询按 `chat_id` 读，改名永远不会让读消息失败。判断是不是瞬时：同一群隔一会儿再读一次，`ok:true` 就是瞬时。`listMessages`/`listChats` 失败现在抛 `LarkApiError`（带 `code`/`log_id`/`retryable`，`isTransientLarkError` 判定 2200 / 非 JSON 崩溃 / timeout 为可重试）。`feishu-user` 轮询对瞬时错误：头几次只记 `WARN`、靠下一轮 4s 轮询自愈（游标只在成功后推进，不丢消息）；连续失败 ≥3 次或不可重试才升级 `ERROR` 并按 `2^n` 退避到最多 60s，避免刷屏。

## 7.5 群消失 / 被踢 / 错误信封外漏（2026-06-18 修，重点）

- **`code=232009 "...chat which has already been dissolved"` = 群已被解散，永久消失，重试永远不会成功。** 检测 `isChatGoneError(e)`（`lark.ts`，按错误码 232009 + "dissolved/disbanded" 文案）。命中 → 立即 `store.markChatInactive(chatId,'dissolved')` + **停轮**（轮询 `tick` 直接 `return`、不再 reschedule）+ 成员置离开；以后 `syncMembers`/`startNew` 跳过；`agent doctor` 末尾可见。
- **被踢出群 / 无权限 = 不可访问、可能恢复**（如 `"Bot/User can NOT be out of the chat"`、no permission/forbidden）。检测 `isChatInaccessibleError(e)`（按文案，已排除"解散"）。**保守判定**：不是一次就停，轮询循环要**连续 `INACCESSIBLE_STANDDOWN_AFTER=3` 次**才 `markChatInactive(chatId,'inaccessible')` + 停轮；未到阈值就退避重试；任何一次成功或其它错误都清零计数。**自动恢复**：被重新拉回群后它会重新出现在实时群发现列表 → `startNew` 检测到 reason=`inaccessible` → `clearChatInactive` + 恢复监听（解散的群永不恢复，因为永远不再出现在列表里）。
- **⚠️ 两个极易踩的根因坑（不修的话上面全是死代码 + 每 5 分钟刷屏）**：
  1. **`larkExec` 的 `execFileSync` 默认把子进程 stderr 转发到我们的 stderr** → lark-cli 失败时会把整个错误信封（`{"ok":false,"identity":"user","error":{...}}`）漏到控制台/日志，**和我们有没有 try/catch 无关**。修法：`execFileSync(..., { stdio:['ignore','pipe','pipe'] })` 把 stderr **捕获**（仍从 `err.stderr` 读出来解析），就不再外漏。
  2. **`listChatMembers` 原本"绝不抛错"**（任何错误都 `break` 返回空 Map）→ 成员同步路径**永远检测不到解散**（写在 syncMembers 里的 catch 是死代码），解散群每 5 分钟被命中一次、且空名册还会被 `syncChatMembers` 误判成"全员离开"。修法：`listChatMembers` 只对**确定性**的解散/不可访问错误**抛 `LarkApiError`**（其余临时 / 分页失败照旧吞掉、返回部分结果）；调用方（`syncMembers`、events `roster()`、`destinationMemberIds`）都要 try/catch。**外加**：取到**空名册 = 临时失败被吞**（我们一定是群成员，名册不可能真空），syncMembers 要**跳过本轮**，别让它标"全员离开"污染 `member_sync_rounds`。
- 轮询路径 `listMessages` 本来就抛 `LarkApiError`、`tick` 已处理；以前一直漏的是**成员同步路径（`listChatMembers` 吞错）+ stderr 外漏**这两条。停服状态表见 `local-db-playbook §8`。

## 8. 关键 ID 速查

- SeeDAO profile：`example_lark_profile`
- 城邦土地神 app：`cli_example_app_id`；bot openId：`ou_example_bot`
- 操作者（SeeDAO 身份）openId：`ou_example_operator`
- AgentTasks：`oc_example_agent_tasks`（话题群）
- AgentNotify：`oc_example_agent_notify`

## 9. 在话题群里建话题 / 改帖 / 中文排版

- **建话题**：在话题群（如 AgentTasks）直接 `im +messages-send --chat-id oc_xxx --as bot --markdown "..."`（不带 reply）就会开一个新话题。飞书**没有单独设置话题标题的接口**——标题就写在内容首行（用 **加粗** 当标题）。
- **富文本**：`--markdown` 会自动转成 post 格式，支持 **加粗**、• 列表、emoji、换行；要排版好看就用它，别用 `--text`。
- **改帖**：lark-cli **没有编辑消息的命令**。发错了只能撤回（`im messages delete --params '{"message_id":"om_xxx"}' --as bot --yes`）再重发；撤回只是收回内容、会留下一条【已撤回】的空记录，话题也无法通过 API 关闭。
- **多行 / emoji 内容**：不要直接在命令行拼引号。写一个临时 node 脚本，把内容当数组元素传给 `execFileSync('node', [run, ...])`，避开 shell 引号转义和中文 / emoji 编码问题（框架的 `lark.ts` 就是这么做的）。
- **中文排版习惯（操作者要求）**：给 SeeDAO 飞书群的内容一律**简体中文 + 大陆用语**；中文强调 / 书名 / 标签统一用 **【】**。

## 10. auth / scope 管理、通用 api/schema、访问记录类 API（2026-06-19）

### 通用调用 & 自省（封装不到的接口直接打）
- **任意原生接口**：`lark-cli api GET|POST <path> --params '<json>' --data '<json>'`。
- **看接口的入参/返回/所需 scope**：`lark-cli schema <service.resource.method>`（如 `drive.file.view_records.list`），输出含 inputSchema/outputSchema、`_meta.scopes`（列出的 scope **任一**满足即可）、`_meta.access_tokens`（bot/user 谁能调）。
- **`+xxx` 便捷命令可能比原生命令卡更严的 scope**：如 `wiki +space-list` 硬卡 `wiki:space:retrieve`，但原生 `wiki spaces list` 接受 `wiki:wiki:readonly` → 缺前者就**改用原生命令绕过**（原生看 `code===0`、翻页 `has_more`+`page_token`）。

### 查 scope 现状（排查 `missing_scope` 必用）
- `auth status`：当前 **user token** 的 `scope`（已授予）、`refreshExpiresAt`（重登死线）、`grantedAt`。
- `auth scopes`：应用在**后台开通**的 scope（≠ user token 已授予的那份）。
- `auth check --scope "<a>"`：某 scope 是否已授予；**多个 `--scope` 只认最后一个**，要逐个查。

### `auth login` 重新授权（重点坑）
- `auth login --scope "<空格/逗号分隔>"`：device flow、阻塞输出验证 URL、浏览器完成；无 `--as`；可 `--domain drive,wiki`（整域）/ `--exclude` 微调。
- **覆盖式**：会把 user token 的 scope 整份替换成本次请求的 → **必须带【现有全部 scope + 新增】取并集**（含 `offline_access`），否则丢掉原有 im/calendar 等能力。最省心写法：先 `auth status` 取当前 `scope`、拼上新 scope 去重。
- **user 身份 ≠ 应用身份(bot)**：`auth login` 只授 **user token**。bot（`--as bot`/tenant_access_token）要在**后台把同样 scope 开给【应用身份】+ 创建版本 + 申请发布**，否则 `--as bot` 报 `app_scope_not_applied`(99991672)。
- user token 约 **7 天**到期（`refreshExpiresAt`），到期需人工重登（浏览器、无法全自动）→ 已加 Telegram 到期提醒（见 `telegram-playbook`，`pnpm agent token-check`）。

### 云文档访问记录类 API（采集落地见 local-db-playbook §10）
- `drive file.view_records list`：**谁看了某文档 + 最近一次访问时间**（`viewer_id`/`name`/`last_view_time` 秒；一访问者一条、是【最近一次】不是逐次流）。**必须文档 owner 或可管理(admin) 才读得到，edit/read 一律 `forbidden`(1069603)**。wiki 文档用节点的 `obj_token`+`obj_type`（不是 node_token+wiki）。
- `drive file.statistics get`：聚合 `uv/pv`（只有人数、没有【谁】），**edit 权就能读**。
- 妙记 `minutes minutes get` 无任何 view/统计字段（拿不到访问记录）；**bot 加不进 wiki 空间**（成员只能用户/部门，`+member-add --member-type appid` 无效）→ 知识库访问采集**只能用 user(操作者) 身分**，且 操作者 要是该空间 admin（实测【数字城邦】是 admin 能读全空间）。

