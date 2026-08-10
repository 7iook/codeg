//! Wire-level tests for the listener's per-call `model` parse.
//!
//! `delegate_to_agent` accepts an optional `model` so the calling LLM can pick
//! which model a delegated sub-agent runs on, per call — instead of the global
//! panel setting that changes every delegation at once.
//!
//! These drive a REAL length-prefixed `BrokerMessage::Call` frame through
//! `serve_one` (the exact path the `codeg-mcp` companion uses) and observe the
//! listener's verdict on the far side: either a `Failed` report carrying the
//! `invalid_model` wire code and NO spawn, or a normal delegation that reaches
//! the spawner.
//!
//! The normalization contract is deliberately permissive — an arbitrary
//! non-Anthropic id must pass through verbatim, because the whole point is that
//! the user's own endpoint (possibly a relay) decides what it serves. The ONE
//! input class that fails loudly is an id carrying a control character, which
//! is rejected as paste contamination rather than forwarded (see
//! `normalize_requested_model` for why that is a hygiene rule, not a transport
//! limit — control characters other than NUL do cross a process env-var value
//! intact). Everything else — including ids this build has never heard of — is
//! kept as-is.
//!
//! `wire_accepted_model_reaches_the_broker_request` observes the outbound
//! `DelegationRequest` directly, which is what proves the normalized value
//! actually propagates: the report and the spawn look identical whether the
//! listener carries `model` or drops it.
//!
//! `AgentType::Kiro` is used throughout to match the sibling
//! `listener_subagent_type_wire.rs` harness: its persona path needs no
//! filesystem, so a spawn here has no environment dependencies.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

use codeg_lib::acp::delegation::broker::{
    ConversationDepthLookup, DelegationBroker, DelegationConfig,
};
use codeg_lib::acp::delegation::listener::{
    normalize_requested_model, DelegationListener, ParentSessionLookup, TokenEntry, TokenRegistry,
};
use codeg_lib::acp::delegation::spawner::{mock::MockSpawner, ConnectionSpawner};
use codeg_lib::acp::delegation::transport::{
    read_frame, write_frame, BrokerMessage, BrokerRequest, BrokerResponse,
};
use codeg_lib::acp::delegation::types::{
    DelegationError, DelegationRequest, DelegationTaskReport, TaskStatus,
};
use codeg_lib::acp::feedback::{PendingFeedback, SessionFeedbackAccess};
use codeg_lib::acp::question::{QuestionSpec, RegisteredQuestion, SessionQuestionAccess};
use codeg_lib::acp::session_info::{SessionInfo, SessionInfoAccess};
use codeg_lib::acp::work_task_tools::{TaskReportAck, WorkTaskToolAccess};

// ── Minimal stubs for the listener's non-delegation collaborators ────────────

struct RootDepth;
#[async_trait]
impl ConversationDepthLookup for RootDepth {
    async fn parent_of(&self, _conversation_id: i32) -> Result<Option<i32>, DelegationError> {
        Ok(None)
    }
}

struct StaticParent;
#[async_trait]
impl ParentSessionLookup for StaticParent {
    async fn current_conversation_id(&self, _parent_connection_id: &str) -> Option<i32> {
        Some(1)
    }
}

struct NoFeedback;
#[async_trait]
impl SessionFeedbackAccess for NoFeedback {
    async fn read_pending_feedback(&self, _parent: &str) -> Vec<PendingFeedback> {
        Vec::new()
    }
    async fn commit_feedback_delivered(&self, _parent: &str, _ids: Vec<String>) {}
}

struct NoQuestions;
#[async_trait]
impl SessionQuestionAccess for NoQuestions {
    async fn register_question(
        &self,
        _parent: &str,
        _questions: Vec<QuestionSpec>,
    ) -> Option<RegisteredQuestion> {
        None
    }
    async fn cancel_question(&self, _parent: &str, _question_id: &str) {}
    async fn cancel_questions_by_parent(&self, _parent: &str) {}
}

struct NoSessionInfo;
#[async_trait]
impl SessionInfoAccess for NoSessionInfo {
    async fn resolve(&self, session_id: i32, _max_messages: u32) -> SessionInfo {
        SessionInfo::not_found(session_id)
    }
}

