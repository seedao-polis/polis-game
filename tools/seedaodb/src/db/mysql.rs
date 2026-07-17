//! MySQL backend skeleton.
//!
//! Only compiled when the `mysql-backend` Cargo feature is enabled (it is off by default, so a
//! plain `cargo build` never pulls in a MySQL driver). This module exists purely to hold the
//! shape of the abstraction boundary described in `db::Backend` -- every method here reports
//! "not implemented" rather than doing real work, so wiring a real MySQL driver in later is a
//! contained change that does not touch the routing, auth, or statement-guard layers.
//!
//! This file is only included in the build at all when the `mysql-backend` feature is enabled
//! (see the `#[cfg(feature = "mysql-backend")]` on its `mod mysql;` declaration).

use serde_json::Value;

use crate::error::AppError;

use super::{ExecResult, QueryResult};

pub struct MysqlBackend;

impl MysqlBackend {
    pub async fn connect(_url: &str, _readonly: bool) -> anyhow::Result<Self> {
        anyhow::bail!(
            "the mysql-backend feature only carries the abstraction skeleton; \
             a real MySQL driver has not been wired in yet"
        )
    }

    pub async fn query(&self, _sql: &str, _params: &[Value]) -> Result<QueryResult, AppError> {
        Err(AppError::Internal(anyhow::anyhow!(
            "mysql backend not implemented"
        )))
    }

    pub async fn exec(
        &self,
        _sql: &str,
        _params: &[Value],
        _busy_retry_max: u32,
    ) -> Result<ExecResult, AppError> {
        Err(AppError::Internal(anyhow::anyhow!(
            "mysql backend not implemented"
        )))
    }

    pub async fn list_tables(&self) -> Result<Vec<String>, AppError> {
        Err(AppError::Internal(anyhow::anyhow!(
            "mysql backend not implemented"
        )))
    }

    pub async fn rows_page(
        &self,
        _table: &str,
        _limit: i64,
        _offset: i64,
    ) -> Result<QueryResult, AppError> {
        Err(AppError::Internal(anyhow::anyhow!(
            "mysql backend not implemented"
        )))
    }
}
