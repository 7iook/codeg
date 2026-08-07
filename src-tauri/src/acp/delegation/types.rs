//! Broker-facing request / outcome types.
//!
//! These cross two boundaries:
//! 1. The MCP companion serializes `DelegationRequest` → JSON-RPC params and
//!    deserializes `DelegationOutcome` → MCP `tool_result`.
//! 2. The broker emits a structured outcome the listener can persist and
//!    forward to the parent's tool_use_id.
//!
//! DB ids are `i32` to match the actual `conversation.id` / `conversation.parent_id`
//! column types — keeping them strongly typed here saves us a parse-or-die step
//! at every DB boundary.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::models::AgentType;

/// Per-agent defaults applied when codeg-mcp spawns a subagent on behalf of a
/// `delegate_to_agent` call. Mirrors the two knobs `ConnectionManager::spawn_agent`
/// already accepts:
///   * `mode_id` → forwarded as `preferred_mode_id`
///   * `config_values` → forwarded as `preferred_config_values`
///
/// All fields are optional / may be empty; an absent entry means "no override —
/// use whatever the agent advertises as the default."
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentDelegationDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub config_values: BTreeMap<String, String>,
}

impl AgentDelegationDefaults {
    pub fn is_empty(&self) -> bool {
        self.mode_id.is_none() && self.config_values.is_empty()
    }
}

/// Everything the broker needs to dispatch a single delegation call.
///
/// `parent_connection_id` is the codeg-internal ACP connection UUID for the
/// parent session (NOT the agent-assigned ACP session id). The broker uses it
/// to inherit the parent's EventEmitter/working_dir and to scope
/// `cancel_by_parent`.
///
/// `external_handle` is a companion-minted opaque token (per MCP `tools/call`)
/// that the broker stores alongside the pending entry so an MCP-side
/// `notifications/cancelled` can target this specific delegation without the
/// companion having to know the broker-internal `call_id`. `None` for non-MCP
/// callers and tests that don't exercise the cancel path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegationRequest {
    pub parent_connection_id: String,
    pub parent_conversation_id: i32,
    pub parent_tool_use_id: String,
    pub agent_type: AgentType,
    pub task: String,
    pub working_dir: Option<String>,
    /// The `working_dir` exactly as the LLM passed it in the
    /// `delegate_to_agent` arguments, BEFORE the listener defaults a missing
    /// value to the parent's launch directory. Used only as part of the
    /// `(agent_type, task, requested_working_dir)` correlation key so two
    /// parallel calls sharing an agent and task but targeting different
    /// explicit directories don't bind to each other's `tool_call_id`.
    /// `None` when the LLM omitted it — symmetric with the ACP `raw_input`,
    /// which also omits it then. Distinct from `working_dir` above, which is
    /// the defaulted value the child is actually spawned in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_working_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_handle: Option<String>,
    /// Optional persona / sub-agent name nominated by the LLM's
    /// `delegate_to_agent` call. Grammar: 1-64 chars of `[A-Za-z0-9_-]`
    /// (see [`super::persona::is_valid_persona_name`]); the broker
    /// enforces it BEFORE any filesystem access.
    ///
    /// Semantic strength varies by `agent_type`:
    /// - `Kiro` → REAL persona, translated to `--agent <name>` argv.
    /// - `ClaudeCode` / `Codex` → BEST-EFFORT hint, body of
    ///   `<HOME>/.claude/agents/<name>.md` (or `.codex`) prepended to the
    ///   first turn; frontmatter high-order fields don't take effect.
    /// - Any other agent_type → Ignored; a `[note]` rides
    ///   `DelegationSuccess.text`; delegation still succeeds.
    ///
    /// # Naming trap — NOT the same `subagent_type` other parsers use
    ///
    /// Several CLI adapters
    /// (`parsers::codebuddy` / `parsers::cursor` / `parsers::opencode` /
    /// `parsers::kimi_code`) have their own `subagent_type` concept for
    /// parsing INBOUND tool_use metadata — an entirely different flow
    /// (they read what a running agent emitted, this field records what
    /// the parent asked for). Do NOT wire this field into those parsers
    /// or vice versa; the wire shape happens to match, the semantics do
    /// not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_type: Option<String>,
    /// Optional per-call model id nominated by the LLM's `delegate_to_agent`
    /// call. `None` = inherit whatever the user configured for that agent
    /// (the settings panel's global knob), which is the only mechanism that
    /// existed before this field.
    ///
    /// # WIRE-ONLY at this stage: normalized and carried, NOT yet applied
    ///
    /// Nothing consumes this field yet. The listener normalizes it and the
    /// request carries it, but no spawn path reads it, so nominating an id
    /// does NOT change which model the child runs on -- the child still
    /// starts on the model configured for that agent. A later launch stage
    /// wires it into the spawned child process.
    ///
    /// What survives verbatim is the id itself; what is normalized is only
    /// its framing (trim / blank / control characters -- see below).
    ///
    /// TODO(delegation-model-launch): when that launch stage lands, update
    /// BOTH user-visible contracts in the SAME change: this doc comment and
    /// the `model` property description in
    /// `src-tauri/src/acp/delegation/tool_schema.json`, which currently
    /// tells the host LLM the value is not yet in effect. Leaving either one
    /// stale re-creates the same silent-downgrade failure that description
    /// warns about, just in the opposite direction.
    ///
    /// Deliberately NOT validated against any list of known model names: the
    /// id is served by the *user's own* endpoint, which may be a relay in
    /// front of any vendor, so an id this build has never heard of is a
    /// legitimate value. The listener only normalizes it — trim, blank ⇒
    /// `None` — and rejects ids containing control characters as paste
    /// contamination (see [`super::listener::normalize_requested_model`] for
    /// why that is a hygiene rule and not a transport limit).
    ///
    /// # Not the same axis as `subagent_type`
    ///
    /// `subagent_type` picks a *persona* inside the target CLI (its system
    /// prompt / tools / permissions); `model` picks the *LLM* that persona
    /// runs on. They are independent: a call may set either, both, or
    /// neither. Note the two can collide on one CLI family — a Kiro persona
    /// definition can itself pin a model, and for `claude_code` / `codex`
    /// personas the frontmatter `model` field is dropped on the Hint leg
    /// anyway (see `subagent_type` above), which is part of why a per-call
    /// `model` is useful there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegationSuccess {
    pub text: String,
    pub child_conversation_id: i32,
    pub child_agent_type: AgentType,
    pub turn_count: u32,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<TokenUsage>,
    /// What the broker actually applied for this delegation, if the LLM
    /// nominated a persona via `subagent_type`. Only populated once the
    /// spawn (and, for `Hint` effects, the first-turn send) actually
    /// succeeded — a failed spawn leaves this `None` and the failure
    /// rides `DelegationOutcome::Err.code == "invalid_persona"` instead
    /// (R3 F2 rejects a symmetric `AppliedPersona::Failed` variant).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_persona: Option<super::persona::AppliedPersona>,
}

