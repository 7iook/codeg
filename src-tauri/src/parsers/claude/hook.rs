//! Claude Code Stop-hook lifecycle adaptation.
//!
//! A single real Stop-hook trigger lands in the JSONL as TWO sibling
//! `type:"attachment"` records (sampled wire: `w1-report.md` §二):
//!
//! 1. `attachment.type == "hook_success"` — the execution fact
//!    (command / exitCode / stdout / stderr / durationMs).
//! 2. `attachment.type == "hook_additional_context"` — the decision result
//!    (the `additionalContext` array fed back to Claude).
//!
//! They are paired by the strong key `toolUseID` within a 500ms window and
//! merged into ONE `HookLifecycleEvent` so the user sees one card, not two
//! (decision-card §1.3 aggregation contract).
//!
//! ⚠️ This is NOT the codeg `<task-notification>` XML path (claude.rs:60 /
//! line ~988). That is the built-in Task-tool async sub-agent. Same word
//! "hook" nowhere overlaps — keep the parsing paths isolated (recon R6).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Pairing window: two sibling attachment records of one hook trigger are
/// written microseconds apart (sampled: 2ms). 500ms is a loose safe bound;
/// beyond it a lone `hook_success` is treated as an orphan and flushed alone.
pub(crate) const HOOK_PAIRING_WINDOW_MS: i64 = 500;

/// Max chars kept per merged `additional_context` entry (A6 data-minimization).
pub(crate) const ADDITIONAL_CONTEXT_MAX_CHARS: usize = 4_096;

/// Max chars kept for the `command_display` basename (A6).
pub(crate) const COMMAND_DISPLAY_MAX_CHARS: usize = 128;

/// Single source of truth for the Stop outcome (A2). The backend decides the
/// class ONCE; the frontend never rebuilds it from `exit_code` + `stdout`.
///
/// Priority when classifying: root `decision`/`reason`, then
/// `hookSpecificOutput`, then `exitCode`, then presence of
/// `additional_context` (issue #19115 — both the root-`decision` and
/// `hookSpecificOutput` schemas must be tolerated).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookOutcome {
    /// `exit_code == 0` and no `decision:block` — the stop was allowed with no
    /// feedback fed back to Claude.
    Pass,
    /// `exit_code == 0` but the hook emitted `additionalContext` (soft feedback
    /// Claude reads). The sampled wire in w1-report §二 is exactly this class.
    SoftContext,
    /// `exit_code == 2`, or stdout JSON `decision == "block"` — hard block.
    HardBlock,
    /// `exit_code == 1` (neither 2 nor 0) — the hook script itself errored.
    Error,
}

/// One fully-aggregated Stop-hook lifecycle, merged from the sibling
/// `hook_success` + `hook_additional_context` attachment records.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookLifecycleEvent {
    pub hook_name: String,
    pub hook_event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    pub outcome: HookOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome_reason: Option<String>,
    pub exit_code: i32,
    pub duration_ms: u64,
    /// A6: basename only (no absolute path), truncated to
    /// `COMMAND_DISPLAY_MAX_CHARS`. e.g. "claude-stop-orchestrator.ps1".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_display: Option<String>,
    /// Merged from `hook_additional_context.content`; each entry truncated to
    /// `ADDITIONAL_CONTEXT_MAX_CHARS`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_context: Vec<String>,
    /// Structured `hookSpecificOutput` JSON (never the raw stdout string).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook_specific_output: Option<serde_json::Value>,
    // A6: raw fields for controlled debugging only — `serde(skip)` unless the
    // `claude-hook-debug` feature is on, so the frontend never receives them.
    #[cfg_attr(not(feature = "claude-hook-debug"), serde(skip))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_raw: Option<String>,
    #[cfg_attr(not(feature = "claude-hook-debug"), serde(skip))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_raw: Option<String>,
    #[cfg_attr(not(feature = "claude-hook-debug"), serde(skip))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_raw: Option<String>,
    pub timestamp: DateTime<Utc>,
}

/// Classification of a `type:"attachment"` record's `attachment.type`.
/// Unknown types return `Unknown` — the caller logs one `tracing::debug!`
/// line and skips (A4 single contract: no placeholder UI, no panic).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachmentKind {
    HookSuccess,
    HookAdditionalContext,
    Unknown,
}

