# seedaodb

A standalone Rust HTTP server that exposes SQL CRUD access to the tudigong SQLite databases,
guarded by a service token, Feishu-identity-based authentication, and per-user role-based access
control (RBAC).

This crate is fully self-contained. It does not import anything from the surrounding
`polis-game` Node/TypeScript project, does not read the host project's root `.env` or
`configs/`, and is not part of any pnpm workspace. The only coupling to the host project is a
file path recorded in `config/datasources.toml` -- and that disappears entirely once a
datasource is repointed at a non-SQLite backend.

## Why this exists

The host project's tudigong agent keeps its data in two SQLite files under `.agent/`
(`tudigong.db` for per-soul data such as messages/chats/events, `shared.db` for the
cross-soul LP ledger/profiles/badges). `seedaodb` gives other tools/operators a general,
authenticated SQL interface onto those same files -- without embedding any Rust dependency into
the Node process, and without every caller needing direct filesystem access to `.agent/`.

## Quick start

```bash
cd tools/seedaodb
cp .env.example .env
cp config/datasources.toml.example config/datasources.toml
cp config/acl.toml.example config/acl.toml
# edit .env, config/datasources.toml, config/acl.toml with real values

cargo build --release
./target/release/seedaodb
# or, under pm2:
pm2 start ecosystem.config.cjs
```

`GET /health` requires no authentication and always works once the process is up:

```bash
curl http://127.0.0.1:8878/health
```

Every other endpoint requires both a service token and a resolvable identity (see
"Authentication and authorization" below).

## Local development / testing without Feishu

Set `SEEDAODB_AUTH_MODE=static` and point `SEEDAODB_STATIC_TOKENS_FILE` at a copy of
`config/static-tokens.toml.example`. This swaps in `StaticVerifier`, which maps a fixed set of
bearer tokens to `open_id`s from a local file -- no network access to Feishu is involved. This
is also exactly what the integration test suite (`tests/integration.rs`) does internally, so the
full HTTP -> auth -> RBAC -> SQLite chain can be exercised offline. Do not use `static` mode
against untrusted clients in production.

## API

All responses use the same JSON envelope:

```json
{ "ok": true, "data": { "...": "..." }, "error": null }
```

```json
{ "ok": false, "data": null, "error": { "code": "FORBIDDEN", "message": "..." } }
```

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | Liveness probe; returns version and configured datasource names. |
| GET | `/datasources` | service token + identity | Lists datasource name/backend/readonly. Never returns URLs or credentials. |
| GET | `/tables?db=<name>` | + read permission on `db` | Lists table names from `sqlite_master`. |
| GET | `/tables/:name/rows?db=<name>&limit=&offset=` | + read permission on `db` | Paginated row browsing. `limit` defaults to 100, capped at 1000. `:name` is validated against the live table list before use. |
| POST | `/query` | + read permission on `db` | Body `{ db, sql, params }`. Only `SELECT`, `PRAGMA table_info`, `EXPLAIN` are allowed. |
| POST | `/exec` | + write permission on `db` | Body `{ db, sql, params }`. Returns `{ changes, lastInsertRowid }`. Rejects schema-changing/file-rewriting statements (see below). |

`params` is a JSON array bound positionally (`?` placeholders), the same mental model as the
host project's own `db.prepare(sql).run(...params)` calls. Supported parameter JSON types:
`null`, `boolean`, `number` (integer or float), `string`. Arrays/objects are rejected -- SQLite
has no container type to bind them to.

Query results are returned as `{ columns: [...], rows: [[...], ...] }`, decoded per-cell from
SQLite's actual runtime storage class (not the column's declared type, since SQLite values are
dynamically typed): `NULL -> null`, `INTEGER -> number`, `REAL -> number`, `TEXT -> string`,
`BLOB -> base64-encoded string`.

### Statement guard

This is a simple prefix/keyword check, not a SQL parser:

- `/query` allows only statements starting with `select`, `pragma table_info`, or `explain`
  (after stripping leading whitespace/comments).
- `/exec` rejects statements starting with `vacuum`, `alter`, `drop`, `create`, `attach`,
  `detach`, `pragma journal_mode`, `pragma writable_schema`, or `reindex`.
- Both reject a request whose SQL contains more than one statement (a second `;`-separated
  statement beyond one optional trailing `;`).

