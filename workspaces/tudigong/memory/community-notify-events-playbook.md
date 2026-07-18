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
| `first-try-notify` | 成员首次使用新上线功能 | 围观群 | 手动触发（operator 供 member_name/function_name/actorOpenId），奖励 LP+10，详见 §13（2026-07-07） |

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

社区成员**在一个逻辑周内**点赞（表情反应）达 **66 次**时触发，目标 = 围观群，奖励 **LP+20**，每人每周只发一次。这是第一个以【表情反应】为来源信号的事件，需要先建一整套【反应采集】机制。

> **⚠️ 本节旧版写的是「累计跨 6 的倍数」，那是初版规则，代码早已改成【一周内 66 次】，2026-07-17 才发现记忆和公开档案都还停在旧规格（`docs/data.js` 也一起改了）。判据以代码 `LIKE_MANIAC_WEEKLY_THRESHOLD` 与事件正文为准——事件正文「此事件在社区成员一周内点赞达 66 次时发生」一直是对的。**

- **数据来源（关键发现）**：`im +chat-messages-list` **不带 `--no-reactions`** 时，每条消息内联返回 `reactions.details[]`——含 `emoji_type`、`operator.operator_id`（点赞者 open_id）、`operator.operator_type`（`user`/`app`）、`action_time`（unix 秒）。所以**不用逐条消息额外调 API**，轮询消息列表就能拿到反应。主轮询循环用 `--no-reactions` 抑制它省流量；`listMessages(chatId,{includeReactions:true})`（`src/core/lark.ts`）保留并解析成 `LarkMessage.reactions: MessageReaction[]`。
- **累计计数**：新表 **`chat_reactions`（migration v21）**，PK `(message_id, reactor_open_id, emoji_type)`——同一人对同一条消息同一表情**只算一次**（`recordChatReaction` 用 `INSERT OR IGNORE`、返回是否新插入）。某人累计点赞数 = `memberReactionCount(openId)` = `COUNT(*) by reactor`（`src/core/store/reactions.ts`）。
- **触发轮询 `syncChatReactions`**（`feishu-user.ts`，挂 discovery cadence、跟 syncMembers 同周期、排在其后好让名字先入库）：对每个**非工作群**（`getChatTier(chatId)!=='work'`）取**最近 18 则**消息（`REACTION_SCAN_MESSAGES`、对应模板【近 18 则讯息】）的反应，逐条 `recordChatReaction`，累计本轮每人新增数；对本轮有新增的人算 `weeklyMemberReactionCount(openId, 本逻辑周)`，达 `LIKE_MANIAC_WEEKLY_THRESHOLD`（=66）且本周没发过 → `fireEvent('like-maniac-notify', {actorOpenId, vars:{member_name}})`。**每人每周一次的闸门落在 `like_maniac_weeks` 账本**（`recordLikeManiacWeek` 幂等），不是内存里的跨越判断——内存判断一重启就会重发，且迟到的跨周反应会误触发。
- **首轮基线 guard**：第一轮只**播种**已存在的历史反应（记库、不触发里程碑），用 state cursor `feishu-reactions-seed-<profile>`（`lastPosition===1`=已播种、跨重启保留）标记；否则启动即把一堆旧反应判成跨越、群里刷屏。对照 §7 的【上一轮 vs 本轮】通用模式，只是多了首轮播种。
- **排除项**：`operator_type!=='user'`（滤掉 bot/app 反应）、`reactor===botOpenId`（bot 自己）、`emoji_type ∈ {reactionEmoji, queuedReactionEmoji}`（`Status_PrivateMessage`/`OnIt` 是「思考中/排队」进度指示，非真点赞）。**操作者不排除**（他也是居民，符合【只排除 bot】惯例）。
- **事件定义**：静态 `scope:'global'`、`overlays:[]`、`imageHeight:128`、`gapLines:1`，底图 `assets/events/like-maniac-notify-bg.png`（图床 `i.meee.com.tw/wR0g7BZ.png` 落地，1254²，不叠字）。标题 `点赞狂魔 {{member_name}} 出现了`（**去掉模板里的引号**，遵 §3【标题纯文字】）；正文把 `member_name` 当**粗体文字**（不是可点 @，为保运营者写的粗体句式，@ 无法嵌进 md 粗体）。`prepare()` 只挂 `afterSend` 发 LP+20 给 `opts.actorOpenId`（发成功才发奖）。
- **改了轮询循环 = 要重启 serve**（`syncChatReactions` 在 worker 里，但热重载 `agent update` 会重启 worker → 生效；若只想稳妥就整个重启 serve）。研究/实现代码：`src/core/{db,lark,events}.ts`、`src/core/store/reactions.ts`、`src/channels/feishu-user.ts`；测试在 `src/core/store.test.ts`（`chat reactions: dedupe...`）。