/// Classify one attachment record's inner `attachment.type` string.
pub(crate) fn classify_attachment(attachment_type: &str) -> AttachmentKind {
    match attachment_type {
        "hook_success" => AttachmentKind::HookSuccess,
        "hook_additional_context" => AttachmentKind::HookAdditionalContext,
        _ => AttachmentKind::Unknown,
    }
}

/// Pairing key for one hook trigger. Strong when `toolUseID` is present (it is
/// the authoritative primary key); otherwise a weak composite that still keeps
/// distinct hooks apart within one turn (decision-card §1.3).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum PairKey {
    Strong(String),
    Weak {
        hook_name: String,
        hook_event: String,
        parent_uuid: String,
    },
}

fn pair_key(record: &serde_json::Value, attachment: &serde_json::Value) -> PairKey {
    let field = |v: &serde_json::Value, k: &str| {
        v.get(k)
            .and_then(|s| s.as_str())
            .map(str::to_string)
            .unwrap_or_default()
    };
    match attachment.get("toolUseID").and_then(|v| v.as_str()) {
        Some(id) if !id.is_empty() => PairKey::Strong(id.to_string()),
        _ => PairKey::Weak {
            hook_name: field(attachment, "hookName"),
            hook_event: field(attachment, "hookEvent"),
            parent_uuid: field(record, "parentUuid"),
        },
    }
}

/// Reduce an absolute hook command line to a displayable basename (A6): take
/// the last path-ish token of the executable/script argument, strip the
/// directory, and bound the length. `None` when there is nothing to show.
fn command_display_from_raw(command: &str) -> Option<String> {
    // The interesting token is the script/executable path — prefer the last
    // token that looks like a path to a file, else the first token.
    let basename_of = |token: &str| {
        token
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(token)
            .trim()
            .to_string()
    };
    let tokens: Vec<&str> = command.split_whitespace().collect();
    let picked = tokens
        .iter()
        .rev()
        .find(|t| {
            let base = basename_of(t);
            base.contains('.') && !base.starts_with('-')
        })
        .map(|t| basename_of(t))
        .or_else(|| tokens.first().map(|t| basename_of(t)))?;
    if picked.is_empty() {
        return None;
    }
    Some(truncate_with_ellipsis(&picked, COMMAND_DISPLAY_MAX_CHARS))
}

/// Truncate on a char boundary, appending an ellipsis marker when cut.
fn truncate_with_ellipsis(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let kept: String = value.chars().take(max_chars).collect();
    format!("{kept}…truncated")
}

