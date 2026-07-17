//! Network-layer tests for the Feishu OAuth flow, run entirely offline against a `wiremock` fake
//! token endpoint bound to an ephemeral local port. No real network access and no real Feishu
//! endpoint are involved.
//!
//! Pure-logic coverage (PKCE vectors, authorize-URL shape, callback/manual-input parsing, and
//! response-body parsing against fixed JSON) lives as unit tests inside
//! `src/feishu_oauth.rs::tests`; this file focuses on what only a real HTTP round trip can prove:
//! the request actually reaches the right path/method, and `auth::resolve_user_token` refreshes
//! and persists a near-expired feishu-mode token end to end.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use seedaodb_client::auth::{self, LoginState};
use seedaodb_client::config::{AuthMode, ClientConfig};
use seedaodb_client::feishu_oauth::FeishuOAuthClient;

/// Builds a unique path under the OS temp directory so parallel tests never share a token file.
fn unique_temp_path(label: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "seedaodb-client-test-{label}-{}-{n}.json",
        std::process::id()
    ))
}

fn feishu_config(token_base_url: &str, token_file: PathBuf) -> ClientConfig {
    ClientConfig {
        base_url: "http://127.0.0.1:1".to_string(),
        service_token: "svc-token".to_string(),
        auth_mode: AuthMode::Feishu,
        static_token: None,
        token_file,
        feishu_app_id: Some("cli_test123".to_string()),
        feishu_app_secret: Some("secret_test123".to_string()),
        feishu_token_base_url: token_base_url.to_string(),
        feishu_authorize_base_url: "https://accounts.feishu.cn".to_string(),
        feishu_scope: "offline_access".to_string(),
        oauth_redirect_port: 8899,
        feishu_redirect_uri: None,
        lark_run: None,
    }
}

fn epoch_seconds_from_now(delta: i64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    (now + delta).to_string()
}

#[tokio::test]
async fn exchange_code_success_round_trips_over_http() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/open-apis/authen/v2/oauth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "code": 0,
            "access_token": "u-abc123",
            "token_type": "Bearer",
            "expires_in": 7200,
            "refresh_token": "r-abc123",
            "refresh_token_expires_in": 2592000,
            "scope": "offline_access"
        })))
        .mount(&server)
        .await;

    let client = FeishuOAuthClient::new(server.uri(), "cli_test123", "secret_test123");
    let token = client
        .exchange_code(
            "auth-code-xyz",
            "http://127.0.0.1:8899/callback",
            "verifier-xyz",
            Some("offline_access"),
        )
        .await
        .expect("exchange_code should succeed");

    assert_eq!(token.access_token, "u-abc123");
    assert_eq!(token.refresh_token.as_deref(), Some("r-abc123"));
    assert_eq!(token.expires_in, 7200);
}

#[tokio::test]
async fn refresh_success_round_trips_over_http() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/open-apis/authen/v2/oauth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "code": 0,
            "access_token": "u-refreshed",
            "token_type": "Bearer",
            "expires_in": 7200,
            "refresh_token": "r-refreshed",
            "refresh_token_expires_in": 2591999
        })))
        .mount(&server)
        .await;

    let client = FeishuOAuthClient::new(server.uri(), "cli_test123", "secret_test123");
    let token = client
        .refresh("r-old")
        .await
        .expect("refresh should succeed");

    assert_eq!(token.access_token, "u-refreshed");
    assert_eq!(token.refresh_token.as_deref(), Some("r-refreshed"));
}

#[tokio::test]
async fn token_endpoint_error_over_http_is_a_clear_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/open-apis/authen/v2/oauth/token"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "error": "invalid_grant",
            "error_description": "authorization code has expired"
        })))
        .mount(&server)
        .await;

    let client = FeishuOAuthClient::new(server.uri(), "cli_test123", "secret_test123");
    let err = client
        .exchange_code("stale-code", "http://127.0.0.1:8899/callback", "verifier", None)
        .await
        .expect_err("should fail");

    let msg = err.to_string();
    assert!(msg.contains("invalid_grant"));
    assert!(msg.contains("authorization code has expired"));
}

