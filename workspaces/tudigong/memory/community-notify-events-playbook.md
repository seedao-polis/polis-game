# 社区推播事件 playbook（2026-06-19/20）

这次新建的一批【推播到群】的事件，以及做它们时定下/踩到的通用约定。事件框架本身见 `event-system-playbook.md`，新建事件填 `event-creation-prompt-template.md`。

## 1. 群 ID 速查（别记错）

- **运营小天地**（外部群、status=normal、bot 在内）：`oc_example_ops_group`。⚠️ 有个**同名内部群** `oc_example_ops_group_old` 已 **dissolved**，别用（旧事件 lurker 还指着它）。
- **城邦快报**：`oc_example_broadcast_group`（外部）。⚠️ **2026-07-01 起，原本发往城邦快报的三条群推播（`badge-awarded-group` / `class-event-notify` / `visitor-num-notify`）全部改发【围观群】**（tudigong bot 已入围观群）；城邦快报别名仍在 `configs/lark.json`，但已无任何事件以它为目标。
- **SeeDAO 2.0 社区围观群**：`oc_example_public_group`。
- 常用 open_id：管理员 `ou_example_admin`；操作者（内部那个）`ou_example_operator`；海外号 `ou_example_member`。

## 2. 这次建的事件（都 `scope:'global'`、`overlays:[]`、`imageHeight:128`）

| eventTypeId | 触发 | 目标群 | 备注 |
|---|---|---|---|
| `badge-awarded` | 每位新得主 | personal P2P | 发放私信恭喜 |
| `badge-awarded-default` | 单人发放、徽章无自定事件 | 运营小天地 | 单人群公告 |
| `badge-awarded-group` | 多人(2+)发放、徽章无自定事件 | 围观群 | `prepare()` 动态 @ 全员，靠 `opts.recipients`（2026-07-01 由城邦快报改此） |
| `class-event-notify` | 课程报名跨里程碑 | 围观群 | RSVP 轮询触发，详见 §5（2026-07-01 由城邦快报改此） |
| `visitor-num-notify` | 围观群人数每满 100 | 围观群 | 成员同步轮询触发，详见 §6（2026-07-01 由城邦快报改此） |
| `cityhall-proposal-voted-notify` | 市政厅对提案做出决议 | 运营小天地 | 手动触发（未来接提案系统）；无 @、无奖励，详见 §10 |
| `like-maniac-notify` | 成员累计点赞跨 6 的倍数 | 围观群 | 表情反应轮询触发，奖励 LP+20，详见 §11（2026-07-03） |

底图都从图床下载落地到 `assets/badges/`（徽章）或 `assets/events/`（其它）。

## 3. 标题 vs 正文的 markdown（最重要的坑）

- **标题是飞书纯文字**（`sendPost` 的 `zh_cn.title`），**markdown 不渲染**：标题里写 `**粗体**` 会显示成字面星号 `**...**`。→ **标题别用粗体**。操作者 还要求**标题连引号都不要**（纯文字、不加 `'...'` 不加 `**...**`）；所有事件标题统一照办（含老的 lurker）。
- **正文走 `md` 元素**（`buildLine` 对无 `{{@}}` 的行发 `tag:'md'`）→ markdown 能渲染。**粗体格式**：` **内容** ` —— `**` 与内容之间**不留空格**，但 `**` 开头前面、结尾后面**各留一个空格**（如 `课程 **{{x}}** 在`）。CJK 紧贴 `**` 不留外侧空格可能不渲染粗体。
- **数学占位符 fillTemplate 不会算**：`{{100 - accept_num}}` 不会被计算（当成未知变量→空）。→ 在触发代码里先算好 `remaining` 变量再塞进 `vars`，正文用 `{{remaining}}`。

## 4. @ 提及（mentions）

- **固定对象**：直接在 `registerEvent` 的 `cfg.mentions` 写死，正文用 `{{@key}}`（如 visitor-num-notify 写死 `contact_1`=管理员、`contact_2`=操作者）。
- **动态对象**：`FireEventOptions` 这次加了 `recipients?: {openId,name}[]`；在事件 `prepare()` 里把它组成 `{{@m0}}、{{@m1}}…` token + `mentions` map 回传（badge-awarded-group 就这么干）。
- **不在目标群的 @ 自动降级**成【@名字】纯文字（`downgradeAtNonMembers`，避 230002）。dry-run 的【@:】行会标 `[可@]`/`[不在目标→降级]`。
- 注意：`event --dry-run` 预览里 `{{@key}}` 会显示**字面 token**（fillTemplate 不处理 `{{@}}`），但实际发送时 `buildLine` 会转成真 @ —— 看【@:】行确认即可，别被预览吓到。

