# EventTypeConfig 字段

`registerEvent({...})` 接受一个 `EventTypeConfig`。字段如下。

<fields>
| 字段 | 必填 | 含义与规则 |
|------|------|-----------|
| `eventTypeId` | 是 | 唯一事件 id，kebab-case（如 `lurker-discovered`）。`agent event <id>` 用它定位。 |
| `title` | 是 | 飞书 post 标题，可含占位符（如 `🐟 {{lurker_name}} 在社区潜水被发现了`，由 `prepare` 的 `vars` 填）。 |
| `description` | 是 | markdown 正文模板，可含占位符。若正文在触发时才能算出（条件句），这里留空字符串、改在 `prepare` 返回 `description`。 |
| `scope` | 是 | `'global'` = 发到群；`'personal'` = P2P 私聊。 |
| `targetChatId` | global 时填 | global 事件的默认目标群 `oc_...`；personal 时忽略。 |
| `baseImage` | 是 | 底图路径，绝对或相对仓库根。约定放 `workspaces/<soul>/assets/events/<id>/base.png`。 |
| `overlays` | 是 | 文字叠加块数组（百分比定位）；不叠字就给 `[]`。 |
| `mentions` | 选填 | 可在正文用 `{{@key}}` 引用的 @，形如 `{ contact: { id: 'ou_...', name: 'X' } }`。 |
| `gapLines` | 选填 | 各段间（标题↔图、图↔正文）插入的空行数，默认 2。 |
| `imageHeight` | 选填 | 发送图的像素高度（等比缩放），默认 `EVENT_IMAGE_HEIGHT`（128）。 |
| `prepare` | 选填 | 触发时的动态解析钩子，见 `event-model.md`。 |
| `schedule` | 选填 | 让事件可被自动定时触发，见 `schedule.md`。 |
</fields>

<placeholders>
## 占位符清单

正文 `description`、标题 `title`、文字叠加 `overlays[].text` 都支持 `{{key}}` 替换。

**时间类**（内建自动填）：
| 占位符 | 例 |
|--------|----|
| `{{date}}` | `2026-06-17` |
| `{{date_cn}}` | `2026年06月17日` |
| `{{time}}` | `14:30` |
| `{{weekday_cn}}` | `周三` |

**游戏信息类**（针对某对象时，由 `actorOpenId` 驱动）：
| 占位符 | 含义 |
|--------|------|
| `{{name}}` | 对象显示名 |
| `{{pt}}` | 对象的 LP（生命点） |
| `{{level}}` | 对象等级 |
| `{{badges}}` | 对象徽章 |

**@ 提及**：正文写 `{{@key}}`，`key` 来自 `mentions`（静态）或 `prepare` 返回的 `mentions`（动态）。被 @ 的人不在目标会话时自动降级成【@名字】纯文本。

**自定义**：`prepare` 返回的 `vars` 或 `opts.vars` 里任意 `key`，最后合并（覆盖内建）。
</placeholders>

<scope-examples>
## scope 两种形态

**global（发到群）** —— 必须 bot 已在该群，否则报 230002：
```ts
registerEvent({
  eventTypeId: 'morning-greeting',
  title: '早安',
  description: '**{{date}}（{{weekday_cn}}）早安！**\n\n新的一天，冲鸭 🚀',
  scope: 'global',
  targetChatId: 'oc_xxxxxxxx',
  baseImage: 'workspaces/<soul>/assets/events/morning/base.png',
  overlays: [],
});
```

**personal（P2P）** —— bot 天然在私聊里，无 230002 问题；目标默认 = `actorOpenId` 本人：
```ts
registerEvent({
  eventTypeId: 'welcome',
  title: '🌱 {{name}}，欢迎加入！',
  description: '欢迎！有问题联系 {{@contact}}。',
  scope: 'personal',
  baseImage: 'workspaces/<soul>/assets/events/welcome/base.png',
  overlays: [],
  mentions: { contact: { id: 'ou_xxxxxxxx', name: '联系人' } },
  gapLines: 2,
});
```
</scope-examples>

<dynamic-example>
## 带 prepare 的动态事件（骨架）

```ts
registerEvent({
  eventTypeId: 'lurker-discovered',
  title: '🐟 {{lurker_name}} 在社区潜水被发现了', // {{lurker_name}} 由 prepare 填
  description: '',                                  // 正文在 prepare 里算
  scope: 'global',
  targetChatId: SOURCE_AND_TARGET_CHAT_ID,
  baseImage: 'workspaces/<soul>/assets/events/lurker-discovered/base.png',
  overlays: [],
  gapLines: 1,
  schedule: { kind: 'weekly', weekday: 1, windowStart: '19:00', windowEnd: '20:00', probability: 0.25, note: '每周一·19:00-20:00随机·25%触发' },
  prepare: (opts) => {
    const cutoffMs = Date.now() - SILENT_DAYS * 86400 * 1000; // 毫秒！
    const report = store.silentMemberReport(cutoffMs, {
      sourceChatIds: [SOURCE_CHAT_ID],
      excludeOpenIds: [SELF_BOT_OPEN_ID],   // 只排除 bot
    });
    const pool = report.silent;
    if (pool.length === 0 && !opts.force) return null; // 排程时无人则跳过
    const pick = /* 随机或最久未发言的一个 */ pool[0];
    return {
      vars: { lurker_name: pick.name },               // 填标题占位符
      mentions: { lurker: { id: pick.openId, name: pick.name } },
      description: `欢迎大家认识 {{@lurker}}！`,
      afterSend: async () => { /* 条件满足才发 LP */ },
    };
  },
});
```
</dynamic-example>