## 12. 热门消息自动置顶（2026-07-03，**不是事件、是飞书运营动作**）

某消息被**去重 ≥N 人**按表情反应就**自动置顶**（Feishu Pin），跟 §11 的表情采集共用同一次 `listMessages({includeReactions:true})` 抓取，但**独立于事件系统**（不发图、不发公告、不进 events.ts，纯 `im pins` 操作）。生产目标=**围观群**，阈值 **3**、**仅当天(逻辑日)消息**。

> **⚠️ 本功能曾静默死了两周（2026-07-04 → 07-17），根因是 lark-cli 1.0.69 把 `create_time` 人性化 → 裸 `Number()` = NaN → 「仅当天」闸门对每条消息判否。完整根因与两个命令家族的模型见 [[lark-cli-playbook]] §11.1。**
> **本节旧版把它写成「功能正常」，是又一次「playbook 把错的写成规格」。诊断口径：**
> - **别信 playbook、别信帖子，先查 DB。** `pinned_messages` 全表只有一行、`pinned_at` 停在 07-04，一眼就能看出功能死了；而日志「置顶 0 条」看起来完全正常。
> - **反应入库和置顶判定在同一个循环、同一份 `msg.reactions` 上**。所以「点赞进得来但没置顶」＝扫描看得见消息，只可能是 pin 的四个前置条件之一挡的，不是采集问题。
> - **没有 `热门消息置顶失败` 警告 ≠ 没尝试**。那条 warn 只在 `pinMessage()` 返回 false 时打；条件判断挡掉时**一声不吭**。现已给「时间解析不出来」补了 warn 分支。



- **飞书 Pin API（实测于运营小天地，已清理）**：`im pins create --data '{"message_id":"om_xxx"}' --as bot`（建，看 `code===0`）/ `im pins list --params '{"chat_id":"oc_xxx"}'`（查）/ `im pins delete --params '{"message_id":"om_xxx"}' --yes`（移除，**`--yes` 是命令旗标、不能塞 params**，我踩过一次）。bot / user 身份都行，需 scope `im:message.pins:write_only`（SeeDAO 应用已具备），**bot 必须在群里**否则失败。封装成 `lark.pinMessage/unpinMessage(messageId,{as,profile})`（best-effort 返回 boolean，绝不抛）。
- **配置驱动、不写死群 id**：`configs/chat-policies.json` 每群加 `"autoPinMinReactors": 3` 即启用（缺省/0=不启用）；helper `getAutoPinThreshold(chatId)`（`src/core/configs.ts`）。目前只在**围观群**开。要加群改 config 即可、但**改 config 要重启 serve**（chat-policies 有缓存）。
- **判定**：`syncChatReactions` 里每条消息去重人数 = `Set(operator_id)`（滤 `operator_type!=='user'`、bot 自己、指示表情 `Status_PrivateMessage`/`OnIt`——和 §11 同一套排除）；`humanReactors.size >= 阈值` **且** `create_time >= logicalDayStart(now)`（**仅当天**，`src/core/time.ts`）**且** 没置顶过 → `pinMessage(as:'bot')` + `store.recordPinnedMessage`。
- **幂等**：新表 **`pinned_messages`（migration v22）**，PK `message_id`、`recordPinnedMessage` 用 `INSERT OR IGNORE`、返回是否新插入；`isMessagePinned` 先查、置顶过就跳，**永不重复调 API**。
- **扫描范围合并**：原本 `syncChatReactions` 只扫非工作群（为 §11 点赞）；现改成【非工作群(点赞) **或** 配了 autoPin 的群】都扫，一次抓取同时喂两个用途。工作群若将来也想置顶，给它配 `autoPinMinReactors` 即可（会只做置顶、不做点赞采集）。
- **首轮不 gate 置顶**：§11 的首轮基线 guard 只压【点赞里程碑】不发；**置顶在循环内、每轮都跑**，所以首次启动就会把当天已够 3 人的热门消息置顶（安静幂等、不像点赞事件会群发刷屏，可接受）。
- **每群上限 5 条、超了取消最旧（2026-07-03）**：常量 `PIN_CAP=5`（feishu-user.ts）。每成功置顶一条后，`store.pinnedMessagesOldestBeyond(chatId, 5)` 取【我们自己置顶】里超过 5 条的最旧几条（按 `pinned_at DESC, rowid DESC` OFFSET 5、只算 `pinned_messages` 里的行 → **绝不动人工置顶**），逐条 `unpinMessage` + `removePinnedMessage`。**取消后无论 unpin 成功与否都移除追踪**——unpin 失败几乎都是【消息已删/被手动取消】即本就不在置顶里，留着会把上限逻辑卡死；代价是极偶发的临时网络失败会多留一条可见置顶，可接受。实测：运营小天地连置 6 条→自动取消最旧→恰好剩 5（已全部清理）。
- **注意**：只按【条数】上限，没做【时间过期】取消（如隔天取消）；要的话在轮询里对 `pinned_messages` 按 `pinned_at` 加个 TTL 扫描即可。研究/实现：`src/core/{db,lark,configs}.ts`、`src/core/store/reactions.ts`（`recordPinnedMessage`/`isMessagePinned`/`pinnedMessagesOldestBeyond`/`removePinnedMessage`）、`src/channels/feishu-user.ts`；测试 `src/core/store.test.ts`（`pinned messages: record once...` + `...cap eviction...`）。