/// Classify the outcome from the `hook_success` payload, in the priority order
/// fixed by decision-card §3.1: root `decision`/`reason` (PostToolUse/Stop
/// schema) > `hookSpecificOutput` (PreToolUse schema, issue #19115) >
/// `exitCode` > presence of additional context.
///
/// Returns the outcome plus the reason summary when one is available.
fn classify_outcome(
    stdout_json: Option<&serde_json::Value>,
    exit_code: i32,
    stderr: &str,
    has_additional_context: bool,
) -> (HookOutcome, Option<String>) {
    let text_at = |v: &serde_json::Value, path: &[&str]| -> Option<String> {
        let mut cur = v;
        for key in path {
            cur = cur.get(key)?;
        }
        cur.as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };

    // 1 · root `decision` / `reason` (Stop + PostToolUse schema).
    if let Some(json) = stdout_json {
        if let Some(decision) = text_at(json, &["decision"]) {
            if decision.eq_ignore_ascii_case("block") {
                return (HookOutcome::HardBlock, text_at(json, &["reason"]));
            }
        }
        // 2 · `hookSpecificOutput` (PreToolUse schema; also where Stop hooks
        //     put a soft `additionalContext`).
        if let Some(hso) = json.get("hookSpecificOutput") {
            let decision = text_at(hso, &["permissionDecision"])
                .or_else(|| text_at(hso, &["decision"]))
                .unwrap_or_default();
            if decision.eq_ignore_ascii_case("deny") || decision.eq_ignore_ascii_case("block") {
                let reason = text_at(hso, &["permissionDecisionReason"])
                    .or_else(|| text_at(hso, &["reason"]));
                return (HookOutcome::HardBlock, reason);
            }
        }
    }

    // 3 · exit code. 2 = hard block, other non-zero = the script itself failed.
    if exit_code == 2 {
        let reason = stdout_json
            .and_then(|j| text_at(j, &["reason"]))
            .or_else(|| first_line(stderr));
        return (HookOutcome::HardBlock, reason);
    }
    if exit_code != 0 {
        return (HookOutcome::Error, first_line(stderr));
    }

    // 4 · exit 0: soft feedback when the hook produced additional context.
    let soft_reason = stdout_json
        .and_then(|j| text_at(j, &["hookSpecificOutput", "additionalContext"]))
        .or_else(|| stdout_json.and_then(|j| text_at(j, &["additionalContext"])));
    if has_additional_context || soft_reason.is_some() {
        return (HookOutcome::SoftContext, soft_reason);
    }
    (HookOutcome::Pass, None)
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// The parsed shape of one `hook_success` attachment, held until its
/// `hook_additional_context` sibling arrives (or the window/EOF closes it).
#[derive(Debug, Clone)]
struct PendingSuccess {
    hook_name: String,
    hook_event: String,
    tool_use_id: Option<String>,
    exit_code: i32,
    duration_ms: u64,
    command_display: Option<String>,
    command_raw: Option<String>,
    stdout_raw: Option<String>,
    stderr_raw: Option<String>,
    stdout_json: Option<serde_json::Value>,
    hook_specific_output: Option<serde_json::Value>,
    timestamp: DateTime<Utc>,
}

impl PendingSuccess {
    /// Finish this hook trigger, folding in whatever additional context was
    /// paired with it (empty for the orphan case).
    fn into_event(self, additional_context: Vec<String>) -> HookLifecycleEvent {
        let (outcome, outcome_reason) = classify_outcome(
            self.stdout_json.as_ref(),
            self.exit_code,
            self.stderr_raw.as_deref().unwrap_or(""),
            !additional_context.is_empty(),
        );
        HookLifecycleEvent {
            hook_name: self.hook_name,
            hook_event: self.hook_event,
            tool_use_id: self.tool_use_id,
            outcome,
            outcome_reason,
            exit_code: self.exit_code,
            duration_ms: self.duration_ms,
            command_display: self.command_display,
            additional_context,
            hook_specific_output: self.hook_specific_output,
            command_raw: self.command_raw,
            stdout_raw: self.stdout_raw,
            stderr_raw: self.stderr_raw,
            timestamp: self.timestamp,
        }
    }
}

/// Extract the `content` of a `hook_additional_context` attachment. The field
/// is an array of strings in the sampled wire, but tolerate a bare string.
fn additional_context_entries(attachment: &serde_json::Value) -> Vec<String> {
    let entry = |s: &str| {
        let trimmed = s.trim();
        (!trimmed.is_empty()).then(|| truncate_with_ellipsis(trimmed, ADDITIONAL_CONTEXT_MAX_CHARS))
    };
    match attachment.get("content") {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|i| i.as_str())
            .filter_map(entry)
            .collect(),
        Some(serde_json::Value::String(s)) => entry(s).into_iter().collect(),
        _ => Vec::new(),
    }
}

/// Stateful aggregator: fed each classified hook attachment in file order,
/// pairs `hook_success` with its `hook_additional_context` sibling by
/// `toolUseID` within `HOOK_PAIRING_WINDOW_MS`, and flushes merged
/// `HookLifecycleEvent`s. Orphans flush alone at EOF (decision-card §1.3).
///
/// The buffer is bidirectional: the sampled siblings are 2ms apart and nothing
/// guarantees filesystem write order, so a `hook_additional_context` arriving
/// FIRST is held too and joined when its `hook_success` shows up.
#[derive(Debug, Default)]
pub(crate) struct HookAggregator {
    /// Unpaired `hook_success`, in arrival order (order preserved so EOF flush
    /// emits them as they appeared in the file).
    pending_success: Vec<(PairKey, PendingSuccess)>,
    /// `hook_additional_context` seen before its `hook_success` sibling.
    pending_context: Vec<(PairKey, DateTime<Utc>, Vec<String>)>,
    /// `uuid`s already ingested — a repeated record (crash-recovery replay) is
    /// ignored rather than double-counted.
    seen_uuids: std::collections::HashSet<String>,
}

