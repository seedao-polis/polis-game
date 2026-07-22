# seedaodb 数据库网关工具 playbook

> `tools/seedaodb/`（Rust HTTP 服务端）+ `tools/seedaodb-client/`（Rust CLI 客户端）是一对**独立于 polis-game 框架**的工具，用来给 tudigong 的 SQLite 库开一个带鉴权的 SQL CRUD 网关。与主程序**零代码耦合**，不进 tsc/pnpm workspace，不整合进 agent 的 pm2，只通过文件路径共享同一颗 SQLite 库。研究/施工全文见 `thoughts/shared/research/2026-07-17-seedaodb-*.md` 与 `thoughts/shared/coding/2026-07-17-seedaodb-*.md`。

## 0. 定位与两个 crate

- **`tools/seedaodb/`**：axum + sqlx 的 HTTP 服务，对 tudigong 两颗库提供通用 SQL 存取（`/query` 只读、`/exec` 读写、`/tables`、`/datasources`、`/health`）。
- **`tools/seedaodb-client/`**：clap CLI，演示怎么用上面那个服务；含飞书身份登录与权限呈现。
- 两者各自 `Cargo.toml`/`Cargo.lock`、各自 `.env`、可独立 build/test。**只动这两个目录**，别去改主程序。

## 1. 服务端架构（要点）

- **技术栈**：`axum` + `tokio` + `sqlx`（edition 2024，本机 `cargo/rustc 1.94`）。
- **⚠️ 用具体 `sqlx::SqlitePool`，不用 `sqlx::Any`**：本服务核心工作是把「任意结果集」解码成 JSON，`Any` 驱动的动态列类型覆盖窄、不可靠。动态列按 SQLite **运行期存储类别**逐格解码（INTEGER→number、REAL→number、BLOB→base64 字符串、其余→字符串），不看声明类型（SQLite 逐行动态定型）。
- **可插拔后端**：datasource 用**具名**（`soul`/`shared` → URL）抽象，API 只认逻辑名、永不接受调用方传任意路径/连接串。换 MySQL 只改 `config/datasources.toml` 的 `url`；`src/db/mysql.rs` 是 `mysql-backend` feature-gate 的骨架（默认不编进去）。**⚠️ 后端抽象统一不了 SQL 方言**——FTS5/`PRAGMA`/`INSERT OR IGNORE` 等是 SQLite 专属，真换 MySQL 要另做 schema/方言迁移。
- **`/exec` 写入**：短事务 + `busy_timeout` + 对 `SQLITE_BUSY`/`SQLITE_LOCKED` 做有上限指数退避（`SEEDAODB_BUSY_RETRY_MAX`）。语句黑名单挡 `VACUUM`/`ALTER`/`DROP`/`CREATE`/`ATTACH`/`PRAGMA journal_mode` 等（`sql_guard.rs`，是前缀/关键字匹配**不是** SQL parser）。

## 2. 三道闸门鉴权

1. **service token（粗闸门）**：`Authorization: Bearer` 或 `X-Service-Token`，比对 `SEEDAODB_SERVICE_TOKEN`（常数时间比较）。**未设 = 除 `/health` 外全 401（fail-closed）**，没有「无闸门」退路。
2. **身份**：`X-Feishu-User-Token` 换 `open_id`，验证器可切换（`SEEDAODB_AUTH_MODE=feishu|static`）。`feishu` 打飞书 `authen/v1/user_info`；`static` 查本地 `static-tokens.toml`（离线开发/测试用）。
3. **RBAC**：在 handler 里 `acl.authorize(open_id, db, Read|Write)`，回 403 `FORBIDDEN`（消息含拒因，客户端原样透传）。ACL（`config/acl.toml`）：`open_id → role → { read:[db], write:[db] }`、`default_role`（可为 `"deny"`）。**⚠️ ACL 文件缺失/格式错 = 启动即失败**，绝不空 ACL 全放行。**admin 的 open_id 从 `configs/admins.json` 手动同步**（服务端刻意不直接读该文件，保持解耦）。

## 3. ⚠️ 关键 DB 事实（复用 local-db 的结论）

