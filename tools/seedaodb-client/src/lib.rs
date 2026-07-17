//! Library crate backing the `seedaodb-client` binary.
//!
//! Split from `main.rs` so the HTTP client, configuration parsing, and subcommand logic can be
//! exercised directly -- including from integration tests -- without spawning the compiled
//! binary. Mirrors the same main/lib split the `seedaodb` server crate itself uses.

pub mod auth;
pub mod client;
pub mod commands;
pub mod config;
pub mod feishu_oauth;
pub mod lark_shell;
pub mod models;
pub mod params;
