//! `logout` subcommand: clears local login state regardless of auth mode.

use anyhow::Result;

use crate::auth;
use crate::config::{AuthMode, ClientConfig};

pub fn run(config: &ClientConfig) -> Result<()> {
    auth::logout(config)?;
    match config.auth_mode {
        AuthMode::Static => println!(
            "logged out. Note: in static mode this only clears the local login marker -- \
             SEEDAODB_CLIENT_STATIC_TOKEN in your .env is still the token `login` will use next \
             time, since static mode has no server-side session to invalidate."
        ),
        AuthMode::Feishu => println!("logged out."),
    }
    Ok(())
}
