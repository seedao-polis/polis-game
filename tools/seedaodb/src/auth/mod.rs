//! Identity verification and authorization.
//!
//! "Who are you" (`IdentityVerifier`, this module + `feishu.rs`/`static_verifier.rs`) is kept
//! separate from "what are you allowed to do" (`rbac.rs`). Two `IdentityVerifier`
//! implementations exist so the same route/middleware code can run against a real Feishu tenant
//! in production or a static, network-free token table in tests and local development.

pub mod feishu;
pub mod rbac;
pub mod static_verifier;

use async_trait::async_trait;

use crate::error::AppError;

/// Resolves a bearer-style user token into a stable `open_id`. Implementations must fail closed:
/// an invalid, expired, or unrecognized token is always `Err(AppError::Unauthorized(_))`, never a
/// default identity.
#[async_trait]
pub trait IdentityVerifier: Send + Sync {
    async fn verify(&self, token: &str) -> Result<String, AppError>;
}