struct NoTaskTools;
#[async_trait]
impl WorkTaskToolAccess for NoTaskTools {
    async fn report_progress(&self, _parent: &str, _message: &str) -> TaskReportAck {
        TaskReportAck::rejected("no task engine in this process")
    }
    async fn complete(
        &self,
        _parent: &str,
        _verdict: &str,
        _summary: Option<&str>,
    ) -> TaskReportAck {
        TaskReportAck::rejected("no task engine in this process")
    }
}

/// Chat-authoring stub: this test only drives `delegate_to_agent`'s wire shape,
/// never the authoring arms.
struct NoAuthoring;
#[async_trait]
impl codeg_lib::acp::chat_authoring::ChatAuthoringAccess for NoAuthoring {
    async fn create_automation(
        &self,
        _ctx: codeg_lib::acp::chat_authoring::AuthoringContext,
        _spec: codeg_lib::acp::chat_authoring::NewAutomationSpec,
    ) -> codeg_lib::acp::chat_authoring::AuthoringOutcome {
        codeg_lib::acp::chat_authoring::AuthoringOutcome::rejected("automation", "no authoring")
    }
    async fn create_work_task(
        &self,
        _ctx: codeg_lib::acp::chat_authoring::AuthoringContext,
        _spec: codeg_lib::acp::chat_authoring::NewWorkTaskSpec,
    ) -> codeg_lib::acp::chat_authoring::AuthoringOutcome {
        codeg_lib::acp::chat_authoring::AuthoringOutcome::rejected("work_task", "no authoring")
    }
}

// ── Harness ─────────────────────────────────────────────────────────────────

/// What one `delegate_to_agent` wire call produced: the listener's report,
/// whether the broker got as far as `ConnectionSpawner::spawn`, and the
/// `DelegationRequest` the listener actually handed to the broker.
struct WireVerdict {
    report: DelegationTaskReport,
    spawned: bool,
    /// The outbound request, or `None` if the call was rejected before the
    /// broker was invoked at all. `request.model` is what proves the normalized
    /// value PROPAGATES — the report and the spawn both look identical whether
    /// the field is carried or dropped.
    request: Option<DelegationRequest>,
}

/// Send one `BrokerMessage::Call` whose `arguments` JSON is exactly `input`
/// through a real framed socket and report what came back.
async fn call_wire(input: serde_json::Value) -> WireVerdict {
    let mock = Arc::new(MockSpawner::new());
    mock.queue_spawn(Ok("child-conn".into())).await;
    mock.queue_send(Ok(42)).await;

    let broker = Arc::new(DelegationBroker::new(
        mock.clone() as Arc<dyn ConnectionSpawner>,
        Arc::new(RootDepth) as Arc<dyn ConversationDepthLookup>,
    ));
    broker
        .set_config(DelegationConfig {
            enabled: true,
            ..DelegationConfig::default()
        })
        .await;

    let tokens = Arc::new(TokenRegistry::default());
    tokens
        .register(
            "tok".into(),
            TokenEntry {
                parent_connection_id: "parent-conn".into(),
                working_dir: PathBuf::from("/tmp"),
            },
        )
        .await;

    let listener = DelegationListener::new(
        broker.clone(),
        tokens,
        Arc::new(StaticParent),
        Arc::new(NoFeedback),
        Arc::new(NoQuestions),
        Arc::new(NoSessionInfo),
        Arc::new(NoTaskTools),
        Arc::new(NoAuthoring),
    );

    let (mut client, mut server) = tokio::io::duplex(16 * 1024);
    let server_task = tokio::spawn(async move { listener.serve_one(&mut server).await });

    let msg = BrokerMessage::Call(BrokerRequest {
        token: "tok".into(),
        parent_connection_id: "parent-conn".into(),
        parent_tool_use_id: "pt-1".into(),
        external_handle: None,
        correlation_nonce: None,
        input,
    });
    write_frame(&mut client, &msg).await.expect("write frame");
    let resp: BrokerResponse = read_frame(&mut client).await.expect("read frame");
    server_task.await.expect("join").expect("serve_one");

    let report: DelegationTaskReport =
        serde_json::from_value(resp.outcome).expect("outcome decodes as a task report");
    let spawned = !mock.spawn_args.lock().await.is_empty();
    let request = broker.received_requests().await.into_iter().next();
    WireVerdict {
        report,
        spawned,
        request,
    }
}

