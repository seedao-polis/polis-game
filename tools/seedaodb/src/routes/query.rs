//! `POST /query` (read-only) and `POST /exec` (read-write) -- the general-purpose SQL endpoints.

use axum::extract::{Extension, State};
use axum::Json;

use crate::audit::{self, AuditEvent};
use crate::db::Operation;
use crate::error::AppError;
use crate::models::{Envelope, ExecResultData, QueryResultData, SqlRequest};
use crate::sql_guard;
use crate::state::{AppState, AuthContext};

pub async fn query_handler(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
    Json(body): Json<SqlRequest>,
) -> Result<Json<Envelope<QueryResultData>>, AppError> {
    let entry = state
        .datasources
        .get(&body.db)
        .ok_or_else(|| AppError::NotFound(format!("unknown datasource {:?}", body.db)))?;

    if let Err(err) = state.acl.authorize(&ctx.open_id, &body.db, Operation::Read) {
        audit::write_audit(
            &state.config.audit_log,
            AuditEvent {
                open_id: Some(&ctx.open_id),
                source_ip: ctx.source_ip.as_deref(),
                db: Some(&body.db),
                operation: "query",
                sql: Some(&body.sql),
                outcome: "forbidden",
                changes: None,
            },
        );
        return Err(err);
    }

    if let Err(msg) = sql_guard::validate_query(&body.sql) {
        audit::write_audit(
            &state.config.audit_log,
            AuditEvent {
                open_id: Some(&ctx.open_id),
                source_ip: ctx.source_ip.as_deref(),
                db: Some(&body.db),
                operation: "query",
                sql: Some(&body.sql),
                outcome: "rejected_statement",
                changes: None,
            },
        );
        return Err(AppError::BadRequest(msg));
    }

    let result = entry.backend.query(&body.sql, &body.params).await?;
    Ok(Json(Envelope::ok(QueryResultData {
        columns: result.columns,
        rows: result.rows,
    })))
}

pub async fn exec_handler(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
    Json(body): Json<SqlRequest>,
) -> Result<Json<Envelope<ExecResultData>>, AppError> {
    let entry = state
        .datasources
        .get(&body.db)
        .ok_or_else(|| AppError::NotFound(format!("unknown datasource {:?}", body.db)))?;

    if let Err(err) = state.acl.authorize(&ctx.open_id, &body.db, Operation::Write) {
        audit::write_audit(
            &state.config.audit_log,
            AuditEvent {
                open_id: Some(&ctx.open_id),
                source_ip: ctx.source_ip.as_deref(),
                db: Some(&body.db),
                operation: "exec",
                sql: Some(&body.sql),
                outcome: "forbidden",
                changes: None,
            },
        );
        return Err(err);
    }

    if let Err(msg) = sql_guard::validate_exec(&body.sql) {
        audit::write_audit(
            &state.config.audit_log,
            AuditEvent {
                open_id: Some(&ctx.open_id),
                source_ip: ctx.source_ip.as_deref(),
                db: Some(&body.db),
                operation: "exec",
                sql: Some(&body.sql),
                outcome: "rejected_statement",
                changes: None,
            },
        );
        return Err(AppError::BadRequest(msg));
    }

    // `/exec` is always audited (success or failure), per the audit-log requirement: this is
    // the one endpoint that can mutate `.agent`-equivalent data.
    match entry
        .backend
        .exec(&body.sql, &body.params, state.config.busy_retry_max)
        .await
    {
        Ok(result) => {
            audit::write_audit(
                &state.config.audit_log,
                AuditEvent {
                    open_id: Some(&ctx.open_id),
                    source_ip: ctx.source_ip.as_deref(),
                    db: Some(&body.db),
                    operation: "exec",
                    sql: Some(&body.sql),
                    outcome: "ok",
                    changes: Some(result.changes),
                },
            );
            Ok(Json(Envelope::ok(ExecResultData {
                changes: result.changes,
                last_insert_rowid: result.last_insert_rowid,
            })))
        }
        Err(err) => {
            audit::write_audit(
                &state.config.audit_log,
                AuditEvent {
                    open_id: Some(&ctx.open_id),
                    source_ip: ctx.source_ip.as_deref(),
                    db: Some(&body.db),
                    operation: "exec",
                    sql: Some(&body.sql),
                    outcome: "error",
                    changes: None,
                },
            );
            Err(err)
        }
    }
}
