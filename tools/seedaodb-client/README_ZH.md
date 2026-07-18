# seedaodb-client

一个独立的 Rust CLI 客户端,面向 [`tools/seedaodb`](../seedaodb)——那个挡在 tudigong SQLite 数据库前面的 HTTP SQL 网关。本 crate 演示了如何正确地与该服务对话:在每个受保护请求上同时带齐两种必需凭据、区分请求失败的各种不同方式,以及处理 seedaodb 支持的两种鉴权模式——固定的静态 token,或经由本客户端自身 OAuth 登录拿到的真实飞书用户身份。

本 crate 完全自包含。它不引用外层 `polis-game` Node/TypeScript 项目的任何代码,也不属于任何 pnpm workspace 或 Cargo workspace。它与 `tools/seedaodb` 唯一的关系,是双方讲同一套 HTTP 契约——两个 crate 不共享任何代码,可以彼此独立地构建 / 测试。

## 快速开始(static 模式)

static 模式完全不需要访问飞书网络,是确认本客户端能正确连上你的 seedaodb 服务端的最快方式。即便你最终打算用 `feishu` 模式,也从这里起步——在把 OAuth 掺进来之前,这是排除 base URL / 服务令牌问题的最快途径。

1. 在 seedaodb 服务端一侧,确保设置了 `SEEDAODB_AUTH_MODE=static`,并且 `config/static-tokens.toml` 至少有一条 `[[token]]` 条目(参见 `tools/seedaodb/config/static-tokens.toml.example`)。启动(或重启)该服务端。
2. 在本目录下:

   ```bash
   cd tools/seedaodb-client
   cp .env.example .env
   # 编辑 .env:SEEDAODB_CLIENT_BASE_URL、SEEDAODB_CLIENT_SERVICE_TOKEN(必须与服务端的
   # SEEDAODB_SERVICE_TOKEN 一致)、SEEDAODB_CLIENT_STATIC_TOKEN(必须是服务端已注册的
   # 某个静态 token)。

   cargo build --release
   ./target/release/seedaodb-client login
   ```

   `login` 成功会打印 `login ok (static mode)`。它恰好发两次请求:一次未鉴权的 `GET /health`(确认服务端可达),再一次已鉴权的 `GET /datasources`(确认服务令牌 + 静态 token 的组合确实能通过服务端的两道鉴权闸门)。

3. 接下来:

   ```bash
   ./target/release/seedaodb-client datasources
   # name                 backend      readonly
   # soul                 sqlite       false
   # shared               sqlite       true

   ./target/release/seedaodb-client tables --db soul
   # messages
   # chats

   ./target/release/seedaodb-client rows --db soul --table messages --limit 10
   # id | body
   # 1 | hi
   # (1 row)
   # note: each value is decoded from SQLite's runtime storage class, ...

   ./target/release/seedaodb-client query --db soul --sql "SELECT id, body FROM messages LIMIT 5"
   ./target/release/seedaodb-client exec --db soul --sql "UPDATE messages SET body = ? WHERE id = ?" --param "edited" --param 1
   # changes: 1, lastInsertRowid: 0

   ./target/release/seedaodb-client whoami
   # open_id: ...
   # role:    ...
   #
   # datasource           read     write
   # shared               yes      no
   # soul                 yes      yes
   #
   # note: table-level permissions are decided entirely by the seedaodb server ...
   # lark-cli cross-check: ...

   ./target/release/seedaodb-client logout
   # logged out. Note: in static mode this only clears the local login marker ...
   ```

`dotenvy` 从**当前工作目录**读取 `.env`,所以请在 `tools/seedaodb-client/` 目录下运行该二进制(或以其他方式确保一份带这些变量的 `.env` 能被找到)——见下文「Windows 注意事项」。

## 子命令

| 子命令 | 服务端端点 | 说明 |
|---|---|---|
| `login [--manual]` | 无(static 模式下是本地操作 + 一次 health/datasources 探测;feishu 模式下是一次真实的飞书 OAuth 交换) | 见下文「鉴权模式」。`--manual` 只对 feishu 模式有效。 |
| `logout` | 无 | 清除本地登录状态文件。 |
| `whoami` | `GET /whoami`,失败则回退到探测 | 见下文「whoami」。 |
| `datasources` | `GET /datasources` | 列出数据源的 name/backend/readonly。 |
| `tables --db <name>` | `GET /tables?db=` | 列出表名。 |
| `rows --db <name> --table <name> [--limit] [--offset]` | `GET /tables/:name/rows` | 分页浏览行;服务端 `limit` 默认 100,上限 1000。 |
| `query --db <name> --sql <...> [--param <value>]...` | `POST /query` | 只读;服务端只接受以 `SELECT`、`PRAGMA table_info`、`EXPLAIN` 开头的语句。 |
| `exec --db <name> --sql <...> [--param <value>]...` | `POST /exec` | 读写;服务端拒绝改结构的语句(`VACUUM`/`ALTER`/`DROP`/`CREATE`/...)。 |

