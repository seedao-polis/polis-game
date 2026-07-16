# Telegram 日志镜像 playbook（2026-06-19 加）

> 目的：`pnpm agent serve` 的日志**单向**镜像一份到 Telegram，方便随时看运行状况。**只发不收**——不是 webhook（webhook 是 Telegram→你的入站方向，不需要），就是调 Bot API 的 `sendMessage`/`sendPhoto` 往外推。以后发人数曲线图等也走这条。

## 架构（一句话）

`src/core/log.ts` 的 `emit()` 是全项目日志的唯一收口 → 在那加一个 Telegram sink，本地 stderr/文件/Telegram 三路齐发，其余代码零改动。封装全在新模块 `src/core/telegram.ts`。

## 配置（密钥走 .env，不进 configs/git）

- `.env`（已 gitignore）4 个变量：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`TELEGRAM_LOG_LEVEL`（debug/info/warn/error，默认 info）、`TELEGRAM_FLUSH_MS`（默认 3000，最低 1000）。两个都填了才启用，否则整个 sink 是 no-op。
- **项目原本没有任何 dotenv 加载**（`.env.example` 是摆设、靠 shell export）。已在 `bin/agent.ts` 入口加 Node 自带 `process.loadEnvFile(REPO_ROOT/.env)`（容忍缺失），无需装包；supervisor spawn worker 时 env 自动继承，两进程都读得到。
- Telegram 端设置：`@BotFather` `/newbot` 拿 token；给 bot 发条消息后开 `https://api.telegram.org/bot<token>/getUpdates` 取 `chat.id`（群是负数）；`pnpm agent tg-test [消息]` 验证连接。

## ⚠️ 关键设计点（都是为了不踩坑）

- **档位独立**：`emit()` 在本地 `LOG_LEVEL` 闸门**之前**调 `pushLogLine`，所以 Telegram 用自己的 `TELEGRAM_LOG_LEVEL`——本地 info、Telegram 可 debug，互不影响。
- **双进程各推各的**：supervisor 和 worker 都跑 `cmd==='serve'`、都 `enableLogSink()`，各一份缓冲，靠 `[sup]`/`[wkr]` 前缀区分（worker 看 `AGENT_WORKER`）。
- **批量限频**（Telegram 单聊约 1 msg/s）：缓冲日志行，每 `flush_ms` 合并成**一条**发；单条 ≤4096（留头到 3500）；一批切多条时每条间隔 1100ms。**绝不一行一发**（必被 429 + 刷屏）。
- **`HTTP 429 retry after N` 会自愈、别慌**：日志见 `[telegram] 推送失败，进入退避（约每 30s 重试一次、期间静默）：HTTP 429` 是 Telegram Bot API 限流（多半启动时一波通知打太密），代码已自带退避重试、会自己恢复，**本地文件日志始终完整**，不用管。**它跟 lark-cli 无关**——2026-07-14 lark-cli 升级同时段冒出来过，别误以为是飞书那边的问题去改 lark 代码（那次真正的 bug 是信封变更，见 [[lark-cli-playbook]] §11）。
- **debug 洪流安全阀**：单进程缓冲超 800 行就压成头 50 + 尾 50 + 【省略 N 行】，避免一次发几百条。完整日志始终在本地文件。
- **防递归**：`telegram.ts` 绝不 import/调 `log.*`，自身报错只 `process.stderr.write`（否则 推送失败→打日志→又推→死循环）。
- **只在 serve 启用**：`enableLogSink()` 只在 serve 调；flush 定时器 `unref()`，所以一次性 CLI 命令不会把日志推到 Telegram（进程先退）。
- **退出前同步冲刷**：`flushTelegramSync()`（用 `execFileSync('curl', -m 5)` 同步发）挂在 supervisor `shutdown()` + 两个频道的 `stop()`，因为它们 `process.exit()` 会打断 async fetch。最后一批可能丢是可接受的（本地文件完整）。
- **启动参数**：跟 `--quiet` 一样，改 `.env` 要 `pnpm agent update` 重启 serve 才生效。

## 运维提醒：user token 到期推送（`token-watch.ts`）

> 因为知识库访问记录采集只能用 user token（bot 加不进 wiki，见 local-db §10），而 user token 约 7 天到期需人工重授，故用 Telegram bot 主动私訊提醒。

- **触发**：以 `refreshExpiresAt`（刷新令牌到期=真正需重登的死线，不是会自动续的 access token）倒数，在 **3 天 / 2 天 / 1 天 / 当天(≤0)** 各推一次，共 4 次。`checkUserTokenExpiry(profile)` 挂 `feishu-user.ts` 的 **6 小时**回圈（首跑延迟 12s）。
- **去重 + 重授自动停**：每档一行存 `token_expiry_alerts(grant_key, threshold)`（migration v16，`INSERT OR IGNORE`），`grant_key = profile + grantedAt`。重新授权 → `grantedAt` 变 → 新 key → 旧档失效、死线外推一周，自然不再推；下个周期到期前 3 天才重新开始。一轮跨过多个档（停机补发）只发最紧迫那条、其余一并标记。
- **发送独立于日志镜像**：`sendTelegramAlert(text)`（best-effort，从不抛）发到 **`TELEGRAM_ALERT_CHAT_ID`**（留空回退 `TELEGRAM_CHAT_ID`）；提醒正文内嵌**即时生成的重授命令**（`auth login --scope "<当前全部 scope>"`，覆盖式所以照搬现有 scope 取并集）。
- **CLI**：`pnpm agent token-check` 看剩余天数 + 跑一次真实检查；`pnpm agent token-check --test` 发一条测试提醒验证投递（不动去重状态）。
- **scope 真相**：`auth status` 的 `identities.user.refreshExpiresAt` / `grantedAt` / `scope` 是数据源。

## 发图（`sendTelegramPhoto`，阶段二备好）

- 签名 `sendTelegramPhoto(image: Buffer|本地路径|http(s)URL, caption?)`，走 multipart `FormData`（Node 22 原生 `FormData`/`Blob`/`fetch`，无依赖）。URL 形式由 Telegram 自己抓取；本地数据**要拷进新 `ArrayBuffer`**（`new ArrayBuffer + Uint8Array.set`）再 `new Blob`，否则 Node `Buffer` 命中 `SharedArrayBuffer` 联合类型、`BlobPart` 报错。
- **阶段二待办（人数曲线）**：数据已在 `member_sync_rounds`（见 [local-db-playbook §7]）→ 本地渲染 PNG（建议 `chartjs-node-canvas`，别走第三方 URL 外泄社区数据）→ `sendTelegramPhoto` 发出 + 新增 `pnpm agent chart` 命令。

## 改动文件

`src/core/telegram.ts`（新）、`log.ts`（emit 加 sink）、`bin/agent.ts`（loadEnvFile + serve 里 enableLogSink + `tg-test` 命令）、`supervisor.ts` / `feishu-bot.ts` / `feishu-user.ts`（退出 flush）、`.env.example`（4 个变量）。
