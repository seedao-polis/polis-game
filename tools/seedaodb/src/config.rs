//! Process configuration, sourced entirely from `SEEDAODB_*` environment variables.
//!
//! This module intentionally does not read anything from the host project's `.env` or
//! `configs/` directory; `tools/seedaodb` is a self-contained crate and every setting it needs
//! is namespaced under the `SEEDAODB_` prefix and documented in `.env.example`.

use std::path::PathBuf;

use anyhow::{Context, Result};

/// Selects which `IdentityVerifier` implementation is wired up at startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    /// Verify a Feishu user access token against the Feishu OpenAPI.
    Feishu,
    /// Look a token up in a local static table; used for local development and integration tests.
    Static,
}

/// Fully resolved process configuration.
pub struct AppConfig {
    pub port: u16,
    pub bind_addr: String,
    pub service_token: Option<String>,
    pub auth_mode: AuthMode,
    pub feishu_app_id: Option<String>,
    pub feishu_app_secret: Option<String>,
    pub feishu_base_url: String,
    pub static_tokens_file: PathBuf,
    pub datasources_file: PathBuf,
    pub acl_file: PathBuf,
    pub token_cache_ttl_s: u64,
    pub busy_retry_max: u32,
    pub max_body_bytes: usize,
    pub tls_cert: Option<PathBuf>,
    pub tls_key: Option<PathBuf>,
    pub audit_log: PathBuf,
}

fn env_string(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn env_or(key: &str, default: &str) -> String {
    env_string(key).unwrap_or_else(|| default.to_string())
}

fn env_parse_or<T: std::str::FromStr>(key: &str, default: T) -> Result<T> {
    match env_string(key) {
        None => Ok(default),
        Some(raw) => raw
            .parse::<T>()
            .map_err(|_| anyhow::anyhow!("invalid value for {key}: {raw:?}")),
    }
}

impl AppConfig {
    /// Reads and validates configuration from the process environment.
    ///
    /// Does not load `.env` itself; call `dotenvy::dotenv()` before this if a `.env` file
    /// should be applied first (this is what `main.rs` does).
    pub fn from_env() -> Result<Self> {
        let auth_mode = match env_or("SEEDAODB_AUTH_MODE", "feishu").to_ascii_lowercase().as_str() {
            "feishu" => AuthMode::Feishu,
            "static" => AuthMode::Static,
            other => {
                anyhow::bail!("invalid SEEDAODB_AUTH_MODE: {other:?} (expected 'feishu' or 'static')")
            }
        };

        Ok(AppConfig {
            port: env_parse_or("SEEDAODB_PORT", 8878u16).context("SEEDAODB_PORT")?,
            bind_addr: env_or("SEEDAODB_BIND_ADDR", "0.0.0.0"),
            service_token: env_string("SEEDAODB_SERVICE_TOKEN"),
            auth_mode,
            feishu_app_id: env_string("SEEDAODB_FEISHU_APP_ID"),
            feishu_app_secret: env_string("SEEDAODB_FEISHU_APP_SECRET"),
            feishu_base_url: env_or("SEEDAODB_FEISHU_BASE_URL", "https://open.feishu.cn"),
            static_tokens_file: PathBuf::from(env_or(
                "SEEDAODB_STATIC_TOKENS_FILE",
                "config/static-tokens.toml",
            )),
            datasources_file: PathBuf::from(env_or(
                "SEEDAODB_DATASOURCES_FILE",
                "config/datasources.toml",
            )),
            acl_file: PathBuf::from(env_or("SEEDAODB_ACL_FILE", "config/acl.toml")),
            token_cache_ttl_s: env_parse_or("SEEDAODB_TOKEN_CACHE_TTL_S", 300u64)
                .context("SEEDAODB_TOKEN_CACHE_TTL_S")?,
            busy_retry_max: env_parse_or("SEEDAODB_BUSY_RETRY_MAX", 5u32)
                .context("SEEDAODB_BUSY_RETRY_MAX")?,
            max_body_bytes: env_parse_or("SEEDAODB_MAX_BODY_BYTES", 1_048_576usize)
                .context("SEEDAODB_MAX_BODY_BYTES")?,
            tls_cert: env_string("SEEDAODB_TLS_CERT").map(PathBuf::from),
            tls_key: env_string("SEEDAODB_TLS_KEY").map(PathBuf::from),
            audit_log: PathBuf::from(env_or("SEEDAODB_AUDIT_LOG", "logs/audit.jsonl")),
        })
    }
}
