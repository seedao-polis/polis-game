//! HTTP-layer integration tests, run entirely offline against a `wiremock` fake seedaodb server.
//!
//! No real network access and no real seedaodb process are involved -- every test starts its own
//! local mock server bound to an ephemeral port and tears it down at the end of the test.

use serde_json::json;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

use seedaodb_client::client::{ClientError, SeedaodbClient};

fn client_for(server: &MockServer) -> SeedaodbClient {
    SeedaodbClient::new(server.uri(), "svc-token", "user-token")
}

#[tokio::test]
async fn datasources_happy_path_parses_the_envelope() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/datasources"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ok": true,
            "data": [
                {"name": "soul", "backend": "sqlite", "readonly": false},
                {"name": "shared", "backend": "sqlite", "readonly": true}
            ],
            "error": null
        })))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let list = client
        .datasources()
        .await
        .expect("datasources should succeed");

    assert_eq!(list.len(), 2);
    assert_eq!(list[0].name, "soul");
    assert_eq!(list[0].backend, "sqlite");
    assert!(!list[0].readonly);
    assert!(list[1].readonly);
}

#[tokio::test]
async fn tables_happy_path_binds_the_db_query_param() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/tables"))
        .and(query_param("db", "soul"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ok": true,
            "data": ["messages", "chats"],
            "error": null
        })))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let tables = client.tables("soul").await.expect("tables should succeed");
    assert_eq!(tables, vec!["messages".to_string(), "chats".to_string()]);
}

#[tokio::test]
async fn rows_happy_path_decodes_mixed_column_types() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/tables/messages/rows"))
        .and(query_param("db", "soul"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ok": true,
            "data": {"columns": ["id", "body"], "rows": [[1, "hi"], [2, null]]},
            "error": null
        })))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let result = client
        .rows("soul", "messages", None, None)
        .await
        .expect("rows should succeed");

    assert_eq!(result.columns, vec!["id".to_string(), "body".to_string()]);
    assert_eq!(
        result.rows,
        vec![
            vec![json!(1), json!("hi")],
            vec![json!(2), serde_json::Value::Null],
        ]
    );
}

#[tokio::test]
async fn query_happy_path() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/query"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ok": true,
            "data": {"columns": ["n"], "rows": [[1]]},
            "error": null
        })))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let result = client
        .query("soul", "SELECT 1 as n", vec![])
        .await
        .expect("query should succeed");
    assert_eq!(result.columns, vec!["n".to_string()]);
    assert_eq!(result.rows, vec![vec![json!(1)]]);
}

#[tokio::test]
async fn exec_success_returns_changes_and_camel_case_last_insert_rowid() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/exec"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ok": true,
            "data": {"changes": 1, "lastInsertRowid": 42},
            "error": null
        })))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let result = client
        .exec("soul", "INSERT INTO t VALUES (1)", vec![])
        .await
        .expect("exec should succeed");
    assert_eq!(result.changes, 1);
    assert_eq!(result.last_insert_rowid, 42);
}

#[tokio::test]
async fn forbidden_is_rendered_with_the_servers_own_message_not_a_panic() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/tables"))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({
            "ok": false,
            "data": null,
            "error": {
                "code": "FORBIDDEN",
                "message": "role \"readonly\" cannot write to datasource \"shared\""
            }
        })))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let err = client
        .tables("shared")
        .await
        .expect_err("should be rejected as forbidden");

    let rendered = err.friendly();
    assert!(rendered.contains("role \"readonly\" cannot write to datasource \"shared\""));
    match err {
        ClientError::Server { code, .. } => assert_eq!(code, "FORBIDDEN"),
        other => panic!("expected ClientError::Server, got {other:?}"),
    }
}

#[tokio::test]
async fn json_envelope_404_is_a_structured_not_found_not_a_panic() {
    // This is a handler explicitly returning AppError::NotFound (e.g. an unknown datasource
    // name) -- it carries a JSON envelope, unlike an unregistered route (see the next test).
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/tables"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "ok": false,
            "data": null,
            "error": {"code": "NOT_FOUND", "message": "unknown datasource \"ghost\""}
        })))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let err = client
        .tables("ghost")
        .await
        .expect_err("should be a structured not-found");

    match err {
        ClientError::Server { code, message, .. } => {
            assert_eq!(code, "NOT_FOUND");
            assert!(message.contains("ghost"));
        }
        other => panic!("expected ClientError::Server, got {other:?}"),
    }
}

#[tokio::test]
async fn non_json_404_is_detected_as_an_unregistered_route_not_a_panic() {
    // This is axum's own router fallback for a path that was never registered as a route at
    // all -- plain-text body, no envelope. whoami's fallback logic depends on being able to tell
    // this apart from the JSON 404 case above without panicking on the non-JSON body.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/whoami"))
        .respond_with(ResponseTemplate::new(404).set_body_string("404 Not Found"))
        .mount(&server)
        .await;

    let client = client_for(&server);
    let err = client
        .whoami()
        .await
        .expect_err("a plain-text 404 body should not parse as a JSON envelope");

    match err {
        ClientError::UnregisteredRoute { status, .. } => assert_eq!(status.as_u16(), 404),
        other => panic!("expected ClientError::UnregisteredRoute, got {other:?}"),
    }
}

#[tokio::test]
async fn health_requires_no_authentication_headers() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/health"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ok": true,
            "data": {"status": "ok", "version": "0.1.0", "datasources": ["soul", "shared"]},
            "error": null
        })))
        .mount(&server)
        .await;

    // Deliberately constructed with empty credentials to confirm /health does not need them.
    let client = SeedaodbClient::new(server.uri(), "", "");
    let health = client.health().await.expect("health should succeed");
    assert_eq!(health.status, "ok");
    assert_eq!(health.datasources, vec!["soul".to_string(), "shared".to_string()]);
}
