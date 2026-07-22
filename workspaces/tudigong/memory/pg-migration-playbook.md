# SQLite → PostgreSQL 迁移 playbook（城邦土地神工作区记忆）

> tudigong 的两颗 SQLite 库（`.agent/shared.db` 全体 soul 共用的 LP 经济、`.agent/tudigong.db` tudigong 专属对话/运营数据）迁移到远端 PostgreSQL（`feishu_biz` 库，`shared`/`soul_tudigong` 两个 schema）的完整工程记录。**其余 soul（analyst-mira/trader-yifan 等）无限期留在 SQLite**，两种后端长期并存，不是过渡态。
> 计划：`thoughts/shared/plan/2026-07-21-tudigong-sqlite-to-pgsql-migration-plan.md`；研究：`thoughts/shared/research/2026-07-21-tudigong-sqlite-to-pgsql-migration.md`；施工总结：`thoughts/shared/coding/2026-07-21-tudigong-sqlite-to-pgsql-migration.md`（含完整正式割接执行手册的最新版本，找命令一律去那份）。
> 与本册分工：`local-db-playbook.md §11` 记表结构/型别对映这条主线；`pt-gamification-playbook.md §12` 记 LP 帐本这条主线；本册记两者都用得上、但归不进上述任一册主题的横切经验——`AsyncLocalStorage` 除错心得、连线延迟观察、ETL 效能优化、以及**目前的真实上线状态**。

## 0. 目前状态（每次读这份先看这里，别信旧结论）

- **✅ 正式割接已执行（2026-07-22），tudigong 现在跑在 PostgreSQL 上**。`.env` 的 `AGENT_PG_URL`/`AGENT_PG_POOL_MAX` 已取消注释、生效。割接当时金额分毫不差实测 **5441.8**（`SUM(pt_ledger.delta)`＝`SUM(profiles.pt_balance)`，SQLite 与 PG 四个数字全等）。ETL 两支脚本 + 全部验证一次通过（见 §6）。
- **代码**：Phase 0-3 全部完成 + **割接后追加的性能修复（§7，larkExec async 化 + syncChatMembers 批次化）+ 断线容错机制（§8，断路器/LP 暂拒/遥测降级队列/告警）**；`pnpm build` 零错误、`pnpm test` **389/389**（含 §8 新增的 31 个测试，5 个 `*.pg.test.ts` 专测 PostgreSQL-only 风险点）。
- **⚠️ 割接当天踩的最大坑：SQLite 时代无感的同步 DB 调用，PG 时代会拖垮整个进程**。`larkExec` 的 `execFileSync`（每次 0.5-2 秒）让事件循环长期饱和，导致 profile 指令回复延迟一度到 **12 分钟**、成员同步交易独占连线 9 分钟、偶发 ECONNRESET。根治靠 §7 的两台手术。**这是本次迁移最重要的教训，别再让任何同步阻塞调用活在 async DB 路径旁边**。
- **剩余未动的同步阻塞源：`kimi.ts` 的 `runFileSync`**（LLM CLI 整轮同步阻塞事件循环）。纯指令（profile/签到，不走 LLM）已经秒级；但走 LLM 的对话回复在 LLM 执行那几秒仍会挡住并发 PG 查询。若观察到 LLM 对话偶发拖慢，下一刀就是它（同 §7 的手法：`runFileSync`→async）。
- **SQLite 冻结快照仍保留**在 `.agent/*.db`（尚未 chmod 唯读封存，留作回滚保险）——观察期 3-7 天稳定后再封存。回滚＝把 `.env` 两行重新注释再重启，SQLite 原档割接期间没被写过。
- **`.env` 里 `AGENT_PG_URL` 现在是打开的、且这是正确状态**（不再是 §4 描述的地雷期）——§4 那颗地雷是"割接前"的注意事项，现在已过那个阶段；但回滚时把它注释回去的道理不变。
- 判断"割接有没有执行"最快的办法：`psql` 连远端 `feishu_biz` 查 `select count(*) from soul_tudigong.messages`（几千笔 = 已割接，仍在增长 = 生产在写 PG）。

