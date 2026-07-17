//! Binary entry point: parses CLI arguments and dispatches into `seedaodb_client::commands`.
//! All real logic lives in the library crate so it can be exercised without the compiled binary.

use clap::{Parser, Subcommand};

use seedaodb_client::commands;
use seedaodb_client::config::ClientConfig;

#[derive(Parser)]
#[command(
    name = "seedaodb-client",
    about = "Rust CLI client for the seedaodb HTTP database gateway",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Establish a local login session: static token verification, or a Feishu OAuth user login
    /// -- see README.md's "Auth modes" section.
    Login {
        /// Feishu mode only: skip the loopback callback listener and instead prompt to paste the
        /// redirected URL or authorization code manually. Use this when the registered redirect
        /// URI is not a loopback address, or when the loopback port cannot be bound.
        #[arg(long)]
        manual: bool,
    },
    /// Clear the local login session.
    Logout,
    /// Show the current identity and, where determinable, its read/write permissions.
    Whoami,
    /// List configured datasources.
    Datasources,
    /// List table names in a datasource.
    Tables {
        #[arg(long)]
        db: String,
    },
    /// Browse rows of a table, paginated.
    Rows {
        #[arg(long)]
        db: String,
        #[arg(long)]
        table: String,
        #[arg(long)]
        limit: Option<i64>,
        #[arg(long)]
        offset: Option<i64>,
    },
    /// Run a read-only SQL query.
    Query {
        #[arg(long)]
        db: String,
        #[arg(long)]
        sql: String,
        /// Positional parameter, repeatable. Each value is parsed as JSON first
        /// (null/number/boolean/string); anything that fails to parse as JSON is sent as a
        /// plain string.
        #[arg(long = "param")]
        params: Vec<String>,
    },
    /// Run a read-write SQL statement.
    Exec {
        #[arg(long)]
        db: String,
        #[arg(long)]
        sql: String,
        #[arg(long = "param")]
        params: Vec<String>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    // Only applies if a `.env` file is present in the current working directory; harmless
    // otherwise. Real environment variables always take precedence over `.env` contents.
    dotenvy::dotenv().ok();

    let cli = Cli::parse();
    let config = ClientConfig::from_env()?;

    match cli.command {
        Command::Login { manual } => commands::login::run(&config, manual).await?,
        Command::Logout => commands::logout::run(&config)?,
        Command::Whoami => commands::whoami::run(&config).await?,
        Command::Datasources => commands::datasources::run(&config).await?,
        Command::Tables { db } => commands::tables::run(&config, &db).await?,
        Command::Rows {
            db,
            table,
            limit,
            offset,
        } => commands::rows::run(&config, &db, &table, limit, offset).await?,
        Command::Query { db, sql, params } => {
            commands::query::run(&config, &db, &sql, &params).await?
        }
        Command::Exec { db, sql, params } => {
            commands::exec::run(&config, &db, &sql, &params).await?
        }
    }

    Ok(())
}