A determined caller could still try to hide a second statement inside a string literal or some
other dialect quirk; a real defense against that needs a proper SQL parser (see "Known
limitations" below). Which datasource a caller may read/write at all is governed separately by
the RBAC layer, not by this guard.

## Authentication and authorization

Three gates, in order:

1. **Service token** (coarse, service-to-service). Send `Authorization: Bearer <token>` or
   `X-Service-Token: <token>`, matching `SEEDAODB_SERVICE_TOKEN`. If that variable is unset, every
   protected endpoint rejects every request -- there is no "no gate" fallback.
2. **Identity**. Send `X-Feishu-User-Token: u-xxx`. The client obtains this token itself by
   completing Feishu's own OAuth login flow; this service only verifies it, it never runs the
   login flow. Verification is pluggable via `SEEDAODB_AUTH_MODE`:
   - `feishu` (default): calls the real Feishu OpenAPI (`FeishuVerifier`) to resolve the token to
     an `open_id`, caching the result for `SEEDAODB_TOKEN_CACHE_TTL_S` seconds.
   - `static`: looks the token up in `SEEDAODB_STATIC_TOKENS_FILE` (`StaticVerifier`), no network
     access. Development/testing only.
3. **RBAC** (`config/acl.toml`). `open_id -> role -> { read: [datasource...], write:
   [datasource...] }`. `/query` checks read permission on the target `db`; `/exec` checks write
   permission. An identity with no matching `[[user]]` entry falls back to `default_role` (which
   may be the literal string `"deny"`). A missing or invalid ACL file is a hard startup failure;
   this service never starts with an empty, all-permissive ACL.

The `admin` open_id list in `acl.toml` is expected to be synced by hand from the host project's
`configs/admins.json` -- this service intentionally does not read that file directly, to keep the
two codebases decoupled (see "Decoupling" below).

## Pluggable backend (SQLite today, MySQL later)

Datasources are addressed by logical name (`config/datasources.toml`: `name -> url + readonly +
busy_timeout_ms`), never by file path or connection string, and the API never accepts an
arbitrary path/DSN from a caller. This is what lets a datasource be repointed at a different
database engine purely through configuration.

Only the SQLite backend is implemented today, using a concrete `sqlx::SqlitePool` (not
`sqlx::Any` -- the `Any` driver's dynamic-row type coverage is narrower and less predictable for
an endpoint whose whole job is decoding arbitrary result sets to JSON). SQLite connections are
opened with `journal_mode=WAL`, a configurable `busy_timeout`, and the datasource's `readonly`
flag applied at the connection level (in addition to, and independent of, whatever RBAC allows
for a given user).

`src/db/mysql.rs` holds a compile-clean skeleton of the same interface, gated behind the
`mysql-backend` Cargo feature (off by default, so a plain `cargo build` never pulls in a MySQL
driver). Every method on it currently returns "not implemented" -- wiring in a real MySQL driver
later only touches this one file, not routing/auth/statement-guard code. Build with
`cargo build --features mysql-backend` to compile it in.

**SQL dialect portability is not solved by this abstraction.** The backend abstraction unifies
connection/execution, not SQL dialect. Raw SQL sent by callers (`INSERT OR IGNORE`, FTS5
`MATCH`, `PRAGMA`, double-quoted identifiers, ...) that works against SQLite may not work
unchanged against MySQL, and the tudigong schema itself has SQLite-specific structures (FTS5
virtual tables). Migrating to MySQL for real needs a dedicated schema/dialect migration effort,
not just a URL change.

## WAL concurrency notes

Existing `.agent/*.db` files are already in WAL mode (a persistent, on-disk setting) -- this
service does not need to and does not attempt to change that. WAL allows multiple readers
alongside a single writer, but writes are still globally serialized per file. Since the host
Node process (serve worker + supervisor + per-turn MCP subprocesses) may already hold open
connections to the same files, seedaodb:

- always sets a `busy_timeout` (`busy_timeout_ms` in `datasources.toml`) so a lock conflict waits
  instead of failing immediately with `SQLITE_BUSY`;
- retries `/exec` on `SQLITE_BUSY`/`SQLITE_LOCKED` with capped exponential backoff, up to
  `SEEDAODB_BUSY_RETRY_MAX` attempts;
- keeps `/exec` transactions short (bind params, `BEGIN` -> execute -> `COMMIT`, no long-held
  locks);
- uses a small pool of short-lived connections per datasource rather than one long-lived
  connection, so this service is not itself a reason WAL checkpointing stalls.

Writing to `shared.db` (the LP ledger/profile database) through raw SQL can bypass the host
project's own bookkeeping (`pt_ledger` is append-only and `profiles.pt_balance` is a derived
value the Node code keeps in sync via `grantPt()`). The example ACL restricts `shared` writes to
the `admin` role for this reason; treat any such write as a deliberate, audited, out-of-band
operation, not routine traffic.

## Security

- **Transport encryption**: this service does not terminate TLS itself by default. Put it behind
  a TLS-terminating reverse proxy (nginx/caddy) if it will ever be reached over an untrusted
  network -- user tokens and SQL payloads must not cross the network in plaintext.
  `SEEDAODB_TLS_CERT`/`SEEDAODB_TLS_KEY` are read into configuration for a future
  self-termination option but are not wired up to an HTTPS listener yet (TODO).
