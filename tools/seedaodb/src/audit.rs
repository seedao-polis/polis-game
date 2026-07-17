//! Append-only audit log for write operations and denied requests.
//!
//! Every line is a self-contained JSON object appended to `SEEDAODB_AUDIT_LOG`. Parameter values
//! are never written here (only the SQL text, truncated) since they may carry personal data;
//! only the statement shape and outcome are recorded.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

const SQL_PREFIX_MAX_LEN: usize = 200;

pub struct AuditEvent<'a> {
    pub open_id: Option<&'a str>,
    pub source_ip: Option<&'a str>,
    pub db: Option<&'a str>,
    pub operation: &'a str,
    pub sql: Option<&'a str>,
    pub outcome: &'a str,
    pub changes: Option<i64>,
}

#[derive(Serialize)]
struct AuditRecord<'a> {
    ts_ms: u128,
    open_id: Option<&'a str>,
    source_ip: Option<&'a str>,
    db: Option<&'a str>,
    operation: &'a str,
    sql_prefix: Option<String>,
    outcome: &'a str,
    changes: Option<i64>,
}

fn truncate_sql(sql: &str) -> String {
    if sql.chars().count() <= SQL_PREFIX_MAX_LEN {
        sql.to_string()
    } else {
        let truncated: String = sql.chars().take(SQL_PREFIX_MAX_LEN).collect();
        format!("{truncated}...")
    }
}

/// Appends one JSON line to the audit log. Failures are logged via `tracing` but never bubble up
/// as a request error -- an audit log outage should not take the API down.
pub fn write_audit(path: &Path, event: AuditEvent<'_>) {
    let record = AuditRecord {
        ts_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default(),
        open_id: event.open_id,
        source_ip: event.source_ip,
        db: event.db,
        operation: event.operation,
        sql_prefix: event.sql.map(truncate_sql),
        outcome: event.outcome,
        changes: event.changes,
    };

    let line = match serde_json::to_string(&record) {
        Ok(line) => line,
        Err(err) => {
            tracing::error!(error = %err, "failed to serialize audit record");
            return;
        }
    };

    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            tracing::error!(error = %err, path = %parent.display(), "failed to create audit log directory");
            return;
        }
    }

    let file = OpenOptions::new().create(true).append(true).open(path);
    match file {
        Ok(mut file) => {
            if let Err(err) = writeln!(file, "{line}") {
                tracing::error!(error = %err, "failed to append audit log entry");
            }
        }
        Err(err) => {
            tracing::error!(error = %err, path = %path.display(), "failed to open audit log file");
        }
    }
}
