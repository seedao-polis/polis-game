//! Subcommand implementations.
//!
//! Each module maps one CLI subcommand onto `client::SeedaodbClient` calls and console output.
//! Shared plumbing (client construction, error rendering, query-result printing) lives here so
//! every subcommand applies it identically.

pub mod datasources;
pub mod exec;
pub mod login;
pub mod logout;
pub mod query;
pub mod rows;
pub mod tables;
pub mod whoami;

use anyhow::Result;

use crate::auth;
use crate::client::{ClientError, SeedaodbClient};
use crate::config::ClientConfig;
use crate::models::QueryResultData;

/// Resolves the identity token every non-login command sends as `X-Feishu-User-Token` (via
/// `auth::resolve_user_token`, which refreshes a near-expired feishu-mode token transparently),
/// then builds a client. Centralized so both auth modes are resolved the same way everywhere.
pub async fn build_client(config: &ClientConfig) -> Result<SeedaodbClient> {
    let user_token = auth::resolve_user_token(config).await?;
    Ok(SeedaodbClient::new(
        &config.base_url,
        &config.service_token,
        user_token,
    ))
}

/// Prints a `ClientError`'s human-readable rendering to stderr under a short label identifying
/// which subcommand hit it, without unwinding the process -- every subcommand calls this on
/// failure so a FORBIDDEN/UNAUTHORIZED response reads as one clear line, not a Rust error chain.
pub fn report_client_error(label: &str, err: &ClientError) {
    eprintln!("{label}: {}", err.friendly());
}

/// Prints a `QueryResultData` as an aligned, pipe-separated table, followed by a row count and a
/// reminder of the column-decoding rules (values are decoded per SQLite's runtime storage class,
/// not a declared column type).
pub fn print_query_result(data: &QueryResultData) {
    println!("{}", data.columns.join(" | "));
    for row in &data.rows {
        let cells: Vec<String> = row.iter().map(format_cell).collect();
        println!("{}", cells.join(" | "));
    }
    let count = data.rows.len();
    println!("({count} row{})", if count == 1 { "" } else { "s" });
    println!(
        "note: each value is decoded from SQLite's runtime storage class, not a declared column \
         type -- integers/floats come through as JSON numbers, BLOB columns come through as \
         base64-encoded strings, and everything else (TEXT and untyped columns) comes through as \
         a plain string."
    );
}

fn format_cell(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}
