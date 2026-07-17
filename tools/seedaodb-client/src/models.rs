//! Data shapes mirroring the seedaodb server's JSON payloads.
//!
//! Field names (including the camelCase `lastInsertRowid` rename) are kept in lockstep with
//! `tools/seedaodb/src/models.rs` on the server side, since these two crates only agree on a
//! wire contract, not a shared Rust type.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The `{ ok, data, error }` envelope every seedaodb response is wrapped in.
///
/// `data` is optional because a failure response carries `data: null`; `error` is optional
/// because a success response carries `error: null`. Both fields are parsed regardless of which
/// branch is taken, so a malformed envelope from either side surfaces as a normal `None` rather
/// than a deserialization failure.
#[derive(Debug, Deserialize)]
pub struct Envelope<T> {
    pub ok: bool,
    pub data: Option<T>,
    pub error: Option<ErrorBody>,
}

/// The `error` object of a failed envelope: a machine-readable code plus a human-readable
/// message that, for `FORBIDDEN` responses, already states the exact RBAC rule that denied the
/// request.
#[derive(Debug, Clone, Deserialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

/// One entry of `GET /datasources`. Never carries a connection string or credentials.
#[derive(Debug, Clone, Deserialize)]
pub struct DatasourceInfo {
    pub name: String,
    pub backend: String,
    pub readonly: bool,
}

/// Response body of `GET /health`.
#[derive(Debug, Deserialize)]
pub struct HealthData {
    pub status: String,
    pub version: String,
    pub datasources: Vec<String>,
}

/// Result shape shared by `POST /query` and the row-browsing endpoints.
///
/// Each cell is decoded from SQLite's runtime storage class rather than a declared column type:
/// `NULL -> null`, `INTEGER`/`REAL -> number`, `TEXT -> string`, `BLOB -> base64-encoded string`.
#[derive(Debug, Deserialize)]
pub struct QueryResultData {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

/// Result shape of `POST /exec`.
#[derive(Debug, Deserialize)]
pub struct ExecResultData {
    pub changes: i64,
    #[serde(rename = "lastInsertRowid")]
    pub last_insert_rowid: i64,
}

/// Request body shared by `POST /query` and `POST /exec`.
///
/// `params` is bound positionally (`?` placeholders); supported JSON types are `null`, `boolean`,
/// `number`, and `string` -- arrays/objects have no SQLite container type to bind to and are
/// rejected by the server.
#[derive(Debug, Serialize)]
pub struct SqlRequest {
    pub db: String,
    pub sql: String,
    pub params: Vec<Value>,
}

/// Per-datasource read/write flags, as reported by a companion `GET /whoami` endpoint or
/// reconstructed locally by probing.
#[derive(Debug, Clone, Deserialize)]
pub struct DbPermission {
    pub read: bool,
    pub write: bool,
}

/// Response body of a companion `GET /whoami` endpoint (not guaranteed to exist on every
/// seedaodb deployment -- see `client::SeedaodbClient::whoami` and `commands::whoami`).
#[derive(Debug, Deserialize)]
pub struct WhoamiData {
    pub open_id: String,
    pub role: String,
    pub permissions: HashMap<String, DbPermission>,
}
