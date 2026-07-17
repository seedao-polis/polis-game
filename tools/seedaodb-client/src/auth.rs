//! Identity login/logout flows.
//!
//! Two modes, selected by `SEEDAODB_CLIENT_AUTH_MODE`:
//!
//! - `static`: no network Feishu interaction at all. `login_static` only verifies that
//!   `SEEDAODB_CLIENT_STATIC_TOKEN` is configured, then probes the live server once to confirm
//!   both gates (service token + this static token) actually pass end to end.
//! - `feishu`: a real user OAuth flow against the Feishu OpenAPI, so this client can send its
//!   own `X-Feishu-User-Token` rather than depending on any other tool's session. lark-cli
//!   deliberately does not export a token an external process can reuse (see `lark_shell`'s
//!   module docs for why), so `login_feishu` talks to Feishu directly instead of "borrowing"
//!   lark-cli, running the authorization-code + PKCE flow implemented in `feishu_oauth`.
//!
//! `resolve_user_token` is the single place both auth modes' "what token do I send right now"
//! logic lives -- `commands::build_client` calls it for every subcommand, so static and feishu
//! mode are resolved identically everywhere rather than each command reimplementing this.

use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::client::SeedaodbClient;
use crate::config::{AuthMode, ClientConfig};
use crate::feishu_oauth;

/// A near-expiry access token is refreshed proactively rather than waited out, so a command
/// already in flight (DNS lookup, TLS handshake, ...) does not race the token's real expiry.
const TOKEN_EXPIRY_BUFFER_SECS: u64 = 60;

/// How long `login` (loopback mode) waits for the browser to complete the authorization step
/// and redirect back, matching the ~5 minute validity window Feishu documents for the
/// authorization `code` itself.
const CALLBACK_WAIT_TIMEOUT: Duration = Duration::from_secs(300);

/// Local login-state file contents.
///
/// `static` mode still writes one (with `user_token` set to the configured static token) purely
/// so `logout` has something uniform to clear and `whoami`/other commands have one place to read
/// the active token from; the source of truth for static mode remains
/// `SEEDAODB_CLIENT_STATIC_TOKEN` in `.env`, not this file. `feishu` mode is this file's real
/// source of truth: `user_token`/`refresh_token`/`expires_at` are the values `login_feishu`
/// obtained from Feishu and that `resolve_user_token` refreshes transparently as needed.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct LoginState {
    pub mode: String,
    pub open_id: Option<String>,
    pub user_token: Option<String>,
    pub refresh_token: Option<String>,
    /// Unix epoch seconds (as a decimal string) at which `user_token` expires. `None` for
    /// `static` mode, which has no expiry. Stored as a plain string rather than a numeric type
    /// so a hand-edited or older-format state file with a missing/malformed value fails to parse
    /// as a number (and is therefore treated as "needs a refresh") rather than panicking.
    pub expires_at: Option<String>,
}

impl LoginState {
    pub fn load(path: &Path) -> Option<Self> {
        let raw = fs::read_to_string(path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("creating {parent:?}"))?;
        }
        let raw = serde_json::to_string_pretty(self)?;
        fs::write(path, raw).with_context(|| format!("writing {path:?}"))?;
        restrict_permissions(path);
        Ok(())
    }

    pub fn clear(path: &Path) -> Result<()> {
        if path.exists() {
            fs::remove_file(path).with_context(|| format!("removing {path:?}"))?;
        }
        Ok(())
    }
}

/// Narrows the login-state file to owner-only access. This is a best-effort hardening step, not
/// the primary protection -- the file lives under a per-user profile directory by default (see
/// `config::default_token_file`), and its contents are limited to what this client itself needs
/// (never lark-cli's or any other tool's credentials).
#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = fs::metadata(path) {
        let mut perms = metadata.permissions();
        perms.set_mode(0o600);
        let _ = fs::set_permissions(path, perms);
    }
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {
    // Windows ACL narrowing is not attempted here; the default token file path already lives
    // under the per-user %APPDATA% profile directory, which ordinary local accounts other than
    // the owner cannot read by default.
}

/// Verifies `static` mode credentials against a live server and records a local login marker.
///
/// This performs exactly two requests: `GET /health` (unauthenticated, confirms the server is
/// reachable at all) followed by `GET /datasources` (requires both the service token and the
/// static identity token to pass), so a success here is proof the full two-gate chain works, not
/// just that the token strings are non-empty.
pub async fn login_static(config: &ClientConfig) -> Result<()> {
    let token = config.static_token.clone().context(
        "SEEDAODB_CLIENT_STATIC_TOKEN is not set. Static mode requires a token value that is \
         also registered in the seedaodb server's config/static-tokens.toml.",
    )?;

    let client = SeedaodbClient::new(&config.base_url, &config.service_token, &token);

    client
        .health()
        .await
        .map_err(|e| anyhow::anyhow!(e.friendly()))
        .context("could not reach seedaodb's GET /health")?;

    client
        .datasources()
        .await
        .map_err(|e| anyhow::anyhow!(e.friendly()))
        .context(
            "the service token + static token combination was rejected by seedaodb's \
             GET /datasources",
        )?;

    LoginState {
        mode: "static".to_string(),
        open_id: None,
        user_token: Some(token),
        refresh_token: None,
        expires_at: None,
    }
    .save(&config.token_file)?;

    Ok(())
}

