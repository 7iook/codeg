//! Delegation settings persistence + Tauri/HTTP command surface.
//!
//! These knobs survive across restarts:
//!   * `delegation.enabled` — feature kill switch (default false)
//!   * `delegation.depth_limit` — max chain depth a child is allowed to sit at
//!   * `delegation.agent_defaults` — per-agent spawn overrides (JSON blob)
//!   * `delegation.completed_cache_max_mb` — per-parent byte budget (in MB) for
//!     the broker's in-memory cache of completed result text (`0` = unlimited)
//!
//! On startup `apply_persisted_config` reads these keys from `app_metadata`
//! and pushes them into the live `DelegationBroker`. On UI save,
//! `set_delegation_settings_core` writes these keys and immediately
//! re-applies — the broker has no concept of "pending config", it just
//! owns the current `DelegationConfig`. The previously-persisted
//! `delegation.default_timeout_seconds` key is ignored on read (the broker
//! no longer applies a timeout; cancellation flows through MCP
//! `notifications/cancelled` instead).

use std::collections::BTreeMap;
use std::path::PathBuf;
#[cfg(any(test, feature = "tauri-runtime"))]
use std::sync::Arc;

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::delegation::broker::TurnOrigin;
use crate::acp::delegation::broker::{
    ContinuationAvailability, DelegationBroker, DelegationConfig, StatusWait,
};
use crate::acp::delegation::types::{
    AgentDelegationDefaults, DelegationError, DelegationOutcome, DelegationTaskReport, TaskStatus,
};
use crate::app_error::AppCommandError;
use crate::db::service::{app_metadata_service, conversation_service};
use crate::models::AgentType;

pub const KEY_DELEGATION_ENABLED: &str = "delegation.enabled";
pub const KEY_DELEGATION_DEPTH: &str = "delegation.depth_limit";
/// Single JSON-serialized key for the per-agent delegation overrides.
/// Stored as one blob (rather than one row per agent×option) because the
/// option set is dynamic and per-agent — flat keys can't enumerate it.
pub const KEY_DELEGATION_AGENT_DEFAULTS: &str = "delegation.agent_defaults";
/// Per-parent completed-result cache budget, in MB. `0` = unlimited.
pub const KEY_DELEGATION_COMPLETED_CACHE_MB: &str = "delegation.completed_cache_max_mb";

pub const DEPTH_MIN: u32 = 1;
pub const DEPTH_MAX: u32 = 8;

/// Product default for the completed-result cache budget, in MB. Used by
/// `DelegationSettings::default()` and as the serde fallback when a payload
/// omits the field (absent ≠ unlimited).
pub const DEFAULT_COMPLETED_CACHE_MB: u32 = 512;

fn default_completed_cache_max_mb() -> u32 {
    DEFAULT_COMPLETED_CACHE_MB
}

/// Newtype so the Tauri managed-state lookup can distinguish the delegation
/// UDS path from other `PathBuf`s in the state graph.
#[derive(Clone)]
pub struct DelegationSocketPath(pub PathBuf);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegationSettings {
    pub enabled: bool,
    pub depth_limit: u32,
    /// Per-agent default overrides applied by the delegation broker when
    /// codeg-mcp spawns a subagent. Empty map → no overrides anywhere,
    /// which is the pre-existing behavior.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub agent_defaults: BTreeMap<AgentType, AgentDelegationDefaults>,
    /// Per-parent byte budget (in MB) for the broker's in-memory cache of
    /// completed sub-agent result text. `0` = unlimited. Converted to bytes in
    /// `into_broker_config`. Absent in a payload → the product default (not
    /// unlimited), so an older client can't silently disable the valve.
    #[serde(default = "default_completed_cache_max_mb")]
    pub completed_cache_max_mb: u32,
}

impl Default for DelegationSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            depth_limit: 1,
            agent_defaults: BTreeMap::new(),
            completed_cache_max_mb: DEFAULT_COMPLETED_CACHE_MB,
        }
    }
}

impl DelegationSettings {
    fn clamped(self) -> Self {
        Self {
            enabled: self.enabled,
            depth_limit: self.depth_limit.clamp(DEPTH_MIN, DEPTH_MAX),
            agent_defaults: self
                .agent_defaults
                .into_iter()
                .filter(|(_, v)| !v.is_empty())
                .collect(),
            // No upper clamp: the cache budget is a user memory choice, not a
            // safety rail. `0` stays `0` (unlimited).
            completed_cache_max_mb: self.completed_cache_max_mb,
        }
    }

