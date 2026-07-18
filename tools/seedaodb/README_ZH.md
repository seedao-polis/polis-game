# seedaodb

一个独立的 Rust HTTP 服务端,为 tudigong 的两颗 SQLite 数据库提供带鉴权的 SQL 增删改查接口。访问受三重防护:服务令牌(service token)、基于飞书身份的认证,以及按用户区分的基于角色的访问控制(RBAC)。

本 crate 完全自包含。它不引用外层 `polis-game` Node/TypeScript 项目的任何代码,不读取宿主项目根目录的 `.env` 或 `configs/`,也不属于任何 pnpm workspace。它与宿主项目唯一的耦合,是 `config/datasources.toml` 里记录的一条文件路径——而一旦某个数据源被切换到非 SQLite 后端,这条耦合也随之彻底消失。

## 为什么需要这个工具

宿主项目的 tudigong agent 把数据存在 `.agent/` 下的两个 SQLite 文件里(`tudigong.db` 存放 per-soul 数据,如消息、群聊、事件;`shared.db` 存放跨 soul 的 LP 账本、profiles、徽章)。`seedaodb` 为其他工具或运维人员提供一个通用的、带鉴权的 SQL 接口来访问这两个文件——既不用把任何 Rust 依赖塞进 Node 进程,也不用让每个调用方都直接拿到 `.agent/` 的文件系统访问权。

## 快速开始

```bash
cd tools/seedaodb
cp .env.example .env
cp config/datasources.toml.example config/datasources.toml
cp config/acl.toml.example config/acl.toml
# 用真实值编辑 .env、config/datasources.toml、config/acl.toml

cargo build --release
./target/release/seedaodb
# 或者用 pm2 托管:
pm2 start ecosystem.config.cjs
```

`GET /health` 无需任何鉴权,只要进程起来就始终可用:

```bash
curl http://127.0.0.1:8878/health
```

除此之外的每一个端点,都同时需要服务令牌和一个可解析的身份(详见下文「认证与授权」)。

## 不接飞书的本地开发 / 测试

把 `SEEDAODB_AUTH_MODE=static` 设上,并让 `SEEDAODB_STATIC_TOKENS_FILE` 指向 `config/static-tokens.toml.example` 的一份拷贝。这会切换到 `StaticVerifier`,它把一组固定的 bearer token 映射到本地文件里的 `open_id`——整个过程不涉及任何对飞书的网络访问。集成测试套件(`tests/integration.rs`)内部走的正是这条路径,因此可以离线跑通完整的 HTTP -> 鉴权 -> RBAC -> SQLite 链路。不要在生产环境对不受信任的客户端使用 `static` 模式。

## API

所有响应都使用同一套 JSON 信封:

```json
{ "ok": true, "data": { "...": "..." }, "error": null }
```

```json
{ "ok": false, "data": null, "error": { "code": "FORBIDDEN", "message": "..." } }
```

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 无 | 存活探针;返回版本号和已配置的数据源名称。 |
| GET | `/datasources` | 服务令牌 + 身份 | 列出数据源的 name/backend/readonly。永不返回 URL 或凭据。 |
| GET | `/tables?db=<name>` | + 对 `db` 的读权限 | 从 `sqlite_master` 列出表名。 |
| GET | `/tables/:name/rows?db=<name>&limit=&offset=` | + 对 `db` 的读权限 | 分页浏览行数据。`limit` 默认 100,上限 1000。`:name` 会先与实时表清单校验后才使用。 |
| POST | `/query` | + 对 `db` 的读权限 | 请求体 `{ db, sql, params }`。只允许 `SELECT`、`PRAGMA table_info`、`EXPLAIN`。 |
| POST | `/exec` | + 对 `db` 的写权限 | 请求体 `{ db, sql, params }`。返回 `{ changes, lastInsertRowid }`。拒绝改结构 / 改写文件的语句(见下)。 |

`params` 是一个按位置绑定的 JSON 数组(对应 `?` 占位符),与宿主项目自己的 `db.prepare(sql).run(...params)` 调用是同一套心智模型。支持的参数 JSON 类型:`null`、`boolean`、`number`(整数或浮点)、`string`。数组和对象会被拒绝——SQLite 没有可供绑定的容器类型。

