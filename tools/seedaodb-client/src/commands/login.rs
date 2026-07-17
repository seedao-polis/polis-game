//! `login` subcommand: dispatches to the static or feishu login flow by `SEEDAODB_CLIENT_AUTH_MODE`.

use anyhow::Result;

use crate::auth;
use crate::config::{AuthMode, ClientConfig};

/// `manual` only affects `feishu` mode: it skips the loopback callback listener in favor of
/// prompting the user to paste the redirected URL or authorization code (see
/// `auth::login_feishu`).
pub async fn run(config: &ClientConfig, manual: bool) -> Result<()> {
    match config.auth_mode {
        AuthMode::Static => {
            auth::login_static(config).await?;
            println!("login ok (static mode)");
        }
        AuthMode::Feishu => {
            auth::login_feishu(config, manual).await?;
        }
    }
    Ok(())
}
