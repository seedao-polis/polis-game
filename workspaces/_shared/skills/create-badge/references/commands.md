# agent badge 命令速查

所有命令在仓库根目录运行（需先 build；运行形式与项目一致，如 `pnpm agent badge ...`）。

<commands>
```
agent badge import <json_file> [--profile <p>]
agent badge award <badge-ref> <target> [target2 ...] [--profile <p>] [--note <text>] [--dry-run]
agent badge list [target]
```
</commands>

<import>
## import

`agent badge import <json_file> [--profile <p>]`

- `<json_file>`：JSON 文件路径，单对象或数组（字段见 badge-fields.md）。
- 按 `badge_id` upsert 写入当前 soul 的 `badges` 表；幂等。
- 只写【定义】，不发给任何人、不触发任何通知。
</import>

<award>
## award

`agent badge award <badge-ref> <target> [target2 ...] [--profile <p>] [--note <text>] [--dry-run]`

- `<badge-ref>`：`badge_id` 或 `badge_name`（= 入库时的 `name`，默认等于 headline）。找不到会报错并提示用 `agent badge list`。
- `<target...>`：可给**多个**，空格分隔。
  - `ou_xxxxxx`：直接按 open_id 指定。
  - 飞书显示名称：在已同步的 `chat_members` 里查；**查不到会中止整批**，**同名多人**会列出候选要求改用 `ou_`。
  - 重复目标自动去重。
- `--note <text>`：可选备注，存进 `user_badges.ref`。
- `--dry-run`：只预览得主与将触发的事件，**不写库、不发通知**。发放前建议先跑一次。
- 写库用 `INSERT OR IGNORE`：已持有该徽章的人不会重复发，也不会为他触发通知（只对【本次新得主】触发）。
</award>

<list>
## list

`agent badge list [target]`

- 无参数：列出当前 soul 全部徽章定义。
- 带 `target`（名称或 `ou_xxx`）：列出该成员持有的徽章。
</list>

<events>
## 发放时触发的事件

只对【本次新获得】的得主触发。每次 award 会发两类事件：

1. **逐人私信** `badge-awarded`（scope=personal）：每位新得主收一条 P2P 恭喜私信（128px 底图）。
2. **一条群公告**，事件 ID 按下面优先级决定：
   - 徽章的 `event` 字段非空 → 取其 `/` 前第一段作为事件 ID（覆盖默认）；
   - 否则新得主 **2 人及以上** → `badge-awarded-group` → 发到 **SeeDAO 城邦快报**（`oc_example_broadcast_group`），正文 @ 全部新得主；
   - 否则**单人** → `badge-awarded-default` → 发到 **SeeDAO 运营小天地**（`oc_example_ops_group`）。
   - 指定的自订事件若未在 `src/core/events.ts` 注册，则跳过、只打印警告。

事件定义在 `src/core/events.ts`；命令实现在 `src/bin/agent.ts` 的 `cmd_badge`。
</events>

<profile_and_db>
## --profile 与数据库落点

- 数据库总是当前 soul 的 `.agent/<soul>.db`，由环境变量 `AGENT_SOUL` 决定（默认 `tudigong`）。
- `--profile` 只切换**发通知用的飞书身份**，不改数据库落点。
- 所以：在哪个 soul 下 import 的徽章，只能在同一个 soul 下 award。
</profile_and_db>
