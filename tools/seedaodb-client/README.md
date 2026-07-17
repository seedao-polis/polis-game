# seedaodb-client

A standalone Rust CLI client for [`tools/seedaodb`](../seedaodb), the HTTP SQL gateway in front
of the tudigong SQLite databases. This crate demonstrates how to talk to that service correctly:
sending both required credentials on every protected request, distinguishing the different ways
a request can fail, and handling the two auth modes seedaodb supports -- a fixed static token, or
a real Feishu user identity obtained through this client's own OAuth login.

This crate is fully self-contained. It does not import anything from the surrounding
`polis-game` Node/TypeScript project and is not part of any pnpm workspace or Cargo workspace.
The only relationship to `tools/seedaodb` is that it speaks the same HTTP contract -- the two
crates share no code and can be built/tested independently of each other.

## Quick start (static mode)

Static mode requires no Feishu network access at all and is the fastest way to confirm this
client talks to your seedaodb server correctly. Start here even if you plan to use `feishu` mode
eventually -- it is the quickest way to rule out base URL/service-token problems before adding
OAuth into the mix.

1. On the seedaodb server side, make sure `SEEDAODB_AUTH_MODE=static` is set and
   `config/static-tokens.toml` has at least one `[[token]]` entry (see
   `tools/seedaodb/config/static-tokens.toml.example`). Start (or restart) that server.