/// Broker-internal failure modes. Serialized via the wrapping
/// [`DelegationOutcome::Err`] variant — the broker maps each into a stable
/// `code` string so the frontend / MCP consumer can pattern-match without
/// caring about the inner shape.
#[derive(Debug, Clone, thiserror::Error, Serialize, Deserialize)]
#[serde(tag = "code", content = "detail", rename_all = "snake_case")]
pub enum DelegationError {
    #[error("depth limit exceeded ({current_depth} >= {limit})")]
    DepthLimitExceeded { current_depth: u32, limit: u32 },
    #[error("invalid agent type")]
    InvalidAgentType,
    #[error("invalid working dir: {0}")]
    InvalidWorkingDir(String),
    #[error("spawn failed: {0}")]
    SpawnFailed(String),
    /// The LLM nominated `subagent_type` but the broker could not honor
    /// it — name grammar failed, the persona file was missing, malformed,
    /// or oversize, or a path-safety check tripped. Detail carries the
    /// user-visible reason (see [`super::persona::PersonaError::Display`]).
    /// Wire code is [`INVALID_PERSONA_WIRE_CODE`].
    #[error("invalid persona: {0}")]
    InvalidPersona(String),
    /// The LLM nominated a per-call `model` carrying a control character
    /// (newline, tab, NUL, ...). Detail carries the user-visible reason. Wire
    /// code is [`INVALID_MODEL_WIRE_CODE`].
    ///
    /// Rejected as input hygiene, NOT because of a transport limit: control
    /// characters other than NUL do survive a process env-var value intact
    /// (verified by controlled experiment — see
    /// [`super::listener::normalize_requested_model`]). Such an id is almost
    /// always paste contamination, and failing loudly at the argument boundary
    /// beats an opaque error from the user's endpoint — or a silent fall back
    /// to its default model reported as a success on the requested one. NUL is
    /// the one value that genuinely cannot be represented at all.
    ///
    /// This is the ONLY model input class that fails: an unrecognized-but-
    /// well-formed id is passed through verbatim on purpose (the user's own
    /// endpoint decides what it serves), and a blank id degrades to "inherit
    /// the configured default".
    #[error("invalid model: {0}")]
    InvalidModel(String),
    #[error("subagent runtime error: {0}")]
    SubagentRuntimeError(String),
    /// Child agent ended its turn via `refusal`. Often a backend / gateway
    /// error masquerading as a refusal per the ACP spec gap.
    #[error("subagent refused to continue")]
    ChildRefusal,
    #[error("subagent reached max token budget")]
    ChildMaxTokens,
    #[error("subagent reached max turn request budget")]
    ChildMaxTurnRequests,
    /// Child reported `end_turn` without producing any output (synthesized
    /// as `empty` by the connection loop's "silent EndTurn" guard).
    #[error("subagent produced no output")]
    ChildEmpty,
    #[error("subagent ended with unrecognized stop reason: {0}")]
    ChildUnknown(String),
    #[error("canceled: {reason}")]
    Canceled { reason: String },
    #[error("parent session is gone")]
    ParentSessionGone,
    /// `continue_with_session` targeted a task whose current turn is still
    /// running (Requirement 2.4).
    #[error("subagent session is still running; wait for it or cancel first")]
    SessionStillRunning,
    /// The session was RELEASED by `close_session` / parent-conversation
    /// deletion (R2-B4 release semantics — not a permanent close; a process
    /// restart naturally expires the lease). Upstream PR #375 calls this
    /// `session_closed`; see [`canonical_continuation_code`].
    #[error("subagent session was released; start a new delegation for further work")]
    SessionReleased,
    /// The task exists but cannot be continued: empty message, missing
    /// resume credential after process death, binding mismatch, etc.
    /// (Requirements 3.2, 7.6).
    #[error("subagent session cannot be continued: {0}")]
    NotContinuable(String),
    /// The resume chain cannot restore the prior context. Returned BEFORE any
    /// prompt side effect — never silently degraded to a context-losing
    /// `session/new` (Requirements 3.3, 7.7).
    #[error("resume unavailable: {0}")]
    ResumeUnavailable(String),
    /// The same `continuation_id` was reused with a different payload
    /// (Requirement 2.13 — idempotency keys bind to one exact request).
    #[error("continuation_id was already used with a different payload")]
    ContinuationConflict,
    /// Retryable startup state: the broker is still rebuilding its session
    /// index (Requirement 7.2) — answering `Unknown` would read as "your
    /// session is lost", so this distinct code tells callers to retry.
    #[error("the broker is rebuilding its session index after startup; retry shortly")]
    Rebuilding,
}