## 13. 首次尝新功能 `first-try-notify`（2026-07-07）

社区里有成员**首次使用新上线的功能**时，恭喜他并号召大家来玩，目标 = 围观群，奖励 **LP+10** 给发现者本人。**手动触发**、跟 `cityhall-proposal-voted-notify` 同型（静态 `scope:'global'`、`overlays:[]`、`imageHeight:128`、`gapLines:1`，无 `schedule`）。

- **为什么手动**：`function_name`（新功能名）是**只有 operator 知道的自由文本**，无法从任何 DB 信号/表情累计自动推导；`member_name`（发现者）也由 operator 给。所以走手动 + 自定义 vars。⚠️ 创建单里【事件来源】写的【表情累计达 6 的倍数】是照 like-maniac 模板填的，与【触发方式=手动】矛盾——按【触发方式】字段实现为手动（`function_name` 决定了只能手动）。
- **实发姿势**：`agent event` CLI 传不了自定义 vars（预览里 `member_name`/`function_name` 会空）。真发用 §9 的临时 `fireEvent` 脚本：`fireEvent('first-try-notify', { actorOpenId: 'ou_发现者', vars: { member_name, function_name } })`。`actorOpenId` 用来发 LP+10（`prepare().afterSend` 里 `store.grantPt(actor, 10, 'event:first-try-notify')`，发送成功才发奖）。
- **文案**：标题 `{{member_name}} 发现了新功能 {{function_name}}`（遵 §3 标题纯文字：**去掉创建单里的引号**、不加粗体）；正文 `member_name` 作**粗体文字**（不是可点 @，@ 嵌不进 md 粗体，跟 like-maniac 同理），`function_name` 保留单引号（正文允许）。底图 `assets/events/first-try-notify-bg.png`（图床 `i.meee.com.tw/z9HEPWx.png` 落地，1254²，不叠字）。无 `@`、无 mentions。
- **实现**：只在 `src/core/events.ts` 加一个 `registerEvent`（紧接 like-maniac 之后），复用现有框架，无新表/无轮询/无 supervisor 改动 → `agent update` 热重载即可，不必重启 serve。事件编号 `[11]`。
- **实测手动触发（2026-07-07）**：给围观群里【用户560770】发了一次（`function_name=每日签到`、`actor=ou_42de8fa5…`、`message_id=om_x100b6bfd9edd5ca0c2334f86e07ea53`、LP+10 入账余额 132.9）。沉淀出【手动带自定义 vars 触发任一事件】的通用姿势：
  - **反查 open_id（名字→ou_）**：`store.findOpenIdsByName(name)`（`src/core/store/gamification.ts`，从 `chat_members` 名册 `present=1`、`last_seen` 倒序、去重、exact→trim 回退）；临时脚本 / 直查 `SELECT open_id FROM chat_members WHERE name=?`，库在 `.agent/<soul>.db`（tudigong 用 `.agent/tudigong.db`；repo 根 `tudigong.db` 是 0 字节残留别查）。
  - **真发脚本**：`AGENT_SOUL=tudigong node --env-file=.env` 跑临时 `import { fireEvent } from './dist/core/events.js'` + `fireEvent('first-try-notify', { triggerReason:'manual', actorOpenId:'ou_…', vars:{ member_name, function_name } })`。**必须带 `AGENT_SOUL` 否则 db 解析成默认 soul**；`.env` 才有密钥。`pnpm agent event <id>` CLI **传不了 vars**（预览里占位符会空），只能用脚本——同 §9、§10。
  - **发奖副作用**：`prepare().afterSend` 里 `store.grantPt(actorOpenId, 10, 'event:first-try-notify')`，**只在发送成功后跑**（发失败不发奖）。
  - ⚠️ **LP / profile / 账本在共享库 `.agent/shared.db`，不是 soul.db**：验账 `sqlite3 .agent/shared.db "SELECT delta,reason FROM pt_ledger WHERE user_open_id=? ORDER BY rowid DESC"`。**账本表 `pt_ledger`、余额列 `pt_balance`、发放函数 `grantPt`**——旧名 `ap_ledger`/`ap_balance`/`grantAp` 已由 `db.ts` 迁移改名（`ALTER TABLE ap_ledger RENAME TO pt_ledger`），别再用（详见 `local-db-playbook §5`、`pt-gamification-playbook` 抬头更正）。
  - ⚠️ **`pnpm agent unsend <message_id>` 撤回只删群消息、不退已发的 LP**（撤回 ≠ 回滚副作用；真要退得手动补一笔负 delta 到 `pt_ledger`）。

