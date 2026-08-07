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
//! input class that fails loudly is a value that cannot cross the process
//! env-var / argv boundary the model id is eventually carried on (control
//! characters: newline, NUL, ...). Everything else — including ids this build
//! has never heard of — is kept as-is.
//!
//! Exact-value assertions live on the pure normalizer
//! (`normalize_requested_model`, exercised in `model_normalization` below);
//! stage 1 has no downstream consumer of `DelegationRequest.model` yet, so
//! there is no spawn-arg channel to observe the kept value through.
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
use codeg_lib::acp::delegation::types::{DelegationError, DelegationTaskReport, TaskStatus};
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

// ── Harness ─────────────────────────────────────────────────────────────────

/// What one `delegate_to_agent` wire call produced: the listener's report, and
/// whether the broker got as far as `ConnectionSpawner::spawn`.
struct WireVerdict {
    report: DelegationTaskReport,
    spawned: bool,
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
        broker,
        tokens,
        Arc::new(StaticParent),
        Arc::new(NoFeedback),
        Arc::new(NoQuestions),
        Arc::new(NoSessionInfo),
        Arc::new(NoTaskTools),
    );

    let (mut client, mut server) = tokio::io::duplex(16 * 1024);
    let server_task = tokio::spawn(async move { listener.serve_one(&mut server).await });

    let msg = BrokerMessage::Call(BrokerRequest {
        token: "tok".into(),
        parent_connection_id: "parent-conn".into(),
        parent_tool_use_id: "pt-1".into(),
        external_handle: None,
        input,
    });
    write_frame(&mut client, &msg).await.expect("write frame");
    let resp: BrokerResponse = read_frame(&mut client).await.expect("read frame");
    server_task.await.expect("join").expect("serve_one");

    let report: DelegationTaskReport =
        serde_json::from_value(resp.outcome).expect("outcome decodes as a task report");
    let spawned = !mock.spawn_args.lock().await.is_empty();
    WireVerdict { report, spawned }
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

/// A model id carrying a newline cannot be represented as a process env-var /
/// argv value, so it must be REJECTED with a specific reason rather than
/// silently dropped (the drop would look like "my model choice was ignored",
/// which is exactly the failure this feature exists to remove).
#[tokio::test]
async fn wire_model_with_newline_is_rejected() {
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

/// A NUL byte terminates a C string, so it can never reach a child process
/// intact — reject rather than truncate.
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

// ── The pure normalizer: exact values ───────────────────────────────────────

/// `normalize_requested_model` is the single place the contract lives, so the
/// exact-value cases are asserted on it directly. (Stage 1 has no downstream
/// consumer of the kept value, so there is no spawn-arg channel yet.)
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

    #[test]
    fn interior_control_characters_are_rejected() {
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