/// Wire-stable `DelegationOutcome::Err.code` for [`DelegationError::InvalidPersona`].
///
/// Single source of truth: every producer of this code — [`DelegationOutcome::from_err`],
/// the persona providers' `PersonaEffect::Failed { wire_code, .. }`, and any listener
/// fast-path that reports the failure before a typed error exists — MUST reference this
/// constant rather than re-spelling the literal. The string ships to LLM context and to
/// the frontend, so a drifted second spelling is a silent contract break that no compiler
/// error catches.
pub const INVALID_PERSONA_WIRE_CODE: &str = "invalid_persona";

/// Wire-stable `DelegationOutcome::Err.code` for [`DelegationError::InvalidModel`].
///
/// Same single-source rule as [`INVALID_PERSONA_WIRE_CODE`]: the listener's
/// pre-typed rejection path and [`DelegationOutcome::from_err`] must both read
/// this constant, so renaming or extending the code is a one-line change.
pub const INVALID_MODEL_WIRE_CODE: &str = "invalid_model";

/// Historical alias accepted on the facade (R2-B4): upstream PR #375 named the
/// released state `session_closed`; this build reports `session_released`.
/// Anything comparing / routing on continuation error codes should normalize
/// through [`canonical_continuation_code`] instead of matching the alias.
pub const SESSION_CLOSED_LEGACY_ALIAS: &str = "session_closed";

/// Map a wire error code to its canonical form: the upstream `session_closed`
/// alias folds into `session_released`; every other code passes through.
pub fn canonical_continuation_code(code: &str) -> &str {
    if code == SESSION_CLOSED_LEGACY_ALIAS {
        "session_released"
    } else {
        code
    }
}