/// Build the `arguments` JSON a `delegate_to_agent` call carries, optionally
/// with a `model` of an arbitrary JSON shape.
fn call_input(model: Option<serde_json::Value>) -> serde_json::Value {
    let mut input = serde_json::json!({
        "agent_type": "kiro",
        "task": "do x",
    });
    if let Some(v) = model {
        input["model"] = v;
    }
    input
}

// ── The one input class that must fail loudly ───────────────────────────────

/// A model id carrying a newline is paste contamination, not a model choice, so
/// it is REJECTED at the argument boundary with a specific reason. (It would in
/// fact reach the child intact — the rejection is hygiene, not a transport
/// limit — but forwarding it buys either an opaque endpoint error or a silent
/// fall back to the endpoint's default model reported as success on the
/// requested one.)
#[tokio::test]
async fn wire_model_with_newline_is_rejected_as_paste_contamination() {
    let verdict = call_wire(call_input(Some(serde_json::json!(
        "claude-sonnet-5\nrm -rf /"
    ))))
    .await;
    assert_eq!(verdict.report.status, TaskStatus::Failed);
    assert_eq!(verdict.report.error_code.as_deref(), Some("invalid_model"));
    assert!(
        !verdict.spawned,
        "a rejected model must abort BEFORE any child is spawned"
    );
}

/// NUL is the one value that genuinely cannot be represented in a process
/// env-var / argv value at all: carrying it would fail at spawn time with a
/// generic "embedded null character". Rejecting it here turns that late,
/// opaque failure into a specific one naming the argument.
#[tokio::test]
async fn wire_model_with_nul_is_rejected() {
    let verdict = call_wire(call_input(Some(serde_json::json!("gpt-5.6\0sol")))).await;
    assert_eq!(verdict.report.status, TaskStatus::Failed);
    assert_eq!(verdict.report.error_code.as_deref(), Some("invalid_model"));
    assert!(!verdict.spawned);
}

/// The rejection message must name the offending value's problem, so the LLM
/// can correct it instead of retrying the same thing.
#[tokio::test]
async fn wire_rejected_model_explains_itself() {
    let verdict = call_wire(call_input(Some(serde_json::json!("a\rb")))).await;
    let message = verdict.report.message.unwrap_or_default();
    assert!(
        message.contains("model"),
        "rejection message must mention the model argument, got: {message}"
    );
}

// ── Everything else proceeds normally ───────────────────────────────────────

/// An arbitrary id this build has never heard of — the whole point of the
/// feature — must NOT be rejected. Delegation proceeds to spawn.
#[tokio::test]
async fn wire_arbitrary_model_id_is_accepted() {
    let verdict = call_wire(call_input(Some(serde_json::json!("gpt-5.6-sol")))).await;
    assert_ne!(
        verdict.report.error_code.as_deref(),
        Some("invalid_model"),
        "an unrecognized model id must not be validated against any allowlist"
    );
    assert!(
        verdict.spawned,
        "an accepted model must not block the delegation"
    );
}

/// A blank model is equivalent to omitting it: inherit the user's configured
/// default, do not fail the whole tool call.
#[tokio::test]
async fn wire_blank_model_does_not_fail_the_call() {
    for blank in [serde_json::json!(""), serde_json::json!("   ")] {
        let verdict = call_wire(call_input(Some(blank.clone()))).await;
        assert_ne!(
            verdict.report.error_code.as_deref(),
            Some("invalid_model"),
            "a blank model {blank} must degrade to the configured default, not fail"
        );
        assert!(verdict.spawned, "blank model {blank} must still spawn");
    }
}

