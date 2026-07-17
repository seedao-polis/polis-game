//! `query --db <name> --sql <...> [--param <value>]...` subcommand: read-only SQL.

use anyhow::Result;

use crate::config::ClientConfig;
use crate::params::parse_param;

use super::{build_client, print_query_result, report_client_error};

pub async fn run(config: &ClientConfig, db: &str, sql: &str, params: &[String]) -> Result<()> {
    let client = build_client(config).await?;
    let parsed: Vec<serde_json::Value> = params.iter().map(|p| parse_param(p)).collect();
    match client.query(db, sql, parsed).await {
        Ok(data) => print_query_result(&data),
        Err(e) => report_client_error("query", &e),
    }
    Ok(())
}
