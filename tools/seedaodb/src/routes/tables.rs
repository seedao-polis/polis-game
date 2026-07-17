//! Read-only helper endpoints: `GET /datasources`, `GET /tables`, `GET /tables/:name/rows`.

use axum::extract::{Extension, Path, Query, State};
use axum::Json;

use crate::db::Operation;
use crate::error::AppError;
use crate::models::{DatasourceInfo, DbQuery, Envelope, QueryResultData, RowsQuery};
use crate::state::{AppState, AuthContext};

const DEFAULT_ROWS_LIMIT: i64 = 100;
const MAX_ROWS_LIMIT: i64 = 1000;

/// Any authenticated caller may list datasource names/kinds/readonly flags -- no secrets (URLs,
/// credentials) are ever included, so this does not need a per-datasource permission check.
pub async fn list_datasources(
    State(state): State<AppState>,
    Extension(_ctx): Extension<AuthContext>,
) -> Json<Envelope<Vec<DatasourceInfo>>> {
    let data = state
        .datasources
        .list_info()
        .into_iter()
        .map(|s| DatasourceInfo {
            name: s.name,
            backend: s.backend,
            readonly: s.readonly,
        })
        .collect();
    Json(Envelope::ok(data))
}

pub async fn list_tables(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
    Query(q): Query<DbQuery>,
) -> Result<Json<Envelope<Vec<String>>>, AppError> {
    let entry = state
        .datasources
        .get(&q.db)
        .ok_or_else(|| AppError::NotFound(format!("unknown datasource {:?}", q.db)))?;
    state.acl.authorize(&ctx.open_id, &q.db, Operation::Read)?;

    let tables = entry.backend.list_tables().await?;
    Ok(Json(Envelope::ok(tables)))
}

pub async fn table_rows(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
    Path(name): Path<String>,
    Query(q): Query<RowsQuery>,
) -> Result<Json<Envelope<QueryResultData>>, AppError> {
    let entry = state
        .datasources
        .get(&q.db)
        .ok_or_else(|| AppError::NotFound(format!("unknown datasource {:?}", q.db)))?;
    state.acl.authorize(&ctx.open_id, &q.db, Operation::Read)?;

    // The table name must be validated against the schema's own table list before it is ever
    // interpolated into a SQL statement -- it never gets there via unchecked user input.
    let known_tables = entry.backend.list_tables().await?;
    if !known_tables.iter().any(|t| t == &name) {
        return Err(AppError::NotFound(format!(
            "table {name:?} not found in datasource {:?}",
            q.db
        )));
    }

    let limit = q.limit.unwrap_or(DEFAULT_ROWS_LIMIT).clamp(1, MAX_ROWS_LIMIT);
    let offset = q.offset.unwrap_or(0).max(0);

    let result = entry.backend.rows_page(&name, limit, offset).await?;
    Ok(Json(Envelope::ok(QueryResultData {
        columns: result.columns,
        rows: result.rows,
    })))
}