## 5. 课程报名里程碑 `class-event-notify`

- **触发**：挂在 `feishu-user.ts` 的 `syncCalendarEventRsvp`（RSVP 轮询）。只对**名称含【共学】或【课】**的活动；`accept_num` = **接受 + 待定**（含待定！）；当 `accept_num` 相对**上一轮** RSVP round 新跨越 `10/25/40/50/60/75/90` 任一阈值时触发一次（单轮跨多个只发一次、带当下真实人数）。`remaining = max(0, 100 - accept_num)`。
- **活动链接 `event_link`**：用网页分享链接 `https://www.feishu.cn/calendar/share?token=...`，封装 `lark.getEventShareLink(calendarId, eventId)`（调原生 `calendar events share_info`）；**`--event-id` 要完整 occurrence id（带 `_<ts>`/`_0`），裸 uuid 报 invalid_parameters**；失败回退 `CalendarEvent.app_link`（新加的字段，取自 `+agenda` 的 `app_link`，是 `applink.feishu.cn` 应用内链接）。只在跨阈值要发时才调 share_info（不在每轮热路径）。
- 标题：`【剩 {{remaining}} 名额】 {{event_name}}报名达 {{accept_num}} 人`（手机先看到剩余名额）；`event_name` 记得 `.trim()`（飞书标题常带前导空格）。

## 6. 围观群人数里程碑 `visitor-num-notify`

- **触发**：挂在 `feishu-user.ts` 的 `syncMembers`（成员同步轮询）。监控群 `oc_example_public_group`（围观群）；同步前用新加的 `store.presentMemberCount(chatId)` 取上一轮在群人数 `watchPrev`，同步后 `r.total` 为本轮；当 `floor(now/100) > floor(prev/100)` 即**跨越 100 的整数倍**时触发一次，`visitor_num`=当下总人数。
- **首轮 guard**：`watchPrev > 0` 才判跨越，避免 DB 空时首次直接误触发（实际 `chat_members` 已有该群名册，prev 不会是 0）。

## 7. 里程碑触发的通用模式

- **【上一轮 vs 本轮】比对跨越**，免另存【已通知】状态：`prev` 取自上一轮记录（RSVP round / `presentMemberCount`），`crossed = floor(now/step) > floor(prev/step)`（或离散阈值数组 `filter(t => prev<t && now>=t)`）。因为每轮都会刷新记录，prev 就是上轮值，天然【每个里程碑只发一次】。
- 触发都 **fire-and-forget**：`void fireEvent(...)`（fireEvent 自带 try/catch、绝不抛进轮询热路径）。

## 8. sup 日志（监督者必须能看到）

- 触发要 `log.info`（INFO 才会进 Telegram 镜像）；平时【监测但没跨阈值】用 `log.debug`（免每 5 分钟刷屏）。
- 例：`INFO 课程报名提醒触发【…】`、`INFO 访客人数提醒触发【…】：257 → 300 人，跨越 300`、`INFO 事件已发送【…】，目标 oc_…（message_id=…）`。

## 9. 手动测试事件（带自定义 vars/recipients）

`pnpm agent event <id>` **不能传**自定义 `vars`/`recipients`（预览里占位符会是空）。要用真实数据测：写临时 node 脚本 `import { fireEvent } from './dist/core/events.js'`，自己组 `vars`/`recipients`，`enableLogSink()` + 跑完 `flushTelegramSync()`，用 `node --env-file=.env tmp.mjs` 跑（`.env` 才有 Telegram 密钥）。测完 `rm` 脚本、`pnpm agent unsend <message_id>` 撤回测试贴文、清 DB 里的测试徽章。

## 10. 市政厅提案决议 `cityhall-proposal-voted-notify`（2026-06-20）

