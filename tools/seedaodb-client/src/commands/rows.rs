//! `rows --db <name> --table <name> [--limit] [--offset]` subcommand: paginated row browsing.

use anyhow::Result;

use crate::config::ClientConfig;

use super::{build_client, print_query_result, report_client_error};

pub async fn run(
    config: &ClientConfig,
    db: &str,
    table: &str,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<()> {
    let client = build_client(config).await?;
    match client.rows(db, table, limit, offset).await {
        Ok(data) => print_query_result(&data),
        Err(e) => report_client_error("rows", &e),
    }
    Ok(())
}