`--param` 可以重复出现,按位置绑定(对应 `?` 占位符),与服务端自己的绑定模型一致。每个值会先尝试当作 JSON 解析,因此 `null`、`true`/`false`、整数 / 浮点会以它们各自的 SQLite 原生存储类别绑定;任何无法解析为 JSON 的东西(包括一个裸的、不加引号的词)都会作为纯字符串发送,所以命令行上普通的文本值从不需要手动加引号。查询 / 行结果打印时,每个单元格都按 SQLite **运行期实际存储类别**解码,而非声明的列类型——`BLOB` 列会以 base64 编码字符串的形式呈现。

每一个响应错误都会渲染成一行可读文本:取自服务端 JSON 信封的 `error.code` / `error.message`,其中 `FORBIDDEN` 始终原样带上服务端自己的 RBAC 拒绝消息(例如 `role "readonly" cannot write to datasource "shared"`),而不是把它重新措辞成一句摘要。一个带纯文本响应体的 404(未注册的路由)和一个带 JSON 信封的 404(某个 handler 自己的「未找到」)都能被无 panic 地处理,并被区别对待地报告出来——至于这个区分为什么重要,见下文「whoami」。

## 鉴权模式

由 `SEEDAODB_CLIENT_AUTH_MODE` 选择:

### `static`

不涉及任何对飞书的网络调用。`login` 会校验 `SEEDAODB_CLIENT_STATIC_TOKEN` 已设置,然后对在线服务端探测一次(`GET /health` + 一次已鉴权的 `GET /datasources`),以证明服务令牌 + 静态 token 的组合确实能通过服务端的两道鉴权闸门。此后每一条命令都会发送 `X-Feishu-User-Token: <SEEDAODB_CLIENT_STATIC_TOKEN>`。

### `feishu`

本客户端跑自己的一套飞书用户 OAuth 登录——它不会「借用」本机 lark-cli 的会话。lark-cli 的 `auth status --json` 暴露的是登录**状态**(`openId`、`tokenStatus`……),但从不把底层的 access token 字符串交给外部进程;这是 lark-cli 自身的设计,不是疏漏(见 `src/lark_shell.rs` 的模块文档)。所以 feishu 模式下的 `login` 直接对飞书 OpenAPI 说话,走的是 **authorization-code + PKCE** 的 OAuth 2.0 流程(不是 device-code):

1. 本客户端生成一个随机 `state`(用于 CSRF 防护)和一对 PKCE 的 `code_verifier` / `code_challenge`,然后打印一个 authorize URL 供你在浏览器里打开。
2. 你在浏览器里登录并批准该请求。飞书带着一个授权 `code` 重定向回本客户端注册的 redirect URI。
3. 默认情况下,本客户端此时已经在那个 redirect URI 上监听(一个一次性的本地 loopback HTTP 监听器),会自动捕获这个 `code`;它同时会尝试帮你打开默认浏览器(best-effort——如果失败,自己打开打印出来的 URL 即可)。传 `login --manual` 可跳过监听器,改为把重定向后的 URL(或仅仅那个 `code` 值)粘回终端——当你注册的 redirect URI 不是 loopback 地址、或那个 loopback 端口无法绑定时,用这个方式。
4. 本客户端用这个 `code`(加上原来的 `code_verifier`)换取一个 access token;由于默认 scope 含 `offline_access`,还会拿到一个 refresh token。
5. 它还会调用飞书的 `user_info` 端点解析出你的 `open_id` 以供显示;这一步是 best-effort 的,它自身绝不会让登录失败。
6. 结果被保存到本地登录状态文件(其位置见下文「环境变量」)。此后每一条命令都会读这个文件,在 access token 过期或距过期不足 60 秒时通过 refresh token 透明地刷新它,并把刷新后的值回存到同一个文件。如果 access token 已过期且没有可用的 refresh token(或者刷新本身失败),命令会报一条清晰的错误,让你重新跑 `login`。