/// Field omitted entirely (every pre-model companion, and any call happy with
/// the configured default) ⇒ delegation proceeds untouched.
#[tokio::test]
async fn wire_omitted_model_proceeds() {
    let verdict = call_wire(call_input(None)).await;
    assert_eq!(verdict.report.error_code, None);
    assert!(verdict.spawned);
}

/// Non-string JSON must degrade to "no model" via `as_str()` rather than
/// panicking or coercing — a schema-violating companion must not be able to
/// crash the listener or lose the user's whole tool call.
#[tokio::test]
async fn wire_non_string_model_degrades_to_default() {
    for bad in [
        serde_json::json!(42),
        serde_json::json!([]),
        serde_json::json!({}),
        serde_json::json!(null),
        serde_json::json!(true),
        serde_json::json!(["claude-sonnet-5"]),
    ] {
        let verdict = call_wire(call_input(Some(bad.clone()))).await;
        assert_ne!(
            verdict.report.error_code.as_deref(),
            Some("invalid_model"),
            "non-string model {bad} must degrade to the default without failing"
        );
        assert!(verdict.spawned, "non-string model {bad} must still spawn");
    }
}

// ── Propagation: the normalized value must LAND on the outbound request ──────

/// The regression this stage actually needs. Every other test here passes
/// unchanged if `listener::process` builds its `DelegationRequest` with
/// `model: None` instead of `model,` — the report is the same, the spawn is the
/// same, the normalizer is the same. Only observing the outbound request
/// distinguishes "parsed correctly" from "parsed correctly AND carried".
///
/// Asserted on exact values, not `is_some()`, so a truncated or re-defaulted id
/// fails too.
#[tokio::test]
async fn wire_accepted_model_reaches_the_broker_request() {
    let verdict = call_wire(call_input(Some(serde_json::json!("gpt-5.6-sol")))).await;
    let request = verdict
        .request
        .expect("an accepted model must reach the broker");
    assert_eq!(
        request.model.as_deref(),
        Some("gpt-5.6-sol"),
        "the normalized model id must land on DelegationRequest.model, not be \
         dropped between the parse and the broker"
    );
}

/// Trimming happens on the way to the broker, not just inside the normalizer:
/// the request must carry the clean id.
#[tokio::test]
async fn wire_padded_model_reaches_the_broker_trimmed() {
    let verdict = call_wire(call_input(Some(serde_json::json!("  gpt-5.6-sol  ")))).await;
    let request = verdict.request.expect("a padded model must still delegate");
    assert_eq!(request.model.as_deref(), Some("gpt-5.6-sol"));
}

/// Blank / whitespace-only must arrive as `None` — "inherit the configured
/// default" — rather than as `Some("")`, which downstream would read as an
/// explicit request for an empty model id.
#[tokio::test]
async fn wire_blank_model_reaches_the_broker_as_none() {
    for blank in [serde_json::json!(""), serde_json::json!("   ")] {
        let verdict = call_wire(call_input(Some(blank.clone()))).await;
        let request = verdict
            .request
            .unwrap_or_else(|| panic!("blank model {blank} must still delegate"));
        assert_eq!(
            request.model, None,
            "blank model {blank} must arrive as None, not an empty string"
        );
    }
}

/// A non-string JSON value degrades to `None` all the way to the broker, so a
/// schema-violating companion cannot turn `42` into a model id.
#[tokio::test]
async fn wire_non_string_model_reaches_the_broker_as_none() {
    for bad in [
        serde_json::json!(42),
        serde_json::json!([]),
        serde_json::json!({}),
        serde_json::json!(null),
        serde_json::json!(true),
        serde_json::json!(["claude-sonnet-5"]),
    ] {
        let verdict = call_wire(call_input(Some(bad.clone()))).await;
        let request = verdict
            .request
            .unwrap_or_else(|| panic!("non-string model {bad} must still delegate"));
        assert_eq!(
            request.model, None,
            "non-string model {bad} must arrive as None"
        );
    }
}

/// An omitted `model` arrives as `None` — the pre-model companion's shape.
#[tokio::test]
async fn wire_omitted_model_reaches_the_broker_as_none() {
    let verdict = call_wire(call_input(None)).await;
    let request = verdict
        .request
        .expect("an omitted model must still delegate");
    assert_eq!(request.model, None);
}

