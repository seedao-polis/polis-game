//! Thin HTTP wrapper around the seedaodb server's endpoint surface.
//!
//! Every protected request carries both the coarse service token (`Authorization: Bearer`) and
//! the caller's resolved identity token (`X-Feishu-User-Token`), mirroring the two-gate sequence
//! the server enforces in its own auth middleware before a request ever reaches per-datasource
//! RBAC. `GET /health` is the one exception and is sent with no headers at all.

use reqwest::{Client, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::models::{
    DatasourceInfo, Envelope, ExecResultData, HealthData, QueryResultData, SqlRequest, WhoamiData,
};

/// Everything that can go wrong talking to a seedaodb server, distinguishing the shapes of
/// failure a caller actually needs to react to differently.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// Transport-level failure (connection refused, TLS error, timeout, ...).
    #[error("network error contacting seedaodb: {0}")]
    Network(#[from] reqwest::Error),

    /// The server understood the request and returned its own structured `{ ok: false, error }`
    /// envelope. This covers every `AppError` variant the server defines, including a
    /// `NOT_FOUND` for an unknown datasource/table (which does carry an envelope, unlike an
    /// unregistered route -- see `UnregisteredRoute`).
    #[error("seedaodb rejected the request ({status}) {code}: {message}")]
    Server {
        status: StatusCode,
        code: String,
        message: String,
    },

    /// A 404 whose body is not a JSON envelope at all. This is axum's own router fallback for a
    /// path that was never registered as a route, as opposed to a handler explicitly returning
    /// `AppError::NotFound` (which does produce a JSON envelope). Distinguishing the two matters
    /// for `whoami`: an unregistered `/whoami` route means "this server version does not have
    /// this endpoint", not "this identity has no whoami record".
    #[error(
        "seedaodb has no route registered for this request (status {status}); this server \
         version likely does not implement this endpoint"
    )]
    UnregisteredRoute { status: StatusCode, body: String },

    /// A response body that is neither a valid envelope nor a recognizable plain-text 404, so it
    /// cannot be safely interpreted as either success or a known failure shape.
    #[error("unexpected response from seedaodb (status {status}): {body}")]
    UnexpectedResponse { status: StatusCode, body: String },
}

impl ClientError {
    /// Renders a one-line, human-readable explanation suitable for direct CLI output.
    ///
    /// `FORBIDDEN` and every other server-reported code always includes the server's own
    /// message verbatim -- RBAC denial text (e.g. `role "readonly" cannot write to datasource
    /// "shared"`) is already precise, so this never rephrases or truncates it.
    pub fn friendly(&self) -> String {
        match self {
            ClientError::Network(err) => format!("could not reach seedaodb: {err}"),
            ClientError::Server {
                status,
                code,
                message,
            } => format!("seedaodb rejected the request ({status} {code}): {message}"),
            ClientError::UnregisteredRoute { status, .. } => format!(
                "no route registered on this seedaodb server for this request (status {status})"
            ),
            ClientError::UnexpectedResponse { status, body } => {
                format!("unexpected response from seedaodb (status {status}): {body}")
            }
        }
    }
}

/// A configured connection to one seedaodb server, carrying the two credentials every protected
/// request needs.
#[derive(Clone)]
pub struct SeedaodbClient {
    http: Client,
    base_url: String,
    service_token: String,
    user_token: String,
}

