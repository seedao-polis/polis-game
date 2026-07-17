//! Router assembly: wires the auth middleware and the request body size limit around every
//! endpoint except `GET /health`.

pub mod health;
pub mod query;
pub mod tables;

use axum::routing::{get, post};
use axum::Router;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::trace::TraceLayer;

use crate::middleware::auth_middleware;
use crate::state::AppState;

pub fn build_router(state: AppState) -> Router {
    let max_body_bytes = state.config.max_body_bytes;

    let protected = Router::new()
        .route("/datasources", get(tables::list_datasources))
        .route("/tables", get(tables::list_tables))
        .route("/tables/{name}/rows", get(tables::table_rows))
        .route("/query", post(query::query_handler))
        .route("/exec", post(query::exec_handler))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    Router::new()
        .route("/health", get(health::health_handler))
        .merge(protected)
        .layer(RequestBodyLimitLayer::new(max_body_bytes))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
