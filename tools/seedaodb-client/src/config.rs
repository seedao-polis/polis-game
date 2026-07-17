//! Client-side configuration, sourced from `SEEDAODB_CLIENT_*` environment variables.
//!
//! Deliberately namespaced separately from the server's own `SEEDAODB_*` variables even though
//! both ultimately point at the same running service: this is an independent crate with its own
//! `.env`, not a shared configuration surface with `tools/seedaodb`.

use std::path::PathBuf;

use anyhow::{Context, Result};

/// Selects how this client resolves the `X-Feishu-User-Token` value it sends on every request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    /// Uses a fixed token from `SEEDAODB_CLIENT_STATIC_TOKEN`, matched against the server's own
    /// `static-tokens.toml`. No network call to Feishu is involved.
    Static,
    /// Resolves a Feishu user access token through the Feishu OpenAPI's own authorization-code +
    /// PKCE user OAuth flow (see `feishu_oauth` and `auth::login_feishu`).
    Feishu,
}

/// Fully resolved client configuration.
#[derive(Debug)]
pub struct ClientConfig {
    /// Base URL of the seedaodb server, e.g. `http://127.0.0.1:8878`.
    pub base_url: String,
    /// Sent as `Authorization: Bearer <token>` on every protected request.
    pub service_token: String,
    pub auth_mode: AuthMode,
    /// Required when `auth_mode` is `Static`.
    pub static_token: Option<String>,
    /// Local path where login state (identity token, and eventually a Feishu refresh token) is
    /// persisted between commands.
    pub token_file: PathBuf,
    pub feishu_app_id: Option<String>,
    pub feishu_app_secret: Option<String>,
    /// Base URL for the Feishu token exchange/refresh and user_info endpoints. Not the same host
    /// as the authorize endpoint -- see `feishu_authorize_base_url`.
    pub feishu_token_base_url: String,
    /// Base URL for the Feishu authorize endpoint a user's browser is sent to.
    pub feishu_authorize_base_url: String,
    /// Space-separated OAuth scopes requested during login. Must include `offline_access` for
    /// Feishu to issue a `refresh_token`.
    pub feishu_scope: String,
    /// Loopback port `login` binds to while waiting for the authorization callback, used unless
    /// `feishu_redirect_uri` is set explicitly. Also embedded in the default redirect URI.
    pub oauth_redirect_port: u16,
    /// Explicit override for the redirect URI presented to Feishu and matched against the
    /// callback. When unset, resolves to `http://127.0.0.1:<oauth_redirect_port>/callback` (see
    /// `feishu_redirect_uri()`).
    pub feishu_redirect_uri: Option<String>,
    /// Optional override for locating lark-cli's `run.js`, used only by the best-effort identity
    /// cross-check in `whoami` (see `lark_shell`).
    pub lark_run: Option<String>,
}

impl ClientConfig {
    /// Reads configuration from the real process environment. Does not load a `.env` file
    /// itself -- `main.rs` calls `dotenvy::dotenv()` before this, matching the server crate's
    /// own startup order.
    pub fn from_env() -> Result<Self> {
        Self::from_lookup(|key| std::env::var(key).ok().filter(|v| !v.is_empty()))
    }

    /// Resolves the OAuth redirect URI this client presents to Feishu on the authorize request
    /// and listens for the callback on: `feishu_redirect_uri` verbatim if set, otherwise a
    /// loopback URL built from `oauth_redirect_port`.
    pub fn feishu_redirect_uri(&self) -> String {
        self.feishu_redirect_uri
            .clone()
            .unwrap_or_else(|| format!("http://127.0.0.1:{}/callback", self.oauth_redirect_port))
    }

    /// Core parsing logic, parameterized over a key lookup so it can be unit-tested without
    /// mutating real process environment variables (which are global process state and would
    /// make parallel tests flaky).
    fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let base_url = lookup("SEEDAODB_CLIENT_BASE_URL").context(
            "SEEDAODB_CLIENT_BASE_URL is not set. Point it at the seedaodb server's base URL, \
             e.g. http://127.0.0.1:8878 (after any port mapping you have set up).",
        )?;