impl SeedaodbClient {
    pub fn new(
        base_url: impl Into<String>,
        service_token: impl Into<String>,
        user_token: impl Into<String>,
    ) -> Self {
        Self {
            http: Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            service_token: service_token.into(),
            user_token: user_token.into(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn authed(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        builder
            .bearer_auth(&self.service_token)
            .header("X-Feishu-User-Token", &self.user_token)
    }

    /// `GET /health`. The server never requires authentication for this endpoint, so no headers
    /// are attached here.
    pub async fn health(&self) -> Result<HealthData, ClientError> {
        let resp = self.http.get(self.url("/health")).send().await?;
        Self::decode(resp).await
    }

    /// `GET /datasources`. Any resolvable identity may call this -- it carries no
    /// per-datasource permission check on the server side.
    pub async fn datasources(&self) -> Result<Vec<DatasourceInfo>, ClientError> {
        let resp = self
            .authed(self.http.get(self.url("/datasources")))
            .send()
            .await?;
        Self::decode(resp).await
    }

    /// `GET /tables?db=<name>`. Requires read permission on `db`.
    pub async fn tables(&self, db: &str) -> Result<Vec<String>, ClientError> {
        let resp = self
            .authed(self.http.get(self.url("/tables")))
            .query(&[("db", db)])
            .send()
            .await?;
        Self::decode(resp).await
    }

    /// `GET /tables/:name/rows?db=<name>&limit=&offset=`. Requires read permission on `db`.
    pub async fn rows(
        &self,
        db: &str,
        table: &str,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<QueryResultData, ClientError> {
        let mut query: Vec<(&str, String)> = vec![("db", db.to_string())];
        if let Some(l) = limit {
            query.push(("limit", l.to_string()));
        }
        if let Some(o) = offset {
            query.push(("offset", o.to_string()));
        }
        let path = format!("/tables/{table}/rows");
        let resp = self
            .authed(self.http.get(self.url(&path)))
            .query(&query)
            .send()
            .await?;
        Self::decode(resp).await
    }

    /// `POST /query`. Requires read permission on `db`; the server only accepts statements
    /// starting with `SELECT`, `PRAGMA table_info`, or `EXPLAIN`.
    pub async fn query(
        &self,
        db: &str,
        sql: &str,
        params: Vec<Value>,
    ) -> Result<QueryResultData, ClientError> {
        let body = SqlRequest {
            db: db.to_string(),
            sql: sql.to_string(),
            params,
        };
        let resp = self
            .authed(self.http.post(self.url("/query")))
            .json(&body)
            .send()
            .await?;
        Self::decode(resp).await
    }

    /// `POST /exec`. Requires write permission on `db`; the server rejects schema-changing
    /// statements but does not otherwise parse the SQL.
    pub async fn exec(
        &self,
        db: &str,
        sql: &str,
        params: Vec<Value>,
    ) -> Result<ExecResultData, ClientError> {
        let body = SqlRequest {
            db: db.to_string(),
            sql: sql.to_string(),
            params,
        };
        let resp = self
            .authed(self.http.post(self.url("/exec")))
            .json(&body)
            .send()
            .await?;
        Self::decode(resp).await
    }

    /// `GET /whoami`, a companion endpoint that may or may not exist on a given seedaodb
    /// deployment. A server that has never registered this route answers with a non-JSON 404,
    /// which surfaces as `ClientError::UnregisteredRoute` rather than a decoding panic -- callers
    /// use that variant to detect "this server has no `/whoami`" and fall back to probing
    /// (see `commands::whoami`).
    pub async fn whoami(&self) -> Result<WhoamiData, ClientError> {
        let resp = self.authed(self.http.get(self.url("/whoami"))).send().await?;
        Self::decode(resp).await
    }

    /// Reads the response body once, then tries to interpret it as a `{ ok, data, error }`
    /// envelope. A body that fails to parse as JSON is only ever treated as
    /// `UnregisteredRoute` when the status is 404 (axum's own router fallback renders exactly
    /// that shape); any other non-JSON body is reported as `UnexpectedResponse` rather than
    /// guessed at.
    async fn decode<T: DeserializeOwned>(resp: reqwest::Response) -> Result<T, ClientError> {
        let status = resp.status();
        let body = resp.text().await?;
        match serde_json::from_str::<Envelope<T>>(&body) {
            Ok(envelope) if envelope.ok => {
                envelope
                    .data
                    .ok_or_else(|| ClientError::UnexpectedResponse {
                        status,
                        body: "server reported ok=true but included no data".to_string(),
                    })
            }
            Ok(envelope) => {
                let err = envelope.error.unwrap_or(crate::models::ErrorBody {
                    code: "UNKNOWN".to_string(),
                    message: "server reported ok=false with no error body".to_string(),
                });
                Err(ClientError::Server {
                    status,
                    code: err.code,
                    message: err.message,
                })
            }
            Err(_) if status == StatusCode::NOT_FOUND => {
                Err(ClientError::UnregisteredRoute { status, body })
            }
            Err(_) => Err(ClientError::UnexpectedResponse { status, body }),
        }
    }
}