## 1. `AsyncLocalStorage` 双后端交易设计的除错心得

- **心智模型**：SQLite 的交易天然靠单一进程内的一个同步 handle 表达"这几个语句在同一笔交易里"；PostgreSQL 的交易靠"这几个语句在同一条连线上按序执行"表达（连线池借出的是不同的 `PoolClient`，随便两个 `pool.query()` 可能落在不同连线上，各自隐含 autocommit，交易边界就散了）。`AsyncLocalStorage`（`node:async_hooks`）用来把"这次交易借到的那一个 `PoolClient`"绑定到整棵嵌套 async 调用树上，`tx()`/`lpTx()` 内部任何一层再调 `getDb()`/`getLpDb()`，只要还在同一个 `ALS.run()` 的调用树里，读到的都是**同一个** client，而不是又跟连线池借一个新的。
- **可重入闸门**：交易函式一进来先检查 `als.getStore()`——如果已经在交易里（呼叫方自己就是从另一个 `tx()`/`lpTx()` 内部再叫进来的），直接复用现有连线、不再 `BEGIN` 一次（PostgreSQL 不支援真正的嵌套交易，`BEGIN` 两次会报 `WARNING: there is already a transaction in progress` 或行为不如预期）。SQLite 分支完全不用管这件事，因为它本来就是同一个进程内的同步 handle，天然可重入。
- **踩坑**：如果忘了在 `finally` 里释放连线（`client.release()`）会导致连线池慢慢枯竭——PostgreSQL 分支务必用 `try/finally` 包住"借连线→BEGIN→跑 callback→COMMIT/ROLLBACK→release"整段，`ROLLBACK` 一定要在 `catch` 里做，`release()` 一定要在最外层 `finally` 里做（不管成功失败都要还连线）。

## 2. 连线延迟对使用体验的实际影响（真实观察，非估算）

- 本机（macOS，家用/办公网络）到远端 `8.148.232.222:5432` 的单次 round trip，实测在**几毫秒到十几毫秒**量级——对单笔查询（LP 余额、profile 查询）几乎无感；但**任何写成"N 行数据、N 次 round trip"的循环**会被这个延迟放大到肉眼可见的秒级甚至分钟级（见 §3 的 ETL 教训）。
- 连线池（`pg.Pool`，`AGENT_PG_POOL_MAX` 默认 5）在低并发下（单一 tudigong 进程、日常对话量）够用；**没有观察到连线数瓶颈**，但如果未来其他 soul 也接上同一个 PostgreSQL 实例（目前无限期不做，见 db.ts `soulUsesPg()` 只认 tudigong），要留意每个 soul 各自的连线池大小加总别超过远端伺服器的 `max_connections`。

## 3. ETL 效能教训：一行一次 round trip 在真实资料量下会超时

- `scripts/etl-soul-tudigong-to-pg.mjs` 第一版是"每一行资料各自一次 `pool.query()`"（照抄 `etl-shared-to-pg.mjs` 的写法），对 shared.db 那种几十笔资料的小库没问题，但 `tudigong.db` 有 30 张表、总计约 **21,550 行**（`calendar_event_rsvp_rounds` 一张表就近 8,700 行、`member_sync_rounds` 约 5,500 行、`messages` 约 4,550 行），一行一次 round trip 对远端伺服器实测**跑超过 2 分钟仍未跑完**（超过命令超时上限，被系统中断）。
- **修法**：改成批次多行 `INSERT`（`BATCH_SIZE=500`，一条 SQL 语句塞 500 行的 `VALUES (...),(...),...`），把 round trip 数从"资料笔数"降到"资料笔数 / 500"。改完后同一份真实资料**完整跑完（ETL + 全部验证查询）只要约 94 秒**，两个数量级的差距。
- **参数上限要注意**：PostgreSQL 单条查询的参数数量有上限（约 65535），`批次大小 × 栏位数` 要留够余裕——本次最宽的表约 20 栏，500 行批次即 10,000 个参数，远低于上限，安全。
- **`shared` 的 ETL 没有做这个优化**：那份资料量目前只有几十到几百笔，一行一次 round trip 几秒内跑完，暂不需要——但如果 shared.db 未来资料量大幅成长（例如 `pt_ledger` 累积到几万笔），照同样的批次手法改造即可，写法可以直接抄 `etl-soul-tudigong-to-pg.mjs` 的 `BATCH_SIZE` 循环。