- **Audit log** (`SEEDAODB_AUDIT_LOG`, default `logs/audit.jsonl`): every `/exec` call (success
  or failure) and every request denied by the service-token gate, RBAC, or the statement guard is
  appended as one JSON line (timestamp, `open_id`, source IP if available, `db`, operation, a
  truncated SQL prefix, outcome, `changes`). Parameter values are never logged.
- **Request body limit**: `SEEDAODB_MAX_BODY_BYTES` (default 1 MiB), enforced before a handler
  reads the body.
- **Minimal disclosure**: `/health` and `/datasources` never return connection strings or
  credentials; internal errors are logged in full server-side but reported to clients as a
  generic message, never with file paths or connection strings.
- **Per-IP/per-token rate limiting is not implemented** (TODO). `SEEDAODB_SERVICE_TOKEN` + RBAC +
  the audit log are the controls in place today; a network-level control (firewall/security
  group restricting which hosts can reach this port) is recommended regardless of token auth.

## Environment variables

See `.env.example` for the full, commented list (`SEEDAODB_PORT`, `SEEDAODB_BIND_ADDR`,
`SEEDAODB_SERVICE_TOKEN`, `SEEDAODB_AUTH_MODE`, `SEEDAODB_FEISHU_APP_ID`/`_APP_SECRET`/`_BASE_URL`,
`SEEDAODB_STATIC_TOKENS_FILE`, `SEEDAODB_DATASOURCES_FILE`, `SEEDAODB_ACL_FILE`,
`SEEDAODB_TOKEN_CACHE_TTL_S`, `SEEDAODB_BUSY_RETRY_MAX`, `SEEDAODB_MAX_BODY_BYTES`,
`SEEDAODB_TLS_CERT`/`_TLS_KEY`, `SEEDAODB_AUDIT_LOG`). All of them are namespaced under
`SEEDAODB_` and read from this directory's own `.env`; nothing is read from the host project's
root `.env`.

## Deploying with pm2

```bash
cd tools/seedaodb
cargo build --release
pm2 start ecosystem.config.cjs
pm2 logs seedaodb
```

`ecosystem.config.cjs` lives only in this directory and is never merged into the host project's
own pm2/supervisor configuration. The pm2 process name is fixed to `seedaodb` to avoid future
name collisions if the host project ever adopts pm2 itself.

pm2 does not reload environment variables on a plain `pm2 restart`. After changing `.env`, run:

```bash
pm2 restart seedaodb --update-env
```

Make sure pm2 is installed (`npm install -g pm2` or use `npx pm2`) before deploying.

## Decoupling from the host project

- Independent Cargo crate with its own `Cargo.toml`/`Cargo.lock`; not part of any pnpm workspace,
  not on the host project's TypeScript build path (`pnpm build` only compiles `.ts`).
- No `import`/`require` of any `src/` TypeScript module.
- Does not read the host project's `configs/admins.json` or `.agent/auth/`; the `admin` role's
  `open_id` list in `acl.toml` is synced by hand as an operational step.
- Not added to any pnpm workspace file.
- `.gitignore` keeps `target/`, `.env`, `config/*.toml` (the real, credential-bearing files), and
  `logs/` out of version control; only the `.example` templates and this README are checked in.

## Known limitations / deferred work

- **MySQL backend**: skeleton only (`src/db/mysql.rs`, `mysql-backend` feature), every method
  returns "not implemented". Needs a real driver plus a schema/dialect migration plan before
  it's usable.
- **`identity_links` collapsing**: the host project's `shared.db` has an `identity_links` table
  that collapses multiple app-specific `open_id`s onto one logical identity. This service does
  not query it (kept off by default to avoid a hard dependency on `shared.db` from the auth
  layer); RBAC currently matches on the raw `open_id` returned by the identity verifier.
- **Rate limiting**: not implemented; see "Security" above.
- **Self-terminated TLS**: `SEEDAODB_TLS_CERT`/`_TLS_KEY` are read but not yet wired to an HTTPS
  listener; use a reverse proxy for TLS today.
- **Statement guard is prefix/keyword-based**, not a parser; see "Statement guard" above for
  what it does and does not catch.
- **`admin` open_id sync**: manual, from `configs/admins.json` into `acl.toml`; no automatic
  sync mechanism exists (deliberately, to avoid re-coupling the two codebases).

## Testing

```bash
cargo build --release
cargo test
```

`tests/integration.rs` drives the router directly (`Router::oneshot`, no real TCP listener)
against a `tempfile`-backed SQLite database and a `StaticVerifier`, so the whole suite runs
offline and never touches `.agent/tudigong.db` or `.agent/shared.db`.