## 14. 访客里程碑防重发 + 记录第 100·N 位访客（2026-07-08）

**事故**：`visitor-num-notify`（§6）重启后又把「400 人达到」发了一次（400 早已达标）。**根因**：去重是**内存里的上一轮计数**在做（`feishu-user.ts` 的 `prevVisitorWatchCount`、`watchPrev` 轮对轮比较），**重启即归零**——`notADip` guard 被绕过，DB 在群数一旦相对上轮跨过百位就重发。里程碑达标是「永远只发一次」的事，靠内存状态不可靠。

**修法（持久化台账当闸门，重启不失效）**：
- 新表 **`visitor_milestones`**（migration **v26**：`chat_id+milestone` 主键、`open_id`/`name`/`reached_at`）+ **JSON 台账** `workspaces/<soul>/visitors/<chatId>.json`（人可读，用户要的文件）。两者任一有记录 = 已发过。模块 `src/core/visitor-milestones.ts`（`isMilestoneRecorded`/`recordMilestone`/`refreshVisitorMilestonesWiki`）。
- `feishu-user.ts` 里程碑块**改成台账闸门**：`milestone = floor(present/100)*100`；`milestone>=100 && !isMilestoneRecorded(...)` 才 record + 刷 wiki + `fireEvent`，否则跳过。删掉了 `prevVisitorWatchCount`/`crossed`/`notADip` 那套内存去重。
- **「第 100·N 位访客」= 在群成员按 first_seen 升序的第 N 位**（`store.nthPresentMemberByArrival`）。**必须对齐 `visitor-num-notify` 数的是 present（在群）人数**——用「所有曾出现（含已离开）」排序会差开（实测 #400 差成 严玲，正解是 hsiu）。达成时间用该人的 `first_seen`。
- **回填**：`pnpm agent visitors backfill [--chat oc_id]`（幂等、只 record 不 fire）。已回填围观群 100=李磊 / 200=李绍杰 / 300=懿轩 / 400=hsiu。
- **wiki**：每次达标（及回填）**机械式覆写**知识库【访客里程碑】页（`configs/lark.json` 的 `visitorMilestoneWikiDocId`=`KTqsdp3bGo0sK1xHMGcc7b77nof`，node=`MDx4w9siFiAbvfk7mI4cvHGQntQ`），表格：里程碑 / 第 N 位访客 / 达成日期。
- **通用教训重申**：「只做一次」的动作要用**持久化幂等台账**当闸门，别靠进程内存状态（重启就破）。同「别赖 LLM 调工具」一类的框架确定性原则。
- 改了核心档（feishu-user/events 采集侧）+ 新增 v26 迁移，**要完整重启 serve 才生效**；旧 serve 在重启前仍是旧逻辑（在群数稳定时不会跨百位、暂不会重发）。

## 15. 迎新自介邀请 + `收录自介` 发 60 LP（2026-07-13）

**需求**：以前迎新靠心跳 LLM 现写，很「干、没意义」（例：「管这么大的地不累吗？…还好我是本地部署🏯 欢迎 @X 加入…」）。改为**框架确定性固定文案**邀请新人自我介绍，并提到自介完成得 60 LP。60 LP **不自动发**——由运营用 `收录自介` 手动机械发放。