查询结果以 `{ columns: [...], rows: [[...], ...] }` 返回,每个单元格按 SQLite **运行期实际存储类别**逐格解码(而非该列的声明类型,因为 SQLite 的值是动态定型的):`NULL -> null`、`INTEGER -> number`、`REAL -> number`、`TEXT -> string`、`BLOB -> base64 编码的字符串`。

### 语句防护(statement guard)

这只是一个简单的前缀 / 关键字检查,不是 SQL 解析器:

- `/query` 只允许以 `select`、`pragma table_info`、`explain` 开头的语句(先剥掉开头的空白 / 注释)。
- `/exec` 拒绝以 `vacuum`、`alter`、`drop`、`create`、`attach`、`detach`、`pragma journal_mode`、`pragma writable_schema`、`reindex` 开头的语句。
- 两者都会拒绝含多条语句的请求(除一个可选的结尾 `;` 外,再出现第二条以 `;` 分隔的语句就拒)。

一个存心绕过的调用方,仍可能把第二条语句藏在字符串字面量里,或利用某种方言怪癖钻空子;要真正防住这类攻击,需要一个正规的 SQL 解析器(见下文「已知限制」)。至于某个调用方到底能不能读 / 写某个数据源,是由 RBAC 层单独管控的,不归这道防护管。

## 认证与授权

三道闸门,依次通过:

1. **服务令牌(粗粒度,服务对服务)**。发送 `Authorization: Bearer <token>` 或 `X-Service-Token: <token>`,与 `SEEDAODB_SERVICE_TOKEN` 比对。若该变量未设置,则每一个受保护端点都会拒绝每一个请求——没有「无闸门」的退路(fail-closed)。
2. **身份**。发送 `X-Feishu-User-Token: u-xxx`。该 token 由客户端自己走完飞书的 OAuth 登录流程获取;本服务只负责校验它,从不代跑登录流程。校验方式通过 `SEEDAODB_AUTH_MODE` 可插拔切换:
   - `feishu`(默认):调用真实的飞书 OpenAPI(`FeishuVerifier`)把 token 解析成 `open_id`,并把结果缓存 `SEEDAODB_TOKEN_CACHE_TTL_S` 秒。
   - `static`:在 `SEEDAODB_STATIC_TOKENS_FILE`(`StaticVerifier`)里查这个 token,不走网络。仅供开发 / 测试。
3. **RBAC**(`config/acl.toml`)。`open_id -> role -> { read: [数据源...], write: [数据源...] }`。`/query` 检查对目标 `db` 的读权限;`/exec` 检查写权限。若某个身份没有匹配的 `[[user]]` 条目,则回退到 `default_role`(它可以是字面量字符串 `"deny"`)。ACL 文件缺失或格式错误会导致启动直接失败;本服务绝不会以一份空的、全放行的 ACL 启动。

`acl.toml` 里的 `admin` open_id 列表,应由人工从宿主项目的 `configs/admins.json` 手动同步过来——本服务刻意不直接读那个文件,以保持两套代码库解耦(见下文「与宿主项目解耦」)。

## 可插拔后端(今天是 SQLite,以后可换 MySQL)

数据源通过逻辑名寻址(`config/datasources.toml`:`name -> url + readonly + busy_timeout_ms`),从不通过文件路径或连接串寻址,API 也从不接受调用方传入的任意路径 / DSN。正是这一点,让一个数据源可以纯粹通过配置就切换到另一种数据库引擎。

今天只实现了 SQLite 后端,使用具体的 `sqlx::SqlitePool`(而不是 `sqlx::Any`——对一个「本职工作就是把任意结果集解码成 JSON」的端点来说,`Any` 驱动的动态行类型覆盖更窄、更不可预测)。SQLite 连接以 `journal_mode=WAL` 打开,配有可配置的 `busy_timeout`,并在连接层应用数据源的 `readonly` 标志(这与 RBAC 对某个用户放行什么是相互独立、叠加生效的)。