## 4. 一个差点酿成事故的发现：`.env` 里活着的 `AGENT_PG_URL` 是颗地雷

- **背景**：Phase 0 就把 `AGENT_PG_URL` 写进了 `.env`（方便 ETL 脚本 `--env-file=.env` 读取、方便测试），但一直到 Phase 3 结束、正式割接前，远端 `shared`/`soul_tudigong` 两个 schema 都**只套过基线 DDL，完全没有真实资料**。
- **风险**：`.env` 里的 `AGENT_PG_URL` 一旦被任何一个进程在启动时读到，`lpUsesPg()`（对所有 soul 生效）/`soulUsesPg()`（只对 tudigong 生效）就会回传 `true`，该进程立刻改用 PostgreSQL 后端——但那边是空的。也就是说：**只要有人在割接手册跑之前，因为任何原因（不一定跟这次迁移有关——例如例行重启、当机自动重启、甚至只是手滑）重启了 tudigong 进程，或第一次启动了目前还没上线的 analyst-mira/trader-yifan（它们也共用同一份 `.env`，`lpUsesPg()` 对所有 soul 生效）**，那个新进程会瞬间"看起来" LP 余额全部归零、聊天记录全部清空——**不会报错**，只会安安静静地对着一个空后端运作，像是资料被删了一样。
- **已采取的防护**：把 `.env` 里的 `AGENT_PG_URL`/`AGENT_PG_POOL_MAX` 两行**注释掉**（不是删除，保留原值），并在旁边写清楚"只有在正式割接、且已经跑完 ETL 验证之后，才能取消注释"。这样任何例行重启都会安全地退回 SQLite，直到有人照着执行手册**刻意**打开这个开关。
- **给未来维护者的提醒**：如果你在这份迁移完全定案之前看到 `.env` 里 `AGENT_PG_URL` 是打开的（没被注释），先别急着重启任何 soul 的行程——去確認 §0 提到的"正式割接是否已执行"，别让一次例行操作变成资料看起来消失的事故。

## 5. 一个新发现的 PostgreSQL 行为（跟 `AsyncLocalStorage`/ETL 无关，独立记一笔）

- PostgreSQL 对同一个查询里重复出现的参数占位符（如 `$2`），型别推断是**从左到右、看第一个给出型别语境的出现位置**决定的——`(message_id <> $2 OR $2 IS NULL)` 可以、但反过来 `($2 IS NULL OR message_id <> $2)` 会报 `could not determine data type of parameter`。这条只有对着真的 PostgreSQL 才测得出来（SQLite 两种写法都吃），已在 `local-db-playbook.md §11` 记过一次，这里不重复，只标注"这是本次迁移过程里**独立发现、此前没有任何文档记录过**的一条 PostgreSQL 行为细节"，供日后写新 SQL 时留意。

## 6. 正式割接执行记录（2026-07-22）

按施工总结第五节手册执行，一次通过：

