//! Feishu-backed identity verifier.
//!
//! Exchanges a caller-supplied Feishu user access token (`u-xxx`, obtained by the client through
//! its own OAuth login flow -- this service never runs the login flow itself) for that user's
//! `open_id` via the Feishu OpenAPI. Both the app-level tenant access token and the resolved
//! `open_id` are cached in memory to avoid hammering Feishu on every request and to stay under
//! its rate limits.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::Deserialize;

use crate::error::AppError;

use super::IdentityVerifier;

pub struct FeishuVerifier {
    app_id: String,
    app_secret: String,
    base_url: String,
    user_cache_ttl: Duration,
    http: reqwest::Client,
    tenant_token: Mutex<Option<(String, Instant)>>,
    user_cache: Mutex<HashMap<String, (String, Instant)>>,
}

#[derive(Deserialize)]
struct TenantTokenResponse {
    code: i32,
    msg: String,
    tenant_access_token: Option<String>,
    expire: Option<i64>,
}

#[derive(Deserialize)]
struct UserInfoResponse {
    code: i32,
    msg: String,
    data: Option<UserInfoData>,
}

#[derive(Deserialize)]
struct UserInfoData {
    open_id: String,
}

impl FeishuVerifier {
    pub fn new(
        app_id: String,
        app_secret: String,
        base_url: String,
        user_cache_ttl_s: u64,
    ) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self {
            app_id,
            app_secret,
            base_url,
            user_cache_ttl: Duration::from_secs(user_cache_ttl_s),
            http,
            tenant_token: Mutex::new(None),
            user_cache: Mutex::new(None.into_iter().collect()),
        })
    }

    /// Fetches (and caches) the app-level tenant access token. This authenticates the app
    /// itself to Feishu; it is a separate credential from the per-user token passed to
    /// `verify()`.
    async fn tenant_access_token(&self) -> Result<String, AppError> {
        if let Some((token, expires_at)) = self.tenant_token.lock().unwrap().clone() {
            if Instant::now() < expires_at {
                return Ok(token);
            }
        }

        let url = format!("{}/open-apis/auth/v3/tenant_access_token/internal", self.base_url);
        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({
                "app_id": self.app_id,
                "app_secret": self.app_secret,
            }))
            .send()
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("feishu tenant token request failed: {e}")))?;

        let body: TenantTokenResponse = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("feishu tenant token response parse failed: {e}")))?;

        if body.code != 0 {
            return Err(AppError::Unauthorized(format!(
                "feishu tenant token error {}: {}",
                body.code, body.msg
            )));
        }
        let token = body
            .tenant_access_token
            .ok_or_else(|| AppError::Internal(anyhow::anyhow!("feishu tenant token missing in response")))?;

        // Refresh a little before actual expiry to avoid racing against it.
        let ttl_secs = body.expire.unwrap_or(3600).max(60) as u64 - 30;
        let expires_at = Instant::now() + Duration::from_secs(ttl_secs);
        *self.tenant_token.lock().unwrap() = Some((token.clone(), expires_at));
        Ok(token)
    }
}

#[async_trait]
impl IdentityVerifier for FeishuVerifier {
    async fn verify(&self, token: &str) -> Result<String, AppError> {
        if let Some((open_id, expires_at)) = self.user_cache.lock().unwrap().get(token).cloned() {
            if Instant::now() < expires_at {
                return Ok(open_id);
            }
        }

        // Confirms the app's own credentials are valid; some Feishu deployments also expect an
        // app-level session to exist alongside the user token.
        let _tenant_token = self.tenant_access_token().await?;

        let url = format!("{}/open-apis/authen/v1/user_info", self.base_url);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("feishu user_info request failed: {e}")))?;

        let body: UserInfoResponse = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("feishu user_info response parse failed: {e}")))?;

        if body.code != 0 {
            return Err(AppError::Unauthorized(format!(
                "feishu user token invalid ({}: {})",
                body.code, body.msg
            )));
        }
        let open_id = body
            .data
            .ok_or_else(|| AppError::Unauthorized("feishu user_info missing data".to_string()))?
            .open_id;

        let expires_at = Instant::now() + self.user_cache_ttl;
        self.user_cache
            .lock()
            .unwrap()
            .insert(token.to_string(), (open_id.clone(), expires_at));
        Ok(open_id)
    }
}