/// Clears whatever local login state exists, regardless of auth mode.
pub fn logout(config: &ClientConfig) -> Result<()> {
    LoginState::clear(&config.token_file)
}

/// Runs the Feishu user OAuth authorization-code + PKCE flow end to end and records the result
/// as the local `feishu`-mode login state.
///
/// The client obtains its own token directly from the Feishu OpenAPI; it does not reuse
/// lark-cli's session, which is not designed to export a reusable token to another process (see
/// `lark_shell`'s module docs). Steps:
///
/// 1. Generate `state` (CSRF) and a PKCE `code_verifier`/`code_challenge` pair.
/// 2. Build the authorize URL and obtain the resulting authorization `code`, either via a
///    one-shot loopback listener (default) or by prompting for a pasted URL/code (`manual`).
/// 3. Exchange the `code` for an access/refresh token pair at the v2 token endpoint.
/// 4. Best-effort resolve `open_id` via `user_info`; a failure here does not fail the login,
///    since the access token itself is already valid at this point.
/// 5. Persist everything to the local login-state file.
pub async fn login_feishu(config: &ClientConfig, manual: bool) -> Result<()> {
    let app_id = config.feishu_app_id.clone().context(
        "SEEDAODB_CLIENT_FEISHU_APP_ID is not set. Configure it in .env (see README.md's \
         Feishu-mode section).",
    )?;
    let app_secret = config.feishu_app_secret.clone().context(
        "SEEDAODB_CLIENT_FEISHU_APP_SECRET is not set. Configure it in .env (see README.md's \
         Feishu-mode section).",
    )?;

    let redirect_uri = config.feishu_redirect_uri();
    let state = feishu_oauth::generate_state();
    let code_verifier = feishu_oauth::generate_code_verifier();
    let code_challenge = feishu_oauth::code_challenge_from_verifier(&code_verifier);

    // Bound before the authorize URL is even printed (loopback mode only) so a busy port is
    // reported up front rather than after the user has already gone through the browser step.
    let listener = if manual {
        None
    } else {
        Some(feishu_oauth::bind_loopback_listener(config.oauth_redirect_port).await?)
    };

    let authorize_url = feishu_oauth::build_authorize_url(
        &config.feishu_authorize_base_url,
        &app_id,
        &redirect_uri,
        &config.feishu_scope,
        &state,
        &code_challenge,
    )?;

    println!("Open this URL in a browser, sign in, and approve the request:\n");
    println!("  {authorize_url}\n");

    let code = if let Some(listener) = listener {
        feishu_oauth::try_open_browser(&authorize_url);
        println!(
            "Waiting for the browser redirect on http://127.0.0.1:{}/callback ...",
            config.oauth_redirect_port
        );
        let (code, received_state) =
            feishu_oauth::await_callback(listener, CALLBACK_WAIT_TIMEOUT).await?;
        feishu_oauth::validate_state(&received_state, &state)?;
        code
    } else {
        println!(
            "After approving, paste the full redirected URL (or just the `code` value) below, \
             then press Enter:"
        );
        let mut input = String::new();
        std::io::stdin()
            .read_line(&mut input)
            .context("reading the pasted authorization response from stdin")?;
        feishu_oauth::extract_code_from_pasted_input(&input, &state)?
    };

    println!("Exchanging the authorization code for a Feishu access token...");
    let oauth_client = feishu_oauth::FeishuOAuthClient::new(
        config.feishu_token_base_url.clone(),
        app_id,
        app_secret,
    );
    let token = oauth_client
        .exchange_code(&code, &redirect_uri, &code_verifier, Some(&config.feishu_scope))
        .await
        .context("exchanging the authorization code for a Feishu access token")?;

    let open_id = match oauth_client.fetch_user_info(&token.access_token).await {
        Ok(info) => Some(info.open_id),
        Err(e) => {
            eprintln!("(could not resolve open_id via Feishu user_info, continuing without it: {e})");
            None
        }
    };

    LoginState {
        mode: "feishu".to_string(),
        open_id: open_id.clone(),
        user_token: Some(token.access_token),
        refresh_token: token.refresh_token,
        expires_at: Some(compute_expires_at(token.expires_in)),
    }
    .save(&config.token_file)?;

    match open_id {
        Some(id) => println!("login ok (feishu mode), open_id={id}"),
        None => println!("login ok (feishu mode)"),
    }

    Ok(())
}