1. **停机**：使用者在跑 `pnpm agent serve --bot tudigong --sup` 的终端机 `Ctrl+C`（前景进程，非 pm2/systemd，只能在该窗口停）。`ps aux | grep "agent.js serve"` 确认无残留。analyst-mira/trader-yifan 当时没在跑，不用管。
2. **解封 `.env`**：取消 `AGENT_PG_URL`/`AGENT_PG_POOL_MAX` 两行注释。
3. **两支 ETL**：`node --env-file=.env scripts/etl-shared-to-pg.mjs`（9 表，金额 5441.8 分毫不差）→ `scripts/etl-soul-tudigong-to-pg.mjs`（30 表，messages=4586、rsvp=8801，抽样 0 不符，序号防重 OK）。
4. **`pnpm build`** → 使用者原样重启。
5. **验收**：`psql` 查 `pg_stat_activity` 确认进程连的是 PG、`soul_tudigong.messages` 在增长；群里发 `@城邦土地神 profile` 看回复内容与 PG 端 `shared.profiles`/`user_badges` 一致（Ricky Wang、257.6、3 徽章）——**读写都在 PG、帐目零误**。
- **确认后端最快看 log**：serve 启动会打两行 `soul 库后端：PostgreSQL（schema=soul_tudigong，pool max=N）` + `LP 库后端：PostgreSQL（schema=shared，…）`（`src/core/db.ts` 的 `logBackendChoice`，MCP 子进程降 DEBUG 免每轮多一个 log 档）。

## 7. ⚠️ 割接后的性能修复：同步阻塞调用是 async DB 的头号杀手（2026-07-22，最重要）

**症状**：割接后 tudigong 功能全对但慢到不可用——profile 指令回复延迟 12 分钟、成员同步交易独占 PG 连线 9 分钟、偶发 `read ECONNRESET`（查询等 78 秒被伺服器掐断）。

**根因（务必记住）**：SQLite 是**同步、进程内、本地文件**，`store.*` 调一次 DB 是同步返回，事件循环有没有被别的同步调用堵住无所谓。换 PG 后 `store.*` 全 async，靠事件循环把 promise resolve 回来——但本代码库有大量**故意的同步阻塞调用**：`src/core/lark.ts` 的 `larkExec`/`larkExecSend` 用 `execFileSync` 调 lark CLI（每次 0.5-2 秒），轮询循环 14 群 × 每 4 秒不停调。事件循环被这些 `execFileSync` 长期占满，**任何在途的 PG 查询的 promise 都排在后面 resolve 不了**——一条服务端 50ms 的查询端到端能拖到 6 秒，一个 20 语句的指令回复拖到分钟级。**这不是 PG 慢，是事件循环被同步调用饿死**。

**怎么快速确诊是这个病**：`src/core/db.ts` 的慢查询日志已经把耗时拆成三段——`PG 慢查询 Xms（执行 Ams，池等待 Bms，事件循环阻塞约 Cms，池 总T/闲I/队W）`。**执行 A 小、阻塞 C 大 = 事件循环问题（不是 DB）**；池等待 B 大 = 连线池饥饿（通常是有长交易在霸占连线，比如没批次化的成员同步）。真慢（A 大）才是 DB/网络问题。这套归因日志是这次现学现加的，`AGENT_PG_SLOW_QUERY_MS`（默认 2000）/`AGENT_PG_SLOW_TX_MS`（默认 30000）可调。

