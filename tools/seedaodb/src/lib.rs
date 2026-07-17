//! `seedaodb`: a standalone HTTP CRUD gateway in front of the tudigong SQLite databases.
//!
//! Everything here is self-contained: no module imports anything from the surrounding
//! `polis-game` Node/TypeScript project. The only coupling to the host project is a file path
//! recorded in `config/datasources.toml`, which disappears entirely if that datasource is ever
//! repointed at a non-SQLite backend.
//!
//! The crate is split into a library (this file and its modules) and a thin binary
//! (`src/main.rs`) so integration tests can exercise the router, auth, and database layers
//! in-process (via `axum::Router::oneshot`) without going through a real TCP socket.

pub mod audit;
pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod middleware;
pub mod models;
pub mod routes;
pub mod sql_guard;
pub mod state;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};

use auth::feishu::FeishuVerifier;
use auth::rbac::AclConfig;
use auth::static_verifier::StaticVerifier;
use auth::IdentityVerifier;
use config::{AppConfig, AuthMode};
use db::DatasourceRegistry;
use state::AppState;

/// Builds the identity verifier selected by `SEEDAODB_AUTH_MODE`.
fn build_verifier(config: &AppConfig) -> Result<Arc<dyn IdentityVerifier>> {
    match config.auth_mode {
        AuthMode::Feishu => {
            let app_id = config
                .feishu_app_id
                .clone()
                .context("SEEDAODB_FEISHU_APP_ID is required when SEEDAODB_AUTH_MODE=feishu")?;
            let app_secret = config.feishu_app_secret.clone().context(
                "SEEDAODB_FEISHU_APP_SECRET is required when SEEDAODB_AUTH_MODE=feishu",
            )?;
            let verifier = FeishuVerifier::new(
                app_id,
                app_secret,
                config.feishu_base_url.clone(),
                config.token_cache_ttl_s,
            )?;
            Ok(Arc::new(verifier))
        }
        AuthMode::Static => {
            let verifier = StaticVerifier::from_file(&config.static_tokens_file)?;
            Ok(Arc::new(verifier))
        }
    }
}

/// Runs the full startup sequence: load `.env`, parse configuration, connect every configured
/// datasource, load the ACL, then serve HTTP until the process is terminated.
///
/// Any failure here (bad config, unreadable ACL, a datasource that fails to connect) is
/// treated as fatal -- this service never starts in a partially-configured, silently-permissive
/// state.
pub async fn run() -> Result<()> {
    // Only applies if a `.env` file is present in the current working directory; harmless
    // otherwise. Real environment variables always take precedence over `.env` contents.
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = AppConfig::from_env().context("loading configuration from environment")?;

    if config.service_token.is_none() {
        tracing::warn!(
            "SEEDAODB_SERVICE_TOKEN is not set; every protected endpoint will reject all requests"
        );
    }

    let datasources = DatasourceRegistry::load(&config.datasources_file)
        .await
        .context("loading datasources.toml")?;
    tracing::info!(datasources = ?datasources.names(), "datasources connected");

    let acl = AclConfig::load(&config.acl_file).context("loading acl.toml")?;

    let verifier = build_verifier(&config)?;

    let state = AppState {
        config: Arc::new(config),
        datasources: Arc::new(datasources),
        acl: Arc::new(acl),
        verifier,
    };

    let bind_addr = format!("{}:{}", state.config.bind_addr, state.config.port);
    let router = routes::build_router(state);

    tracing::info!(addr = %bind_addr, "starting seedaodb");
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .with_context(|| format!("binding to {bind_addr}"))?;

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .context("server error")?;

    Ok(())
}
