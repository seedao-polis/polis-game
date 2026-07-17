//! Request-level authentication middleware.
//!
//! Runs the first two gates described in the architecture layering before a request reaches its
//! route handler:
//!
//! 1. Service token (`Authorization: Bearer <token>` or `X-Service-Token`) -- a coarse
//!    service-to-service gate, fails closed if no token is configured.
//! 2. Feishu/static identity (`X-Feishu-User-Token`) -- resolves the caller's `open_id`.
//!
//! The third gate, per-datasource RBAC, is deliberately *not* done here: the target datasource
//! name only becomes known once a handler has parsed its own request body or query string, so
//! each handler calls into `auth::rbac` directly once it knows what `db` and operation it needs.

use axum::extract::connect_info::ConnectInfo;
use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;
use std::net::SocketAddr;

use crate::error::AppError;
use crate::state::{AppState, AuthContext};

fn extract_service_token(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers.get(axum::http::header::AUTHORIZATION) {
        if let Ok(s) = value.to_str() {
            if let Some(token) = s.strip_prefix("Bearer ") {
                return Some(token.to_string());
            }
        }
    }
    headers
        .get("x-service-token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

/// Compares two strings without short-circuiting on the first differing byte, to avoid leaking
/// token length/prefix information through response timing.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub async fn auth_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    // Gate 1: service token. Fails closed (rejects everyone) if no token is configured at all,
    // rather than treating an unset token as "no gate".
    let configured = state.config.service_token.as_deref();
    let provided = extract_service_token(req.headers());
    let service_token_ok = match (configured, provided.as_deref()) {
        (Some(expected), Some(got)) => constant_time_eq(expected, got),
        _ => false,
    };
    if !service_token_ok {
        return Err(AppError::Unauthorized(
            "missing or invalid service token".to_string(),
        ));
    }

    // Gate 2: identity. Every protected route requires a resolvable open_id.
    let user_token = req
        .headers()
        .get("x-feishu-user-token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            AppError::Unauthorized("missing X-Feishu-User-Token header".to_string())
        })?;

    let open_id = state.verifier.verify(&user_token).await?;

    let source_ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip().to_string());

    req.extensions_mut().insert(AuthContext { open_id, source_ip });

    Ok(next.run(req).await)
}
