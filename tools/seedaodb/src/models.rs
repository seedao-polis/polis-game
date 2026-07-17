//! Request/response payload shapes shared across route handlers.
//!
//! Every successful response is wrapped in the same `{ ok, data, error }` envelope so clients
//! can rely on a single shape regardless of endpoint.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Standard success envelope. Errors use `crate::error::AppError` instead, which renders its
/// own envelope with `ok: false`.
#[derive(Serialize)]
pub struct Envelope<T: Serialize> {
    pub ok: bool,
    pub data: T,
    pub error: Option<()>,
}

impl<T: Serialize> Envelope<T> {
    pub fn ok(data: T) -> Self {
        Envelope {
            ok: true,
            data,
            error: None,
        }
    }
}

/// Body for `POST /query` and `POST /exec`.
#[derive(Deserialize)]
pub struct SqlRequest {
    /// Logical datasource name as registered in `datasources.toml` (e.g. `"soul"`, `"shared"`).
    pub db: String,
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

/// Result shape for `POST /query` and the read-only table browsing endpoints.
#[derive(Serialize)]
pub struct QueryResultData {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

/// Result shape for `POST /exec`.
#[derive(Serialize)]
pub struct ExecResultData {
    pub changes: i64,
    #[serde(rename = "lastInsertRowid")]
    pub last_insert_rowid: i64,
}

/// Query string for `GET /tables`.
#[derive(Deserialize)]
pub struct DbQuery {
    pub db: String,
}

/// Query string for `GET /tables/:name/rows`.
#[derive(Deserialize)]
pub struct RowsQuery {
    pub db: String,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// One entry of `GET /datasources`. Never includes the connection URL or credentials.
#[derive(Serialize)]
pub struct DatasourceInfo {
    pub name: String,
    pub backend: String,
    pub readonly: bool,
}

/// Response body for `GET /health`.
#[derive(Serialize)]
pub struct HealthData {
    pub status: &'static str,
    pub version: &'static str,
    pub datasources: Vec<String>,
}