- **soul 库 = `.agent/tudigong.db`、shared 库 = `.agent/shared.db`**；仓库根的 `tudigong.db` 是 0 字节空壳别碰。
- 两颗库跑**同一份** `runMigrations()`，所以物理上 schema 完全相同（`/tables` 对 soul/shared 返回同一张表清单）；「哪张表该读哪颗」纯属应用约定，非 schema 强制。
- 都是 **WAL 模式**。**⚠️ per-soul `getDb()` 没设 `busy_timeout`，只有 shared 的 `getLpDb()` 设了 5000ms**（`src/core/db.ts`）——seedaodb 一旦写入就是 serve worker + supervisor + MCP 子进程之外的第三方写者，所以 seedaodb 端**必须**自己设 `busy_timeout` + 退避。
- **⚠️ 写 shared.db（LP 账本）会绕过主程序 `grantPt()` 记账**（`pt_ledger` append-only + `profiles.pt_balance` 派生），造成账本/余额不一致。**双层保护**：datasources 里把 `shared` 设 `readonly=true`（连接层只读，连 admin 也挡下，实测报 500 DATABASE_ERROR），且 ACL 只给 admin 写 shared；`soul` 才 `readonly=false`。要放开 shared 写入是刻意动作，改 `readonly=false`。
- **⚠️ `shared.db`／`tudigong.db` 有一份 PostgreSQL 迁移计划已在 2026-07-21 完成代码与 ETL 验证**（`feishu_biz` 库的 `shared`/`soul_tudigong` schema，见 `pg-migration-playbook.md`），**但截至目前正式割接尚未执行**——tudigong 生产行程仍在跑本节说的这两颗 SQLite 档案，`tools/seedaodb` 目前读到的就是**即时生产数据**，不是冻结快照。**等正式割接真的执行之后**（详见 `pg-migration-playbook.md` 的执行手册），这两颗 `.agent/*.db` 会改唯读权限、封存至少 30 天，届时 `tools/seedaodb` 读到的才会变成"迁移前的冻结快照"，需要另外接上 PostgreSQL 才能读到即时数据（`tools/seedaodb` 本身尚未规划接 PG，见该 playbook 的后续工作）——**维护者看到这份 playbook 时请先确认割接是否已执行**（检查 `.agent/tudigong.db` 的档案权限，或问操作者），别想当然套用旧结论。

## 4. 客户端（seedaodb-client）

- clap CLI + lib 拆分；子命令 `login`/`logout`/`whoami`/`datasources`/`tables`/`rows`/`query`/`exec`。`--param` 先按 JSON 解析（null/数字/布尔/字符串），失败当纯字符串。
- **统一 `decode()` 稳健容错**：区分 envelope 成功/失败、**非 JSON 的 404**（axum 未注册路由 fallback → `UnregisteredRoute`）与 **JSON envelope 的 404**（handler `AppError::NotFound`），全程不 panic。
- **whoami 降级探测**（服务端目前**没有** `/whoami` 端点）：先试 `GET /whoami`，收到非 JSON 404 就降级——`/datasources` → 逐个 `GET /tables?db=` 探读 → **`POST /exec {sql:"SELECT 1"}` 探写**。这个 SELECT 1 是**安全写探针**：服务端「先 RBAC 授权、再语句防护」，无写权限会在授权就 403、`SELECT 1` 也不改数据。末尾固定提示「表级权限以服务端实际执行为准」。

## 5. ⚠️⚠️ lark-cli 不吐 token（实测结论，登录设计的地基）

- **lark-cli 不会、也没设计成把 `user_access_token`（`u-xxx`）交给外部程序**。实测 `@larksuite/cli@1.0.69`：`auth` 所有子命令（check/list/login/logout/qrcode/scopes/status）没一个导出 token；`auth status --json` 只有 `openId`/`scope`/`tokenStatus`/`expiresAt`，**无 token 值**；`~/.lark-cli/config.json` 连 appSecret 都只存 keychain 引用。
- **所以客户端 `feishu` 模式必须自己实作一段独立的飞书 user OAuth**，不能借 lark-cli 的 session。lark-cli 只能拿来做「本机身份对照显示」（whoami 里 best-effort，失败不致命，绝不把它的输出塞进给 seedaodb 的 header）。

## 6. 飞书 OAuth（authorization code + PKCE）

- **采 authorization code + PKCE，不用 device flow**。device flow 的 `/oauth/v1/device_authorization` 是半内部端点、官方文档没公开，硬用有风险。
- **端点（都已核实，别凭记忆改）**：
  - authorize（取 code）：`GET https://accounts.feishu.cn/open-apis/authen/v1/authorize`（`client_id`/`response_type=code`/`redirect_uri`/`scope`/`state`/`code_challenge`/`code_challenge_method=S256`）。
  - token（换/刷新）：`POST https://open.feishu.cn/open-apis/authen/v2/oauth/token`（authorization_code / refresh_token grant，JSON）。
  - user_info（取 open_id）：`GET /open-apis/authen/v1/user_info`，`Authorization: Bearer <u-xxx>`。