        let service_token = lookup("SEEDAODB_CLIENT_SERVICE_TOKEN").unwrap_or_default();
        if service_token.is_empty() {
            tracing::warn!(
                "SEEDAODB_CLIENT_SERVICE_TOKEN is empty; every protected seedaodb endpoint will \
                 reject requests with 401 UNAUTHORIZED"
            );
        }

        let auth_mode = match lookup("SEEDAODB_CLIENT_AUTH_MODE")
            .unwrap_or_else(|| "static".to_string())
            .to_ascii_lowercase()
            .as_str()
        {
            "static" => AuthMode::Static,
            "feishu" => AuthMode::Feishu,
            other => anyhow::bail!(
                "invalid SEEDAODB_CLIENT_AUTH_MODE: {other:?} (expected 'static' or 'feishu')"
            ),
        };

        let token_file = lookup("SEEDAODB_CLIENT_TOKEN_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(default_token_file);

        let feishu_token_base_url = lookup("SEEDAODB_CLIENT_FEISHU_TOKEN_BASE_URL")
            .unwrap_or_else(|| "https://open.feishu.cn".to_string());
        let feishu_authorize_base_url = lookup("SEEDAODB_CLIENT_FEISHU_AUTHORIZE_BASE_URL")
            .unwrap_or_else(|| "https://accounts.feishu.cn".to_string());
        let feishu_scope = lookup("SEEDAODB_CLIENT_FEISHU_SCOPE")
            .unwrap_or_else(|| "offline_access".to_string());

        let oauth_redirect_port: u16 = match lookup("SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT") {
            Some(raw) => raw.parse().with_context(|| {
                format!("SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT is not a valid port number: {raw:?}")
            })?,
            None => 8899,
        };

        Ok(ClientConfig {
            base_url: base_url.trim_end_matches('/').to_string(),
            service_token,
            auth_mode,
            static_token: lookup("SEEDAODB_CLIENT_STATIC_TOKEN"),
            token_file,
            feishu_app_id: lookup("SEEDAODB_CLIENT_FEISHU_APP_ID"),
            feishu_app_secret: lookup("SEEDAODB_CLIENT_FEISHU_APP_SECRET"),
            feishu_token_base_url,
            feishu_authorize_base_url,
            feishu_scope,
            oauth_redirect_port,
            feishu_redirect_uri: lookup("SEEDAODB_CLIENT_FEISHU_REDIRECT_URI"),
            lark_run: lookup("SEEDAODB_CLIENT_LARK_RUN"),
        })
    }
}

