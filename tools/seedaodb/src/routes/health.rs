//! `GET /health` -- unauthenticated liveness probe.

use axum::extract::State;
use axum::Json;

use crate::models::{Envelope, HealthData};
use crate::state::AppState;

pub async fn health_handler(State(state): State<AppState>) -> Json<Envelope<HealthData>> {
    Json(Envelope::ok(HealthData {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        datasources: state.datasources.names(),
    }))
}
