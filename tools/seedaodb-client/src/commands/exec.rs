//! `exec --db <name> --sql <...> [--param <value>]...` subcommand: read-write SQL.

use anyhow::Result;

use crate::config::ClientConfig;
use crate::params::parse_param;

use super::{build_client, report_client_error};

pub async fn run(config: &ClientConfig, db: &str, sql: &str, params: &[String]) -> Result<()> {
    let client = build_client(config).await?;
    let parsed: Vec<serde_json::Value> = params.iter().map(|p| parse_param(p)).collect();
    match client.exec(db, sql, parsed).await {
        Ok(data) => println!(
            "changes: {}, lastInsertRowid: {}",
            data.changes, data.last_insert_rowid
        ),
        Err(e) => report_client_error("exec", &e),
    }
    Ok(())
}
