//! Claude Code Dynamic Workflows (DW) lifecycle adaptation.
//!
//! DW events ride `type:"system"` + `subtype:"task_*"` (flat payload, NO
//! `data` wrapper) — a DIFFERENT top-level branch from Stop hooks, which ride
//! `type:"attachment"`. Protocol modeled from three cross-validated sources
//! (recon §2.1): official workflows doc + nexus PR#31 (CLI 2.1.159 wire) +
//! CodeBuddy alignment doc ("aligns with 2.1.220").
//!
//! ⚠️ The stream-json `subtype:"task_notification"` here is NOT the codeg
//! `<task-notification>` XML (claude.rs:60 / ~988). Same words, different
//! wire, different channel, different meaning — never reuse that regex/struct
//! (recon R6). No type name here carries `Notification` to avoid the trap.

use serde::{Deserialize, Serialize};

/// Lifecycle status of a workflow run (decision-card §1.3 state machine).
/// `Unknown` = a `task_started` seen but never terminated (crash / EOF flush).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStatus {
    Started,
    Running,
    Completed,
    Failed,
    Killed,
    Stopped,
    Unknown,
}

/// Aggregate token / wall-clock usage carried on progress + notification.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowUsage {
    #[serde(default)]
    pub total_tokens: u64,
    #[serde(default)]
    pub duration_ms: u64,
}

/// One node of the cumulative `workflow_progress[]` array. Each `task_progress`
/// event carries the FULL current array (cumulative, NOT incremental — recon
/// R7): the reducer REPLACES the stored array wholesale, never appends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkflowProgressNode {
    WorkflowPhase {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        elapsed_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        agent_count: Option<u32>,
    },
    WorkflowAgent {
        index: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        state: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_calls: Option<u32>,
    },
}

/// A fully-aggregated snapshot of one workflow run, keyed by `task_id`. The
/// backend reducer owns the state machine; the frontend stores this snapshot
/// by `task_id` and overwrites — it does NOT rebuild the machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowRunEvent {
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_name: Option<String>,
    pub task_type: String,
    pub status: WorkflowStatus,
    /// Cumulative full-replacement (recon R7).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workflow_progress: Vec<WorkflowProgressNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<WorkflowUsage>,
}

/// Stateful reducer: fed each `system/task_*` record in file order, keyed by
/// `task_id`. Applies the state machine (started → progress[cumulative] →
/// updated → notification) and emits an updated snapshot per event. Orphans
/// (progress before started / started never terminated) handled per
/// decision-card §1.3.
#[derive(Debug, Default)]
pub(crate) struct WorkflowReducer {
    /// `task_id` → run state, in first-seen order (a Vec keeps the emission
    /// order stable; a run count is bounded by workflows per session).
    runs: Vec<(String, WorkflowRunEvent)>,
    /// Whether a run already reached a terminal `task_notification`, so a late
    /// `task_progress` cannot roll its status back (§1.3 out-of-order rule).
    terminal: std::collections::HashSet<String>,
    /// `(task_id, subtype, timestamp)` triples already applied — a replay of
    /// the identical event is idempotent.
    seen: std::collections::HashSet<String>,
}

/// Subtypes this reducer owns. Anything else on a `system` record belongs to
/// another branch (e.g. `turn_duration`) and must not reach here.
pub(crate) fn is_workflow_subtype(subtype: &str) -> bool {
    matches!(
        subtype,
        "task_started" | "task_progress" | "task_updated" | "task_notification"
    )
}

fn parse_status(raw: &str) -> Option<WorkflowStatus> {
    match raw {
        "running" => Some(WorkflowStatus::Running),
        "completed" => Some(WorkflowStatus::Completed),
        "failed" => Some(WorkflowStatus::Failed),
        "killed" => Some(WorkflowStatus::Killed),
        "stopped" => Some(WorkflowStatus::Stopped),
        "started" => Some(WorkflowStatus::Started),
        _ => None,
    }
}