- **静态全局事件**（`scope:'global'`、`overlays:[]`、`imageHeight:128`、`gapLines:1`、无 `prepare`/`schedule`/`mentions`/奖励），目标 = 运营小天地 `oc_example_ops_group`。底图 `assets/events/cityhall-proposal-voted-notify-bg.png`（图床 `i.meee.com.tw/CfGED5G.png` 落地，1254²，不叠字）。
- **三个占位符全靠 `vars` 注入**：`proposal_name`（提案名，标题+正文）、`proposal_voted_result`（结果如【通过】【不通过】，正文粗体）、`proposal_url`（提案链接，正文末尾自动 link）。目前**手动触发**（未来接提案系统）；`agent event` CLI 传不了 vars → 实发要用 §9 的临时 `fireEvent` 脚本带 `vars`。
- 坑复用 §3：结果行 `决议： **{{proposal_voted_result}}**` 在全角冒号 `：` 后**补一个半角空格**再起 `**`，否则 CJK 紧贴 `**` 可能不渲染粗体。

## 11. 点赞狂魔 `like-maniac-notify`（2026-07-03）

社区成员累计点赞（表情反应）跨 **6 的倍数**时触发，目标 = 围观群，奖励 **LP+20**。这是第一个以【表情反应】为来源信号的事件，需要先建一整套【反应采集】机制。

- **数据来源（关键发现）**：`im +chat-messages-list` **不带 `--no-reactions`** 时，每条消息内联返回 `reactions.details[]`——含 `emoji_type`、`operator.operator_id`（点赞者 open_id）、`operator.operator_type`（`user`/`app`）、`action_time`（unix 秒）。所以**不用逐条消息额外调 API**，轮询消息列表就能拿到反应。主轮询循环用 `--no-reactions` 抑制它省流量；`listMessages(chatId,{includeReactions:true})`（`src/core/lark.ts`）保留并解析成 `LarkMessage.reactions: MessageReaction[]`。
- **累计计数**：新表 **`chat_reactions`（migration v21）**，PK `(message_id, reactor_open_id, emoji_type)`——同一人对同一条消息同一表情**只算一次**（`recordChatReaction` 用 `INSERT OR IGNORE`、返回是否新插入）。某人累计点赞数 = `memberReactionCount(openId)` = `COUNT(*) by reactor`（`src/core/store/reactions.ts`）。
- **触发轮询 `syncChatReactions`**（`feishu-user.ts`，挂 discovery cadence、跟 syncMembers 同周期、排在其后好让名字先入库）：对每个**非工作群**（`getChatTier(chatId)!=='work'`）取**最近 18 则**消息（`REACTION_SCAN_MESSAGES`、对应模板【近 18 则讯息】）的反应，逐条 `recordChatReaction`，累计本轮每人新增数；某人 `floor(now/6) > floor((now-delta)/6)` 即跨越 6 的倍数 → `fireEvent('like-maniac-notify', {actorOpenId, vars:{member_name}})`。
- **首轮基线 guard**：第一轮只**播种**已存在的历史反应（记库、不触发里程碑），用 state cursor `feishu-reactions-seed-<profile>`（`lastPosition===1`=已播种、跨重启保留）标记；否则启动即把一堆旧反应判成跨越、群里刷屏。对照 §7 的【上一轮 vs 本轮】通用模式，只是多了首轮播种。
- **排除项**：`operator_type!=='user'`（滤掉 bot/app 反应）、`reactor===botOpenId`（bot 自己）、`emoji_type ∈ {reactionEmoji, queuedReactionEmoji}`（`Status_PrivateMessage`/`OnIt` 是「思考中/排队」进度指示，非真点赞）。**操作者不排除**（他也是居民，符合【只排除 bot】惯例）。
- **事件定义**：静态 `scope:'global'`、`overlays:[]`、`imageHeight:128`、`gapLines:1`，底图 `assets/events/like-maniac-notify-bg.png`（图床 `i.meee.com.tw/wR0g7BZ.png` 落地，1254²，不叠字）。标题 `点赞狂魔 {{member_name}} 出现了`（**去掉模板里的引号**，遵 §3【标题纯文字】）；正文把 `member_name` 当**粗体文字**（不是可点 @，为保运营者写的粗体句式，@ 无法嵌进 md 粗体）。`prepare()` 只挂 `afterSend` 发 LP+20 给 `opts.actorOpenId`（发成功才发奖）。
- **改了轮询循环 = 要重启 serve**（`syncChatReactions` 在 worker 里，但热重载 `agent update` 会重启 worker → 生效；若只想稳妥就整个重启 serve）。研究/实现代码：`src/core/{db,lark,events}.ts`、`src/core/store/reactions.ts`、`src/channels/feishu-user.ts`；测试在 `src/core/store.test.ts`（`chat reactions: dedupe...`）。