2. In this directory:

   ```bash
   cd tools/seedaodb-client
   cp .env.example .env
   # edit .env: SEEDAODB_CLIENT_BASE_URL, SEEDAODB_CLIENT_SERVICE_TOKEN (must match the server's
   # SEEDAODB_SERVICE_TOKEN), and SEEDAODB_CLIENT_STATIC_TOKEN (must be one of the server's
   # registered static tokens).

   cargo build --release
   ./target/release/seedaodb-client login
   ```

   A successful `login` prints `login ok (static mode)`. It performs exactly two requests: an
   unauthenticated `GET /health` (confirms the server is reachable), then an authenticated
   `GET /datasources` (confirms the service token + static token combination actually passes
   both of the server's auth gates).

3. From there:

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

`dotenvy` reads `.env` from the **current working directory**, so run the binary from
`tools/seedaodb-client/` (or otherwise ensure a `.env` with these variables is discoverable) --
see "Windows notes" below.

## Subcommands

| Subcommand | Server endpoint | Notes |
|---|---|---|
| `login [--manual]` | none (local + a health/datasources probe in static mode; a real Feishu OAuth exchange in feishu mode) | See "Auth modes" below. `--manual` only affects feishu mode. |
| `logout` | none | Clears the local login-state file. |
| `whoami` | `GET /whoami`, falling back to probing | See "whoami" below. |
| `datasources` | `GET /datasources` | Lists datasource name/backend/readonly. |
| `tables --db <name>` | `GET /tables?db=` | Lists table names. |
| `rows --db <name> --table <name> [--limit] [--offset]` | `GET /tables/:name/rows` | Paginated row browsing; server defaults `limit` to 100, caps it at 1000. |
| `query --db <name> --sql <...> [--param <value>]...` | `POST /query` | Read-only; the server only accepts statements starting with `SELECT`, `PRAGMA table_info`, or `EXPLAIN`. |
| `exec --db <name> --sql <...> [--param <value>]...` | `POST /exec` | Read-write; the server rejects schema-changing statements (`VACUUM`/`ALTER`/`DROP`/`CREATE`/...). |

`--param` may be repeated and binds positionally (`?` placeholders), matching the server's own
binding model. Each value is first tried as JSON, so `null`, `true`/`false`, and
integers/floats bind as their native SQLite storage classes; anything that fails to parse as
JSON (including a bare, unquoted word) is sent as a plain string, so ordinary text values never
need manual quoting on the command line. Query/row results print each cell decoded from
SQLite's actual runtime storage class, not a declared column type -- `BLOB` columns come through
as base64-encoded strings.

Every response error is rendered as one readable line: `error.code`/`error.message` from the
server's JSON envelope, with `FORBIDDEN` always including the server's own RBAC denial message
verbatim (e.g. `role "readonly" cannot write to datasource "shared"`) rather than a rephrased
summary. A 404 with a plain-text body (an unregistered route) and a 404 with a JSON envelope (a
handler's own "not found") are both handled without panicking, and are reported differently --
see `whoami` below for why that distinction matters.

## Auth modes

Selected by `SEEDAODB_CLIENT_AUTH_MODE`:

### `static`

No network call to Feishu is involved. `login` verifies `SEEDAODB_CLIENT_STATIC_TOKEN` is set,
then probes the live server once (`GET /health` + an authenticated `GET /datasources`) to prove
the service token + static token combination actually passes both of the server's auth gates.
Every subsequent command sends `X-Feishu-User-Token: <SEEDAODB_CLIENT_STATIC_TOKEN>`.

### `feishu`

This client runs its own Feishu user OAuth login -- it does not "borrow" a local lark-cli
session. lark-cli's `auth status --json` exposes login *state* (`openId`, `tokenStatus`, ...) but
never the underlying access token string to an external process; that is lark-cli's own design,
not an oversight (see `src/lark_shell.rs`'s module docs). So `login` in feishu mode talks to the
Feishu OpenAPI directly using an **authorization-code + PKCE** OAuth 2.0 flow (not device-code):

1. This client generates a random `state` (CSRF protection) and a PKCE `code_verifier`/
   `code_challenge` pair, then prints an authorize URL for you to open in a browser.
2. You sign in and approve the request in the browser. Feishu redirects back to this client's
   registered redirect URI with an authorization `code`.
3. By default, this client is already listening on that redirect URI (a one-shot local loopback
   HTTP listener) and captures the `code` automatically; it also tries to open your default
   browser for you (best-effort -- if that fails, just open the printed URL yourself). Pass
   `login --manual` to skip the listener and instead paste the redirected URL (or just the `code`
   value) back into the terminal -- use this if your registered redirect URI is not a loopback
   address, or if the loopback port cannot be bound.
4. This client exchanges the `code` (plus the original `code_verifier`) for an access token and,
   since the default scope includes `offline_access`, a refresh token.
5. It also calls Feishu's `user_info` endpoint to resolve your `open_id` for display; this step
   is best-effort and never fails the login by itself.
6. The result is saved to the local login-state file (see "Environment variables" below for its
   location). Every subsequent command reads this file, transparently refreshing the access token
   via the refresh token when it is expired or within 60 seconds of expiring, and persisting the
   refreshed values back to the same file. If the access token has expired and no refresh token
   is available (or refreshing itself fails), the command reports a clear error asking you to run
   `login` again.

#### Feishu mode setup

Before setting `SEEDAODB_CLIENT_AUTH_MODE=feishu`:

1. In the [Feishu Open Platform](https://open.feishu.cn/) developer console, create (or reuse) an
   app and note its **App ID** and **App Secret**.
2. **Recommended: use the same app as the seedaodb server.** The server's own `FeishuVerifier`
   (`tools/seedaodb/src/auth/feishu.rs`) fetches its own app-level `tenant_access_token` from
   `SEEDAODB_FEISHU_APP_ID`/`_APP_SECRET` alongside verifying the user token, because some
   Feishu deployments expect an app-level session to exist alongside the per-user token. Using a
   different app here than the server uses is untested territory; point
   `SEEDAODB_CLIENT_FEISHU_APP_ID`/`_APP_SECRET` at the same app as the server's
   `SEEDAODB_FEISHU_APP_ID`/`_APP_SECRET` (see `tools/seedaodb/.env.example`) unless you have a
   specific reason not to.
3. In the app's **Security Settings**, register the redirect URI this client will use:
   - Default (loopback) flow: `http://127.0.0.1:8899/callback`, or whatever port you set via
     `SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT` (the URI must match exactly, including the port).
   - `--manual` flow: register any URI you are able to retrieve the `code` from after the
     browser redirects (it does not need to be reachable by this client -- you are copying the
     `code`/URL out of the browser's address bar by hand). A loopback URI still works fine here
     too; you would just be choosing not to let this client capture it automatically.
4. Under the app's permissions/scopes, make sure the scopes you request are enabled for the app.
   **`offline_access` is required** for Feishu to issue a `refresh_token` -- without it, `login`
   still succeeds, but every command will require a fresh `login` once the access token expires
   (Feishu's default access-token lifetime is a couple of hours).

#### Feishu login steps

1. In `.env`, set:

   ```bash
   SEEDAODB_CLIENT_AUTH_MODE=feishu
   SEEDAODB_CLIENT_FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
   SEEDAODB_CLIENT_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   # Optional, only if you need to override the defaults:
   # SEEDAODB_CLIENT_FEISHU_SCOPE=offline_access
   # SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT=8899
   # SEEDAODB_CLIENT_FEISHU_REDIRECT_URI=
   ```

2. Run:

   ```bash
   ./target/release/seedaodb-client login
   ```

   This prints an authorize URL, waits for the browser redirect on the loopback listener, and
   (on success) prints `login ok (feishu mode), open_id=ou_xxxxxxxx`.

   If the loopback redirect does not work for your setup (see "Feishu mode setup" above), use:

   ```bash
   ./target/release/seedaodb-client login --manual
   ```

   and paste the redirected URL (or just the `code` value) back into the terminal when prompted.

3. From here on, every other command (`datasources`, `tables`, `rows`, `query`, `exec`, `whoami`)
   transparently uses (and refreshes, as needed) the token `login` obtained -- no need to re-run
   `login` before each one.

## `whoami`

`whoami` first tries a companion `GET /whoami` endpoint. If the server has never registered that
route (detected as a non-JSON 404 -- axum's own router fallback, distinct from a handler's own
JSON-enveloped "not found"), it falls back to reconstructing a permission matrix by probing:

1. `GET /datasources` for the list of datasource names.
2. Per datasource, `GET /tables?db=<name>` to probe read access (200 = readable, 403 = not).
3. Per datasource, `POST /exec {db, sql: "SELECT 1"}` to probe write access. This is safe: the
   server checks RBAC authorization *before* statement validation, `SELECT` is never in the
   `/exec` statement blocklist, and `SELECT 1` changes no data even when execution is allowed.

Both paths print the same "datasource x read/write" table and end with the same reminder:
**table-level permission is decided entirely by the server at execution time; this client
cannot predict in advance whether a specific SQL statement will be rejected.** Treat the
server's actual response, not this command's output, as the source of truth.

`whoami` also runs a best-effort, purely informational lark-cli identity cross-check (see
"Windows notes" below) so an operator can compare "who this client authenticated as" against
"who this machine's lark-cli thinks you are". Failure to find or run lark-cli never fails
`whoami` itself, and nothing from lark-cli is ever sent to seedaodb.

## Environment variables

See `.env.example` for the full, commented list:

| Variable | Purpose |
|---|---|
| `SEEDAODB_CLIENT_BASE_URL` | seedaodb server base URL, e.g. `http://127.0.0.1:8878`. Required. |
| `SEEDAODB_CLIENT_SERVICE_TOKEN` | Sent as `Authorization: Bearer`; must match the server's `SEEDAODB_SERVICE_TOKEN`. |
| `SEEDAODB_CLIENT_AUTH_MODE` | `static` or `feishu`. Defaults to `static`. |
| `SEEDAODB_CLIENT_STATIC_TOKEN` | Required for `static` mode; must be registered in the server's `static-tokens.toml`. |
| `SEEDAODB_CLIENT_TOKEN_FILE` | Optional override for the local login-state file path. Defaults to a per-user config directory -- see "Windows notes". |
| `SEEDAODB_CLIENT_FEISHU_APP_ID` / `_APP_SECRET` | Required for `feishu` mode. See "Feishu mode setup" above; using the same app as the seedaodb server is recommended. |
| `SEEDAODB_CLIENT_FEISHU_TOKEN_BASE_URL` | Base URL for the Feishu token exchange/refresh and user_info endpoints. Defaults to `https://open.feishu.cn`. |
| `SEEDAODB_CLIENT_FEISHU_AUTHORIZE_BASE_URL` | Base URL for the Feishu authorize endpoint. Defaults to `https://accounts.feishu.cn`. |
| `SEEDAODB_CLIENT_FEISHU_SCOPE` | Space-separated OAuth scopes requested during `login`. Defaults to `offline_access`; must include it for `refresh_token` issuance. |
| `SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT` | Loopback port `login` binds to while waiting for the browser redirect (default flow only). Defaults to `8899`. |
| `SEEDAODB_CLIENT_FEISHU_REDIRECT_URI` | Optional explicit override for the redirect URI. Defaults to `http://127.0.0.1:<SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT>/callback`. Must exactly match what is registered in the app's Security Settings. |
| `SEEDAODB_CLIENT_LARK_RUN` | Optional override for locating lark-cli's `run.js` for the `whoami` identity cross-check; `LARK_RUN` is also honored. |

## Windows notes

- **`.env` location**: `dotenvy` reads `.env` from the current working directory. Run the binary
  from `tools\seedaodb-client\`, or otherwise make sure a discoverable `.env` sets these
  variables.
- **Local login-state file**: defaults to `%APPDATA%\seedaodb-client\token.json`, not the
  current working directory, so login state does not appear to "disappear" when the binary is
  run from a different folder.
- **Loopback port conflicts (feishu mode)**: if `login` reports it could not bind the loopback
  listener, another process is likely already using that port. Set
  `SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT` to a free port (and re-register the matching redirect URI
  in the app's Security Settings), or use `login --manual` instead.
- **lark-cli invocation (only relevant if you enable the `whoami` cross-check)**: this client
  never calls `lark-cli`/`lark-cli.cmd` directly. A globally npm-installed `lark-cli` on Windows
  is a `.cmd` shim, which `std::process::Command` does not reliably invoke without an extra
  shell layer (with its own argument-escaping quirks). Instead, this client resolves lark-cli's
  `run.js` script using the same candidate-path search the host project's own TypeScript tooling
  uses (`src/core/paths.ts`'s `resolveLarkRun()`), then always runs it as
  `node <run.js> auth status --json`. Candidate order: `SEEDAODB_CLIENT_LARK_RUN` ->
  `LARK_RUN` -> `%APPDATA%\nvm_symlink\node_modules\@larksuite\cli\scripts\run.js` ->
  `<node dir>\..\lib\node_modules\@larksuite\cli\scripts\run.js` ->
  `<node dir>\node_modules\@larksuite\cli\scripts\run.js`. `node` itself is assumed to be on
  `PATH` (the same assumption the TypeScript implementation makes); if lark-cli cannot be
  found or run, `whoami` prints one informational line and continues normally.
- **TLS**: the seedaodb server does not terminate TLS itself by default (see its own README).
  Local/LAN testing is plain HTTP; only point `SEEDAODB_CLIENT_BASE_URL` at `https://` once the
  server is behind a TLS-terminating reverse proxy. Feishu's own endpoints (`open.feishu.cn`,
  `accounts.feishu.cn`) are always `https://` regardless of how you reach seedaodb itself.
- **Port mapping**: this client only ever uses `SEEDAODB_CLIENT_BASE_URL` for the seedaodb
  connection -- it does not probe ports or assume a default beyond what you configure.
  `SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT` is unrelated and only affects the feishu-mode loopback
  listener described above.

## Known limitations / deferred work

- **Feishu OAuth login has not been end-to-end verified against a real Feishu app.** The
  implementation follows the authorization-code + PKCE flow and the v2 token endpoint shape as
  documented by the Feishu Open Platform at the time this was written, and is covered by offline
  tests against a mocked token endpoint (see "Testing" below), but the first real run against a
  live app may surface a documentation/reality mismatch. Likely failure points if `login` does
  not work end to end: the redirect URI is not registered exactly as configured (scheme, host,
  port, and path all matter), the requested scope is not enabled for the app, or the app is
  different from the one seedaodb's server itself trusts (see "Feishu mode setup" above).
- **No server-side companion changes are made by this crate.** `GET /whoami` is used opportunistically
  if a given seedaodb deployment has it, with graceful fallback if not; this crate does not add
  that endpoint, extend table-level ACLs, or otherwise modify `tools/seedaodb`.
- **Table-level permission is never predicted client-side.** Only the server's actual response
  determines whether a specific table read/write or SQL statement is allowed; the ACL model
  seedaodb enforces today is per-datasource, not yet per-table for `/query`/`/exec`.
- **Local login-state storage is a plain file, not an OS credential store.** The file is written
  with owner-only permissions where the platform supports it (Unix `0600`) and defaults to a
  per-user profile directory, but it is not encrypted. In `feishu` mode this file now holds a
  real Feishu access token and (when `offline_access` was granted) refresh token; treat it with
  the same care as any other credential file. If this needs hardening later, consider the
  `keyring` crate (OS credential store integration) instead of a plain file.

## Testing

```bash
cargo build --release
cargo test
```

- `tests/integration.rs` drives `client::SeedaodbClient` against a `wiremock`-hosted fake
  seedaodb server bound to an ephemeral local port -- no real network access and no real
  seedaodb process are involved.
- `tests/feishu_oauth_integration.rs` drives `feishu_oauth::FeishuOAuthClient` (token exchange,
  refresh, user_info) and `auth::resolve_user_token` against a `wiremock`-hosted fake Feishu
  token endpoint, including a full round trip proving an expired feishu-mode access token is
  refreshed and the new token/refresh-token/expiry are persisted back to the login-state file --
  again, no real network access and no real Feishu endpoint are involved.
- Unit tests inside `src/config.rs`, `src/params.rs`, `src/lark_shell.rs`, `src/feishu_oauth.rs`,
  and `src/auth.rs` cover configuration parsing, `--param` JSON-type inference, lark-cli path
  resolution, PKCE generation (checked against the fixed verifier/challenge vector from
  [RFC 7636 Appendix B](https://www.rfc-editor.org/rfc/rfc7636#appendix-B)), authorize-URL
  construction, OAuth callback/manual-input parsing, token-response parsing (including both
  documented Feishu error shapes), and token-expiry buffer logic -- all without touching real
  environment variables, the filesystem outside temp-safe candidates, or any real network
  endpoint.
