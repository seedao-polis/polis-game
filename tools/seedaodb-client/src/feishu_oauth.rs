//! Feishu user OAuth 2.0 (authorization-code + PKCE) mechanics.
//!
//! Covers PKCE generation, the authorize-URL shape, the v2 token endpoint (both the
//! authorization_code and refresh_token grants), the user_info lookup, and the loopback/manual
//! capture of the authorization callback. This implements only the authorization-code + PKCE
//! flow (not device-code), against the endpoint shapes the Feishu Open Platform documents:
//!
//! - authorize: `GET {authorize_base_url}/open-apis/authen/v1/authorize`
//! - token exchange/refresh: `POST {token_base_url}/open-apis/authen/v2/oauth/token`
//! - user info: `GET {token_base_url}/open-apis/authen/v1/user_info`
//!
//! `auth::login_feishu` is the only caller of the interactive parts of this module
//! (`bind_loopback_listener`/`await_callback`/`extract_code_from_pasted_input`); everything else
//! here is either pure logic or network-only request/response handling, independently testable
//! with fixed vectors and a `wiremock` server.

use std::time::Duration;

use anyhow::{Context, Result};
use base64::Engine;
use rand::Rng;
use reqwest::StatusCode;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

/// RFC 7636 unreserved character set a PKCE `code_verifier` is drawn from.
const PKCE_VERIFIER_CHARSET: &[u8] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/// Generates a PKCE `code_verifier`: a random string within RFC 7636's required 43-128
/// character range, drawn from its unreserved character set.
pub fn generate_code_verifier() -> String {
    random_token(64)
}

/// Generates a random `state` value for CSRF protection on the authorize request.
pub fn generate_state() -> String {
    random_token(32)
}

fn random_token(len: usize) -> String {
    let mut rng = rand::rng();
    (0..len)
        .map(|_| {
            let idx = (rng.next_u32() as usize) % PKCE_VERIFIER_CHARSET.len();
            PKCE_VERIFIER_CHARSET[idx] as char
        })
        .collect()
}