#[tokio::test]
async fn user_info_success_round_trips_over_http() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/open-apis/authen/v1/user_info"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "code": 0,
            "msg": "success",
            "data": {"open_id": "ou_test456", "name": "Test User"}
        })))
        .mount(&server)
        .await;

    let client = FeishuOAuthClient::new(server.uri(), "cli_test123", "secret_test123");
    let info = client
        .fetch_user_info("u-abc123")
        .await
        .expect("fetch_user_info should succeed");

    assert_eq!(info.open_id, "ou_test456");
    assert_eq!(info.name.as_deref(), Some("Test User"));
}

#[tokio::test]
async fn resolve_user_token_refreshes_an_expired_access_token_and_persists_the_result() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/open-apis/authen/v2/oauth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "code": 0,
            "access_token": "u-brand-new",
            "token_type": "Bearer",
            "expires_in": 7200,
            "refresh_token": "r-brand-new",
            "refresh_token_expires_in": 2591999
        })))
        .mount(&server)
        .await;

    let token_file = unique_temp_path("expired-refresh");
    LoginState {
        mode: "feishu".to_string(),
        open_id: Some("ou_old".to_string()),
        user_token: Some("u-old-and-expired".to_string()),
        refresh_token: Some("r-old".to_string()),
        expires_at: Some(epoch_seconds_from_now(-3600)),
    }
    .save(&token_file)
    .expect("saving initial login state should succeed");

    let config = feishu_config(&server.uri(), token_file.clone());

    let resolved = auth::resolve_user_token(&config)
        .await
        .expect("resolve_user_token should refresh transparently");
    assert_eq!(resolved, "u-brand-new");

    let persisted = LoginState::load(&token_file).expect("token file should still parse");
    assert_eq!(persisted.user_token.as_deref(), Some("u-brand-new"));
    assert_eq!(persisted.refresh_token.as_deref(), Some("r-brand-new"));
    let persisted_expiry: u64 = persisted
        .expires_at
        .as_deref()
        .expect("expires_at should be set")
        .parse()
        .expect("expires_at should be a valid epoch-seconds string");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    assert!(persisted_expiry > now);

    let _ = std::fs::remove_file(&token_file);
}

#[tokio::test]
async fn resolve_user_token_returns_the_cached_token_without_a_network_call_when_still_fresh() {
    let token_file = unique_temp_path("fresh-no-refresh");
    LoginState {
        mode: "feishu".to_string(),
        open_id: Some("ou_fresh".to_string()),
        user_token: Some("u-still-fresh".to_string()),
        refresh_token: Some("r-unused".to_string()),
        expires_at: Some(epoch_seconds_from_now(3600)),
    }
    .save(&token_file)
    .expect("saving initial login state should succeed");

    // Deliberately not backed by any listener: if resolve_user_token attempted a refresh call
    // here, it would fail to connect and this test would fail, proving no network call happens
    // for a token that is not near expiry.
    let config = feishu_config("http://127.0.0.1:1", token_file.clone());

    let resolved = auth::resolve_user_token(&config)
        .await
        .expect("resolve_user_token should return the cached token without refreshing");
    assert_eq!(resolved, "u-still-fresh");

    let _ = std::fs::remove_file(&token_file);
}

#[tokio::test]
async fn resolve_user_token_reports_a_clear_error_when_refresh_token_is_missing() {
    let token_file = unique_temp_path("expired-no-refresh-token");
    LoginState {
        mode: "feishu".to_string(),
        open_id: None,
        user_token: Some("u-old-and-expired".to_string()),
        refresh_token: None,
        expires_at: Some(epoch_seconds_from_now(-3600)),
    }
    .save(&token_file)
    .expect("saving initial login state should succeed");

    let config = feishu_config("http://127.0.0.1:1", token_file.clone());

    let err = auth::resolve_user_token(&config)
        .await
        .expect_err("should fail without a refresh token");
    assert!(err.to_string().contains("login` again"));

    let _ = std::fs::remove_file(&token_file);
}

#[tokio::test]
async fn resolve_user_token_reports_a_clear_error_when_not_logged_in() {
    let token_file = unique_temp_path("never-logged-in");
    let _ = std::fs::remove_file(&token_file); // ensure it does not exist

    let config = feishu_config("http://127.0.0.1:1", token_file);

    let err = auth::resolve_user_token(&config)
        .await
        .expect_err("should fail when no login state file exists");
    assert!(err.to_string().contains("not logged in"));
}
