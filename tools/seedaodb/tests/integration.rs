//! End-to-end integration tests driving the full HTTP -> auth -> RBAC -> SQLite chain in-process
//! (via `Router::oneshot`, no real TCP socket) against a temporary SQLite file. Never touches
//! the real `.agent/*.db` files and never talks to the network -- `StaticVerifier` stands in for
//! `FeishuVerifier` so these tests do not depend on a live Feishu app.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::Engine as _;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use seedaodb::auth::rbac::AclConfig;
use seedaodb::auth::static_verifier::StaticVerifier;
use seedaodb::auth::IdentityVerifier;
use seedaodb::config::{AppConfig, AuthMode};
use seedaodb::db::{DatasourceEntryConfig, DatasourceRegistry};
use seedaodb::routes::build_router;
use seedaodb::state::AppState;

const SERVICE_TOKEN: &str = "test-service-token";
const ADMIN_TOKEN: &str = "test-admin-token";
const ADMIN_OPEN_ID: &str = "ou_test_admin";
const READONLY_TOKEN: &str = "test-readonly-token";
const READONLY_OPEN_ID: &str = "ou_test_readonly";

const ACL_TOML: &str = r#"
default_role = "deny"

[roles.admin]
read = ["soul"]
write = ["soul"]

[roles.readonly]
read = ["soul"]
write = []

[[user]]
open_id = "ou_test_admin"
role = "admin"

[[user]]
open_id = "ou_test_readonly"
role = "readonly"
"#;

const FIXTURE_BLOB: [u8; 4] = [0xDE, 0xAD, 0xBE, 0xEF];

/// Builds a router backed by a fresh temporary SQLite file, a test-only ACL, and a
/// `StaticVerifier`. The returned `TempDir` must be kept alive for the duration of the test (it
/// is deleted on drop).
async fn setup() -> (axum::Router, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("create tempdir");
    let db_path = dir.path().join("test.db");
    let acl_path = dir.path().join("acl.toml");
    std::fs::write(&acl_path, ACL_TOML).expect("write test acl.toml");

    // Fixture schema/rows created directly through sqlx. This is test setup, not part of what
    // is under test -- the HTTP /exec endpoint would (correctly) reject a CREATE TABLE.
    let setup_pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&db_path)
                .create_if_missing(true)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
        )
        .await
        .expect("connect setup pool");

    sqlx::query(
        "CREATE TABLE items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            note TEXT,
            qty INTEGER,
            payload BLOB
        )",
    )
    .execute(&setup_pool)
    .await
    .expect("create fixture table");

    sqlx::query("INSERT INTO items (name, note, qty, payload) VALUES (?, ?, ?, ?)")
        .bind("widget")
        .bind(Option::<String>::None)
        .bind(42i64)
        .bind(FIXTURE_BLOB.to_vec())
        .execute(&setup_pool)
        .await
        .expect("insert fixture row");

    setup_pool.close().await;

    let url = format!("sqlite://{}", db_path.display());
    let datasources = DatasourceRegistry::from_entries(vec![DatasourceEntryConfig {
        name: "soul".to_string(),
        url,
        readonly: false,
        busy_timeout_ms: 5000,
    }])
    .await
    .expect("connect datasource registry");

    let acl = AclConfig::load(&acl_path).expect("load test acl");

    let mut tokens = HashMap::new();
    tokens.insert(ADMIN_TOKEN.to_string(), ADMIN_OPEN_ID.to_string());
    tokens.insert(READONLY_TOKEN.to_string(), READONLY_OPEN_ID.to_string());
    let verifier: Arc<dyn IdentityVerifier> = Arc::new(StaticVerifier::from_map(tokens));

    let config = AppConfig {
        port: 0,
        bind_addr: "127.0.0.1".to_string(),
        service_token: Some(SERVICE_TOKEN.to_string()),
        auth_mode: AuthMode::Static,
        feishu_app_id: None,
        feishu_app_secret: None,
        feishu_base_url: "https://open.feishu.cn".to_string(),
        static_tokens_file: PathBuf::new(),
        datasources_file: PathBuf::new(),
        acl_file: acl_path,
        token_cache_ttl_s: 300,
        busy_retry_max: 5,
        max_body_bytes: 1_048_576,
        tls_cert: None,
        tls_key: None,
        audit_log: dir.path().join("audit.jsonl"),
    };

    let state = AppState {
        config: Arc::new(config),
        datasources: Arc::new(datasources),
        acl: Arc::new(acl),
        verifier,
    };

    (build_router(state), dir)
}

async fn send(
    router: &axum::Router,
    method: &str,
    path: &str,
    service_token: Option<&str>,
    user_token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = service_token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    if let Some(token) = user_token {
        builder = builder.header("x-feishu-user-token", token);
    }

    let request = match body {
        Some(value) => builder
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&value).unwrap()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };

    let response = router.clone().oneshot(request).await.expect("request failed");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("read response body")
        .to_bytes();
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("response body is valid JSON")
    };
    (status, json)
}

#[tokio::test]
async fn health_is_public_and_unauthenticated() {
    let (router, _dir) = setup().await;
    let (status, body) = send(&router, "GET", "/health", None, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], true);
    assert_eq!(body["data"]["status"], "ok");
}