    fn into_broker_config(self) -> DelegationConfig {
        DelegationConfig {
            enabled: self.enabled,
            depth_limit: self.depth_limit,
            agent_defaults: self.agent_defaults,
            // MB → bytes. `saturating_mul` guards a pathologically large MB
            // value from wrapping on 32-bit `usize` targets.
            completed_cache_cap_bytes: (self.completed_cache_max_mb as usize)
                .saturating_mul(1024 * 1024),
            // Not user-configurable yet: `kept_alive_cap` rides the broker
            // default until a settings surface exists (T5 scope).
            ..DelegationConfig::default()
        }
    }
}

/// Read all persisted keys from `app_metadata`, falling back to defaults
/// for any missing or malformed value. Never errors hard — corrupt
/// persistence is treated as "no preference yet."
pub async fn load_delegation_settings(conn: &DatabaseConnection) -> DelegationSettings {
    let mut settings = DelegationSettings::default();
    if let Ok(Some(raw)) = app_metadata_service::get_value(conn, KEY_DELEGATION_ENABLED).await {
        if let Ok(v) = raw.parse::<bool>() {
            settings.enabled = v;
        }
    }
    if let Ok(Some(raw)) = app_metadata_service::get_value(conn, KEY_DELEGATION_DEPTH).await {
        if let Ok(v) = raw.parse::<u32>() {
            settings.depth_limit = v;
        }
    }
    if let Ok(Some(raw)) =
        app_metadata_service::get_value(conn, KEY_DELEGATION_COMPLETED_CACHE_MB).await
    {
        if let Ok(v) = raw.parse::<u32>() {
            settings.completed_cache_max_mb = v;
        }
    }
    if let Ok(Some(raw)) =
        app_metadata_service::get_value(conn, KEY_DELEGATION_AGENT_DEFAULTS).await
    {
        // Corrupt JSON → keep defaults (empty map). Matches the "never errors
        // hard" contract on the other two keys above.
        if let Ok(parsed) =
            serde_json::from_str::<BTreeMap<AgentType, AgentDelegationDefaults>>(&raw)
        {
            settings.agent_defaults = parsed;
        }
    }
    settings.clamped()
}

/// Pull settings from the DB and push the resulting `DelegationConfig` onto
/// the broker. Idempotent — safe to call on startup, after settings save, or
/// after any external write to `app_metadata`.
pub async fn apply_persisted_config(conn: &DatabaseConnection, broker: &DelegationBroker) {
    let settings = load_delegation_settings(conn).await;
    broker.set_config(settings.into_broker_config()).await;
}

/// Persist + apply. Used by both the Tauri command and the HTTP handler so
/// the clamp / re-apply chain is in exactly one place.
pub async fn set_delegation_settings_core(
    conn: &DatabaseConnection,
    broker: &DelegationBroker,
    desired: DelegationSettings,
) -> Result<DelegationSettings, AppCommandError> {
    let clamped = desired.clamped();
    app_metadata_service::upsert_value(conn, KEY_DELEGATION_ENABLED, &clamped.enabled.to_string())
        .await
        .map_err(AppCommandError::from)?;
    app_metadata_service::upsert_value(
        conn,
        KEY_DELEGATION_DEPTH,
        &clamped.depth_limit.to_string(),
    )
    .await
    .map_err(AppCommandError::from)?;
    app_metadata_service::upsert_value(
        conn,
        KEY_DELEGATION_COMPLETED_CACHE_MB,
        &clamped.completed_cache_max_mb.to_string(),
    )
    .await
    .map_err(AppCommandError::from)?;
    // Whole-blob replace semantics: save mirrors what the UI sent. Empty map
    // serializes to "{}" — still write it so a user can clear all overrides
    // back to the agent defaults.
    let agent_defaults_json = serde_json::to_string(&clamped.agent_defaults).map_err(|e| {
        AppCommandError::configuration_invalid(format!("serialize agent_defaults: {e}"))
    })?;
    app_metadata_service::upsert_value(conn, KEY_DELEGATION_AGENT_DEFAULTS, &agent_defaults_json)
        .await
        .map_err(AppCommandError::from)?;
    broker
        .set_config(clamped.clone().into_broker_config())
        .await;
    Ok(clamped)
}

// -------- User-side continuation entry (Task 5 · design §用户侧) -------------

