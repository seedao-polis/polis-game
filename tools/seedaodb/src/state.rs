//! Shared application state handed to every axum handler.

use std::sync::Arc;

use crate::auth::rbac::AclConfig;
use crate::auth::IdentityVerifier;
use crate::config::AppConfig;
use crate::db::DatasourceRegistry;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub datasources: Arc<DatasourceRegistry>,
    pub acl: Arc<AclConfig>,
    pub verifier: Arc<dyn IdentityVerifier>,
}

/// Identity attached to a request by the auth middleware once the service token and user token
/// have both been verified. Route handlers use this to run the RBAC check for the specific
/// datasource they parsed out of the request body/query string.
#[derive(Clone)]
pub struct AuthContext {
    pub open_id: String,
    pub source_ip: Option<String>,
}
