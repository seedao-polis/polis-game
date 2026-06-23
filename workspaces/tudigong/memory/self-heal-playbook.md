# 自愈 / 错误处理 / 串行回复手册（城邦土地神工作区记忆）

> 排查"回复失败"、改 `runKimi` / 会话 / 表情、动错误处理前，先读这份。
> 命令、参数、JSON 字段、emoji_type 一律保留原文。2026-06-16 大改造确立。

## 0. 最容易踩的坑（一句话版）

1. **执行器会话会"中毒"**：一轮被打断后，`--continue` 会永久报 `400`，连"1+1=?"都答不出来——必须重置会话才好，自己不会恢复。
2. **隔离损坏会话只能"移出 `sessions/`"，不能就地改名**。`--continue` 是**扫目录**认会话，就地 `corrupt-` 改名后它照样扫得到，然后报 `Session not found`（我真踩过：12:40 改名止血，13:08 又因这个炸了）。
3. **我方 timeout 现在是 10 分钟**（原 180s）。timeout 半途 SIGTERM 杀掉执行器进程是会话中毒的头号原因。

## 1. 会话中毒：是什么 / 怎么发生 / 怎么判定

- 存储真相：`~/.kimi-code/sessions/wd_<名>_<hash>/session_<uuid>/agents/main/wire.jsonl`（逐事件日志）；workDir → 会话的映射在 `~/.kimi-code/session_index.jsonl`。
- 中毒 = 某个 `tool.call`（按 `event.toolCallId`）**没有配对的 `tool.result`**（"孤儿工具调用"）。一轮在工具执行到一半被打断就会留下它：我方 timeout 杀进程、网络断在工具里（`HTTP 000`）、进程崩。
- 之后每次 `--continue` 都重放这段坏历史，推理服务报 `400 ... an assistant message with 'tool_calls' must be followed by tool messages ... did not have response messages: <Tool>:<n>`。**黏住、永不自愈**，直到会话被重置。
- 判定：解析 wire.jsonl，配对 `tool.call` / `tool.result` 的 id 找孤儿（代码 `validateSession`）。

## 2. `--continue` 的认会话机制（关键真相）

- `--continue` 按 **cwd 重新算 `wd_<hash>`，再扫那个目录里的 session 文件夹挑最新的**——不是只看 `session_index.jsonl`。实测：删了索引行，它照样从目录扫到旧文件夹。
- 所以"重置会话" = 把损坏文件夹**移出 `sessions/`**（到 `~/.kimi-code/quarantine/`）+ 删掉索引行。**就地改名无效**，反而让 `--continue` 扫到一个对不上 id 的文件夹 → `Session not found`。
- `Session not found` / `was not found` 本身是**可恢复**的：不带 `--continue` 重开新会话即可（分类为 `session-missing`，会自动重试）。

## 3. 四层自愈（都在框架代码里，自动跑）

- **inline（`Agent.respond` / `respondAsync` → `runWithHeal*`）**：失败 → 分类 → 记日志 + 错误账本 → 该重置就把会话**移出隔离** → 重试（默认 `maxRetries=1`，共 2 次）。无论哪种硬失败，收尾都再验证+隔离一次，保证"下一个人不被毒到"。
- **worker 启动清理 + 重启恢复（`bin/agent.ts runWorker` + `feishu-bot.ts recover()`）**：每次 worker 启动先扫并隔离所有 `.agent/` 下的损坏会话（不依赖 supervisor）；再恢复被重启打断的回复——见第 8 节。
- **背景 janitor（`supervisor.ts` 的 `scheduleSessionJanitor`）**：周期性兜底，默认每 30 分钟（`SESSION_JANITOR_MIN` 可调）扫所有 `.agent/` 下会话隔离损坏的；隔离时给 notify 群发提醒（`SESSION_JANITOR_NOTIFY=0` 关）。**只动 workDir 在 `.agent/` 下的会话**，绝不碰开发者自己 coding 用的执行器会话。⚠️ **janitor 在 supervisor 进程里，`pnpm agent update` 只重启 worker、不重启 supervisor**，所以 janitor 要等**完整重启 serve**（Ctrl+C supervisor 再 `pnpm agent serve`）才加载；好在 worker 启动清理已覆盖大部分场景，janitor 只是定时兜底。
- **手动 `node dist/bin/agent.js doctor [--fix]`**：扫损坏会话 + 看最近错误；`--fix` 才隔离。出问题先跑它。

## 4. 错误分类与处理（`classifyKimiError`）