/// Synthetic "connection id" stamped on user-side continuation dispatches.
/// The broker's ownership check runs on the parent CONVERSATION id (D5); the
/// connection id only labels the run lease + in-flight registration, and this
/// value never collides with a real ACP connection UUID — so a parent
/// connection teardown can never sweep a user-dispatched turn by accident.
pub const USER_ENTRY_CONNECTION_ID: &str = "user-entry";

/// How a user-supplied child conversation id resolves against the DB.
enum DelegationTarget {
    /// No live row with that id — answered with a non-disclosing `Unknown`.
    NotFound,
    /// A row exists but is not a delegation subsession (`parent_id` null or
    /// no `delegation_call_id`) — refused: a regular conversation can never
    /// be driven through the delegation broker.
    NotASubsession,
    /// A delegation child: the broker task id (= `delegation_call_id`) plus
    /// its owning parent conversation id.
    Target {
        task_id: String,
        parent_conversation_id: i32,
    },
}

/// Resolve a child conversation id to its broker task (D5: the user side
/// addresses sessions by conversation id; the broker speaks task ids).
async fn resolve_delegation_target(
    conn: &DatabaseConnection,
    child_conversation_id: i32,
) -> Result<DelegationTarget, AppCommandError> {
    let Some(row) = conversation_service::get_by_id_optional(conn, child_conversation_id)
        .await
        .map_err(AppCommandError::from)?
    else {
        return Ok(DelegationTarget::NotFound);
    };
    match (row.parent_id, row.delegation_call_id) {
        (Some(parent_conversation_id), Some(task_id)) if !task_id.trim().is_empty() => {
            Ok(DelegationTarget::Target {
                task_id,
                parent_conversation_id,
            })
        }
        _ => Ok(DelegationTarget::NotASubsession),
    }
}

/// The non-disclosing verdict for an id with no live conversation row —
/// mirrors the broker's own `unknown_report` shape (status `Unknown`, no
/// error code) so callers can't tell "never existed" from "not yours".
fn unknown_target_report() -> DelegationTaskReport {
    DelegationTaskReport {
        task_id: None,
        status: TaskStatus::Unknown,
        child_conversation_id: None,
        agent_type: None,
        text: None,
        error_code: None,
        message: Some(
            "Unknown conversation — it never existed, is not a delegation \
             subsession you can address, or was deleted."
                .to_string(),
        ),
        duration_ms: None,
        applied_persona: None,
    }
}

/// Refusal report for a conversation that exists but is not a delegation
/// subsession. Rides `types.rs`' error contract (`not_continuable`) so the
/// frontend surfaces the same stable code the broker uses.
fn not_a_subsession_report(child_conversation_id: i32) -> DelegationTaskReport {
    let err =
        DelegationError::NotContinuable("this conversation is not a delegation subsession".into());
    match DelegationOutcome::from_err(err, Some(child_conversation_id)) {
        DelegationOutcome::Err {
            code,
            message,
            child_conversation_id,
        } => DelegationTaskReport {
            task_id: None,
            status: TaskStatus::Failed,
            child_conversation_id,
            agent_type: None,
            text: None,
            error_code: Some(code),
            message: Some(message),
            duration_ms: None,
            applied_persona: None,
        },
        DelegationOutcome::Ok(_) => unreachable!("from_err never yields Ok"),
    }
}

/// User-side continue: locate the broker task by the child CONVERSATION id
/// (D5) and dispatch the follow-up under the same `task_id` the parent AI
/// holds (Requirement 4.2), with `TurnOrigin::User`. `continuation_id` is the
/// caller-minted idempotency key — the frontend reuses it on retry.
pub async fn continue_delegation_core(
    conn: &DatabaseConnection,
    broker: &DelegationBroker,
    child_conversation_id: i32,
    message: String,
    continuation_id: String,
) -> Result<DelegationTaskReport, AppCommandError> {
    match resolve_delegation_target(conn, child_conversation_id).await? {
        DelegationTarget::NotFound => Ok(unknown_target_report()),
        DelegationTarget::NotASubsession => Ok(not_a_subsession_report(child_conversation_id)),
        DelegationTarget::Target {
            task_id,
            parent_conversation_id,
        } => Ok(broker
            .continue_delegation(
                USER_ENTRY_CONNECTION_ID,
                Some(parent_conversation_id),
                &task_id,
                message,
                &continuation_id,
                TurnOrigin::User,
            )
            .await),
    }
}