/// Resolves the identity token this client should send as `X-Feishu-User-Token` right now.
/// Centralizes token resolution so every subcommand (via `commands::build_client`) goes through
/// the same static/feishu logic instead of reimplementing it per command.
///
/// `static` mode returns the configured token directly. `feishu` mode reads the local login
/// state and, when the stored access token is expired or within `TOKEN_EXPIRY_BUFFER_SECS` of
/// expiring, refreshes it via the token endpoint's `refresh_token` grant and persists the new
/// values before returning.
pub async fn resolve_user_token(config: &ClientConfig) -> Result<String> {
    match config.auth_mode {
        AuthMode::Static => config
            .static_token
            .clone()
            .context("SEEDAODB_CLIENT_STATIC_TOKEN is not set. Set it in .env, then run `login`."),
        AuthMode::Feishu => resolve_feishu_user_token(config).await,
    }
}

async fn resolve_feishu_user_token(config: &ClientConfig) -> Result<String> {
    let mut state = LoginState::load(&config.token_file)
        .context("not logged in. Run `login` first (feishu mode).")?;

    let access_token = state
        .user_token
        .clone()
        .context("stored login state has no access token; run `login` again")?;

    let needs_refresh = match state.expires_at.as_deref() {
        Some(exp) => is_expired_or_near(exp, TOKEN_EXPIRY_BUFFER_SECS),
        // No expiry recorded at all (e.g. a hand-edited or otherwise unusual state file): trust
        // the stored token rather than forcing an unnecessary refresh.
        None => false,
    };

    if !needs_refresh {
        return Ok(access_token);
    }

    let refresh_token = state.refresh_token.clone().context(
        "the stored Feishu access token has expired and no refresh token is available (login \
         may not have granted offline_access); run `login` again",
    )?;
    let app_id = config
        .feishu_app_id
        .clone()
        .context("SEEDAODB_CLIENT_FEISHU_APP_ID is not set; cannot refresh the Feishu access token")?;
    let app_secret = config.feishu_app_secret.clone().context(
        "SEEDAODB_CLIENT_FEISHU_APP_SECRET is not set; cannot refresh the Feishu access token",
    )?;

    let oauth_client = feishu_oauth::FeishuOAuthClient::new(
        config.feishu_token_base_url.clone(),
        app_id,
        app_secret,
    );

    let token = oauth_client
        .refresh(&refresh_token)
        .await
        .context("refreshing the Feishu access token failed; run `login` again")?;

    state.user_token = Some(token.access_token.clone());
    if let Some(new_refresh) = token.refresh_token {
        state.refresh_token = Some(new_refresh);
    }
    state.expires_at = Some(compute_expires_at(token.expires_in));
    state.save(&config.token_file)?;

    Ok(token.access_token)
}

/// Converts an `expires_in` (seconds from now, as reported by the token endpoint) into an
/// absolute Unix epoch second, stored as a decimal string. Uses the real wall-clock time at
/// request completion, since token expiry is inherently a real-time property.
fn compute_expires_at(expires_in_secs: i64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let delta = expires_in_secs.max(0) as u64;
    (now + delta).to_string()
}

/// True when `expires_at` (Unix epoch seconds) is at or within `buffer_secs` of the current real
/// time, or when it fails to parse -- an unparseable value is treated as untrustworthy and
/// therefore due for a refresh rather than silently reused.
fn is_expired_or_near(expires_at: &str, buffer_secs: u64) -> bool {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    match expires_at.parse::<u64>() {
        Ok(exp) => now + buffer_secs >= exp,
        Err(_) => true,
    }
}

#[cfg(test)]
mod expiry_tests {
    use super::*;

    #[test]
    fn far_future_expiry_does_not_need_refresh() {
        let expires_at = compute_expires_at(3600);
        assert!(!is_expired_or_near(&expires_at, TOKEN_EXPIRY_BUFFER_SECS));
    }

    #[test]
    fn past_expiry_needs_refresh() {
        let expires_at = compute_expires_at(-3600);
        assert!(is_expired_or_near(&expires_at, TOKEN_EXPIRY_BUFFER_SECS));
    }

    #[test]
    fn expiry_within_buffer_needs_refresh() {
        let expires_at = compute_expires_at(30);
        assert!(is_expired_or_near(&expires_at, TOKEN_EXPIRY_BUFFER_SECS));
    }

    #[test]
    fn unparseable_expiry_needs_refresh() {
        assert!(is_expired_or_near("not-a-number", TOKEN_EXPIRY_BUFFER_SECS));
    }
}