/// Derives a PKCE `code_challenge` (S256 method) from a `code_verifier`: the base64url
/// (no padding) encoding of the verifier's SHA-256 digest.
pub fn code_challenge_from_verifier(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

/// Builds the Feishu authorize URL a user visits in a browser to approve this client's access
/// request. `prompt=consent` is always included so the consent screen (and therefore a
/// `refresh_token`, which Feishu only issues when `offline_access` is granted) is shown even on
/// a machine that has approved this app before.
pub fn build_authorize_url(
    authorize_base_url: &str,
    client_id: &str,
    redirect_uri: &str,
    scope: &str,
    state: &str,
    code_challenge: &str,
) -> Result<String> {
    let base = Url::parse(authorize_base_url)
        .context("invalid SEEDAODB_CLIENT_FEISHU_AUTHORIZE_BASE_URL")?;
    let mut url = base
        .join("/open-apis/authen/v1/authorize")
        .context("building the Feishu authorize URL")?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", scope)
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("prompt", "consent");
    Ok(url.to_string())
}

/// A successfully parsed Feishu OAuth token-endpoint response (shared by the authorization_code
/// and refresh_token grants).
#[derive(Debug, Clone)]
pub struct TokenSuccess {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: i64,
    /// Only present when the request (or the original authorization) granted `offline_access`.
    pub refresh_token: Option<String>,
    pub refresh_token_expires_in: Option<i64>,
    pub scope: Option<String>,
}

/// Raw shape of a token-endpoint response, wide enough to cover the success fields and both
/// documented failure shapes (`error`/`error_description`, and a nonzero `code`/`msg`) so a
/// single parse handles every case without guessing which shape a given response uses.
#[derive(Debug, Default, Deserialize)]
struct TokenResponseRaw {
    #[serde(default)]
    code: Option<i64>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
    #[serde(default)]
    msg: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    refresh_token_expires_in: Option<i64>,
    #[serde(default)]
    scope: Option<String>,
}

fn parse_token_response(status: StatusCode, body: &str) -> Result<TokenSuccess> {
    let raw: TokenResponseRaw = serde_json::from_str(body).with_context(|| {
        format!("unexpected response from the Feishu token endpoint (status {status}): {body}")
    })?;

    let is_error = raw.error.is_some() || matches!(raw.code, Some(c) if c != 0);
    if is_error {
        let reason = raw
            .error_description
            .clone()
            .or_else(|| raw.msg.clone())
            .unwrap_or_else(|| "no error description provided".to_string());
        let marker = match (&raw.error, raw.code) {
            (Some(e), _) => format!("error={e}"),
            (None, Some(c)) => format!("code={c}"),
            (None, None) => "unknown error".to_string(),
        };
        anyhow::bail!("Feishu token endpoint rejected the request ({marker}): {reason}");
    }

    let access_token = raw
        .access_token
        .context("Feishu token endpoint reported success but included no access_token")?;
    let expires_in = raw
        .expires_in
        .context("Feishu token endpoint reported success but included no expires_in")?;

    Ok(TokenSuccess {
        access_token,
        token_type: raw.token_type.unwrap_or_else(|| "Bearer".to_string()),
        expires_in,
        refresh_token: raw.refresh_token,
        refresh_token_expires_in: raw.refresh_token_expires_in,
        scope: raw.scope,
    })
}

/// A successfully parsed `GET /open-apis/authen/v1/user_info` response.
#[derive(Debug, Clone, Deserialize)]
pub struct UserInfo {
    pub open_id: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct UserInfoEnvelope {
    #[serde(default)]
    code: Option<i64>,
    #[serde(default)]
    msg: Option<String>,
    #[serde(default)]
    data: Option<UserInfo>,
}

fn parse_user_info_response(status: StatusCode, body: &str) -> Result<UserInfo> {
    let raw: UserInfoEnvelope = serde_json::from_str(body).with_context(|| {
        format!(
            "unexpected response from the Feishu user_info endpoint (status {status}): {body}"
        )
    })?;
    if matches!(raw.code, Some(c) if c != 0) {
        let reason = raw.msg.unwrap_or_else(|| "no message provided".to_string());
        anyhow::bail!(
            "Feishu user_info endpoint rejected the request (code={:?}): {reason}",
            raw.code
        );
    }
    raw.data
        .context("Feishu user_info endpoint reported success but included no data")
}

/// A configured connection to the Feishu OAuth token/user_info endpoints for one app.
pub struct FeishuOAuthClient {
    http: reqwest::Client,
    token_base_url: String,
    client_id: String,
    client_secret: String,
}

impl FeishuOAuthClient {
    pub fn new(
        token_base_url: impl Into<String>,
        client_id: impl Into<String>,
        client_secret: impl Into<String>,
    ) -> Self {
        Self {
            http: reqwest::Client::new(),
            token_base_url: token_base_url.into(),
            client_id: client_id.into(),
            client_secret: client_secret.into(),
        }
    }

    /// `grant_type=authorization_code`: exchanges a one-time authorization `code` for an access
    /// token (and, when `offline_access` was granted, a refresh token).
    pub async fn exchange_code(
        &self,
        code: &str,
        redirect_uri: &str,
        code_verifier: &str,
        scope: Option<&str>,
    ) -> Result<TokenSuccess> {
        let mut body = serde_json::json!({
            "grant_type": "authorization_code",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
        });
        if let Some(s) = scope {
            body["scope"] = serde_json::Value::String(s.to_string());
        }
        self.post_token(&body).await
    }

    /// `grant_type=refresh_token`: exchanges a refresh token for a new access token. Feishu
    /// typically rotates the refresh token on every use, so callers must persist whatever comes
    /// back in `TokenSuccess::refresh_token` rather than assuming the token they sent is still
    /// valid afterward.
    pub async fn refresh(&self, refresh_token: &str) -> Result<TokenSuccess> {
        let body = serde_json::json!({
            "grant_type": "refresh_token",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "refresh_token": refresh_token,
        });
        self.post_token(&body).await
    }

    async fn post_token(&self, body: &serde_json::Value) -> Result<TokenSuccess> {
        let url = format!(
            "{}/open-apis/authen/v2/oauth/token",
            self.token_base_url.trim_end_matches('/')
        );
        let resp = self
            .http
            .post(&url)
            .json(body)
            .send()
            .await
            .context("network error contacting the Feishu token endpoint")?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .context("reading the Feishu token endpoint response body")?;
        parse_token_response(status, &text)
    }

    /// `GET /open-apis/authen/v1/user_info`: resolves the `open_id` (and display name) behind an
    /// access token. Purely informational -- a failure here should never block a login that
    /// otherwise obtained a valid access token.
    pub async fn fetch_user_info(&self, access_token: &str) -> Result<UserInfo> {
        let url = format!(
            "{}/open-apis/authen/v1/user_info",
            self.token_base_url.trim_end_matches('/')
        );
        let resp = self
            .http
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .context("network error contacting the Feishu user_info endpoint")?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .context("reading the Feishu user_info response body")?;
        parse_user_info_response(status, &text)
    }
}

/// Extracts `code` and `state` from a callback's query string. Accepts a bare query string
/// (`code=...&state=...`), a full URL, or an HTTP request line (`GET /callback?code=...
/// HTTP/1.1`) -- only the query-string portion is meaningful, so all three shapes are handled by
/// locating the text after the first `?`.
pub fn parse_callback_params(input: &str) -> Result<(String, String)> {
    let query = extract_query_string(input);
    let mut code = None;
    let mut state = None;
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            _ => {}
        }
    }
    let code = code.context("the authorization callback did not include a `code` parameter")?;
    let state =
        state.context("the authorization callback did not include a `state` parameter")?;
    Ok((code, state))
}