**新模块 `src/core/self-intro.ts`**（迎新文案 + 收录逻辑集中一处）：
- `SELF_INTRO_REWARD_PT=60`、`SELF_INTRO_GRANT_REASON='welcome:self-intro'`（也是幂等键）。文案 `SELF_INTRO_BODY_LINES` 为**逐字固定**：「欢迎你自我介绍一下自己… 怎么来到 SeeDAO：/ 对参与 SeeDAO 的期待：/ 可以给予 SeeDAO 的支持：」+ 「只要自我介绍完成，就能获得 60 LP 奖励（社区积分点数，可用于社区各项活动中）。」**改文案只动这里**。
- `buildNewcomerWelcomePost(joiners)`→ `sendPost` 用的 `{title,content:PostElement[][]}`：首段 `{tag:'at'}` @ 每位新人（**上限 12**，超出用「等 N 位新朋友」概括），随后固定文案。无有效 open_id 返回 null。
- `isRecordSelfIntroCommand(text)`：剥前导 @mention/`[/!]` 前缀后 `^收录自介(\s|$)`（整词，"收录自介绍"/"帮我收录自介" 不算）。
- `handleRecordSelfIntro({commandMessageId,eventRootId,eventParentId,senderOpenId,profile})`：**仅 `isAdmin` 白名单**（configs/admins.json）可发。`resolveSelfIntroTarget` 取 `eventRootId||eventParentId`（rootId＝回复链**第一条**＝自介开场白，「一路回溯到最初那条讯息」的语义就靠它），信封没带才退回 `getMessageById(commandMessageId)` 兜底 → 再 `getMessageById(targetId)` 取自介作者。`store.hasPtGrantForRef(reason,targetId)` 幂等（**按自介消息 id、每条只发一次**）；`grantPt(author,60,reason,targetId)`。成功回复＝`已收录 X 的自我介绍，发放 60 LP 🎉` + **`buildStatusFooter(author,60)`**（发奖后算，出 `\n\n[乔伊] 🌱 LP : 119.9 → 179.9 (+60.0)` 标准状态行，别自己拼「当前 LP」）。无权限/追溯不到/追到的是 app 机器人消息/已收录 都返回对应提示、不抛。

  > **⚠️ 2026-07-17 订正一条错记忆（本文旧版把错的写成了规格，害了两次）**
  > 旧版写「事件信封**没有 parent_id/root_id**，所以必须 fetch 命令消息自己」。**前半句只对了一半，后半句是错的**。实测 213 个信封：
  > - `parent_id` **一个都没有**（这个观察是对的）；
  > - 但 `reply_to`、`root_id`、`thread_id` **都在**（37/213 带 reply_to+root_id，正好等于回复类消息数）。
  >
  > **真相是两种形状字段名不同**，不是信封没东西：
  > | 来源 | 直接父消息 | 链根 |
  > |---|---|---|
  > | OpenAPI `GET /im/v1/messages/<id>`、list API | **`parent_id`** | `root_id` |
  > | 事件流 `event consume` 信封 | **`reply_to`** | `root_id` |
  >
  > 2026-07-13 那次真正的 bug 是**把 OpenAPI 的字段名套到了事件信封上**（读 `ev.parent_id` → 恒空）。当时结论下成「信封没东西」，于是加了一次本来不需要的 `getMessageById` 往返，还把这句话写进 playbook 和记忆。后果：2026-07-17 群里回复场景踩了同一个根因（`feishu-bot.ts` 同样读 `ev.parent_id`，回复指向的原文全丢，土地神拿「你怎么看这个发言」去点评了另一条自介）；排查时**两个 subagent 都被这句注释骗**，双双建议「加 getMessageById 回捞」——去调 API 拿一个信封里本来就有的字段。
  >
  > 现在统一走 `replyLinkageFromEvent(ev)`（`src/core/lark.ts`），字段名由 `src/core/lark.test.ts` 用**真实信封**钉死（含一条「只有 reply_to、没有 root_id 可兜底」的测试，专防 root_id 兜底把错字段名掩盖过去）。

**迎新触发＝攒一波、定时统一 @（2026-07-13 改：不再每 5 分钟即时发）**：每 5 分钟太密、时间又长，改成**累积到固定时段统一欢迎**：
- **入队（`feishu-user.ts` 成员同步轮）**：只在**围观群** `VISITOR_WATCH_CHAT_ID` + `watchPrev>0`（跳过某群首次同步把全体旗标为 joined 的 bulk）+ `r.joinedMembers.length>0` 时 `store.enqueuePendingWelcome(chatId, joinedMembers)`（**不再即时 `sendPost`**）。`joinedMembers` 每人只在首次出现时出现、入队 `INSERT OR IGNORE`（PK `chat_id+open_id`）→ 不会重复；离开又回来（行仍在）不算 joined。新表 **`pending_welcome`（migration v33、per-soul db）**、store `enqueue/list/clearPendingWelcome`（members.ts）。
- **播报（`supervisor.ts scheduleWelcomeDigest`，每天 08:30 / 14:30 / 20:30）**：`nextWelcomeDigestTime` 取三时段中最近的一次、fire 后 re-anchor；`runWelcomeDigest` 读队列 → **只留仍在群的**（`chatMemberOpenIds([chatId])` 过滤，期间进又退的丢掉）→ `buildNewcomerWelcomePost(joiners, 50)` 一条消息 @ 全部（cap 50 只防病态 @ 风暴）→ `sendPost` as bot → `clearPendingWelcome` 清空整队。空队列静默。**需 `--sup`**（同 meetup/ops 播报，`--bot --sup` 标准模式：--sup 的采集器跑成员同步入队、supervisor 跑播报）。确定性发送**不过 outbound-guard**（guard 只在 `mcp-server.ts` LLM 发送路径）。
- 改时段动 `WELCOME_DIGEST_TIMES`；改单批 @ 上限动 `WELCOME_DIGEST_MAX_MENTIONS`；`buildNewcomerWelcomePost(joiners, maxMentions=12)` 第二参可调 cap。

