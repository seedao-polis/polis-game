//! Static, network-free identity verifier.
//!
//! Maps a fixed set of bearer tokens to `open_id`s from a small TOML table. This exists so the
//! full HTTP -> auth -> RBAC -> database chain can be exercised end to end (in integration tests
//! and local development) without a live Feishu app or any network access -- selected via
//! `SEEDAODB_AUTH_MODE=static`. It is not meant for production use against untrusted clients.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::Deserialize;

use crate::error::AppError;

use super::IdentityVerifier;

#[derive(Debug, Deserialize)]
struct TokenEntry {
    token: String,
    open_id: String,
}

#[derive(Debug, Deserialize)]
struct StaticTokensFile {
    #[serde(default, rename = "token")]
    token: Vec<TokenEntry>,
}

pub struct StaticVerifier {
    tokens: HashMap<String, String>,
}

impl StaticVerifier {
    /// Builds a verifier directly from a token -> open_id map, without touching the filesystem.
    /// Used by integration tests.
    pub fn from_map(tokens: HashMap<String, String>) -> Self {
        Self { tokens }
    }

    /// Loads the `[[token]]` table from a TOML file (see `config/static-tokens.toml.example`).
    pub fn from_file(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading static tokens file at {}", path.display()))?;
        let parsed: StaticTokensFile =
            toml::from_str(&raw).with_context(|| "parsing static-tokens.toml".to_string())?;
        let tokens = parsed
            .token
            .into_iter()
            .map(|entry| (entry.token, entry.open_id))
            .collect();
        Ok(Self { tokens })
    }
}

#[async_trait]
impl IdentityVerifier for StaticVerifier {
    async fn verify(&self, token: &str) -> Result<String, AppError> {
        self.tokens
            .get(token)
            .cloned()
            .ok_or_else(|| AppError::Unauthorized("unrecognized user token".to_string()))
    }
}