/// The single value the broker hands back to the listener / MCP companion.
/// `child_conversation_id` on the `Err` arm is best-effort — it's `Some` once
/// the broker successfully created the child DB row, even if the run later
/// fails or times out.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DelegationOutcome {
    Ok(DelegationSuccess),
    Err {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        child_conversation_id: Option<i32>,
    },
}

/// Lifecycle status of an asynchronous delegation task. Surfaced by the
/// three delegation tools — `delegate_to_agent` (returns a `Running` ack, or
/// a terminal status when the child finished during setup / setup failed),
/// `get_delegation_status`, and `cancel_delegation`. Wire-stable snake_case
/// strings: they ship to LLM context and to the frontend, so don't rename.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Child is running in the background; no terminal result yet.
    Running,
    /// Child ended its turn cleanly; `text` carries the result (possibly
    /// truncated — open the child session for the full output).
    Completed,
    /// Child ended in a non-cancel failure; `error_code` / `message` describe it.
    Failed,
    /// Task was canceled (by `cancel_delegation`, parent teardown, or a
    /// non-`end_turn` parent turn end).
    Canceled,
    /// Task id is not known to this parent — never existed, belonged to a
    /// different parent, or its result was evicted from the cache and no DB
    /// row backs it.
    Unknown,
}

/// Unified response the broker hands the listener for every delegation tool
/// (`delegate_to_agent` / `get_delegation_status` / `cancel_delegation`). The
/// listener serializes it into `BrokerResponse.outcome`; the companion renders
/// it into the MCP `CallToolResult` (with `structuredContent` carrying this
/// whole shape so the frontend can read `status` and distinguish a running ack
/// from a terminal outcome).
///
/// Fields are all optional except `status` so one type can describe a running
/// ack (ids + `Running`), a completed result (`text` + `duration_ms`), a
/// failure (`error_code` + `message`), and a setup failure (`task_id: None`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegationTaskReport {
    /// Broker `call_id` (UUID) identifying the task. `None` only when setup
    /// failed before a task was registered (no id to track).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_conversation_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<AgentType>,
    /// Completed result text (capped; open the child session for the full
    /// output). Only set for `Completed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Wire-stable error code for `Failed` / `Canceled` (mirrors
    /// `DelegationOutcome::Err.code`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    /// Human-readable note: the failure message, or a hint like
    /// "running in background" / "result not cached; open child session N".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// What the broker actually applied for this delegation, mirrored
    /// from [`DelegationSuccess::applied_persona`] onto the status /
    /// terminal report so `get_delegation_status` also carries it. Same
    /// invariants: only populated on success (spawn + first-turn send),
    /// `None` on failure / cancel / setup-failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_persona: Option<super::persona::AppliedPersona>,
}

impl DelegationTaskReport {
    /// Attach a known `task_id` onto a setup-style error report that was built
    /// without one (e.g. continue/close failures after the id is already
    /// known). Never clobbers an id the report already carries.
    pub fn with_task_id(mut self, task_id: &str) -> Self {
        if self.task_id.is_none() {
            self.task_id = Some(task_id.to_string());
        }
        self
    }
}