#### feishu 模式的准备工作

在设置 `SEEDAODB_CLIENT_AUTH_MODE=feishu` 之前:

1. 在 [飞书开放平台](https://open.feishu.cn/) 开发者后台,创建(或复用)一个应用,记下它的 **App ID** 和 **App Secret**。
2. **建议:使用与 seedaodb 服务端相同的应用。** 服务端自己的 `FeishuVerifier`(`tools/seedaodb/src/auth/feishu.rs`)在校验用户 token 的同时,还会用 `SEEDAODB_FEISHU_APP_ID` / `_APP_SECRET` 去取自己的应用级 `tenant_access_token`,因为某些飞书部署要求在 per-user token 之外还存在一个应用级会话。在这里用一个与服务端不同的应用是未经验证的领域;除非你有特定理由,否则请把 `SEEDAODB_CLIENT_FEISHU_APP_ID` / `_APP_SECRET` 指向与服务端 `SEEDAODB_FEISHU_APP_ID` / `_APP_SECRET`(见 `tools/seedaodb/.env.example`)相同的应用。
3. 在应用的**安全设置**里,注册本客户端将使用的 redirect URI:
   - 默认(loopback)流程:`http://127.0.0.1:8899/callback`,或你通过 `SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT` 设置的任何端口(该 URI 必须完全一致,端口也算在内)。
   - `--manual` 流程:注册任何一个你能在浏览器重定向后从中取出 `code` 的 URI(它不需要本客户端能访问到——你是手动从浏览器地址栏里把 `code`/URL 拷出来的)。这里 loopback URI 也完全能用;你只是选择了不让本客户端自动捕获它而已。
4. 在应用的权限 / scope 里,确保你请求的 scope 已为该应用开通。**`offline_access` 是必需的**,飞书才会签发 `refresh_token`——没有它,`login` 仍会成功,但一旦 access token 过期,每条命令都会要求重新 `login`(飞书默认的 access token 寿命是几个小时)。

#### feishu 登录步骤

1. 在 `.env` 里设置:

   ```bash
   SEEDAODB_CLIENT_AUTH_MODE=feishu
   SEEDAODB_CLIENT_FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
   SEEDAODB_CLIENT_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   # 可选,仅当你需要覆盖默认值时:
   # SEEDAODB_CLIENT_FEISHU_SCOPE=offline_access
   # SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT=8899
   # SEEDAODB_CLIENT_FEISHU_REDIRECT_URI=
   ```

2. 运行:

   ```bash
   ./target/release/seedaodb-client login
   ```

   它会打印一个 authorize URL,在 loopback 监听器上等待浏览器重定向,并在成功时打印 `login ok (feishu mode), open_id=ou_xxxxxxxx`。

   如果 loopback 重定向不适合你的环境(见上文「feishu 模式的准备工作」),改用:

   ```bash
   ./target/release/seedaodb-client login --manual
   ```

   然后在提示时把重定向后的 URL(或仅那个 `code` 值)粘回终端。

3. 从此以后,其余每一条命令(`datasources`、`tables`、`rows`、`query`、`exec`、`whoami`)都会透明地使用(并按需刷新)`login` 拿到的那个 token——不需要在每条命令前重跑 `login`。

## `whoami`

`whoami` 会先尝试一个配套的 `GET /whoami` 端点。如果服务端从未注册过那条路由(被识别为一个非 JSON 的 404——即 axum 自己的路由 fallback,与某个 handler 自己那种带 JSON 信封的「未找到」不同),它会回退到用探测的方式重建一张权限矩阵:

1. `GET /datasources` 拿到数据源名称列表。
2. 对每个数据源,`GET /tables?db=<name>` 探测读权限(200 = 可读,403 = 不可读)。
3. 对每个数据源,`POST /exec {db, sql: "SELECT 1"}` 探测写权限。这是安全的:服务端在语句校验**之前**先做 RBAC 授权,`SELECT` 从不在 `/exec` 的语句黑名单里,而且 `SELECT 1` 即便被允许执行也不改动任何数据。

两条路径都打印同一张「datasource x read/write」表,并以同一句提醒结尾:**表级权限完全由服务端在执行时判定;本客户端无法提前预测某条具体的 SQL 语句是否会被拒绝。** 应把服务端的实际响应、而非本命令的输出,当作事实来源。

`whoami` 还会跑一次 best-effort 的、纯信息性的 lark-cli 身份对照(见下文「Windows 注意事项」),让运维人员能把「本客户端认证成了谁」与「本机 lark-cli 认为你是谁」两相比较。找不到或跑不起 lark-cli 绝不会让 `whoami` 本身失败,而且来自 lark-cli 的任何东西都绝不会被发给 seedaodb。

## 环境变量

完整、带注释的清单见 `.env.example`:

| 变量 | 用途 |
|---|---|
| `SEEDAODB_CLIENT_BASE_URL` | seedaodb 服务端的 base URL,例如 `http://127.0.0.1:8878`。必填。 |
| `SEEDAODB_CLIENT_SERVICE_TOKEN` | 作为 `Authorization: Bearer` 发送;必须与服务端的 `SEEDAODB_SERVICE_TOKEN` 一致。 |
| `SEEDAODB_CLIENT_AUTH_MODE` | `static` 或 `feishu`。默认 `static`。 |
| `SEEDAODB_CLIENT_STATIC_TOKEN` | `static` 模式必填;必须是服务端 `static-tokens.toml` 里已注册的 token。 |
| `SEEDAODB_CLIENT_TOKEN_FILE` | 本地登录状态文件路径的可选覆盖项。默认落在按用户区分的配置目录下——见「Windows 注意事项」。 |
| `SEEDAODB_CLIENT_FEISHU_APP_ID` / `_APP_SECRET` | `feishu` 模式必填。见上文「feishu 模式的准备工作」;建议用与 seedaodb 服务端相同的应用。 |
| `SEEDAODB_CLIENT_FEISHU_TOKEN_BASE_URL` | 飞书 token 交换 / 刷新与 user_info 端点的 base URL。默认 `https://open.feishu.cn`。 |
| `SEEDAODB_CLIENT_FEISHU_AUTHORIZE_BASE_URL` | 飞书 authorize 端点的 base URL。默认 `https://accounts.feishu.cn`。 |
| `SEEDAODB_CLIENT_FEISHU_SCOPE` | `login` 时请求的 OAuth scope(空格分隔)。默认 `offline_access`;必须含它才会签发 `refresh_token`。 |
| `SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT` | `login` 等待浏览器重定向时绑定的 loopback 端口(仅默认流程)。默认 `8899`。 |
| `SEEDAODB_CLIENT_FEISHU_REDIRECT_URI` | redirect URI 的可选显式覆盖项。默认 `http://127.0.0.1:<SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT>/callback`。必须与应用安全设置里注册的完全一致。 |
| `SEEDAODB_CLIENT_LARK_RUN` | 定位 lark-cli 的 `run.js`(供 `whoami` 身份对照用)的可选覆盖项;`LARK_RUN` 也被认可。 |

## Windows 注意事项

- **`.env` 的位置**:`dotenvy` 从当前工作目录读取 `.env`。请在 `tools\seedaodb-client\` 目录下运行二进制,或以其他方式确保一份能被找到的 `.env` 设置了这些变量。
- **本地登录状态文件**:默认在 `%APPDATA%\seedaodb-client\token.json`,而不是当前工作目录,这样从不同文件夹运行二进制时,登录状态不会看起来「消失了」。
- **loopback 端口冲突(feishu 模式)**:如果 `login` 报它无法绑定 loopback 监听器,多半是另一个进程已经在用那个端口。把 `SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT` 设成一个空闲端口(并在应用安全设置里重新注册对应的 redirect URI),或者改用 `login --manual`。
- **lark-cli 的调用方式(仅当你启用 `whoami` 对照时才相关)**:本客户端从不直接调用 `lark-cli` / `lark-cli.cmd`。全局用 npm 装在 Windows 上的 `lark-cli` 是一个 `.cmd` shim,而 `std::process::Command` 不加一层 shell 是无法可靠调起它的(那一层 shell 又有它自己的参数转义怪癖)。因此本客户端用与宿主项目自身 TypeScript 工具链相同的候选路径搜索(`src/core/paths.ts` 的 `resolveLarkRun()`)解析出 lark-cli 的 `run.js` 脚本,然后一律以 `node <run.js> auth status --json` 运行它。候选顺序:`SEEDAODB_CLIENT_LARK_RUN` -> `LARK_RUN` -> `%APPDATA%\nvm_symlink\node_modules\@larksuite\cli\scripts\run.js` -> `<node 目录>\..\lib\node_modules\@larksuite\cli\scripts\run.js` -> `<node 目录>\node_modules\@larksuite\cli\scripts\run.js`。`node` 本身被假定在 `PATH` 上(与 TypeScript 实现的假定相同);如果 lark-cli 找不到或跑不起来,`whoami` 会打印一行信息性提示后照常继续。
- **TLS**:seedaodb 服务端默认不自己终结 TLS(见它自己的 README)。本地 / 局域网测试走明文 HTTP;只有在服务端被放到一个终结 TLS 的反向代理之后,才把 `SEEDAODB_CLIENT_BASE_URL` 指向 `https://`。飞书自己的端点(`open.feishu.cn`、`accounts.feishu.cn`)无论你怎么连 seedaodb 本身,始终是 `https://`。
- **端口映射**:本客户端连 seedaodb 只用 `SEEDAODB_CLIENT_BASE_URL`——它不探测端口,也不假设任何超出你配置之外的默认值。`SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT` 与此无关,只影响上文描述的 feishu 模式 loopback 监听器。

## 已知限制 / 待办

- **飞书 OAuth 登录尚未针对真实飞书应用做端到端验证。** 实现遵循 authorization-code + PKCE 流程,以及编写时飞书开放平台文档所载的 v2 token 端点形状,并有针对一个 mock token 端点的离线测试覆盖(见下文「测试」),但首次对真实应用运行时,可能暴露文档与现实的不一致。如果 `login` 端到端跑不通,可能的失败点:redirect URI 没有按配置完全一致地注册(scheme、host、port、path 都要对上)、请求的 scope 没为该应用开通,或者该应用与 seedaodb 服务端自己信任的应用不是同一个(见上文「feishu 模式的准备工作」)。
- **本 crate 不对服务端做任何配套改动。** 如果某个 seedaodb 部署恰好有 `GET /whoami`,就机会性地用它,没有则优雅回退;本 crate 不会去添加那个端点、扩展表级 ACL,或以其他方式修改 `tools/seedaodb`。
- **表级权限从不在客户端侧预测。** 某个具体的表读 / 写或 SQL 语句是否被允许,只由服务端的实际响应决定;seedaodb 今天强制执行的 ACL 模型是按数据源的,对 `/query` / `/exec` 还不是按表的。
- **本地登录状态存储是一个普通文件,不是操作系统的凭据库。** 该文件在平台支持时以仅属主可访问的权限写入(Unix `0600`),并默认落在按用户区分的 profile 目录下,但它没有加密。在 `feishu` 模式下,这个文件现在存着一个真实的飞书 access token,以及(当授予了 `offline_access` 时)refresh token;请像对待任何其他凭据文件一样谨慎对待它。如果将来需要加固,可考虑用 `keyring` crate(集成操作系统凭据库)来替代普通文件。

## 测试

```bash
cargo build --release
cargo test
```

- `tests/integration.rs` 让 `client::SeedaodbClient` 针对一个由 `wiremock` 托管、绑定在临时本地端口上的假 seedaodb 服务端运行——不涉及任何真实网络访问,也不涉及任何真实的 seedaodb 进程。
- `tests/feishu_oauth_integration.rs` 让 `feishu_oauth::FeishuOAuthClient`(token 交换、刷新、user_info)和 `auth::resolve_user_token` 针对一个由 `wiremock` 托管的假飞书 token 端点运行,其中包含一次完整往返,证明一个过期的 feishu 模式 access token 会被刷新、并且新的 token/refresh-token/过期时间会被回存到登录状态文件——同样,不涉及任何真实网络访问,也不涉及任何真实飞书端点。
- `src/config.rs`、`src/params.rs`、`src/lark_shell.rs`、`src/feishu_oauth.rs`、`src/auth.rs` 里的单元测试覆盖了配置解析、`--param` 的 JSON 类型推断、lark-cli 路径解析、PKCE 生成(用 [RFC 7636 附录 B](https://www.rfc-editor.org/rfc/rfc7636#appendix-B) 里的固定 verifier/challenge 向量核对)、authorize-URL 构造、OAuth 回调 / 手动输入解析、token 响应解析(含两种有文档记载的飞书错误形状),以及 token 过期缓冲逻辑——全程不碰真实环境变量、不碰临时安全候选路径之外的文件系统,也不碰任何真实网络端点。
