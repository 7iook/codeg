use axum::Json;
use serde::Deserialize;
use serde_json::Value;

use crate::app_error::AppCommandError;
use crate::commands::mcp as mcp_commands;
use crate::commands::mcp::{
    KiroMcpView, LocalMcpServer, McpAppType, McpMarketplaceItem, McpMarketplaceProvider,
    McpMarketplaceServerDetail,
};

// ---------------------------------------------------------------------------
// Param structs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMarketplaceParams {
    pub provider_id: String,
    pub query: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMarketplaceServerDetailParams {
    pub provider_id: String,
    pub server_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallFromMarketplaceParams {
    pub provider_id: String,
    pub server_id: String,
    pub apps: Vec<McpAppType>,
    pub spec_override: Option<Value>,
    pub option_id: Option<String>,
    pub protocol: Option<String>,
    pub parameter_values: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertLocalServerParams {
    pub server_id: String,
    pub spec: Value,
    pub apps: Vec<McpAppType>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetServerAppsParams {
    pub server_id: String,
    pub apps: Vec<McpAppType>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveServerParams {
    pub server_id: String,
    pub apps: Option<Vec<McpAppType>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KiroScopedViewParams {
    /// Project-scope root. Absent or blank skips the Project scope.
    pub workspace_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Handlers
//
// Every handler that can reach Kiro's MCP config runs its core call inside
// `with_http_entry_point`, which marks the ambient entry point as HTTP for the
// Kiro credential admission gate in `commands::mcp` (Requirement 5). The gate
// itself lives with the read/write functions so the desktop and HTTP entry
// points share one decision; this wrapper only supplies the "which entry point"
// half. The other 12 agents are unaffected — the gate keys on `McpAppType::Kiro`
// alone (R5.5) — and session browsing / agent startup handlers are deliberately
// NOT wrapped (R5.6).
// ---------------------------------------------------------------------------

pub async fn mcp_scan_local() -> Result<Json<Vec<LocalMcpServer>>, AppCommandError> {
    let result = mcp_commands::with_http_entry_point(mcp_commands::mcp_scan_local()).await?;
    Ok(Json(result))
}

/// Kiro's three-scope display payload. Wrapped like every other Kiro-reaching
/// handler: over HTTP the credential gate denies this by default, since the
/// payload carries `env` values and `args` elements in plaintext (R5.3).
pub async fn mcp_kiro_scoped_view(
    Json(params): Json<KiroScopedViewParams>,
) -> Result<Json<KiroMcpView>, AppCommandError> {
    let result = mcp_commands::with_http_entry_point(mcp_commands::mcp_kiro_scoped_view(
        params.workspace_path,
    ))
    .await?;
    Ok(Json(result))
}

pub async fn mcp_list_marketplaces() -> Result<Json<Vec<McpMarketplaceProvider>>, AppCommandError> {
    let result = mcp_commands::mcp_list_marketplaces().await?;
    Ok(Json(result))
}

pub async fn mcp_search_marketplace(
    Json(params): Json<SearchMarketplaceParams>,
) -> Result<Json<Vec<McpMarketplaceItem>>, AppCommandError> {
    let result =
        mcp_commands::mcp_search_marketplace(params.provider_id, params.query, params.limit)
            .await?;
    Ok(Json(result))
}

pub async fn mcp_get_marketplace_server_detail(
    Json(params): Json<GetMarketplaceServerDetailParams>,
) -> Result<Json<McpMarketplaceServerDetail>, AppCommandError> {
    let result =
        mcp_commands::mcp_get_marketplace_server_detail(params.provider_id, params.server_id)
            .await?;
    Ok(Json(result))
}

pub async fn mcp_install_from_marketplace(
    Json(params): Json<InstallFromMarketplaceParams>,
) -> Result<Json<LocalMcpServer>, AppCommandError> {
    let result = mcp_commands::with_http_entry_point(mcp_commands::mcp_install_from_marketplace(
        params.provider_id,
        params.server_id,
        params.apps,
        params.spec_override,
        params.option_id,
        params.protocol,
        params.parameter_values,
    ))
    .await?;
    Ok(Json(result))
}

pub async fn mcp_upsert_local_server(
    Json(params): Json<UpsertLocalServerParams>,
) -> Result<Json<LocalMcpServer>, AppCommandError> {
    let result = mcp_commands::with_http_entry_point(mcp_commands::mcp_upsert_local_server(
        params.server_id,
        params.spec,
        params.apps,
    ))
    .await?;
    Ok(Json(result))
}

pub async fn mcp_set_server_apps(
    Json(params): Json<SetServerAppsParams>,
) -> Result<Json<Option<LocalMcpServer>>, AppCommandError> {
    let result = mcp_commands::with_http_entry_point(mcp_commands::mcp_set_server_apps(
        params.server_id,
        params.apps,
    ))
    .await?;
    Ok(Json(result))
}

pub async fn mcp_remove_server(
    Json(params): Json<RemoveServerParams>,
) -> Result<Json<bool>, AppCommandError> {
    let result = mcp_commands::with_http_entry_point(mcp_commands::mcp_remove_server(
        params.server_id,
        params.apps,
    ))
    .await?;
    Ok(Json(result))
}