impl WorkflowReducer {
    /// Feed one `system/task_*` JSONL record (the whole record `Value`).
    /// Returns the updated snapshot for this `task_id`, or `None` when the
    /// record is invalid (missing `task_id` → dropped + debug log) or a
    /// duplicate replay.
    pub(crate) fn ingest(&mut self, record: &serde_json::Value) -> Option<WorkflowRunEvent> {
        let subtype = record.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
        if !is_workflow_subtype(subtype) {
            return None;
        }
        let str_field = |v: &serde_json::Value, k: &str| {
            v.get(k)
                .and_then(|s| s.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };

        // `task_id` is the authoritative primary key; without it the event
        // cannot be attributed to a run at all (A4: log once, drop).
        let Some(task_id) = str_field(record, "task_id") else {
            tracing::debug!("[claude-workflow] dropping {subtype} record with no task_id");
            return None;
        };

        // Idempotent replay guard.
        let fingerprint = format!(
            "{task_id}|{subtype}|{}",
            str_field(record, "timestamp").unwrap_or_default()
        );
        if !self.seen.insert(fingerprint) {
            return None;
        }

        // A `task_progress` with no preceding `task_started` (late subscribe)
        // fabricates an implicit started state rather than dropping the run.
        if !self.runs.iter().any(|(id, _)| *id == task_id) {
            let run = WorkflowRunEvent {
                task_id: task_id.clone(),
                workflow_name: None,
                task_type: str_field(record, "task_type")
                    .unwrap_or_else(|| "local_workflow".to_string()),
                status: WorkflowStatus::Started,
                workflow_progress: Vec::new(),
                prompt: None,
                tool_use_id: None,
                session_id: None,
                output_file: None,
                usage: None,
            };
            self.runs.push((task_id.clone(), run));
        }

        let is_terminal_already = self.terminal.contains(&task_id);
        let run = self
            .runs
            .iter_mut()
            .find(|(id, _)| *id == task_id)
            .map(|(_, run)| run)?;

        // Fields that any event may carry are merged when present.
        if let Some(name) = str_field(record, "workflow_name") {
            run.workflow_name = Some(name);
        }
        if let Some(task_type) = str_field(record, "task_type") {
            run.task_type = task_type;
        }
        if let Some(prompt) = str_field(record, "prompt") {
            run.prompt = Some(prompt);
        }
        if let Some(tool_use_id) = str_field(record, "tool_use_id") {
            run.tool_use_id = Some(tool_use_id);
        }
        if let Some(session_id) =
            str_field(record, "session_id").or_else(|| str_field(record, "sessionId"))
        {
            run.session_id = Some(session_id);
        }
        if let Some(output_file) = str_field(record, "output_file") {
            run.output_file = Some(output_file);
        }
        if let Some(usage) = record
            .get("usage")
            .and_then(|u| serde_json::from_value::<WorkflowUsage>(u.clone()).ok())
        {
            run.usage = Some(usage);
        }

        match subtype {
            "task_started" => {
                if !is_terminal_already {
                    run.status = WorkflowStatus::Started;
                }
            }
            "task_progress" => {
                // ⚠️ recon R7: `workflow_progress[]` is CUMULATIVE — each event
                // carries the complete current array. Replace it wholesale;
                // appending would multiply phases/agents on every event.
                if let Some(nodes) = record.get("workflow_progress") {
                    run.workflow_progress = parse_progress_nodes(nodes);
                }
                if !is_terminal_already {
                    run.status = WorkflowStatus::Running;
                }
            }
            "task_updated" => {
                // Status rides a `patch` object here, per the wire model.
                let status_raw = record
                    .get("patch")
                    .and_then(|p| p.get("status"))
                    .or_else(|| record.get("status"))
                    .and_then(|s| s.as_str());
                if let Some(status) = status_raw.and_then(parse_status) {
                    if !is_terminal_already {
                        run.status = status;
                    }
                }
            }
            "task_notification" => {
                // Terminal state wins and is never rolled back afterwards.
                // A missing `status` falls back to `Unknown`, never `Completed`
                // — a genuinely failed run whose status field is absent must
                // NOT be mislabeled as success (reviewer I-4, honesty fix).
                //
                // ⚠️ T8 real-machine finding (2026-08-09, CLI 2.1.226): a live
                // `Create a workflow` run emits NO `system/subtype:task_*`
                // record at all — the terminal signal arrives as the codeg
                // `<task-notification>` XML (type:user) handled at claude.rs:60,
                // and per-agent progress lands in `subagents/workflows/<run>/
                // journal.jsonl`. This stream-json reducer therefore never
                // fires on real 2.1.226 wire; it stays as the modeled-protocol
                // path (nexus#31 / CodeBuddy) and this `Unknown` fallback is a
                // defensive, honest default rather than a hot path. Provenance:
                // w6-sampling-report.md 门2.
                run.status = record
                    .get("status")
                    .and_then(|s| s.as_str())
                    .and_then(parse_status)
                    .unwrap_or(WorkflowStatus::Unknown);
                self.terminal.insert(task_id);
            }
            _ => {}
        }

        Some(run.clone())
    }

    /// Flush pending runs that never reached a terminal `task_notification`
    /// as `WorkflowStatus::Unknown` at end of stream.
    pub(crate) fn flush(&mut self) -> Vec<WorkflowRunEvent> {
        let terminal = std::mem::take(&mut self.terminal);
        self.runs
            .drain(..)
            .map(|(task_id, mut run)| {
                if !terminal.contains(&task_id) {
                    run.status = WorkflowStatus::Unknown;
                }
                run
            })
            .collect()
    }
}

/// Parse the cumulative `workflow_progress[]` array. Unrecognized node types
/// are skipped (A4) rather than surfaced as placeholders.
fn parse_progress_nodes(nodes: &serde_json::Value) -> Vec<WorkflowProgressNode> {
    let Some(items) = nodes.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let node_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let text = |k: &str| {
                item.get(k)
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            };
            let num = |k: &str| item.get(k).and_then(|v| v.as_u64());
            match node_type {
                "workflow_phase" => Some(WorkflowProgressNode::WorkflowPhase {
                    name: text("name").or_else(|| text("title")),
                    elapsed_ms: num("elapsed_ms"),
                    agent_count: num("agent_count").map(|n| n as u32),
                }),
                "workflow_agent" => Some(WorkflowProgressNode::WorkflowAgent {
                    index: num("index").unwrap_or(0) as u32,
                    state: text("state"),
                    prompt: text("prompt"),
                    tool_calls: num("tool_calls").map(|n| n as u32),
                }),
                other => {
                    tracing::debug!("[claude-workflow] skipping progress node type={other:?}");
                    None
                }
            }
        })
        .collect()
}

/// Drive a full slice of `system/task_*` records through a fresh reducer and
/// return the final snapshot per `task_id` in first-seen order. Test-only:
/// production feeds records one at a time through [`WorkflowReducer::ingest`]
/// from the parser's dispatch loop.
#[cfg(test)]
pub(crate) fn reduce_workflow_events(records: &[serde_json::Value]) -> Vec<WorkflowRunEvent> {
    let mut reducer = WorkflowReducer::default();
    for record in records {
        reducer.ingest(record);
    }
    reducer.flush()
}