## 12. 热门消息自动置顶（2026-07-03，**不是事件、是飞书运营动作**）

某消息被**去重 ≥N 人**按表情反应就**自动置顶**（Feishu Pin），跟 §11 的表情采集共用同一次 `listMessages({includeReactions:true})` 抓取，但**独立于事件系统**（不发图、不发公告、不进 events.ts，纯 `im pins` 操作）。生产目标=**围观群**，阈值 **3**、**仅当天(逻辑日)消息**。

- **飞书 Pin API（实测于运营小天地，已清理）**：`im pins create --data '{"message_id":"om_xxx"}' --as bot`（建，看 `code===0`）/ `im pins list --params '{"chat_id":"oc_xxx"}'`（查）/ `im pins delete --params '{"message_id":"om_xxx"}' --yes`（移除，**`--yes` 是命令旗标、不能塞 params**，我踩过一次）。bot / user 身份都行，需 scope `im:message.pins:write_only`（SeeDAO 应用已具备），**bot 必须在群里**否则失败。封装成 `lark.pinMessage/unpinMessage(messageId,{as,profile})`（best-effort 返回 boolean，绝不抛）。
- **配置驱动、不写死群 id**：`configs/chat-policies.json` 每群加 `"autoPinMinReactors": 3` 即启用（缺省/0=不启用）；helper `getAutoPinThreshold(chatId)`（`src/core/configs.ts`）。目前只在**围观群**开。要加群改 config 即可、但**改 config 要重启 serve**（chat-policies 有缓存）。
- **判定**：`syncChatReactions` 里每条消息去重人数 = `Set(operator_id)`（滤 `operator_type!=='user'`、bot 自己、指示表情 `Status_PrivateMessage`/`OnIt`——和 §11 同一套排除）；`humanReactors.size >= 阈值` **且** `create_time >= logicalDayStart(now)`（**仅当天**，`src/core/time.ts`）**且** 没置顶过 → `pinMessage(as:'bot')` + `store.recordPinnedMessage`。
- **幂等**：新表 **`pinned_messages`（migration v22）**，PK `message_id`、`recordPinnedMessage` 用 `INSERT OR IGNORE`、返回是否新插入；`isMessagePinned` 先查、置顶过就跳，**永不重复调 API**。
- **扫描范围合并**：原本 `syncChatReactions` 只扫非工作群（为 §11 点赞）；现改成【非工作群(点赞) **或** 配了 autoPin 的群】都扫，一次抓取同时喂两个用途。工作群若将来也想置顶，给它配 `autoPinMinReactors` 即可（会只做置顶、不做点赞采集）。
- **首轮不 gate 置顶**：§11 的首轮基线 guard 只压【点赞里程碑】不发；**置顶在循环内、每轮都跑**，所以首次启动就会把当天已够 3 人的热门消息置顶（安静幂等、不像点赞事件会群发刷屏，可接受）。
- **每群上限 5 条、超了取消最旧（2026-07-03）**：常量 `PIN_CAP=5`（feishu-user.ts）。每成功置顶一条后，`store.pinnedMessagesOldestBeyond(chatId, 5)` 取【我们自己置顶】里超过 5 条的最旧几条（按 `pinned_at DESC, rowid DESC` OFFSET 5、只算 `pinned_messages` 里的行 → **绝不动人工置顶**），逐条 `unpinMessage` + `removePinnedMessage`。**取消后无论 unpin 成功与否都移除追踪**——unpin 失败几乎都是【消息已删/被手动取消】即本就不在置顶里，留着会把上限逻辑卡死；代价是极偶发的临时网络失败会多留一条可见置顶，可接受。实测：运营小天地连置 6 条→自动取消最旧→恰好剩 5（已全部清理）。
- **注意**：只按【条数】上限，没做【时间过期】取消（如隔天取消）；要的话在轮询里对 `pinned_messages` 按 `pinned_at` 加个 TTL 扫描即可。研究/实现：`src/core/{db,lark,configs}.ts`、`src/core/store/reactions.ts`（`recordPinnedMessage`/`isMessagePinned`/`pinnedMessagesOldestBeyond`/`removePinnedMessage`）、`src/channels/feishu-user.ts`；测试 `src/core/store.test.ts`（`pinned messages: record once...` + `...cap eviction...`）。