fn extract_query_string(input: &str) -> String {
    // A request line ("GET /callback?a=b HTTP/1.1") has three whitespace-separated tokens; a
    // bare URL or query string has one. Taking the second whitespace-separated token when
    // present, and falling back to the whole trimmed input otherwise, handles both.
    let candidate = input
        .split_whitespace()
        .nth(1)
        .unwrap_or_else(|| input.trim());
    match candidate.split_once('?') {
        Some((_, query)) => query.to_string(),
        None => candidate.to_string(),
    }
}

/// Verifies a callback's `state` matches the value generated for this login attempt, guarding
/// against CSRF and against a stale or reused authorization link.
pub fn validate_state(received: &str, expected: &str) -> Result<()> {
    anyhow::ensure!(
        received == expected,
        "state mismatch on the Feishu authorization callback (possible CSRF attempt, or a \
         stale/reused authorization link); expected {expected:?}, got {received:?}"
    );
    Ok(())
}

/// Parses whatever a user pasted after approving the authorization request in `--manual` mode:
/// either the full redirected URL (or just its query string) or a bare authorization code.
///
/// A pasted value containing `=` is assumed to be URL/query-shaped and is parsed with `state`
/// cross-checked against `expected_state`; a value with no `=` at all is treated as a bare code
/// with no `state` to check (the user copied only the `code` value, not the whole URL).
pub fn extract_code_from_pasted_input(input: &str, expected_state: &str) -> Result<String> {
    let trimmed = input.trim();
    anyhow::ensure!(!trimmed.is_empty(), "no authorization response was provided");

    if !trimmed.contains('=') {
        return Ok(trimmed.to_string());
    }

    let (code, state) = parse_callback_params(trimmed)?;
    validate_state(&state, expected_state)?;
    Ok(code)
}

/// Binds the one-shot loopback listener that will receive the Feishu authorization callback.
/// Bound before the authorize URL is shown so a bind failure (e.g. the port already in use) is
/// reported before asking the user to do anything.
pub async fn bind_loopback_listener(port: u16) -> Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", port)).await.with_context(|| {
        format!(
            "could not bind the OAuth loopback listener to 127.0.0.1:{port} (the port is \
             likely already in use). Set SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT to a free port, or \
             rerun with `login --manual`."
        )
    })
}