`src/db/mysql.rs` 里放着同一套接口的、可编译通过的骨架,藏在 `mysql-backend` 这个 Cargo feature 之后(默认关闭,所以普通的 `cargo build` 绝不会拉进 MySQL 驱动)。它上面的每个方法目前都返回「未实现」——将来真接一个 MySQL 驱动只会动这一个文件,不碰路由 / 鉴权 / 语句防护的代码。用 `cargo build --features mysql-backend` 把它编进去。

**这套抽象并没有解决 SQL 方言的可移植性问题。** 后端抽象统一的是连接 / 执行,不是 SQL 方言。调用方发来的原始 SQL(`INSERT OR IGNORE`、FTS5 的 `MATCH`、`PRAGMA`、双引号标识符……)在 SQLite 上能跑,换到 MySQL 上未必原样能跑;而且 tudigong 的表结构本身就带 SQLite 专属结构(FTS5 虚拟表)。真要迁到 MySQL,需要一次专门的表结构 / 方言迁移,不是改个 URL 就完事。

## WAL 并发注意事项

现有的 `.agent/*.db` 文件已经处于 WAL 模式(这是持久化在磁盘上的设置)——本服务不需要、也不会去改这个。WAL 允许多个读者与单个写者并存,但对同一文件的写操作仍是全局串行的。由于宿主 Node 进程(serve worker + supervisor + 每轮的 MCP 子进程)可能已经持有对同一批文件的打开连接,seedaodb 采取了以下措施:

- 始终设置 `busy_timeout`(`datasources.toml` 里的 `busy_timeout_ms`),这样遇到锁冲突时会等待,而不是立刻以 `SQLITE_BUSY` 失败;
- `/exec` 遇到 `SQLITE_BUSY` / `SQLITE_LOCKED` 会做有上限的指数退避重试,最多 `SEEDAODB_BUSY_RETRY_MAX` 次;
- 把 `/exec` 事务保持得很短(绑定参数、`BEGIN` -> 执行 -> `COMMIT`,不长时间持锁);
- 每个数据源用一个由短生命周期连接组成的小连接池,而不是一条长命连接,因此本服务自身不会成为 WAL checkpoint 卡住的原因。

通过原始 SQL 写 `shared.db`(LP 账本 / profile 数据库)会绕过宿主项目自身的记账逻辑(`pt_ledger` 是 append-only 的,`profiles.pt_balance` 是 Node 代码通过 `grantPt()` 维护的派生值)。示例 ACL 正因如此,把 `shared` 的写权限限制给 `admin` 角色;任何这类写入都应被当作一次刻意的、有审计的、带外(out-of-band)操作,而不是日常流量。

## 安全

- **传输加密**:本服务默认不自己终结 TLS。如果它将来会经由不受信任的网络被访问,请把它放在一个终结 TLS 的反向代理(nginx/caddy)之后——用户 token 和 SQL 载荷绝不能明文过网。`SEEDAODB_TLS_CERT` / `SEEDAODB_TLS_KEY` 会被读入配置以备将来的自终结选项之用,但目前尚未接到 HTTPS 监听器上(TODO)。
- **审计日志**(`SEEDAODB_AUDIT_LOG`,默认 `logs/audit.jsonl`):每一次 `/exec` 调用(无论成功或失败),以及每一个被服务令牌闸门、RBAC 或语句防护拒绝的请求,都会作为一行 JSON 追加进去(时间戳、`open_id`、可得的来源 IP、`db`、操作、截断后的 SQL 前缀、结果、`changes`)。参数值永不落日志。
- **请求体大小限制**:`SEEDAODB_MAX_BODY_BYTES`(默认 1 MiB),在 handler 读取请求体之前就强制执行。
- **最小披露**:`/health` 和 `/datasources` 永不返回连接串或凭据;内部错误在服务端完整记录,但对客户端只报一条通用消息,绝不带出文件路径或连接串。
- **按 IP / 按 token 的限流尚未实现**(TODO)。今天在位的控制手段是 `SEEDAODB_SERVICE_TOKEN` + RBAC + 审计日志;无论 token 鉴权如何,都建议再加一层网络层控制(用防火墙 / 安全组限制哪些主机能连到这个端口)。

