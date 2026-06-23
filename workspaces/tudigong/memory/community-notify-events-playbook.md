# 社区推播事件 playbook（2026-06-19/20）

这次新建的一批【推播到群】的事件，以及做它们时定下/踩到的通用约定。事件框架本身见 `event-system-playbook.md`，新建事件填 `event-creation-prompt-template.md`。

## 1. 群 ID 速查（别记错）

- **运营小天地**（外部群、status=normal、bot 在内）：`oc_example_ops_group`。⚠️ 有个**同名内部群** `oc_example_ops_group_old` 已 **dissolved**，别用（旧事件 lurker 还指着它）。
- **城邦快报**：`oc_example_broadcast_group`（外部）。
- **SeeDAO 2.0 社区围观群**：`oc_example_public_group`。
- 常用 open_id：管理员 `ou_example_admin`；操作者（内部那个）`ou_example_operator`；海外号 `ou_example_member`。

## 2. 这次建的事件（都 `scope:'global'`、`overlays:[]`、`imageHeight:128`）

| eventTypeId | 触发 | 目标群 | 备注 |
|---|---|---|---|
| `badge-awarded` | 每位新得主 | personal P2P | 发放私信恭喜 |
| `badge-awarded-default` | 单人发放、徽章无自定事件 | 运营小天地 | 单人群公告 |
| `badge-awarded-group` | 多人(2+)发放、徽章无自定事件 | 城邦快报 | `prepare()` 动态 @ 全员，靠 `opts.recipients` |
| `class-event-notify` | 课程报名跨里程碑 | 运营小天地 | RSVP 轮询触发，详见 §5 |
| `visitor-num-notify` | 围观群人数每满 100 | 运营小天地 | 成员同步轮询触发，详见 §6 |
| `cityhall-proposal-voted-notify` | 市政厅对提案做出决议 | 运营小天地 | 手动触发（未来接提案系统）；无 @、无奖励，详见 §10 |

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
