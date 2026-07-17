//! `tables --db <name>` subcommand: lists table names in a datasource.

use anyhow::Result;

use crate::config::ClientConfig;

use super::{build_client, report_client_error};

pub async fn run(config: &ClientConfig, db: &str) -> Result<()> {
    let client = build_client(config).await?;
    match client.tables(db).await {
        Ok(names) => {
            for name in names {
                println!("{name}");
            }
        }
        Err(e) => report_client_error("tables", &e),
    }
    Ok(())
}
