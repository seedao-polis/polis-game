//! SQLite backend: connection setup, dynamic row -> JSON decoding, parameter binding, and the
//! busy/locked retry loop used by `/exec`.

use std::str::FromStr;
use std::time::Duration;

use base64::Engine as _;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use sqlx::{Column, Row, TypeInfo, ValueRef};

use crate::error::AppError;

use super::{ExecResult, QueryResult};

/// A pool of connections to a single SQLite database file, opened in WAL mode with a busy
/// timeout so concurrent writers (this service, plus whatever else already has the file open)
/// wait for each other instead of failing immediately with `SQLITE_BUSY`.
pub struct SqliteBackend {
    pool: SqlitePool,
}

impl SqliteBackend {
    /// Connects using a `sqlite://...` URL. Existing `.agent/*.db` files are already in WAL
    /// mode (a persistent, on-disk setting) so requesting WAL again here is a no-op for them;
    /// it only matters for a database file created fresh by this service.
    pub async fn connect(url: &str, readonly: bool, busy_timeout_ms: u64) -> anyhow::Result<Self> {
        let options = SqliteConnectOptions::from_str(url)?
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_millis(busy_timeout_ms))
            .foreign_keys(true)
            .read_only(readonly);

        // A small pool of short-lived connections is used deliberately rather than one
        // long-lived connection, so this service does not itself become the reason WAL
        // checkpointing stalls.
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;

        Ok(Self { pool })
    }

    pub async fn query(&self, sql: &str, params: &[Value]) -> Result<QueryResult, AppError> {
        let query = bind_params(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), params)?;
        let rows = query.fetch_all(&self.pool).await?;
        Ok(rows_to_query_result(&rows))
    }

    pub async fn exec(
        &self,
        sql: &str,
        params: &[Value],
        busy_retry_max: u32,
    ) -> Result<ExecResult, AppError> {
        let mut attempt: u32 = 0;
        loop {
            let query = bind_params(sqlx::query(sqlx::AssertSqlSafe(sql.to_string())), params)?;

            let mut tx = self.pool.begin().await?;
            match query.execute(&mut *tx).await {
                Ok(result) => {
                    tx.commit().await?;
                    return Ok(ExecResult {
                        changes: result.rows_affected() as i64,
                        last_insert_rowid: result.last_insert_rowid(),
                    });
                }
                Err(err) => {
                    let _ = tx.rollback().await;
                    if is_busy_or_locked(&err) && attempt < busy_retry_max {
                        attempt += 1;
                        tokio::time::sleep(backoff_delay(attempt)).await;
                        continue;
                    }
                    return Err(AppError::from(err));
                }
            }
        }
    }

    pub async fn list_tables(&self) -> Result<Vec<String>, AppError> {
        let rows = sqlx::query(sqlx::AssertSqlSafe(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                .to_string(),
        ))
        .fetch_all(&self.pool)
        .await?;

        let mut names = Vec::with_capacity(rows.len());
        for row in &rows {
            let name: String = row.try_get(0)?;
            names.push(name);
        }
        Ok(names)
    }

    /// Fetches a page of rows from `table`. Callers must have already validated `table` against
    /// `list_tables()` -- this function trusts its input and only quotes the identifier, it does
    /// not re-check it against the schema.
    pub async fn rows_page(
        &self,
        table: &str,
        limit: i64,
        offset: i64,
    ) -> Result<QueryResult, AppError> {
        let sql = format!(
            "SELECT * FROM {} LIMIT ? OFFSET ?",
            quote_identifier(table)
        );
        let query = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(limit)
            .bind(offset);
        let rows = query.fetch_all(&self.pool).await?;
        Ok(rows_to_query_result(&rows))
    }
}

/// Wraps a table/column identifier in double quotes, doubling any embedded quote character, per
/// standard SQL identifier quoting rules.
fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Binds a heterogeneous JSON parameter array onto a query using positional (`?`) binding.
/// Nested arrays/objects are rejected -- SQLite has no native container type to bind them to.
fn bind_params<'q>(
    mut query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments>,
    params: &[Value],
) -> Result<sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments>, AppError> {
    for (i, value) in params.iter().enumerate() {
        query = match value {
            Value::Null => query.bind(Option::<i64>::None),
            Value::Bool(b) => query.bind(if *b { 1i64 } else { 0i64 }),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    query.bind(i)
                } else if let Some(f) = n.as_f64() {
                    query.bind(f)
                } else {
                    return Err(AppError::BadRequest(format!(
                        "params[{i}]: unsupported numeric value"
                    )));
                }
            }
            Value::String(s) => query.bind(s.clone()),
            Value::Array(_) | Value::Object(_) => {
                return Err(AppError::BadRequest(format!(
                    "params[{i}]: arrays/objects cannot be bound as SQL parameters"
                )));
            }
        };
    }
    Ok(query)
}

/// Decodes every row's every column into a `serde_json::Value` based on that value's *runtime*
/// SQLite storage class (integer/float/text/blob/null), not the column's declared type -- SQLite
/// values are dynamically typed per-row.
fn rows_to_query_result(rows: &[sqlx::sqlite::SqliteRow]) -> QueryResult {
    let columns: Vec<String> = rows
        .first()
        .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
        .unwrap_or_default();

    let mut out_rows = Vec::with_capacity(rows.len());
    for row in rows {
        let mut out_row = Vec::with_capacity(row.columns().len());
        for i in 0..row.columns().len() {
            out_row.push(decode_cell(row, i));
        }
        out_rows.push(out_row);
    }

    QueryResult {
        columns,
        rows: out_rows,
    }
}

fn decode_cell(row: &sqlx::sqlite::SqliteRow, i: usize) -> Value {
    let Ok(raw) = row.try_get_raw(i) else {
        return Value::Null;
    };
    if raw.is_null() {
        return Value::Null;
    }
    match raw.type_info().name() {
        "INTEGER" => row
            .try_get::<i64, _>(i)
            .map(Value::from)
            .unwrap_or(Value::Null),
        "REAL" => row
            .try_get::<f64, _>(i)
            .ok()
            .and_then(|f| serde_json::Number::from_f64(f).map(Value::Number))
            .unwrap_or(Value::Null),
        "BLOB" => row
            .try_get::<Vec<u8>, _>(i)
            .map(|bytes| Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)))
            .unwrap_or(Value::Null),
        // TEXT and any non-standard affinity (BOOLEAN/DATE/TIME/DATETIME/NUMERIC) are all
        // stored as text by SQLite unless they were actually written as an integer/real/blob.
        _ => row
            .try_get::<String, _>(i)
            .map(Value::String)
            .unwrap_or(Value::Null),
    }
}

/// Returns true for `SQLITE_BUSY` (5) and `SQLITE_LOCKED` (6), including their extended result
/// code variants (the low byte of a SQLite extended result code is always the primary code).
fn is_busy_or_locked(err: &sqlx::Error) -> bool {
    let Some(db_err) = err.as_database_error() else {
        return false;
    };
    let Some(code) = db_err.code() else {
        return false;
    };
    match code.parse::<i64>() {
        Ok(full) => matches!(full & 0xff, 5 | 6),
        Err(_) => false,
    }
}

fn backoff_delay(attempt: u32) -> Duration {
    let capped = attempt.min(6);
    Duration::from_millis(50u64.saturating_mul(1u64 << capped))
}