## 环境变量

完整、带注释的清单见 `.env.example`(`SEEDAODB_PORT`、`SEEDAODB_BIND_ADDR`、`SEEDAODB_SERVICE_TOKEN`、`SEEDAODB_AUTH_MODE`、`SEEDAODB_FEISHU_APP_ID` / `_APP_SECRET` / `_BASE_URL`、`SEEDAODB_STATIC_TOKENS_FILE`、`SEEDAODB_DATASOURCES_FILE`、`SEEDAODB_ACL_FILE`、`SEEDAODB_TOKEN_CACHE_TTL_S`、`SEEDAODB_BUSY_RETRY_MAX`、`SEEDAODB_MAX_BODY_BYTES`、`SEEDAODB_TLS_CERT` / `_TLS_KEY`、`SEEDAODB_AUDIT_LOG`)。所有变量都以 `SEEDAODB_` 为前缀,并从本目录自己的 `.env` 读取;不会读取宿主项目根目录的 `.env`。

## 用 pm2 部署

```bash
cd tools/seedaodb
cargo build --release
pm2 start ecosystem.config.cjs
pm2 logs seedaodb
```

`ecosystem.config.cjs` 只存在于本目录,绝不会被并进宿主项目自己的 pm2/supervisor 配置。pm2 进程名固定为 `seedaodb`,以免将来宿主项目自己也用上 pm2 时发生命名冲突。

pm2 在普通的 `pm2 restart` 时不会重新加载环境变量。改完 `.env` 后请执行:

```bash
pm2 restart seedaodb --update-env
```

部署前请确保已安装 pm2(`npm install -g pm2`,或用 `npx pm2`)。

## 与宿主项目解耦

- 独立的 Cargo crate,有自己的 `Cargo.toml` / `Cargo.lock`;不属于任何 pnpm workspace,不在宿主项目的 TypeScript 构建路径上(`pnpm build` 只编译 `.ts`)。
- 不 `import` / `require` 任何 `src/` 下的 TypeScript 模块。
- 不读取宿主项目的 `configs/admins.json` 或 `.agent/auth/`;`acl.toml` 里 `admin` 角色的 `open_id` 列表由人工同步,作为一个运维步骤。
- 不被加入任何 pnpm workspace 文件。
- `.gitignore` 把 `target/`、`.env`、`config/*.toml`(真正带凭据的文件)和 `logs/` 排除在版本控制之外;只有 `.example` 模板和本 README 会入库。

## 已知限制 / 待办

- **MySQL 后端**:仅骨架(`src/db/mysql.rs`,`mysql-backend` feature),每个方法都返回「未实现」。可用之前需要一个真实驱动,外加一份表结构 / 方言迁移方案。
- **`identity_links` 合并**:宿主项目的 `shared.db` 有一张 `identity_links` 表,用来把多个应用专属的 `open_id` 合并到一个逻辑身份上。本服务不查它(默认关闭,以免让鉴权层对 `shared.db` 产生硬依赖);RBAC 目前按身份校验器返回的原始 `open_id` 匹配。
- **限流**:未实现;见上文「安全」。
- **自终结 TLS**:`SEEDAODB_TLS_CERT` / `_TLS_KEY` 会被读入但尚未接到 HTTPS 监听器上;今天请用反向代理来做 TLS。
- **语句防护是前缀 / 关键字式的**,不是解析器;它能拦什么、不能拦什么,见上文「语句防护」。
- **`admin` open_id 同步**:手动,从 `configs/admins.json` 同步进 `acl.toml`;没有自动同步机制(刻意为之,以免两套代码库重新耦合)。

## 测试

```bash
cargo build --release
cargo test
```

`tests/integration.rs` 直接驱动路由(`Router::oneshot`,不起真实 TCP 监听器),针对一个由 `tempfile` 支撑的 SQLite 数据库和一个 `StaticVerifier` 运行,因此整个套件离线跑通,绝不碰 `.agent/tudigong.db` 或 `.agent/shared.db`。