**`收录自介` 触发（群，`feishu-bot.ts`）**：在 LLM 前、TC-bet 拦截之后加确定性 pre-intercept：`isRecordSelfIntroCommand(text)` → `handleRecordSelfIntro({commandMessageId: messageId, eventRootId, eventParentId, …})`（后两者来自 `replyLinkageFromEvent(ev)`）→ `send` 回复。bot 只收到被 @ 的消息，运营在**自介所在话题里**（回复 / 引用自介，或话题下）@ 土地神写「收录自介」即可——**不需精确引用**，信封自带的 `root_id` 直接回溯到自介开场白，**不用再 fetch 命令消息**（见上方订正框）。

**关掉旧 LLM 干欢迎**：`HEARTBEAT.md` 城邦巡查行删「新加入成员尚未被招呼」并注明「迎新已由框架自动处理，心跳不要再手动欢迎」；「框架自动跑的」加迎新一行；`heartbeat.ts` 提示词示例把「招呼新成员」换成「引导长期潜水成员…迎新已由框架自动处理」。

**已删 P2P `welcome-party` DM（2026-07-13，用户要求）**：原「首次 @ 机器人 → 私信迎新图文」入口整个移除——`events.ts` 删 `registerEvent('welcome-party')` 块 + 清空 `TRIGGERS`（原唯一规则 `first_interaction_welcome`，`souls:['tudigong']`、闸门 `hasSuccessfulDispatch('welcome-party',openId)`）。触发框架 `checkAndFireTriggers`/`TRIGGERS: TriggerRule[]=[]` 保留为扩展点（feishu-bot.ts 仍调、空数组 no-op）。孤儿资源 `assets/events/welcome-party/base.png` 留在磁盘（无引用、无害，要清可删）。迎新现在**只有**围观群确定性群发一条路径。

**改了核心档（feishu-user/feishu-bot/lark/gamification/events/db/store.members/supervisor/self-intro）要 `npx tsc -p tsconfig.build.json`（本机 rtk 改写 `npm run build`→Missing script，用 npx tsc）重建 dist + 完整重启 serve 才生效**（supervisor 排程不热重载，改时段/新增 v33 迁移必**完整重启** serve）。测试 `src/core/self-intro.test.ts`（含 `pending_welcome` 队列）。

---

## 16. 群里「回复某条消息 + @ 土地神」的上下文（2026-07-17 事故修复）

**症状**：白鱼**回复**阿坚 3.5 小时前的长发言、@ 土地神问「你怎么看这个发言」，土地神跑去点评了**另一条无关的自我介绍**（李沁/Gloria），阿坚吐槽「看来土地神并没有 get 到是哪条消息」。

**根因不是 LLM 幻觉，是框架确定性喂错料**，三层叠加：
1. `feishu-bot.ts` 读 `ev.parent_id`（OpenAPI 字段名，信封里**根本不存在**）→ 回复线索在入口被丢光。信封其实有 `reply_to`/`root_id`（详见 §15 订正框）。
2. `threadId` 为空（普通回复**不是**话题，这里代码没错）→ 落到 `getRecentChatMessages(chatId,{limit:8})`，纯按时间取 8 条，**对回复关系完全无感**。阿坚那条排第 ~30 位，窗口够不到。
3. 8 格里还有 3 格是噪声（2 条 `system` 入群通知 + 1 条土地神自己的欢迎 post），而李沁的自介连发两遍占了 2 格 → 上下文里唯一像样的「发言」就是自介。**换成任何人都会答成自介。**

