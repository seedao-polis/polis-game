//! `datasources` subcommand: lists configured datasources.

use anyhow::Result;

use crate::config::ClientConfig;

use super::{build_client, report_client_error};

pub async fn run(config: &ClientConfig) -> Result<()> {
    let client = build_client(config).await?;
    match client.datasources().await {
        Ok(list) => {
            println!("{:<20} {:<12} {:<8}", "name", "backend", "readonly");
            for ds in list {
                println!("{:<20} {:<12} {:<8}", ds.name, ds.backend, ds.readonly);
            }
        }
        Err(e) => report_client_error("datasources", &e),
    }
    Ok(())
}