/// User-side close (RELEASE semantics — frees the child process; not a
/// permanent close). Same target resolution as continue.
pub async fn close_delegation_session_core(
    conn: &DatabaseConnection,
    broker: &DelegationBroker,
    child_conversation_id: i32,
    continuation_id: String,
) -> Result<DelegationTaskReport, AppCommandError> {
    match resolve_delegation_target(conn, child_conversation_id).await? {
        DelegationTarget::NotFound => Ok(unknown_target_report()),
        DelegationTarget::NotASubsession => Ok(not_a_subsession_report(child_conversation_id)),
        DelegationTarget::Target {
            task_id,
            parent_conversation_id,
        } => Ok(broker
            .close_delegation_session(
                USER_ENTRY_CONNECTION_ID,
                Some(parent_conversation_id),
                &task_id,
                &continuation_id,
            )
            .await),
    }
}

/// User-side availability query (design §D4 five tiers). Ids that don't
/// resolve to a delegation subsession fold into `NotContinuable` — one
/// verdict, no existence disclosure.
pub async fn get_continuation_availability_core(
    conn: &DatabaseConnection,
    broker: &DelegationBroker,
    child_conversation_id: i32,
) -> Result<ContinuationAvailability, AppCommandError> {
    match resolve_delegation_target(conn, child_conversation_id).await? {
        DelegationTarget::NotFound | DelegationTarget::NotASubsession => {
            Ok(ContinuationAvailability::NotContinuable)
        }
        DelegationTarget::Target { .. } => Ok(broker
            .get_continuation_availability(child_conversation_id)
            .await),
    }
}

/// User-side cancel (Requirement 8): locate the broker task by the child
/// CONVERSATION id and stop it under the same task id the parent AI holds.
/// Same target resolution and same three refusal shapes as
/// [`continue_delegation_core`], so every user-side channel answers a bad id
/// identically.
///
/// The broker's ownership check (D5) runs on `parent_conversation_id`; the
/// synthetic [`USER_ENTRY_CONNECTION_ID`] never resolves to a real ACP
/// connection, so passing the resolved parent conversation id is what makes a
/// user-initiated cancel of an LLM-spawned task addressable at all. Cancel is
/// naturally idempotent here: a task that already went terminal returns its
/// existing terminal report rather than an error, so a double-click can't
/// manufacture a failure.
pub async fn cancel_delegation_core(
    conn: &DatabaseConnection,
    broker: &DelegationBroker,
    child_conversation_id: i32,
) -> Result<DelegationTaskReport, AppCommandError> {
    match resolve_delegation_target(conn, child_conversation_id).await? {
        DelegationTarget::NotFound => Ok(unknown_target_report()),
        DelegationTarget::NotASubsession => Ok(not_a_subsession_report(child_conversation_id)),
        DelegationTarget::Target {
            task_id,
            parent_conversation_id,
        } => Ok(broker
            .cancel_task_by_id(
                USER_ENTRY_CONNECTION_ID,
                Some(parent_conversation_id),
                &task_id,
            )
            .await),
    }
}

/// User-side authoritative status read (Requirement 7.11-7.13): re-read one
/// delegation's status straight from the broker so the observatory panel can
/// reconcile a row whose terminal event never arrived (cancel answered
/// terminal but no `delegation_completed` landed) or that is still shown
/// running after a transport reconnect.
///
/// Never blocks — [`StatusWait::Immediate`] returns the current snapshot. A
/// reconciliation pass is a UI-driven read that must answer promptly; the
/// long-poll modes exist for the LLM channel, which is waiting on a result.
/// Reads through the same ownership rule as cancel (that is why the D5 fix
/// covered `classify_locked` in the same delivery), so the panel and the
/// cancel button agree on which tasks are addressable.
pub async fn get_delegation_task_status_core(
    conn: &DatabaseConnection,
    broker: &DelegationBroker,
    child_conversation_id: i32,
) -> Result<DelegationTaskReport, AppCommandError> {
    match resolve_delegation_target(conn, child_conversation_id).await? {
        DelegationTarget::NotFound => Ok(unknown_target_report()),
        DelegationTarget::NotASubsession => Ok(not_a_subsession_report(child_conversation_id)),
        DelegationTarget::Target {
            task_id,
            parent_conversation_id,
        } => Ok(broker
            .get_task_status(
                USER_ENTRY_CONNECTION_ID,
                Some(parent_conversation_id),
                &task_id,
                StatusWait::Immediate,
            )
            .await),
    }
}