**两台手术（根治，已上线验证 profile 回复 12 分钟→2.5 秒）**：
- **手术 1：`larkExec`/`larkExecSend` async 化**。`execFileSync`→异步 `execFile`（走既有 `subprocess.ts` 的 `runFileAsync`）；429 退避的 `sleepSync`（`Atomics.wait`）删掉改 `await sleep`。**严格保留「只有 `isRateLimited`(429) 才重试、其他错误不重试防重复发送」的语义**。lark.ts 全部 36 个导出包装函式跟着 async 化，全仓呼叫点补 `await`（约 27 个档）。
- **手术 2：`store/members.ts` 的 `syncChatMembers` 批次化**。原本 600 成员逐条 INSERT/UPDATE + 逐人 canonicalId 查询 = 一笔交易约 1800 条语句、开 9 分钟独占连线。改成：一次 SELECT 撈现况→JS 内存 diff 出 joined/left/renamed→多行 VALUES upsert（≤200 列/批）+ leaver 批次 `UPDATE present=0 WHERE open_id IN(...)` + `freshenProfileNames` 批次化。语句数 ~1800→~9。
- **⚠️ async 化的两类 tsc 完全抓不到的陷阱**（这次逐个扫了，务必记住手法）：
  1. **裸调用变 fire-and-forget**：`sendText(...)` 当语句调用不取返回值，变 async 后编译不报错但不再等待。**最阴的是 `const ok = updateMessage(...); if (!ok)`**——async 后 promise 恒 truthy，结算失败的 fallback 文字消息**永远不会发**（tc-settlement/predict-settlement/tc-bet-parser/predict-bet-parser 各一处，全补了 await）。扫法：对每个被改函式 `rg "\bfn\("` 排除已有 await/void/return/赋值的行。
  2. **`.map()/.filter()/.forEach()` 包住被改函式**：`.map(sendText)` 变 async 后返回 `Promise[]`，塞进模板字符串/join 会静默出 `[object Promise]`，编译不报错。改 `Promise.all` 或 for...of await；**发送顺序敏感的一律改循序 for...of，不平行化**。
- **配套**：`.env` 的 `AGENT_PG_POOL_MAX` 从 5 调到 10（远端 `max_connections=100`，用量才十几，余裕大）；`db.ts` 的 `pg.Pool` 加了 `.on('error')` handler（**这是顺手修的可靠性洞：空闲连线被服务端掐断时 Pool 发 `'error'` 事件，没监听器 Node 直接崩进程**）。
- **剩下没动的**：`kimi.ts` 的 `runFileSync`（LLM CLI）——见 §0，纯指令已快，LLM 对话若偶发拖慢再开这刀。

## 8. PG 断线容错机制（断路器 + LP 暂拒 + 遥测降级队列 + 告警，2026-07-22）

割接稳定后补的容错层：PG 真的断线时怎么办。规划文件：`thoughts/shared/research/2026-07-22-pg-failover-sqlite-fallback-backfill.md`（研究，含四方案比较与使用者决策记录）；施工总结：`thoughts/shared/coding/2026-07-22-pg-failover-circuit-breaker-degrade.md`。**Phase 3（全量 LP failover 到本地 SQLite）确定不做**——split-brain 风险，接受「LP 断线就暂拒」。

**核心心智模型**：两个独立 `pg.Pool`（soul／shared）各配一个断路器（`src/core/circuit-breaker.ts` 的 `PgCircuitBreaker`），互不联动——soul 断路器 open 只影响 §8.2 的遥测降级队列；shared 断路器 open 只影响 §8.3 的 LP 暂拒。两者可能同时 open（PG 真的整个挂），也可能只有一个 open（例如某个 schema 级锁等待只影响 soul）。

### 8.1 断路器状态机与"假性缓慢"排除（最容易做错的一环）