/// A rejected model never reaches the broker at all — the abort is upstream of
/// it, so no request is recorded (and therefore no child is spawned).
#[tokio::test]
async fn wire_rejected_model_never_reaches_the_broker() {
    let verdict = call_wire(call_input(Some(serde_json::json!("a\nb")))).await;
    assert!(
        verdict.request.is_none(),
        "a rejected model must abort BEFORE the broker is invoked"
    );
}

// ── The pure normalizer: exact values ───────────────────────────────────────

/// `normalize_requested_model` is the single place the contract lives, so the
/// exhaustive exact-value cases are asserted on it directly. That the value it
/// returns then REACHES the broker is a separate claim, covered by
/// `wire_accepted_model_reaches_the_broker_request` above.
mod model_normalization {
    use super::*;

    fn norm(v: Option<serde_json::Value>) -> Result<Option<String>, DelegationError> {
        let mut input = serde_json::json!({});
        if let Some(v) = v {
            input["model"] = v;
        }
        normalize_requested_model(input.get("model"))
    }

    #[test]
    fn absent_and_null_inherit_the_configured_default() {
        assert_eq!(norm(None).unwrap(), None);
        assert_eq!(norm(Some(serde_json::json!(null))).unwrap(), None);
    }

    #[test]
    fn blank_is_equivalent_to_absent() {
        assert_eq!(norm(Some(serde_json::json!(""))).unwrap(), None);
        assert_eq!(norm(Some(serde_json::json!("   "))).unwrap(), None);
        assert_eq!(norm(Some(serde_json::json!("\t "))).unwrap(), None);
    }

    #[test]
    fn surrounding_whitespace_is_trimmed_and_content_kept() {
        assert_eq!(
            norm(Some(serde_json::json!("  claude-sonnet-5  "))).unwrap(),
            Some("claude-sonnet-5".to_string())
        );
        assert_eq!(
            norm(Some(serde_json::json!("\tgpt-5.6-sol\n"))).unwrap(),
            Some("gpt-5.6-sol".to_string()),
            "trailing whitespace must be trimmed, not treated as a control char"
        );
    }

    /// No allowlist: an id from any vendor, or one nobody has published yet,
    /// survives byte-for-byte. Validating here would defeat the feature.
    #[test]
    fn arbitrary_ids_are_preserved_verbatim() {
        for id in [
            "gpt-5.6-sol",
            "deepseek-v4",
            "qwen/qwen3-max",
            "my-relay:some_model@2026-08",
            "claude-opus-5[1m]",
            "模型-中文-id",
        ] {
            assert_eq!(
                norm(Some(serde_json::json!(id))).unwrap(),
                Some(id.to_string()),
                "{id} must pass through verbatim"
            );
        }
    }

    /// Interior control characters are rejected as paste contamination — NOT
    /// because they cannot be transported (only NUL cannot; the rest survive a
    /// process env-var value intact, verified by controlled experiment).
    #[test]
    fn interior_control_characters_are_rejected_as_paste_contamination() {
        for bad in ["a\nb", "a\rb", "a\0b", "a\tb", "a\u{7f}b", "a\u{1b}[31m"] {
            let err = norm(Some(serde_json::json!(bad)))
                .expect_err("interior control character must be rejected");
            assert!(
                matches!(err, DelegationError::InvalidModel(_)),
                "expected InvalidModel for {bad:?}, got {err:?}"
            );
        }
    }

    /// The typed error projects onto a wire-stable code the LLM can match on,
    /// mirroring how `InvalidPersona` → `invalid_persona` works.
    #[test]
    fn invalid_model_projects_onto_a_wire_stable_code() {
        use codeg_lib::acp::delegation::types::DelegationOutcome;
        let outcome =
            DelegationOutcome::from_err(DelegationError::InvalidModel("because".into()), None);
        match outcome {
            DelegationOutcome::Err { code, message, .. } => {
                assert_eq!(code, "invalid_model");
                assert!(message.contains("because"), "got: {message}");
            }
            other => panic!("expected Err outcome, got {other:?}"),
        }
    }
}