**修法（`src/core/reply-context.ts`，纯函数、可测）**：
- `replyLinkageFromEvent(ev)` 拿 `reply_to || root_id`（`lark.ts`）。**优先 reply_to 不是 root_id**：深回复链里用户指的是他回复的那条，不是链子的开头。
- `buildReplyContext(rows, replyTarget, replier, resolveName)`：把被回复的原文**钉在窗口之上**，标成`【X 正在回复 Y 的这条消息，问题就是针对它】`。**必须独立于 8 条窗口固定注入**——这就是死因，靠扩大窗口治不好。
- 引用块**独立字符预算**（`MAX_QUOTE_CHARS=1200`，超长截断），与窗口的 `MAX_CONTEXT_CHARS=2000` 分开：长引用既不会挤掉窗口、也不会被窗口挤掉。
- 原文**从 DB 取**（`store.getMessageRow`），不调 API：群消息是 user 轮询全量采集的，被回复的原文基本都在库里；取不到就静默降级成只有窗口。
- `renderContext` 补 `CONTEXT_SKIP_MSG_TYPES={'system'}`（入群通知不是对话）+ 连发去重。**别照抄 `feishu-user.ts` 的 `CONTEXT_MSG_TYPES`**：那个集合不含 `post`，而自介/长文都是 post，照抄会误杀真内容。
- ⚠️ **去重要按「同作者 + 前 60 字」，不能逐字比对**：实际连发的两条自介是 627 / 632 字（中间编辑过），**不是**字节相同，逐字比对完全无效。初版就写成了逐字，且单测用两条**完全相同**的字符串把自己测绿了——测试自我实现。用真实长度（600+ 字）当测试数据才暴露出来，配一条「同作者不同发言不能被误杀」的反向用例。
- 非话题窗口加 `sinceMs` 时间截止（`RECENT_CONTEXT_MAX_AGE_MS=24h`，锚在**触发消息自己的时间戳**、不用 `Date.now()`，否则测试会腐坏）。实测 11 个群里 4 个的最近 8 条横跨 >72h（最长 17.8 天），却被贴上「最近的对话上下文」。话题（`getThreadContext`）**不加**时间窗——一个话题就是一场对话，隔多久都算。

**DB**：migration **v38** 给 `messages` 加 `reply_to_id`/`root_id` 两列 + partial index，并从 `raw` 回填历史（`json_extract`）。两条采集路径都要写：`feishu-bot.ts`（事件流，字段 `reply_to`）+ `feishu-user.ts`（轮询，`listMessages` 解析 OpenAPI 的 `parent_id`）。

**⚠️ 两条采集路径（排查时被 subagent 带偏过，实测钉死）**：
- **事件流**（有 `raw`，213 条）：bot **只收到 @ 它的消息**，带 `thread_id`/`reply_to`/`root_id`。
- **user 轮询**（无 `raw`，4174 条）：**全量**采集群消息，带 `message_position`/`sender_name`，`thread_id` 几乎全丢（2/4174）。
- `configs/agents.json` 里 `tudigong-user` 是 `enabled:false`，**但它照跑不误**——`agent.ts:141-147` 明写「启动模式 `--bot/--user/--both` 才是权威，与 per-agent `enabled` 无关」，且 `--sup` 会（`AGENT_COLLECTOR_SOUL`）把该 soul 的 user 频道强拉起来当 collect-only 采集器。**别拿 `enabled:false` 推断「这条路没在跑」。**

**测试**：`src/core/reply-context.test.ts`（用真实事故时间线复刻：窗口够不到原文 → 引用块仍在）+ `src/core/lark.test.ts`（用**真实信封**钉字段名）。⚠️ 写这类测试要做**突变验证**：头条那条「读真实信封」测试其实挡不住字段名改回 `parent_id`——因为真实信封里 `reply_to === root_id`，root_id 兜底把错字段名掩盖了。必须补一条「只有 `reply_to`、没有 `root_id` 可兜底」的用例才真正挡得住。

---

## 17. 事件流 silent stall 导致漏收 @ 消息 + 话题感知补扫（2026-07-17 第二次事故）

**症状**：用户637073 在旧话题里 @ 土地神 `follow SeeAlpha`（22:27），土地神**毫无反应**。日志显示 19:37 那个 serve 实例在 **21:51→22:39 整整 47 分钟一行日志都没有**，那条消息落在静默窗内、连「收到」都没打——**投递层就没收到**，不是收到不处理。22:39 重启换新 consumer 后事件流自愈（P2P 受控测试 6 秒被收到）。