impl DelegationOutcome {
    /// Project a `DelegationError` onto the wire-stable `code` string used by
    /// the frontend and MCP companion. Keep these strings stable — they ship
    /// to LLM context.
    pub fn from_err(err: DelegationError, child_conversation_id: Option<i32>) -> Self {
        let code = match &err {
            DelegationError::DepthLimitExceeded { .. } => "depth_limit",
            DelegationError::InvalidAgentType => "invalid_agent_type",
            DelegationError::InvalidWorkingDir(_) => "invalid_working_dir",
            DelegationError::SpawnFailed(_) => "spawn_failed",
            DelegationError::InvalidPersona(_) => INVALID_PERSONA_WIRE_CODE,
            DelegationError::InvalidModel(_) => INVALID_MODEL_WIRE_CODE,
            DelegationError::SubagentRuntimeError(_) => "subagent_error",
            DelegationError::ChildRefusal => "child_refusal",
            DelegationError::ChildMaxTokens => "child_max_tokens",
            DelegationError::ChildMaxTurnRequests => "child_max_turn_requests",
            DelegationError::ChildEmpty => "child_empty",
            DelegationError::ChildUnknown(_) => "child_unknown",
            DelegationError::Canceled { .. } => "canceled",
            DelegationError::ParentSessionGone => "canceled",
            DelegationError::SessionStillRunning => "session_still_running",
            DelegationError::SessionReleased => "session_released",
            DelegationError::NotContinuable(_) => "not_continuable",
            DelegationError::ResumeUnavailable(_) => "resume_unavailable",
            DelegationError::ContinuationConflict => "continuation_conflict",
            DelegationError::Rebuilding => "rebuilding",
        };
        DelegationOutcome::Err {
            code: code.to_string(),
            message: err.to_string(),
            child_conversation_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// T4.1 red: the five continuation error codes (plus `rebuilding`) must be
    /// typed `DelegationError` variants with wire-stable `from_err` codes —
    /// not broker-local string constants.
    #[test]
    fn from_err_maps_continuation_variants_to_wire_codes() {
        let cases: Vec<(DelegationError, &str)> = vec![
            (
                DelegationError::SessionStillRunning,
                "session_still_running",
            ),
            (DelegationError::SessionReleased, "session_released"),
            (
                DelegationError::NotContinuable("x".into()),
                "not_continuable",
            ),
            (
                DelegationError::ResumeUnavailable("y".into()),
                "resume_unavailable",
            ),
            (
                DelegationError::ContinuationConflict,
                "continuation_conflict",
            ),
            (DelegationError::Rebuilding, "rebuilding"),
        ];
        for (err, want) in cases {
            match DelegationOutcome::from_err(err, None) {
                DelegationOutcome::Err { code, .. } => assert_eq!(code, want),
                other => panic!("expected Err outcome, got {other:?}"),
            }
        }
    }

    /// The two persona/model wire codes have exactly ONE source: the
    /// constants. `from_err` must project onto them, and their literal
    /// values are frozen — they ship to LLM context and to the frontend,
    /// so renaming one silently breaks consumers that pattern-match.
    #[test]
    fn persona_and_model_wire_codes_come_from_the_constants() {
        assert_eq!(INVALID_PERSONA_WIRE_CODE, "invalid_persona");
        assert_eq!(INVALID_MODEL_WIRE_CODE, "invalid_model");

        let cases: Vec<(DelegationError, &str)> = vec![
            (
                DelegationError::InvalidPersona("bad name".into()),
                INVALID_PERSONA_WIRE_CODE,
            ),
            (
                DelegationError::InvalidModel("control char".into()),
                INVALID_MODEL_WIRE_CODE,
            ),
        ];
        for (err, want) in cases {
            match DelegationOutcome::from_err(err, None) {
                DelegationOutcome::Err { code, .. } => assert_eq!(code, want),
                other => panic!("expected Err outcome, got {other:?}"),
            }
        }
    }

    /// R2-B4: the facade accepts upstream PR #375's `session_closed` as a
    /// historical alias for `session_released`; every other code is passed
    /// through canonical unchanged.
    #[test]
    fn session_closed_is_accepted_as_alias_for_session_released() {
        assert_eq!(
            canonical_continuation_code("session_closed"),
            "session_released"
        );
        assert_eq!(
            canonical_continuation_code("session_released"),
            "session_released"
        );
        assert_eq!(
            canonical_continuation_code("not_continuable"),
            "not_continuable"
        );
    }

    /// `with_task_id` attaches a known id onto a setup-style report built
    /// without one, and never clobbers an existing id.
    #[test]
    fn with_task_id_fills_only_missing_ids() {
        let report = DelegationTaskReport {
            task_id: None,
            status: TaskStatus::Failed,
            child_conversation_id: None,
            agent_type: None,
            text: None,
            error_code: Some("not_continuable".into()),
            message: None,
            duration_ms: None,
            applied_persona: None,
        };
        let filled = report.with_task_id("t-1");
        assert_eq!(filled.task_id.as_deref(), Some("t-1"));
        let kept = filled.with_task_id("t-2");
        assert_eq!(kept.task_id.as_deref(), Some("t-1"));
    }

    /// The detail payloads ride the Display string so per-site context
    /// survives the typed funnel (broker call sites embed the reason).
    #[test]
    fn detail_variants_carry_reason_in_message() {
        let out = DelegationOutcome::from_err(
            DelegationError::NotContinuable("message is empty".into()),
            None,
        );
        match out {
            DelegationOutcome::Err { message, .. } => {
                assert!(message.contains("message is empty"), "got: {message}");
            }
            other => panic!("expected Err outcome, got {other:?}"),
        }
    }
}
