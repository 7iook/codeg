use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub use crate::db::entities::work_task::WorkTaskStatus;

/// One folder-bound work task. Wire form mirrors `src/lib/types.ts`
/// (`WorkTask`). `connection_id` is intentionally omitted (internal
/// correlation only).
#[derive(Debug, Clone, Serialize)]
pub struct WorkTaskInfo {
    pub id: i32,
    pub folder_id: i32,
    pub title: String,
    /// Opaque `WorkTaskConfig` snapshot (prompt blocks + per-task overrides);
    /// replayed at launch, never queried.
    pub config: serde_json::Value,
    pub status: WorkTaskStatus,
    pub failure_reason: Option<String>,
    pub last_error: Option<String>,
    pub run_seq: i32,
    pub sort_order: i32,
    pub worktree_folder_id: Option<i32>,
    pub conversation_id: Option<i32>,
    pub base_branch: Option<String>,
    pub base_sha: Option<String>,
    pub work_branch: Option<String>,
    pub cleanup_state: Option<String>,
    pub verdict: Option<String>,
    pub result_summary: Option<String>,
    pub files_changed: Option<i32>,
    pub additions: Option<i32>,
    pub deletions: Option<i32>,
    pub merge_commit: Option<String>,
    /// Latest `agent_progress` milestone (filled by `list` for live tasks only
    /// — the card's realtime progress line).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_progress: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub settled_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
}

/// One timeline entry of a task (append-only; see `work_task_event`).
#[derive(Debug, Clone, Serialize)]
pub struct WorkTaskEventInfo {
    pub id: i32,
    pub task_id: i32,
    pub kind: String,
    pub actor: String,
    pub payload: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
}

/// Create/update payload — the editor loads the whole task and saves it back
/// wholesale (title + captured composer config).
#[derive(Debug, Clone, Deserialize)]
pub struct WorkTaskDraft {
    pub folder_id: i32,
    pub title: String,
    pub config: serde_json::Value,
}

/// The structured shape stored inside `work_task.config`. Kept tolerant
/// (`#[serde(default)]`) so an older/newer snapshot still deserializes. Empty
/// optional fields inherit the folder's `WorkTaskFolderSettings` at launch —
/// the actually-effective values are recorded on a `config_effective` audit
/// event instead of being frozen here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkTaskConfig {
    #[serde(default)]
    pub prompt_blocks: Vec<serde_json::Value>,
    #[serde(default)]
    pub display_text: String,
    /// Per-task agent override. `None` = inherit folder settings.
    #[serde(default)]
    pub agent_type: Option<String>,
    #[serde(default)]
    pub mode_id: Option<String>,
    #[serde(default)]
    pub config_values: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub label_snapshot: Option<serde_json::Value>,
}

/// Per-folder defaults stored in `work_task_settings.config`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkTaskFolderSettings {
    /// `None` → fall back to `folder.default_agent_type`.
    #[serde(default)]
    pub default_agent_type: Option<String>,
    #[serde(default)]
    pub mode_id: Option<String>,
    #[serde(default)]
    pub config_values: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub label_snapshot: Option<serde_json::Value>,
    /// P1: the scheduler claims due todos automatically. Stored now, hidden in
    /// the P0 UI.
    #[serde(default)]
    pub auto_process: bool,
    /// Max concurrently active tasks per folder; 0 = unlimited.
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent: i32,
    /// "squash" (default) | "merge"
    #[serde(default = "default_merge_strategy")]
    pub merge_strategy: String,
    /// Merge dialog's "delete worktree after merge" default.
    #[serde(default = "default_true")]
    pub delete_worktree_default: bool,
}

impl Default for WorkTaskFolderSettings {
    fn default() -> Self {
        Self {
            default_agent_type: None,
            mode_id: None,
            config_values: Default::default(),
            label_snapshot: None,
            auto_process: false,
            max_concurrent: default_max_concurrent(),
            merge_strategy: default_merge_strategy(),
            delete_worktree_default: true,
        }
    }
}

fn default_max_concurrent() -> i32 {
    2
}

fn default_merge_strategy() -> String {
    "squash".to_string()
}

fn default_true() -> bool {
    true
}

/// The merge intent persisted (as JSON in `work_task.merge_state`) in the same
/// transaction as the review→merging CAS. Crash recovery replays git truth
/// against `pre_merge_head` + `message` to decide landed / not landed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkTaskMergeState {
    /// Project-folder HEAD right before stage B.
    pub pre_merge_head: String,
    /// Base HEAD the work branch was synced to by stage A (set after stage A).
    #[serde(default)]
    pub synced_base_sha: Option<String>,
    /// The commit message stage B will use (recovery matches on it).
    pub message: String,
    /// "squash" | "merge"
    pub strategy: String,
    /// Whether the user asked to delete the worktree after landing — persisted
    /// so crash recovery can honor the choice when it back-fills `done`.
    #[serde(default)]
    pub delete_worktree: bool,
}

/// Changed file of a task worktree vs. its recorded base (`git diff --numstat`).
#[derive(Debug, Clone, Serialize)]
pub struct WorkTaskChangedFile {
    pub file: String,
    pub additions: i32,
    pub deletions: i32,
}
