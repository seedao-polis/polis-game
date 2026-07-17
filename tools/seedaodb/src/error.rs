//! Unified application error type.
//!
//! Every error that can surface from a route handler is normalized into this enum, then
//! rendered as the standard `{ ok: false, data: null, error: { code, message } }` JSON envelope.
//! Messages returned to clients never include absolute file paths or connection strings; those
//! details are only ever written to the server-side trace log.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

/// Machine-readable error code paired with an HTTP status and a human-readable message.
#[derive(Debug)]
pub enum AppError {
    /// Missing or invalid service token / identity token.
    Unauthorized(String),
    /// Identity resolved successfully but is not allowed to perform the requested operation.
    Forbidden(String),
    /// Malformed request, unknown datasource, or a SQL statement rejected by the statement guard.
    BadRequest(String),
    /// Referenced resource (datasource, table) does not exist.
    NotFound(String),
    /// Backend/database failure that is safe to summarize but not to expose verbatim.
    Database(String),
    /// Anything else; logged in full server-side, reported generically to the client.
    Internal(anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
struct Envelope {
    ok: bool,
    data: Option<()>,
    error: ErrorBody,
}

impl AppError {
    fn parts(&self) -> (StatusCode, &'static str, String) {
        match self {
            AppError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, "UNAUTHORIZED", msg.clone()),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, "FORBIDDEN", msg.clone()),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, "BAD_REQUEST", msg.clone()),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, "NOT_FOUND", msg.clone()),
            AppError::Database(msg) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "DATABASE_ERROR", msg.clone())
            }
            AppError::Internal(err) => {
                tracing::error!(error = %err, "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL",
                    "internal server error".to_string(),
                )
            }
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = self.parts();
        let body = Envelope {
            ok: false,
            data: None,
            error: ErrorBody { code, message },
        };
        (status, axum::Json(body)).into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        AppError::Internal(err)
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        // Only a terse summary crosses the process boundary; the full error (which may include
        // fragments of the underlying connection string) stays in the trace log.
        tracing::error!(error = %err, "database error");
        AppError::Database("database operation failed".to_string())
    }
}
