//! `whoami` subcommand: shows the current identity and, where determinable, its per-datasource
//! read/write permissions.
//!
//! Tries a companion `GET /whoami` endpoint first; if the server has never registered that route
//! (a non-JSON 404, distinct from a handler-issued JSON `NOT_FOUND`), falls back to reconstructing
//! a read/write matrix by probing: `GET /datasources` for the datasource list, then per
//! datasource a `GET /tables?db=` read probe and a `POST /exec {sql: "SELECT 1"}` write probe.
//! The write probe is safe because the server checks RBAC authorization before statement
//! validation, `SELECT` is never in the exec statement blocklist, and `SELECT 1` changes nothing
//! even when it is allowed to run.
//!
//! Either path ends with the same reminder: table-level permissions are decided entirely by the
//! server at execution time, so this command's output is a best-effort summary, never a
//! guarantee about what a specific SQL statement will be allowed to do.

use anyhow::Result;

use crate::client::ClientError;
use crate::config::ClientConfig;
use crate::lark_shell;
use crate::models::WhoamiData;

use super::{build_client, report_client_error};

pub async fn run(config: &ClientConfig) -> Result<()> {
    let client = build_client(config).await?;

    match client.whoami().await {
        Ok(data) => print_native_whoami(&data),
        Err(ClientError::UnregisteredRoute { .. }) => {
            println!(
                "(this seedaodb server has no /whoami endpoint; falling back to permission \
                 probing via /datasources, /tables, and a SELECT 1 exec probe)"
            );
            if let Err(e) = fallback_probe(&client).await {
                eprintln!("whoami: fallback probing failed: {e}");
                return Ok(());
            }
        }
        Err(other) => {
            report_client_error("whoami", &other);
            return Ok(());
        }
    }

    println!();
    println!(
        "note: table-level permissions are decided entirely by the seedaodb server at \
         execution time; this client cannot predict in advance whether a given SQL statement \
         will be rejected. Treat the server's actual response as the source of truth."
    );

    let probe = lark_shell::probe_identity(config.lark_run.as_deref());
    println!("{}", lark_shell::describe(&probe));

    Ok(())
}

fn print_native_whoami(data: &WhoamiData) {
    println!("open_id: {}", data.open_id);
    println!("role:    {}", data.role);
    println!();
    println!("{:<20} {:<8} {:<8}", "datasource", "read", "write");
    let mut names: Vec<&String> = data.permissions.keys().collect();
    names.sort();
    for name in names {
        let perm = &data.permissions[name];
        println!(
            "{:<20} {:<8} {:<8}",
            name,
            yn(perm.read),
            yn(perm.write)
        );
    }
}

async fn fallback_probe(client: &crate::client::SeedaodbClient) -> Result<()> {
    let datasources = client
        .datasources()
        .await
        .map_err(|e| anyhow::anyhow!(e.friendly()))?;

    println!("{:<20} {:<8} {:<8}", "datasource", "read", "write");
    for ds in datasources {
        let can_read = match client.tables(&ds.name).await {
            Ok(_) => true,
            Err(ClientError::Server { ref code, .. }) if code == "FORBIDDEN" => false,
            Err(e) => {
                println!("{:<20} (probe failed: {})", ds.name, e.friendly());
                continue;
            }
        };
        let can_write = match client.exec(&ds.name, "SELECT 1", vec![]).await {
            Ok(_) => true,
            Err(ClientError::Server { ref code, .. }) if code == "FORBIDDEN" => false,
            Err(e) => {
                println!("{:<20} (write probe failed: {})", ds.name, e.friendly());
                continue;
            }
        };
        println!("{:<20} {:<8} {:<8}", ds.name, yn(can_read), yn(can_write));
    }
    Ok(())
}

fn yn(b: bool) -> &'static str {
    if b {
        "yes"
    } else {
        "no"
    }
}