/// Default local login-state path: a per-user config directory, not the current working
/// directory, so login state does not appear to "disappear" when a command is run from a
/// different directory. Resolves to `%APPDATA%\seedaodb-client\token.json` on Windows and the
/// platform equivalent (e.g. `~/.config/seedaodb-client/token.json`) elsewhere.
fn default_token_file() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("seedaodb-client")
        .join("token.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup_from(map: HashMap<&'static str, &'static str>) -> impl Fn(&str) -> Option<String> {
        move |key| map.get(key).map(|v| v.to_string())
    }

    #[test]
    fn missing_base_url_is_a_clear_error() {
        let err = ClientConfig::from_lookup(lookup_from(HashMap::new())).unwrap_err();
        assert!(err.to_string().contains("SEEDAODB_CLIENT_BASE_URL"));
    }

    #[test]
    fn parses_static_auth_mode_and_token() {
        let mut map = HashMap::new();
        map.insert("SEEDAODB_CLIENT_BASE_URL", "http://127.0.0.1:8878");
        map.insert("SEEDAODB_CLIENT_AUTH_MODE", "static");
        map.insert("SEEDAODB_CLIENT_STATIC_TOKEN", "dev-token");
        let cfg = ClientConfig::from_lookup(lookup_from(map)).unwrap();
        assert_eq!(cfg.auth_mode, AuthMode::Static);
        assert_eq!(cfg.static_token.as_deref(), Some("dev-token"));
        assert_eq!(cfg.base_url, "http://127.0.0.1:8878");
    }

    #[test]
    fn parses_feishu_auth_mode() {
        let mut map = HashMap::new();
        map.insert("SEEDAODB_CLIENT_BASE_URL", "http://127.0.0.1:8878");
        map.insert("SEEDAODB_CLIENT_AUTH_MODE", "feishu");
        let cfg = ClientConfig::from_lookup(lookup_from(map)).unwrap();
        assert_eq!(cfg.auth_mode, AuthMode::Feishu);
    }

    #[test]
    fn rejects_unknown_auth_mode() {
        let mut map = HashMap::new();
        map.insert("SEEDAODB_CLIENT_BASE_URL", "http://127.0.0.1:8878");
        map.insert("SEEDAODB_CLIENT_AUTH_MODE", "bogus");
        let err = ClientConfig::from_lookup(lookup_from(map)).unwrap_err();
        assert!(err.to_string().contains("bogus"));
    }

    #[test]
    fn trailing_slash_is_trimmed_from_base_url() {
        let mut map = HashMap::new();
        map.insert("SEEDAODB_CLIENT_BASE_URL", "http://127.0.0.1:8878/");
        let cfg = ClientConfig::from_lookup(lookup_from(map)).unwrap();
        assert_eq!(cfg.base_url, "http://127.0.0.1:8878");
    }

    #[test]
    fn feishu_settings_default_when_unset() {
        let mut map = HashMap::new();
        map.insert("SEEDAODB_CLIENT_BASE_URL", "http://127.0.0.1:8878");
        let cfg = ClientConfig::from_lookup(lookup_from(map)).unwrap();
        assert_eq!(cfg.feishu_token_base_url, "https://open.feishu.cn");
        assert_eq!(cfg.feishu_authorize_base_url, "https://accounts.feishu.cn");
        assert_eq!(cfg.feishu_scope, "offline_access");
        assert_eq!(cfg.oauth_redirect_port, 8899);
        assert_eq!(cfg.feishu_redirect_uri, None);
        assert_eq!(cfg.feishu_redirect_uri(), "http://127.0.0.1:8899/callback");
    }

    #[test]
    fn feishu_redirect_uri_override_wins_over_the_loopback_default() {
        let mut map = HashMap::new();
        map.insert("SEEDAODB_CLIENT_BASE_URL", "http://127.0.0.1:8878");
        map.insert(
            "SEEDAODB_CLIENT_FEISHU_REDIRECT_URI",
            "https://example.com/oauth/callback",
        );
        let cfg = ClientConfig::from_lookup(lookup_from(map)).unwrap();
        assert_eq!(
            cfg.feishu_redirect_uri(),
            "https://example.com/oauth/callback"
        );
    }

    #[test]
    fn oauth_redirect_port_is_parsed_from_env() {
        let mut map = HashMap::new();
        map.insert("SEEDAODB_CLIENT_BASE_URL", "http://127.0.0.1:8878");
        map.insert("SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT", "9100");
        let cfg = ClientConfig::from_lookup(lookup_from(map)).unwrap();
        assert_eq!(cfg.oauth_redirect_port, 9100);
        assert_eq!(cfg.feishu_redirect_uri(), "http://127.0.0.1:9100/callback");
    }

    #[test]
    fn invalid_oauth_redirect_port_is_a_clear_error() {
        let mut map = HashMap::new();
        map.insert("SEEDAODB_CLIENT_BASE_URL", "http://127.0.0.1:8878");
        map.insert("SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT", "not-a-port");
        let err = ClientConfig::from_lookup(lookup_from(map)).unwrap_err();
        assert!(err.to_string().contains("SEEDAODB_CLIENT_OAUTH_REDIRECT_PORT"));
    }
}