- **⚠️ scope 必须含 `offline_access` 才会发 refresh_token**；redirect_uri 要在飞书后台 Security Settings **完全一致**注册（scheme/host/port/path）。
- **端点来源**：token/user_info/device 端点是从**本机 lark-cli 的 Go 二进制** `strings` 挖出来的（`bin/lark-cli` 是 Mach-O，不是 JS）；authorize 端点 + 参数用**飞书官方文档**核实。这是研究里刻意「不凭记忆猜端点」的做法。
- 客户端流程：`login` 生成 state+PKCE → 打印/开浏览器 authorize URL → 默认**一次性 loopback 监听器**（`127.0.0.1:<port>`，先绑端口再显示 URL，端口冲突 fail-fast）自动接 callback；`--manual` 则粘贴回 URL/code → 换 token 存本地（Unix `0600`）→ 后续命令自动用/刷新（过期前 60 秒缓冲，refresh token 会轮替要回存）。
- **⚠️ 这条 feishu 流程尚未对真实飞书 app 端到端验证**（研究/实作都没触网，靠 wiremock 离线测试覆盖逻辑）。首跑失败最可能三因：redirect URI 没完全对上、scope 没开通、app 与服务端不是同一个（建议客户端 OAuth 用与服务端 `SEEDAODB_FEISHU_APP_ID` **同一个 app**，因服务端 `FeishuVerifier` 要 app 层 session）。

## 7. ⚠️ 两个落差（要满足「每张表不同权限」还得改服务端）

- **表级权限没做**：RBAC 只到 **datasource（db）层**。`/tables`、`/tables/:name/rows` 表名是结构化参数，加表级 ACL 几乎零成本；但 `/query`/`/exec` 收任意 SQL，要可靠列举「这句碰哪些表」需引入 `sqlparser` 做语法树解析 + 处理 JOIN/子查询/CTE 且 **fail-closed**，是独立大工程。**决策（2026-07-17）**：表级先只做 `/tables`/`rows`，`/query`//`exec` 列后续里程碑。
- **无 `/whoami` 端点**：客户端靠降级探测（见 §4）。
- **⚠️ 客户端自查权限只是 UX 提示、不是安全边界**——真正判定必须在服务端（恶意/有 bug 的客户端能直接打 HTTP 绕过）。

## 8. Windows / 部署拓扑

- **⚠️ Windows 上 lark-cli 是 `.cmd` shim**，别 `Command::new("lark-cli")`；照搬主程序 `src/core/paths.ts:65-85` 的 `resolveLarkRun()` 候选路径搜索，找到 `@larksuite/cli/scripts/run.js` 后一律 `node run.js ...`，绕开 shim + 中文/emoji 编码问题。
- **配置文件全 gitignore**（`.env`/`config/*.toml`），**不会随 git 到 Windows**，两端都要 `cp *.example` 后手填。
- **部署拓扑**：真实 `.agent/*.db` 在开发机（Mac）。所以 **seedaodb 服务端跑在数据所在处（Mac）**、用 port mapping 暴露；**客户端可跑 Windows** 连过来。客户端只认 `SEEDAODB_CLIENT_BASE_URL`。
- **TLS**：服务端默认不自终结 TLS，本机/局域网测试走明文 HTTP；对外要放 TLS 反向代理后。

## 9. 构建 / 验证 / 约定

- **构建**：各自目录 `cargo build --release`；`cargo test` 用 `wiremock` 起假服务，**离线、不碰真实库/网络**。seedaodb 22 测试、client 58 测试（含 RFC 7636 PKCE 固定向量）。
- **本地 static 实测已打通**（2026-07-17，Mac）：起服务端连上 soul+shared，客户端 `login`/`datasources`/`tables`/`query` 全通，读到真数据（`pt_ledger` 354、`profiles` 39）；RBAC 生效（readonly token 写 → 403）；shared 只读挡 admin 写（500）；审计日志 4 条 `/exec` 全记录（含被拒），参数值不落地。
- **⚠️ rtk hook 不影响 `cargo`**，但会坏 `grep --include`、`find -not/-exec`——查代码用 `rg`、遍历用 `/usr/bin/find`。
- **开发约定**：开发过程**不 commit / 不 PR**（用户自己 commit）；代码注释一律**英文**、只写静态功能/设计、不写日期/计划/改动历史；代码内中文字符串用**简体大陆用语**，但面向开发者的消息/日志/README 一律英文。见 [[local-db-playbook]] 的 DB 事实、[[lark-cli-playbook]] 的 lark-cli 身份。

## 10. 配置文件清单（gitignore，启动前 cp *.example）

- 服务端 `tools/seedaodb/`：`.env`（`SEEDAODB_*`：PORT 8878、BIND_ADDR、SERVICE_TOKEN、AUTH_MODE、FEISHU_APP_ID/SECRET、各文件路径、BUSY_RETRY_MAX、AUDIT_LOG）、`config/datasources.toml`（soul→tudigong.db、shared→shared.db 且 readonly）、`config/acl.toml`（admin 从 admins.json 同步）、`config/static-tokens.toml`（token→open_id）。
- 客户端 `tools/seedaodb-client/`：`.env`（`SEEDAODB_CLIENT_*`：BASE_URL、SERVICE_TOKEN、AUTH_MODE、STATIC_TOKEN、FEISHU_APP_ID/SECRET、SCOPE、OAUTH_REDIRECT_PORT、TOKEN_FILE）。操作指南在 `tools/seedaodb-client/README.md`。