#[tokio::test]
async fn protected_endpoint_without_service_token_is_unauthorized() {
    let (router, _dir) = setup().await;
    let (status, body) = send(&router, "GET", "/datasources", None, Some(ADMIN_TOKEN), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "UNAUTHORIZED");
}

#[tokio::test]
async fn wrong_service_token_is_unauthorized() {
    let (router, _dir) = setup().await;
    let (status, _body) = send(
        &router,
        "GET",
        "/datasources",
        Some("not-the-right-token"),
        Some(ADMIN_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn datasources_and_tables_are_listed() {
    let (router, _dir) = setup().await;

    let (status, body) = send(
        &router,
        "GET",
        "/datasources",
        Some(SERVICE_TOKEN),
        Some(READONLY_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"][0]["name"], "soul");
    assert_eq!(body["data"][0]["backend"], "sqlite");

    let (status, body) = send(
        &router,
        "GET",
        "/tables?db=soul",
        Some(SERVICE_TOKEN),
        Some(READONLY_TOKEN),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let tables = body["data"].as_array().unwrap();
    assert!(tables.iter().any(|t| t == "items"));
}

#[tokio::test]
async fn readonly_role_can_query_but_not_exec() {
    let (router, _dir) = setup().await;

    let query_body = json!({
        "db": "soul",
        "sql": "SELECT id, name FROM items WHERE id = 1",
        "params": [],
    });
    let (status, body) = send(
        &router,
        "POST",
        "/query",
        Some(SERVICE_TOKEN),
        Some(READONLY_TOKEN),
        Some(query_body),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["rows"][0][1], "widget");

    let exec_body = json!({
        "db": "soul",
        "sql": "UPDATE items SET qty = 100 WHERE id = 1",
        "params": [],
    });
    let (status, body) = send(
        &router,
        "POST",
        "/exec",
        Some(SERVICE_TOKEN),
        Some(READONLY_TOKEN),
        Some(exec_body),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "FORBIDDEN");
}

#[tokio::test]
async fn writer_role_can_insert_update_delete() {
    let (router, _dir) = setup().await;

    let insert_body = json!({
        "db": "soul",
        "sql": "INSERT INTO items (name, note, qty) VALUES (?, ?, ?)",
        "params": ["gadget", "created in test", 7],
    });
    let (status, body) = send(
        &router,
        "POST",
        "/exec",
        Some(SERVICE_TOKEN),
        Some(ADMIN_TOKEN),
        Some(insert_body),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["changes"], 1);
    let new_id = body["data"]["lastInsertRowid"].as_i64().expect("rowid");
    assert!(new_id > 0);

    let update_body = json!({
        "db": "soul",
        "sql": "UPDATE items SET qty = ? WHERE id = ?",
        "params": [99, new_id],
    });
    let (status, body) = send(
        &router,
        "POST",
        "/exec",
        Some(SERVICE_TOKEN),
        Some(ADMIN_TOKEN),
        Some(update_body),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["changes"], 1);

    let delete_body = json!({
        "db": "soul",
        "sql": "DELETE FROM items WHERE id = ?",
        "params": [new_id],
    });
    let (status, body) = send(
        &router,
        "POST",
        "/exec",
        Some(SERVICE_TOKEN),
        Some(ADMIN_TOKEN),
        Some(delete_body),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["changes"], 1);
}

#[tokio::test]
async fn exec_rejects_drop_table() {
    let (router, _dir) = setup().await;
    let body = json!({"db": "soul", "sql": "DROP TABLE items", "params": []});
    let (status, resp) = send(
        &router,
        "POST",
        "/exec",
        Some(SERVICE_TOKEN),
        Some(ADMIN_TOKEN),
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(resp["error"]["code"], "BAD_REQUEST");
}

#[tokio::test]
async fn query_rejects_non_select_statement() {
    let (router, _dir) = setup().await;
    let body = json!({"db": "soul", "sql": "DELETE FROM items", "params": []});
    let (status, resp) = send(
        &router,
        "POST",
        "/query",
        Some(SERVICE_TOKEN),
        Some(ADMIN_TOKEN),
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(resp["error"]["code"], "BAD_REQUEST");
}

#[tokio::test]
async fn query_decodes_dynamic_row_types() {
    let (router, _dir) = setup().await;
    let body = json!({
        "db": "soul",
        "sql": "SELECT id, name, note, qty, payload FROM items WHERE id = 1",
        "params": [],
    });
    let (status, resp) = send(
        &router,
        "POST",
        "/query",
        Some(SERVICE_TOKEN),
        Some(ADMIN_TOKEN),
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let columns = resp["data"]["columns"].as_array().unwrap();
    assert_eq!(columns, &["id", "name", "note", "qty", "payload"]);

    let row = &resp["data"]["rows"][0];
    assert_eq!(row[0], 1); // INTEGER primary key
    assert_eq!(row[1], "widget"); // TEXT
    assert_eq!(row[2], Value::Null); // NULL
    assert_eq!(row[3], 42); // INTEGER
    let expected_blob = base64::engine::general_purpose::STANDARD.encode(FIXTURE_BLOB);
    assert_eq!(row[4], expected_blob); // BLOB -> base64 TEXT
}