/// Accepts exactly one connection on `listener`, reads its HTTP request line, extracts
/// `code`/`state` from it, and responds with a minimal HTML page telling the user they can close
/// the browser tab -- regardless of whether extraction succeeded, so the browser tab never hangs
/// waiting for a response.
pub async fn await_callback(listener: TcpListener, timeout: Duration) -> Result<(String, String)> {
    tokio::time::timeout(timeout, accept_one_callback(listener))
        .await
        .context(
            "timed out waiting for the Feishu authorization callback; the browser approval step \
             may not have completed, or the registered redirect URI does not point at this \
             listener",
        )?
}

async fn accept_one_callback(listener: TcpListener) -> Result<(String, String)> {
    let (mut stream, _) = listener
        .accept()
        .await
        .context("accepting the OAuth callback connection")?;

    let mut buf = vec![0u8; 8192];
    let n = stream
        .read(&mut buf)
        .await
        .context("reading the OAuth callback request")?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let request_line = request.lines().next().unwrap_or_default();
    let result = parse_callback_params(request_line);

    let (status_line, message) = if result.is_ok() {
        ("HTTP/1.1 200 OK", "Login complete. You can close this window.")
    } else {
        (
            "HTTP/1.1 400 Bad Request",
            "Login failed: the callback did not include the expected parameters. You can \
             close this window and retry, e.g. with `login --manual`.",
        )
    };
    let html = format!("<html><body><p>{message}</p></body></html>");
    let response = format!(
        "{status_line}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \
         {}\r\nConnection: close\r\n\r\n{html}",
        html.len(),
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;

    result
}

/// Best-effort attempt to open `url` in the user's default browser. Never fatal: if the OS
/// command cannot be spawned (e.g. no GUI session, or the command is missing), this only prints
/// an informational note -- the authorize URL is always printed separately too, so a failure
/// here never blocks the login flow.
pub fn try_open_browser(url: &str) {
    let spawn_result = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).spawn()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
    } else {
        std::process::Command::new("xdg-open").arg(url).spawn()
    };
    if let Err(e) = spawn_result {
        eprintln!("(could not auto-open a browser: {e}; open the URL above manually)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_appendix_b_vector() {
        // https://www.rfc-editor.org/rfc/rfc7636#appendix-B
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected_challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(code_challenge_from_verifier(verifier), expected_challenge);
    }

    #[test]
    fn generated_code_verifier_is_in_range_and_charset() {
        let verifier = generate_code_verifier();
        assert!(verifier.len() >= 43 && verifier.len() <= 128);
        assert!(verifier.bytes().all(|b| PKCE_VERIFIER_CHARSET.contains(&b)));
    }

    #[test]
    fn build_authorize_url_includes_all_required_parameters() {
        let url = build_authorize_url(
            "https://accounts.feishu.cn",
            "cli_test123",
            "http://127.0.0.1:8899/callback",
            "offline_access",
            "state123",
            "challenge123",
        )
        .expect("should build a valid URL");

        assert!(url.starts_with("https://accounts.feishu.cn/open-apis/authen/v1/authorize?"));
        assert!(url.contains("client_id=cli_test123"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("state=state123"));
        assert!(url.contains("code_challenge=challenge123"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("scope=offline_access"));
    }

    #[test]
    fn parses_code_and_state_from_a_request_line() {
        let (code, state) =
            parse_callback_params("GET /callback?code=abc123&state=xyz789 HTTP/1.1")
                .expect("should parse");
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz789");
    }

    #[test]
    fn parses_code_and_state_from_a_full_url() {
        let (code, state) =
            parse_callback_params("http://127.0.0.1:8899/callback?code=abc123&state=xyz789")
                .expect("should parse");
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz789");
    }

    #[test]
    fn missing_code_is_a_clear_error() {
        let err = parse_callback_params("GET /callback?state=xyz789 HTTP/1.1").unwrap_err();
        assert!(err.to_string().contains("code"));
    }

    #[test]
    fn state_mismatch_is_rejected() {
        let err = validate_state("wrong-state", "expected-state").unwrap_err();
        assert!(err.to_string().contains("state mismatch"));
    }

    #[test]
    fn matching_state_is_accepted() {
        assert!(validate_state("same", "same").is_ok());
    }

    #[test]
    fn manual_input_accepts_a_full_pasted_url_with_correct_state() {
        let code = extract_code_from_pasted_input(
            "http://127.0.0.1:8899/callback?code=abc123&state=xyz789",
            "xyz789",
        )
        .expect("should extract code");
        assert_eq!(code, "abc123");
    }

    #[test]
    fn manual_input_rejects_a_pasted_url_with_wrong_state() {
        let err = extract_code_from_pasted_input(
            "http://127.0.0.1:8899/callback?code=abc123&state=xyz789",
            "different",
        )
        .unwrap_err();
        assert!(err.to_string().contains("state mismatch"));
    }

    #[test]
    fn manual_input_accepts_a_bare_code() {
        let code = extract_code_from_pasted_input("abc123", "xyz789").expect("should accept");
        assert_eq!(code, "abc123");
    }

    #[test]
    fn token_response_parses_authorization_code_success() {
        let body = serde_json::json!({
            "code": 0,
            "access_token": "u-abc",
            "token_type": "Bearer",
            "expires_in": 7200,
            "refresh_token": "r-abc",
            "refresh_token_expires_in": 2592000,
            "scope": "offline_access"
        })
        .to_string();
        let result = parse_token_response(StatusCode::OK, &body).expect("should parse");
        assert_eq!(result.access_token, "u-abc");
        assert_eq!(result.refresh_token.as_deref(), Some("r-abc"));
        assert_eq!(result.expires_in, 7200);
    }

    #[test]
    fn token_response_parses_refresh_success() {
        let body = serde_json::json!({
            "code": 0,
            "access_token": "u-new",
            "token_type": "Bearer",
            "expires_in": 7200,
            "refresh_token": "r-new",
            "refresh_token_expires_in": 2591999
        })
        .to_string();
        let result = parse_token_response(StatusCode::OK, &body).expect("should parse");
        assert_eq!(result.access_token, "u-new");
        assert_eq!(result.refresh_token.as_deref(), Some("r-new"));
    }

    #[test]
    fn token_response_maps_error_description_shape_to_a_clear_error() {
        let body = serde_json::json!({
            "error": "invalid_grant",
            "error_description": "authorization code has expired"
        })
        .to_string();
        let err = parse_token_response(StatusCode::BAD_REQUEST, &body).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("invalid_grant"));
        assert!(msg.contains("authorization code has expired"));
    }

    #[test]
    fn token_response_maps_nonzero_code_shape_to_a_clear_error() {
        let body = serde_json::json!({
            "code": 20029,
            "msg": "invalid redirect_uri"
        })
        .to_string();
        let err = parse_token_response(StatusCode::OK, &body).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("20029"));
        assert!(msg.contains("invalid redirect_uri"));
    }

    #[test]
    fn user_info_parses_success() {
        let body = serde_json::json!({
            "code": 0,
            "msg": "success",
            "data": {"open_id": "ou_abc", "name": "Test User"}
        })
        .to_string();
        let info = parse_user_info_response(StatusCode::OK, &body).expect("should parse");
        assert_eq!(info.open_id, "ou_abc");
        assert_eq!(info.name.as_deref(), Some("Test User"));
    }

    #[test]
    fn user_info_maps_error_to_a_clear_message() {
        let body =
            serde_json::json!({"code": 99991663, "msg": "invalid access token"}).to_string();
        let err = parse_user_info_response(StatusCode::UNAUTHORIZED, &body).unwrap_err();
        assert!(err.to_string().contains("invalid access token"));
    }
}