// -------- Tauri commands -----------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_delegation_settings(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<DelegationSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(load_delegation_settings(&db.conn).await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        // Server mode reaches this via the web handler, not this command.
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_delegation_settings(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] broker: tauri::State<'_, Arc<DelegationBroker>>,
    settings: DelegationSettings,
) -> Result<DelegationSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        set_delegation_settings_core(&db.conn, broker.inner(), settings).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = settings;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn continue_delegation(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] broker: tauri::State<'_, Arc<DelegationBroker>>,
    child_conversation_id: i32,
    message: String,
    continuation_id: String,
) -> Result<DelegationTaskReport, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        continue_delegation_core(
            &db.conn,
            broker.inner(),
            child_conversation_id,
            message,
            continuation_id,
        )
        .await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = (child_conversation_id, message, continuation_id);
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn close_delegation_session(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] broker: tauri::State<'_, Arc<DelegationBroker>>,
    child_conversation_id: i32,
    continuation_id: String,
) -> Result<DelegationTaskReport, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        close_delegation_session_core(
            &db.conn,
            broker.inner(),
            child_conversation_id,
            continuation_id,
        )
        .await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = (child_conversation_id, continuation_id);
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_continuation_availability(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] broker: tauri::State<'_, Arc<DelegationBroker>>,
    child_conversation_id: i32,
) -> Result<ContinuationAvailability, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        get_continuation_availability_core(&db.conn, broker.inner(), child_conversation_id).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = child_conversation_id;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn cancel_delegation(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] broker: tauri::State<'_, Arc<DelegationBroker>>,
    child_conversation_id: i32,
) -> Result<DelegationTaskReport, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        cancel_delegation_core(&db.conn, broker.inner(), child_conversation_id).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = child_conversation_id;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_delegation_task_status(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] broker: tauri::State<'_, Arc<DelegationBroker>>,
    child_conversation_id: i32,
) -> Result<DelegationTaskReport, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        get_delegation_task_status_core(&db.conn, broker.inner(), child_conversation_id).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = child_conversation_id;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::delegation::broker::{ConversationDepthLookup, DelegationBroker};
    use crate::acp::delegation::spawner::{mock::MockSpawner, ConnectionSpawner};
    use crate::acp::delegation::types::DelegationError;
    use async_trait::async_trait;

    struct EmptyLookup;
    #[async_trait]
    impl ConversationDepthLookup for EmptyLookup {
        async fn parent_of(&self, _id: i32) -> Result<Option<i32>, DelegationError> {
            Ok(None)
        }
    }

    fn make_broker() -> DelegationBroker {
        DelegationBroker::new(
            Arc::new(MockSpawner::new()) as Arc<dyn ConnectionSpawner>,
            Arc::new(EmptyLookup) as Arc<dyn ConversationDepthLookup>,
        )
    }

    #[test]
    fn settings_clamp_to_safe_range() {
        let s = DelegationSettings {
            enabled: true,
            depth_limit: 99,
            ..DelegationSettings::default()
        }
        .clamped();
        assert_eq!(s.depth_limit, DEPTH_MAX);
    }

    #[tokio::test]
    async fn load_returns_defaults_when_unset() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let settings = load_delegation_settings(&db.conn).await;
        assert!(!settings.enabled);
        assert_eq!(settings.depth_limit, 1);
    }

    #[tokio::test]
    async fn set_then_load_round_trip_and_broker_applied() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let broker = make_broker();
        let desired = DelegationSettings {
            enabled: false,
            depth_limit: 3,
            ..DelegationSettings::default()
        };
        let saved = set_delegation_settings_core(&db.conn, &broker, desired)
            .await
            .unwrap();
        assert!(!saved.enabled);
        assert_eq!(saved.depth_limit, 3);

        let loaded = load_delegation_settings(&db.conn).await;
        assert_eq!(loaded.enabled, saved.enabled);
        assert_eq!(loaded.depth_limit, saved.depth_limit);

        let cfg = broker.config_snapshot().await;
        assert!(!cfg.enabled);
        assert_eq!(cfg.depth_limit, 3);
    }

    #[tokio::test]
    async fn agent_defaults_round_trip_through_db_and_broker() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let broker = make_broker();

        let mut claude_cfg = BTreeMap::new();
        claude_cfg.insert("model".into(), "claude-sonnet-4-5".into());
        let mut agent_defaults: BTreeMap<AgentType, AgentDelegationDefaults> = BTreeMap::new();
        agent_defaults.insert(
            AgentType::ClaudeCode,
            AgentDelegationDefaults {
                mode_id: Some("auto".into()),
                config_values: claude_cfg.clone(),
            },
        );

        let desired = DelegationSettings {
            enabled: true,
            depth_limit: 4,
            agent_defaults: agent_defaults.clone(),
            ..DelegationSettings::default()
        };
        let saved = set_delegation_settings_core(&db.conn, &broker, desired)
            .await
            .unwrap();
        assert_eq!(saved.agent_defaults, agent_defaults);

        // Re-read from DB — the JSON blob should round-trip identically.
        let loaded = load_delegation_settings(&db.conn).await;
        assert_eq!(loaded.agent_defaults, agent_defaults);

        // Broker should have the same map applied.
        let cfg = broker.config_snapshot().await;
        let entry = cfg.agent_defaults.get(&AgentType::ClaudeCode).unwrap();
        assert_eq!(entry.mode_id.as_deref(), Some("auto"));
        assert_eq!(entry.config_values, claude_cfg);
    }

    #[tokio::test]
    async fn clamped_drops_empty_agent_defaults_entries() {
        // Empty entries (no mode, no config_values) should be filtered out so
        // the persisted JSON stays compact.
        let mut agent_defaults: BTreeMap<AgentType, AgentDelegationDefaults> = BTreeMap::new();
        agent_defaults.insert(AgentType::ClaudeCode, AgentDelegationDefaults::default());
        agent_defaults.insert(
            AgentType::Codex,
            AgentDelegationDefaults {
                mode_id: Some("auto".into()),
                config_values: BTreeMap::new(),
            },
        );
        let s = DelegationSettings {
            enabled: true,
            depth_limit: 2,
            agent_defaults,
            ..DelegationSettings::default()
        }
        .clamped();
        assert!(!s.agent_defaults.contains_key(&AgentType::ClaudeCode));
        assert!(s.agent_defaults.contains_key(&AgentType::Codex));
    }

    #[tokio::test]
    async fn set_clamps_out_of_range_values() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let broker = make_broker();
        let saved = set_delegation_settings_core(
            &db.conn,
            &broker,
            DelegationSettings {
                enabled: true,
                depth_limit: 999,
                ..DelegationSettings::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(saved.depth_limit, DEPTH_MAX);
    }

    #[tokio::test]
    async fn completed_cache_mb_round_trips_and_converts_to_bytes() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let broker = make_broker();
        let desired = DelegationSettings {
            enabled: true,
            depth_limit: 1,
            completed_cache_max_mb: 8,
            ..DelegationSettings::default()
        };
        let saved = set_delegation_settings_core(&db.conn, &broker, desired)
            .await
            .unwrap();
        assert_eq!(saved.completed_cache_max_mb, 8);

        // Persisted + reloaded identically.
        let loaded = load_delegation_settings(&db.conn).await;
        assert_eq!(loaded.completed_cache_max_mb, 8);

        // Broker received the MB → bytes conversion.
        let cfg = broker.config_snapshot().await;
        assert_eq!(cfg.completed_cache_cap_bytes, 8 * 1024 * 1024);
    }

    #[test]
    fn completed_cache_mb_zero_means_unlimited_and_is_not_clamped() {
        let s = DelegationSettings {
            completed_cache_max_mb: 0,
            ..DelegationSettings::default()
        }
        .clamped();
        assert_eq!(s.completed_cache_max_mb, 0);
        assert_eq!(s.into_broker_config().completed_cache_cap_bytes, 0);
    }

    #[tokio::test]
    async fn load_returns_default_completed_cache_when_unset() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let settings = load_delegation_settings(&db.conn).await;
        assert_eq!(settings.completed_cache_max_mb, DEFAULT_COMPLETED_CACHE_MB);
    }

    // -------- User-side cancel + reconciliation query (Requirement 8) --------
    //
    // The end-to-end test below deliberately drives a REAL `DelegationBroker`.
    // A broker-mocked test would have stayed green through the entire
    // pre-`a0779219` ownership defect (`cancel_task_by_id` compared only the
    // connection id, so every user-side cancel answered `Unknown`) — the exact
    // failure mode Requirement 8 exists to close.

    /// Seed a folder + root parent conversation, returning `(folder_id,
    /// parent_conversation_id)`. The parent id is what a `DelegationRequest`
    /// carries and what the broker records on the session entry.
    async fn seed_parent(conn: &DatabaseConnection, folder_path: &str) -> (i32, i32) {
        use crate::db::service::folder_service;

        let folder = folder_service::add_folder(conn, folder_path)
            .await
            .expect("folder");
        let parent_id = conversation_service::create(
            conn,
            folder.id,
            AgentType::ClaudeCode,
            Some("parent".into()),
            None,
        )
        .await
        .expect("parent")
        .id;
        (folder.id, parent_id)
    }

    /// Create a delegation child row under `parent_id` whose
    /// `delegation_call_id` is bound to `task_id`, and return its conversation
    /// id. `delegation_call_id` is the join key `resolve_delegation_target`
    /// reads, and `parent_id` must be the SAME parent the delegation was
    /// started under — the broker's D5 ownership check compares exactly these
    /// two, so a mismatched parent legitimately answers `Unknown`.
    async fn seed_delegation_child(
        conn: &DatabaseConnection,
        folder_id: i32,
        parent_id: i32,
        task_id: &str,
    ) -> i32 {
        use crate::acp::delegation::spawner::DelegationLink;

        conversation_service::create_with_delegation(
            conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("delegated child".into()),
            None,
            Some(DelegationLink {
                parent_conversation_id: parent_id,
                parent_tool_use_id: "pt-user-cancel".into(),
                delegation_call_id: task_id.to_string(),
            }),
        )
        .await
        .expect("child")
        .id
    }

    /// Requirement 8.2: an id with no live conversation row answers `Unknown`
    /// with no error code, so the channel never discloses whether a row
    /// exists.
    #[tokio::test]
    async fn cancel_on_unknown_child_conversation_reports_unknown() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let broker = make_broker();
        let report = cancel_delegation_core(&db.conn, &broker, 424_242)
            .await
            .expect("an unknown id is a report, not an error");
        assert_eq!(report.status, TaskStatus::Unknown);
        assert!(
            report.error_code.is_none(),
            "unknown ids ride the Unknown status shape, not an error code"
        );
    }

    /// Requirement 8.3: a regular root conversation (`parent_id` null) is not
    /// a delegation subsession — cancel is refused with the stable
    /// `not_continuable` code rather than reaching the broker.
    #[tokio::test]
    async fn cancel_on_root_conversation_is_rejected() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let broker = make_broker();
        let (_folder_id, root_id) = seed_parent(&db.conn, "/w8-root").await;

        let report = cancel_delegation_core(&db.conn, &broker, root_id)
            .await
            .expect("a refusal rides the report shape");
        assert_eq!(report.status, TaskStatus::Failed);
        assert_eq!(report.error_code.as_deref(), Some("not_continuable"));
        assert_eq!(report.child_conversation_id, Some(root_id));
    }

    /// Requirement 8.1 + 8.4-8.5, driven end to end through a REAL broker (no
    /// broker mock): an LLM-spawned running task is canceled by the USER-side
    /// entry, which holds no connection context and passes the synthetic
    /// `USER_ENTRY_CONNECTION_ID`. Asserts the observable side effects, not
    /// just the returned status: the session flips to `Canceled` and the child
    /// connection is really torn down through the spawner.
    #[tokio::test]
    async fn cancel_core_cancels_a_real_running_task_through_a_real_broker() {
        use crate::acp::delegation::broker::DelegationConfig;
        use crate::acp::delegation::types::DelegationRequest;

        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let mock = Arc::new(MockSpawner::new());
        let broker = DelegationBroker::new(
            mock.clone() as Arc<dyn ConnectionSpawner>,
            Arc::new(EmptyLookup) as Arc<dyn ConversationDepthLookup>,
        );
        broker
            .set_config(DelegationConfig {
                enabled: true,
                ..DelegationConfig::default()
            })
            .await;

        // The LLM spawns it: the running task carries a REAL parent connection.
        mock.queue_spawn(Ok("child-conn-cancel".into())).await;
        mock.queue_send(Ok(4_242)).await;
        let (folder_id, parent_id) = seed_parent(&db.conn, "/w8-cancel").await;
        let ack = broker
            .start_delegation(DelegationRequest {
                parent_connection_id: "parent-conn".into(),
                parent_conversation_id: parent_id,
                parent_tool_use_id: "pt-user-cancel".into(),
                agent_type: AgentType::ClaudeCode,
                task: "do x".into(),
                working_dir: None,
                requested_working_dir: None,
                external_handle: None,
                subagent_type: None,
            })
            .await;
        let task_id = ack.task_id.expect("a running task carries an id");

        // Bind a child row UNDER THE SAME PARENT to the broker-minted task id
        // (the D5 join key the user-side entry resolves through).
        let child_id = seed_delegation_child(&db.conn, folder_id, parent_id, &task_id).await;

        let report = cancel_delegation_core(&db.conn, &broker, child_id)
            .await
            .expect("the happy path never surfaces an error");

        assert_eq!(
            report.status,
            TaskStatus::Canceled,
            "a user-side cancel of an LLM-spawned task must be honored; \
             `Unknown` here means the ownership check regressed"
        );
        assert_eq!(report.task_id.as_deref(), Some(task_id.as_str()));
        // Real side effect: the child connection was actually torn down.
        assert_eq!(
            mock.disconnects.lock().await.as_slice(),
            &["child-conn-cancel"],
            "cancel must tear the child connection down"
        );
        // And the broker's own view agrees the task is terminal.
        let after = broker
            .get_task_status(
                USER_ENTRY_CONNECTION_ID,
                Some(parent_id),
                &task_id,
                crate::acp::delegation::broker::StatusWait::Immediate,
            )
            .await;
        assert_eq!(after.status, TaskStatus::Canceled);
    }

    /// Requirement 7.11-7.13 read side: the reconciliation query resolves the
    /// authoritative status of a running task through the same user-side
    /// credentials, so the panel can re-read a row after a lost event or a
    /// transport reconnect. Real broker, no mock.
    #[tokio::test]
    async fn status_core_reads_authoritative_status_through_a_real_broker() {
        use crate::acp::delegation::broker::DelegationConfig;
        use crate::acp::delegation::types::DelegationRequest;

        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let mock = Arc::new(MockSpawner::new());
        let broker = DelegationBroker::new(
            mock.clone() as Arc<dyn ConnectionSpawner>,
            Arc::new(EmptyLookup) as Arc<dyn ConversationDepthLookup>,
        );
        broker
            .set_config(DelegationConfig {
                enabled: true,
                ..DelegationConfig::default()
            })
            .await;

        mock.queue_spawn(Ok("child-conn-status".into())).await;
        mock.queue_send(Ok(4_243)).await;
        let (folder_id, parent_id) = seed_parent(&db.conn, "/w8-status").await;
        let ack = broker
            .start_delegation(DelegationRequest {
                parent_connection_id: "parent-conn".into(),
                parent_conversation_id: parent_id,
                parent_tool_use_id: "pt-user-cancel".into(),
                agent_type: AgentType::ClaudeCode,
                task: "do x".into(),
                working_dir: None,
                requested_working_dir: None,
                external_handle: None,
                subagent_type: None,
            })
            .await;
        let task_id = ack.task_id.expect("a running task carries an id");
        let child_id = seed_delegation_child(&db.conn, folder_id, parent_id, &task_id).await;

        let running = get_delegation_task_status_core(&db.conn, &broker, child_id)
            .await
            .expect("the query never surfaces an error for a resolvable id");
        assert_eq!(
            running.status,
            TaskStatus::Running,
            "the reconciliation query must resolve under user-side credentials"
        );
        assert_eq!(running.task_id.as_deref(), Some(task_id.as_str()));

        // After a cancel it must report the new authoritative terminal state —
        // this is precisely the "cancel returned terminal but no event arrived"
        // reconciliation case (R7.11).
        let _ = cancel_delegation_core(&db.conn, &broker, child_id)
            .await
            .expect("cancel");
        let settled = get_delegation_task_status_core(&db.conn, &broker, child_id)
            .await
            .expect("status after cancel");
        assert_eq!(settled.status, TaskStatus::Canceled);
    }

    /// The reconciliation query shares cancel's target resolution, so an
    /// unresolvable id gets the same non-disclosing verdict (Requirement 8.2
    /// applied to the read side).
    #[tokio::test]
    async fn status_core_on_unknown_child_conversation_reports_unknown() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let broker = make_broker();
        let report = get_delegation_task_status_core(&db.conn, &broker, 424_242)
            .await
            .expect("an unknown id is a report, not an error");
        assert_eq!(report.status, TaskStatus::Unknown);
        assert!(report.error_code.is_none());
    }

    /// And a regular root conversation is refused on the read side too.
    #[tokio::test]
    async fn status_core_on_root_conversation_is_rejected() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let broker = make_broker();
        let (_folder_id, root_id) = seed_parent(&db.conn, "/w8-status-root").await;

        let report = get_delegation_task_status_core(&db.conn, &broker, root_id)
            .await
            .expect("a refusal rides the report shape");
        assert_eq!(report.status, TaskStatus::Failed);
        assert_eq!(report.error_code.as_deref(), Some("not_continuable"));
    }
}
