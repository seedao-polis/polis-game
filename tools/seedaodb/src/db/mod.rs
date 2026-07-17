//! Pluggable database backend abstraction.
//!
//! Callers address a "datasource" by its logical name (as declared in `datasources.toml`), never
//! by file path or connection string. This is what lets the SQLite backend be swapped for a
//! different backend later purely through configuration, with no change to the routing or
//! authorization layers.

#[cfg(feature = "mysql-backend")]
pub mod mysql;
pub mod sqlite;

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;

/// Read vs. write intent, used by the RBAC layer to pick which permission list to check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Read,
    Write,
}

/// Result of a `SELECT`-shaped statement: column names plus row-major dynamic values.
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

/// Result of an `INSERT`/`UPDATE`/`DELETE`-shaped statement.
pub struct ExecResult {
    pub changes: i64,
    pub last_insert_rowid: i64,
}

/// One `[[datasource]]` entry from `datasources.toml`.
#[derive(Debug, Clone, Deserialize)]
pub struct DatasourceEntryConfig {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub readonly: bool,
    #[serde(default = "default_busy_timeout_ms")]
    pub busy_timeout_ms: u64,
}

fn default_busy_timeout_ms() -> u64 {
    5000
}

#[derive(Debug, Deserialize)]
struct DatasourcesFile {
    #[serde(default, rename = "datasource")]
    datasource: Vec<DatasourceEntryConfig>,
}

/// A concrete backend connection for one datasource. New backends are added as new variants
/// gated behind their own Cargo feature (see `mysql-backend`), so the default build only ever
/// links the SQLite driver.
pub enum Backend {
    Sqlite(sqlite::SqliteBackend),
    #[cfg(feature = "mysql-backend")]
    Mysql(mysql::MysqlBackend),
}

impl Backend {
    pub fn kind(&self) -> &'static str {
        match self {
            Backend::Sqlite(_) => "sqlite",
            #[cfg(feature = "mysql-backend")]
            Backend::Mysql(_) => "mysql",
        }
    }

    pub async fn query(&self, sql: &str, params: &[Value]) -> Result<QueryResult, AppError> {
        match self {
            Backend::Sqlite(b) => b.query(sql, params).await,
            #[cfg(feature = "mysql-backend")]
            Backend::Mysql(b) => b.query(sql, params).await,
        }
    }

    pub async fn exec(
        &self,
        sql: &str,
        params: &[Value],
        busy_retry_max: u32,
    ) -> Result<ExecResult, AppError> {
        match self {
            Backend::Sqlite(b) => b.exec(sql, params, busy_retry_max).await,
            #[cfg(feature = "mysql-backend")]
            Backend::Mysql(b) => b.exec(sql, params, busy_retry_max).await,
        }
    }

    pub async fn list_tables(&self) -> Result<Vec<String>, AppError> {
        match self {
            Backend::Sqlite(b) => b.list_tables().await,
            #[cfg(feature = "mysql-backend")]
            Backend::Mysql(b) => b.list_tables().await,
        }
    }

    pub async fn rows_page(
        &self,
        table: &str,
        limit: i64,
        offset: i64,
    ) -> Result<QueryResult, AppError> {
        match self {
            Backend::Sqlite(b) => b.rows_page(table, limit, offset).await,
            #[cfg(feature = "mysql-backend")]
            Backend::Mysql(b) => b.rows_page(table, limit, offset).await,
        }
    }
}

/// One registered datasource: its backend connection plus the metadata reported by
/// `GET /datasources` (name/kind/readonly only -- never the URL or credentials).
pub struct DatasourceEntry {
    pub backend: Backend,
    pub readonly: bool,
}

/// Named lookup table of all configured datasources, built once at startup.
pub struct DatasourceRegistry {
    entries: HashMap<String, DatasourceEntry>,
}

impl DatasourceRegistry {
    /// Loads `datasources.toml` from disk and connects every declared datasource.
    pub async fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading datasources file at {}", path.display()))?;
        let parsed: DatasourcesFile =
            toml::from_str(&raw).with_context(|| "parsing datasources.toml".to_string())?;
        Self::from_entries(parsed.datasource).await
    }

    /// Connects a registry directly from a list of entries, bypassing the TOML file. Used by
    /// integration tests to point at a temporary SQLite file without writing a config file.
    pub async fn from_entries(configs: Vec<DatasourceEntryConfig>) -> Result<Self> {
        let mut entries = HashMap::new();
        for cfg in configs {
            let backend = connect_backend(&cfg).await?;
            entries.insert(
                cfg.name.clone(),
                DatasourceEntry {
                    backend,
                    readonly: cfg.readonly,
                },
            );
        }
        Ok(Self { entries })
    }

    pub fn get(&self, name: &str) -> Option<&DatasourceEntry> {
        self.entries.get(name)
    }

    pub fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.entries.keys().cloned().collect();
        names.sort();
        names
    }

    pub fn list_info(&self) -> Vec<DatasourceSummary> {
        let mut list: Vec<DatasourceSummary> = self
            .entries
            .iter()
            .map(|(name, entry)| DatasourceSummary {
                name: name.clone(),
                backend: entry.backend.kind().to_string(),
                readonly: entry.readonly,
            })
            .collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        list
    }
}

#[derive(Serialize)]
pub struct DatasourceSummary {
    pub name: String,
    pub backend: String,
    pub readonly: bool,
}

async fn connect_backend(cfg: &DatasourceEntryConfig) -> Result<Backend> {
    if let Some(_rest) = cfg.url.strip_prefix("sqlite:") {
        let backend = sqlite::SqliteBackend::connect(&cfg.url, cfg.readonly, cfg.busy_timeout_ms)
            .await
            .with_context(|| format!("connecting sqlite datasource {:?}", cfg.name))?;
        return Ok(Backend::Sqlite(backend));
    }

    if cfg.url.strip_prefix("mysql:").is_some() {
        #[cfg(feature = "mysql-backend")]
        {
            let backend = mysql::MysqlBackend::connect(&cfg.url, cfg.readonly)
                .await
                .with_context(|| format!("connecting mysql datasource {:?}", cfg.name))?;
            return Ok(Backend::Mysql(backend));
        }
        #[cfg(not(feature = "mysql-backend"))]
        {
            anyhow::bail!(
                "datasource {:?} uses a mysql:// URL but this build was compiled without \
                 the `mysql-backend` feature; rebuild with `cargo build --features mysql-backend`",
                cfg.name
            );
        }
    }

    anyhow::bail!(
        "datasource {:?} has an unsupported URL scheme (expected sqlite: or mysql:)",
        cfg.name
    )
}