impl HookAggregator {
    /// Feed one `type:"attachment"` JSONL record (the whole record `Value`).
    /// Returns a merged event if this record completed a pair, else `None`
    /// (buffered, deduped by `uuid`, or an unknown type that was skipped).
    pub(crate) fn ingest(&mut self, record: &serde_json::Value) -> Option<HookLifecycleEvent> {
        let attachment = record.get("attachment")?;
        let attachment_type = attachment
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("");

        // Dedupe on the JSONL record primary key before doing any work.
        if let Some(uuid) = record.get("uuid").and_then(|u| u.as_str()) {
            if !uuid.is_empty() && !self.seen_uuids.insert(uuid.to_string()) {
                return None;
            }
        }

        let timestamp = record
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.with_timezone(&Utc))
            .unwrap_or_else(Utc::now);
        let key = pair_key(record, attachment);

        match classify_attachment(attachment_type) {
            AttachmentKind::HookSuccess => {
                let str_field = |k: &str| {
                    attachment
                        .get(k)
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                };
                let stdout_raw = str_field("stdout");
                let stdout_json = stdout_raw
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
                let command_raw = str_field("command");
                let pending = PendingSuccess {
                    hook_name: str_field("hookName").unwrap_or_default(),
                    hook_event: str_field("hookEvent").unwrap_or_default(),
                    tool_use_id: str_field("toolUseID"),
                    exit_code: attachment
                        .get("exitCode")
                        .and_then(|c| c.as_i64())
                        .unwrap_or(0) as i32,
                    duration_ms: attachment
                        .get("durationMs")
                        .and_then(|d| d.as_u64())
                        .unwrap_or(0),
                    command_display: command_raw.as_deref().and_then(command_display_from_raw),
                    command_raw,
                    stdout_raw,
                    stderr_raw: str_field("stderr"),
                    hook_specific_output: stdout_json
                        .as_ref()
                        .and_then(|j| j.get("hookSpecificOutput").cloned()),
                    stdout_json,
                    timestamp,
                };

                // An out-of-order sibling may already be waiting for this key.
                if let Some(idx) = self
                    .pending_context
                    .iter()
                    .position(|(k, ts, _)| *k == key && within_window(*ts, timestamp))
                {
                    let (_, _, context) = self.pending_context.remove(idx);
                    return Some(pending.into_event(context));
                }
                self.pending_success.push((key, pending));
                None
            }
            AttachmentKind::HookAdditionalContext => {
                let context = additional_context_entries(attachment);
                if let Some(idx) = self
                    .pending_success
                    .iter()
                    .position(|(k, p)| *k == key && within_window(p.timestamp, timestamp))
                {
                    let (_, pending) = self.pending_success.remove(idx);
                    return Some(pending.into_event(context));
                }
                // No success seen yet — hold it for the reverse-order case.
                self.pending_context.push((key, timestamp, context));
                None
            }
            AttachmentKind::Unknown => {
                // A4 single contract: log once, emit nothing, keep parsing.
                tracing::debug!(
                    "[claude-hook] skipping unrecognized attachment.type={:?}",
                    attachment_type
                );
                None
            }
        }
    }

    /// Flush every still-pending unpaired `hook_success` as a lone event at
    /// end of the JSONL stream. A `hook_additional_context` that never found
    /// its `hook_success` carries no execution facts of its own, so it is
    /// dropped rather than rendered as a card with no hook behind it.
    pub(crate) fn flush(&mut self) -> Vec<HookLifecycleEvent> {
        self.pending_context.clear();
        self.pending_success
            .drain(..)
            .map(|(_, pending)| pending.into_event(Vec::new()))
            .collect()
    }
}

/// Whether two sibling records fall inside the pairing window.
fn within_window(first: DateTime<Utc>, second: DateTime<Utc>) -> bool {
    (second - first).num_milliseconds().abs() <= HOOK_PAIRING_WINDOW_MS
}

/// Drive a full slice of attachment records through a fresh aggregator and
/// return the events in stream order (buffered pairs first, then the EOF
/// flush). Test-only: production feeds records one at a time through
/// [`HookAggregator::ingest`] from the parser's dispatch loop.
#[cfg(test)]
pub(crate) fn aggregate_hook_events(records: &[serde_json::Value]) -> Vec<HookLifecycleEvent> {
    let mut aggregator = HookAggregator::default();
    let mut events: Vec<HookLifecycleEvent> = records
        .iter()
        .filter_map(|record| aggregator.ingest(record))
        .collect();
    events.extend(aggregator.flush());
    events
}