| kind | 触发特征 | 处理 |
|---|---|---|
| `corrupt-session` | `tool_calls must be followed by tool messages` / `did not have response messages` | 移出隔离 + 不带 `--continue` 重试 |
| `session-missing` | `Session not found` / `was not found` / `no session to continue` | 直接不带 `--continue` 重试新会话 |
| `transient` | `HTTP 000` / `5xx` / `429` / `ECONNRESET` / `ETIMEDOUT` | 退避后重试 |
| `timeout` | 我方 timeout 把执行器进程 SIGTERM 杀了（`killed && signal=SIGTERM`） | 先验证+隔离会话再放弃（它是中毒主因） |
| `empty-output` | 执行器没有输出 assistant 文本 | 重试一次 |
| `config` | 执行器二进制缺失（ENOENT）/ auth / 旗标错 | 不可自愈，大声记录 |
| `unknown` | 其它 | 收尾仍验证+隔离会话 |

## 5. 日志：内部详尽、对外简短

- 对用户**永远只回**"（抱歉，我这边出错了，请稍后再试。）"，绝不洩内部细节。
- 内部：每条请求一个 `corrId`；主 log 一行分类摘要（`kind=/exit=/signal=/dur=` + postmortem 路径）；**完整** stderr/stdout（含大段 HTML）落到 `logs/errors/<时间>-<corrId>.log`；最细的内幕看执行器自己的 `~/.kimi-code/sessions/.../logs/kimi-code.log`。
- 错误账本：SQLite `errors` 表（db 迁移 v4），`store.recordError` / `recentErrors`，janitor 据此做阈值提醒。

## 6. 串行回复 + 表情（bot @ 频道）

- 回复是**串行**的（一轮执行器可能跑几分钟），但收消息**不阻塞**：用 `runKimiAsync` / `respondAsync` 非阻塞跑执行器，事件循环空着继续收新消息。
- 规则：消息进来时——
  - 若前面**有人在答 / 在排队** → 立刻贴**排队表情**（`queuedReactionEmoji`，现用 `OnIt`；`Coffee` 未验证有效性）。
  - 轮到它被回答时 → 排队表情**切成"思考中"**（`reactionEmoji` = `Status_PrivateMessage`）。
  - 进来当下**没人排** → 直接贴"思考中"（跟原逻辑一样）。
  - 答完移除表情。
- 指令类（help/ping/profile…）即时回复，**不进队、不贴表情**。
- emoji_type 不确定就别猜：让人手动按一个 → `im reactions list --params '{"message_id":"om_xxx"}' --format json` 读真值。已知 `Thinking` 无效；`OnIt` / `Status_PrivateMessage` / `THUMBSUP` 有效。

## 7. 重启打断 → 自动恢复（2026-06-16 加）

- **现象**：热重启（SIGHUP→worker 收 SIGTERM 立刻 `process.exit`）若打断进行中的回复，会：① 回复丢失（没发出）；② 那条消息的"思考中"表情留着没清；③ 执行器被半途杀 → 该群 session 中毒。重启后 bot 频道默认只答"启动后"的新消息，不会补答。
- **解法**：进行中的回复持久化到 SQLite `pending_replies` 表（db 迁移 v5）——入队时写、发出后删；所以 worker 启动时**残留的行就是被打断的回复**。
  - 入队即 `addPendingReply`，贴/切表情时存 `reaction_id`，扣 AP 后标 `ap_spent`，回复完（成功或兜底错误）`removePendingReply`。
  - `feishu-bot.ts recover()`（启动时调）：① 清掉残留表情；② 退还已扣 AP（重跑会再扣，净一次）；③ 重新入队重答（绕过启动宽限）；重试上限 `MAX_RECOVERY_ATTEMPTS=2`，超了就回"请重新问我一次"并删行（防某条消息每次都把 worker 跑挂）。
  - 配合 worker 启动清理（第 3 节）：重跑前损坏会话已被隔离，所以重答是干净的新会话。
- **要点**：只做在 **bot @ 频道**。`feishu-user` 频道靠游标续接（从存档 position 之后重读），是另一套恢复模型。

## 8. 相关文件 / 配置 / 恢复

- 代码：`kimi.ts`(KimiError/分类/runKimi+runKimiAsync)、`kimi-session.ts`(validate/quarantine 移出/scan)、`agent.ts`(respond/respondAsync 自愈环)、`supervisor.ts`(janitor)、`bin/agent.ts`(runWorker 启动清理 + doctor)、`channels/feishu-bot.ts`(串行队列+表情+`recover()`)、`store.ts`(`pending_replies` 读写)。
- 配置：`configs/kimi.json`(`timeoutMs=600000`、`maxRetries`)、`configs/agents.json`(`reactionEmoji`、`queuedReactionEmoji`)。
- 改完代码 `pnpm agent update` 热重启 worker 即生效；但 **janitor 等 supervisor 级功能要完整重启 serve**（见第 3 节）。
- 与执行器机制相关的更底层细节见 `memory/agent-executor-playbook.md`。