- 三态 `closed`/`open`/`half-open`。`AGENT_PG_CIRCUIT_FAIL_THRESHOLD`（默认 5）次连续计入失败即 open；`AGENT_PG_CIRCUIT_PROBE_MS`（默认 12000ms）冷却后 `allowRequest()` 放行恰好一次探测（half-open 期间其他呼叫方一律被拒，探测本身不会被并发放大成雪崩）；探测成功 `recordSuccess()` 直接转 closed，失败 `recordFailure()` 打回 open 重新计冷却。
- **⚠️ 这条是整个容错机制的正确性核心**：断路器的失败计数**必须排除事件循环阻塞造成的假性缓慢**（§7 记过的 12 分钟事故——`execFileSync` 饿死事件循环，导致偶发 `ECONNRESET`，但 PG 本身没事）。做法：重用 `classifySlowQuery`（现已搬到独立的 `src/core/db-slow-query.ts`，避免 `circuit-breaker.ts`↔`db.ts` 互相 import 成环）算出 `dbMs = elapsed - blocked`；`shouldCountAsCircuitFailure(e, elapsedMs, blockedMs, threshold)` 先判断 `e` 是否为连线层错误（`ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/`57014`(query_canceled，含 statement_timeout 取消)/`28P01`(密码认证失败) 等一批 code/message 白名单，`isPgConnectionLayerError()`），再看 `classifySlowQuery(...) !== 'loop'`——只要分类结果是 `'loop'`（阻塞时间本身就能解释掉这次失败），一律不计数。纯 SQL 应用层错误（唯一键冲突、语法错误）从来不触发 `isPgConnectionLayerError`，天生就不会被误判成断线。
- 挂钩点：`pgExecutor()` 的 `catch`（每次查询失败都算）、`tx()`/`lpTx()` 自己的 `pool.connect()`（这一步在 `pgExecutor` 之外，容易漏掉，务必也包一层同样的分类逻辑）、两个 `pool.on('error')`（用当下的 `loopTickStalenessMs()` 近似估算阻塞程度，因为没有具体查询可归因）。
- **happy path 零开销**：closed 状态下 `allowRequest()` 只是一个 `if` 判断，`recordSuccess()`/`recordFailure()` 前者只是重置计数器；PG 健康时行为与容错上线前完全一致。

### 8.2 soul 库遥测降级队列（Phase 2，只管 8 张 append-only 表）

- 白名单表（`src/core/pg-outbox.ts` 的 `OUTBOX_TABLES`）：`chats`/`messages`/`activities`/`member_sync_rounds`/`calendar_event_rsvp_rounds`/`doc_view_events`/`chat_reactions`/`handled_messages`/`errors`。**明确排除** LP 帐本（那是 §8.3 的暂拒范畴）与 TC/predict 的 proposals/bets（stateful，split-brain 风险，研究报告已否决）。
- **⚠️ `chats` 是超出研究报告原始清单、但必须加的一张表**：`insertMessage()` 每次写 message 前都会顺手 `INSERT INTO chats(chat_id) ... ON CONFLICT DO NOTHING` 满足外键；如果不让这行也走降级，soul 断路器 open 时每一条被降级的消息仍然会在这行卡一次真实（会失败）的连线尝试，降级等于没做。做法：`insertMessage()` 在判断要降级时，**跳过**这行 chats 占位写入（不进队列），改成回放时（`replayOutbox()`）对 `messages` 表的每一行**动态补一次**同样的 `INSERT INTO chats(...) ON CONFLICT DO NOTHING`（从排队的 `chat_id` 值现推，不需要额外排队一笔 chats 记录）。
- 判断要不要降级的唯一入口：`shouldDivertSoulWrites()`（`db.ts` 导出，内部调用 `soulCircuit.allowRequest()`）——**这是个有副作用的函式**（会消耗 half-open 探测名额），只能在真的要写入前调用恰好一次，绝不能当状态查询用（状态查询用只读的 `isSoulPgCircuitOpen()`）。6 个实际改动的 call site：`gamification.ts` 的 `recordActivity`（顺手把 `recordInteraction` 里重复的 `tx(() => recordActivityRaw(...))` 改成直接调 `recordActivity`，消掉一处技术债）、`messages.ts` 的 `insertMessage`/`markMessageHandled`、`members.ts` 的 `recordMemberSyncRound`、`reactions.ts` 的 `recordChatReactions`、`ops.ts` 的 `recordError`。`calendar_event_rsvp_rounds`/`doc_view_events` 目前代码库里**没有任何 call site 在写它们**（只有 ETL 脚本/schema 里出现），白名单先占位，等未来真的接上轮询写入时自动受益。
- **soul 的其他读写（非白名单表：`chat_members`/`tc_bets`/`tc_proposals`/message_search 等）刻意不拦截**——soul 断路器 open 时这些路径照旧尝试真实 PG（受 Phase 0 快速失败旋钞限制在几秒到十几秒失败，不再是分钟级卡死），只是把结果照实回报给 soul 断路器（`tx()` 不用 `allowRequest()` 闸门，纯粹现状加固）。这是刻意收窄的范围，不是遗漏——已在施工总结记为已知限制。`message_search`（`mcp-server.ts`）额外做了只读优雅降级（`isSoulPgCircuitOpen()` 探测，回「暂时无法搜索」），搜佇列本身列为次要优先级未做。
- **队列本体**：单一路径固定的本地 SQLite 文件（`RUNTIME_DIR/pg-outbox.db`，`AGENT_PG_OUTBOX_PATH` 可覆盖），WAL + `busy_timeout=5000`（照抄 `getLpDbSqliteRaw()` 手法），所有行程（含短命 MCP 子行程）共写同一份文件、写完立刻返回不等回放——这正是佇列形状能让短命子行程安全参与降级的原因（研究报告硬问题 3 的结论）。表结构：`pg_outbox`（table_name/columns_json/values_json/enqueued_at/replayed_at）+ `pg_outbox_replay_log`（每次回放的汇总，供 `agent doctor` 读）。
- **不需要 `OVERRIDING SYSTEM VALUE`**：白名单里每张表的自增 `id` 都没有被任何 FK 引用（不像 `pt_ledger`/`tc_bets`），所以入队/回放时干脆不带 `id` 这栏，让 PG 自己重新分配——比照搬 ETL 脚本的序列重设手法简单很多。
- **回放**：只有 supervisor（唯一长驻、跨行程的协调点）拥有 `replayOutbox()`。触发两条路：① 订阅 `soulCircuit.subscribe()`，状态转到 `closed` 立刻回放一次；② 每 5 分钟一次安全网扫描（`if (!isSoulPgCircuitOpen() && outboxBacklogCount() > 0)`），防的是 supervisor 自己在断线期间重启、完全错过 open→closed 事件、队列从此没人理的情况。每行回放成功立刻 `UPDATE ... SET replayed_at = unixepoch()`（紧跟在远端 INSERT 成功之后，没有跨库两阶段提交，中间那一瞬间的窗口是唯一残留风险——`activities`/`errors` 两张没有天然去重键的表理论上可能因此重复一行，其余表都有唯一键/自然键，`ON CONFLICT DO NOTHING` 兜底）。中途中断可安全重跑：已标记的行不会重放，失败的行留着等下一次。

### 8.3 LP 经济暂拒（Phase 1，不动声色）

- `shared` 断路器 open 时，`getLpDb()`/`lpTx()`（PG 分支）**直接抛 `PgUnavailableError`**（`circuit-breaker.ts` 新 error class，`isPgUnavailableError()` 判断），**在真的呼叫 `lpPgPool().connect()` 之前**——不浪费一次注定超时的尝试，也绝不写本地、绝不回退 SQLite。`getLpDb()`/`lpTx()` 已绑定连线的重入呼叫（同一笔交易内部）不重复闸门，直接沿用现有连线。
- 指令/工具边界统一 catch 成简体中文文案 `PG_UNAVAILABLE_REPLY_ZH`＝「LP 系统维护中，请稍后再试。」：`commands.ts` 的 `sign`、`tc-bet-parser.ts`/`predict-bet-parser.ts` 的下注（**⚠️ 两处都要把 `getProfile()`/`spendPt()` 一起包进同一个 try——`getProfile()` 也会先摸到 LP 库，只包 `spendPt()` 会漏抓**）、`mcp-server.ts` 的 `pt_grant`/`profile_get`/`leaderboard`。**不动声色**：只有使用者主动触发相关指令才看到文案，不主动群发公告。
- Supervisor 的 `scheduleDailyPtReset`/`scheduleTcSettlement` 各自在 tick 最前面用**只读**的 `isLpPgCircuitOpen()`（注意跟 §8.2 的 `shouldDivertSoulWrites()` 不同，这个不消耗探测名额）判断，open 就打一行 warn 跳过本轮，沿用原本的 setTimeout 自我重排骨架（TC 结算冪等闸门 `WHERE status='active'` 保证下一轮重跑安全）——避免对已知不可用的 PG 每分钟洗一轮错误 log。

### 8.4 告警与 `agent doctor`（Phase 4）

- 两个断路器的每次状态转换都 `subscribe()` 到 supervisor，推一行文字到 `notifyTarget()` 解析出的运营通知群（跟 `scheduleSessionJanitor` 的自愈通知走同一个目标，语义上都是"基础设施自愈通知"）。发送前过一遍 `outbound-guard.ts` 的 `isMeaninglessMessage`/`isFanoutFlood`（沿用 mcp-server.ts 对 LLM `feishu_send` 工具的同一套防护，专门防断路器来回抖动时同一句话被反复群发刷屏）。
- `pnpm agent doctor` 新增：两个断路器当前状态（`soulCircuit.state`/`lpCircuit.state`）、降级队列待回补笔数（`outboxBacklogCount()`）、最近一次回放的时间范围与成功/失败笔数（`pg_outbox_replay_log` 表，`lastReplayLog()`）。

### 8.5 环境变量清单（新增）

| 变量 | 默认 | 作用 |
|---|---|---|
| `AGENT_PG_CONNECT_TIMEOUT_MS` | 8000 | pg.Pool 连线逾时（0 关闭），断路器的前置——没有这个，一次丢包会被 TCP 重传放大成几十秒卡死，断路器侦测不及 |
| `AGENT_PG_STATEMENT_TIMEOUT_MS` | 15000 | 服务端 `statement_timeout`；客户端 `query_timeout` 自动取此值 + 2000ms，让服务端先取消、呼叫方拿到真实报错 |
| `AGENT_PG_IDLE_TIMEOUT_MS` | 60000 | pg.Pool 闲置连线回收逾时 |
| `AGENT_PG_CIRCUIT_FAIL_THRESHOLD` | 5 | 连续几次计入失败才 open |
| `AGENT_PG_CIRCUIT_PROBE_MS` | 12000 | open 后冷却多久才放行一次 half-open 探测 |
| `AGENT_PG_OUTBOX_PATH` | `RUNTIME_DIR/pg-outbox.db` | 降级队列文件路径（测试用覆盖隔离） |

### 8.6 已知残留风险（诚实列出，别事后忘记）

- soul 断路器 open 期间，白名单外的 soul 读写（`chat_members`/`tc_bets`/TC-N 查询等）仍会真的尝试 PG，每次被 connect/statement 逾时值限流（不再分钟级卡死，但也不是零延迟）——刻意收窄的范围，不是遗漏。
- `tx()`/`lpTx()` 里直接呼叫的 `BEGIN`/`COMMIT` 本身（不是 `pgExecutor()` 包住的查询）没有单独喂给断路器分类——只有最前面的 `pool.connect()` 失败会被记录；`BEGIN`/`COMMIT` 本身失败的机率远低于连线失败，视为可接受的次要缺口。
- `activities`/`errors` 两张遥测表没有天然去重键，回放时"远端 INSERT 成功"与"本地标记 replayed_at"之间那一瞬间如果进程崩溃，理论上可能重放出重复的一行——影响仅限日志/统计精确度，不影响 LP 帐本或任何业务状态。
- `tools/seedaodb`（唯读分析层）不在本次范围内，没有接断路器；它本来就是唯读、且是独立 Rust 服务，PG 断线时它自己的连线行为不受本次改动影响。