**根因（逐行核实 `src/core/lark.ts:consumeEvents`）**：
1. **事件流会 silent stall 且无检测**。`event consume` 连的是共享常驻 **event bus daemon**（`lark-cli event status` 看，pid 长期不换、跑了 7.5 天）。半开连接时子进程**不退不报错**→只有 `on('exit')` 的重连逻辑永不触发→静默哑掉。原代码**没有 stall watchdog、没有 `child.on('error')`**。
2. **lark-cli 不吐 keepalive**（45s 实测：只在首连打 `[event] ready event_key=<key>` 然后一片空白）→「距上次收到任何行多久」**无法**区分 stall 和安静时段，watchdog 会误杀。
3. **话题内 @ 只有事件流一条命**：轮询用 `im +chat-messages-list`（container=chat）**看不到 thread reply**（实测库里所有话题回覆都是 event 来源、`message_position`=None/thread_id 常 NULL）。事件流一漏，轮询兜不住。
4. 重启也救不回：`event consume` 无 offset 补发，且启动旧消息闸门（`STARTUP_GRACE_MS=5000`）把重启前的消息当「启动前旧消息」丢掉。
5. supervisor 只监控 worker **进程存活**（`process.kill(pid,0)`），看不到进程**内**事件流哑没哑。

**修复 G1（`lark.ts` consumeEvents）——把 stall 上界压死**：
- 给 spawn 加 **`--timeout`**（`RECYCLE_MS`=20min，env `LARK_EVENT_RECYCLE_MS` 可调、floor 10s）：子进程每 20min 干净退出（code 0 reason:timeout）→ 既有 exit 重连 → 全新连接 + 重建订阅。**任意半开 stall ≤20min**，不依赖 keepalive。
- 补 `child.on('error')`（防未处理 error 崩 worker）；`stop()` 用 **SIGTERM 不用 SIGKILL**（横幅明警：kill -9 漏 OAPI 退订、泄漏服务端订阅→重启报 "subscription already exists"/重复投递）。
- 新增 `onReady`（扫 stderr `ready event_key=` 标记，每次首连+重连触发）= G2 挂载点。
- **G1 本身就能避免本次事故**：47min stall 会在 20min（22:11）被回收成新连接，22:27 时连接已健康 → 正常投递。

**修复 G2（`feishu-bot.ts` runBackfill，挂 onReady）——漏收补扫 catch-all**：
- ① **顶层漏收**：`store.unhandledPolledMessagesSince`（`raw IS NULL`=poll 采到但事件漏、未 handled、@ 机器人）→ **纯 DB 零 API**。
- ② **话题漏收**：`store.recentThreadScanKeysSince`（thread_id ∪ root_id、7 天发现窗）→ **`listThreadMessages`**（新增，`im +threads-messages-list`，仓库首次用；事件流/CLI 的 content 都是**已解析纯文本**，与事件同构，synth envelope 直接喂 handleEvent）。
- 去重：持久表 **`handled_messages`（migration v39）**；handleEvent **过启动闸门后** `markMessageHandled`（过闸门前 skip 的旧消息不标记，留给 backfill）；backfill 传 `{backfill}` **豁免闸门**。
- ⚠️**防刷屏 epoch 守卫**：`backfillEpochMs`=v39 `applied_at`。首次上线 `handled_messages` 空，若无守卫会把近 30min 已回过的 @ **全部重回**（实测线上有 18 条会被误重回）。`sinceMs=max(now-30min, epoch)`→首次上线≈now→**0 候选=no-op**。上限 `BACKFILL_MAX=30` + outbound-guard 兜底。
- ⚠️**已知边界（诚实记录）**：**休眠话题**（DB 里无任何 thread_id/root_id 关联）G2 发现不了——事件信封对话题回覆的关联字段**不一致**（白鱼那条显式「回复」带 root_id，07-11 那批直接发在话题里连 root_id 都无）。本次事故 thread 正是如此，靠 **G1 兜底**。backfill 的 API 路径可靠落库 root_id → 话题**逐渐自我可发现**。

**测试**：`src/core/backfill-queries.test.ts`（raw-NULL 过滤、handled 排除、thread key 合并、epoch）+ G1 用 `LARK_EVENT_RECYCLE_MS=15s` 实测回收→重连→onReady 三次。

**⚠️ 手动补回漏收消息的套路**（本次已做）：`im +threads-messages-list --thread <omt_/om_> --order desc` 拿漏收消息的 `message_id`/`sender open_id`（外部群 user 身份发消息报 **230027**，改发 **P2P 私信** bot 测活性）→ 订阅类走 `store.subscribeMeetupTag`（在 **`.agent/tudigong.db` soul 库**不是 shared.db，migration v24）→ `im +messages-reply --message-id <id> --reply-in-thread --as bot` 补话题内回覆（文案抄别人的：`XXX，已为你订阅标签【SeeAlpha】…`）→ 记 journal。**bot 的 open_id** 从事故信封 `mentions[].id`（name=城邦土地神）拿：`ou_f670987e73829c00db5c49d81deb9479`；`cfg.selfOpenId` 是代码里的来源。
