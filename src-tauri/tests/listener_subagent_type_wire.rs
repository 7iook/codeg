//! Wire-level tests for the listener's `subagent_type` parse — review round-2
//! gap 3. `listener::process()` reads the persona nomination straight off the
//! MCP `tools/call` `arguments` JSON:
//!
//! ```ignore
//! subagent_type: req.input.get("subagent_type").and_then(|v| v.as_str())
//!     .map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
//! ```
//!
//! P0-2 only verified this at the type layer. These tests drive a REAL
//! length-prefixed `BrokerMessage::Call` frame through `serve_one` — the exact
//! path the `codeg-mcp` companion uses — and observe the parse's effect on the
//! far side of the broker, via `MockSpawner::spawn_args[..].launch_options`.
//!
//! Observing through `launch_options` (rather than a getter on the parsed
//! request) is deliberate: it proves the whole wire → parse → broker → spawn
//! chain, so a parse that silently dropped the field would show up as a missing
//! Kiro persona nomination — the user-visible failure.
//!
//! `AgentType::Kiro` is used throughout because it is the Native tier: its
//! persona resolves to a `LaunchOption` with no filesystem dependency, so these
//! tests need no persona files or env overrides.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

use codeg_lib::acp::delegation::broker::{
    ConversationDepthLookup, DelegationBroker, DelegationConfig,
};
use codeg_lib::acp::delegation::listener::{
    DelegationListener, ParentSessionLookup, TokenEntry, TokenRegistry,
};
use codeg_lib::acp::delegation::persona::LaunchOption;
use codeg_lib::acp::delegation::spawner::{mock::MockSpawner, ConnectionSpawner};
use codeg_lib::acp::delegation::transport::{
    read_frame, write_frame, BrokerMessage, BrokerRequest, BrokerResponse,
};
use codeg_lib::acp::delegation::types::DelegationError;
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

/// Always resolves the parent to conversation 1, so the delegation is never
/// rejected for "parent has no active conversation".
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

/// Send one `BrokerMessage::Call` whose `arguments` JSON is exactly `input`
/// through a real framed socket, and return what the broker forwarded to
/// `spawn`. `None` = no spawn happened at all; `Some(vec![])` = a spawn with no
/// launch knobs. These inputs never set `model`, so the only variant that can
/// appear in the vec is a persona nomination.
async fn launch_options_for_wire_input(input: serde_json::Value) -> Option<Vec<LaunchOption>> {
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
    let _: BrokerResponse = read_frame(&mut client).await.expect("read frame");
    server_task.await.expect("join").expect("serve_one");

    let args = mock.spawn_args.lock().await;
    args.first().map(|a| a.launch_options.clone())
}

/// Build the `arguments` JSON a `delegate_to_agent` call carries, optionally
/// with a `subagent_type` of an arbitrary JSON shape.
fn call_input(subagent_type: Option<serde_json::Value>) -> serde_json::Value {
    let mut input = serde_json::json!({
        "agent_type": "kiro",
        "task": "do x",
    });
    if let Some(v) = subagent_type {
        input["subagent_type"] = v;
    }
    input
}

// ── The four parse cases the reviewer asked for ──────────────────────────────

/// P0-2 happy path: a real MCP wire request carrying `subagent_type` reaches the
/// broker as a persona nomination, which for Kiro becomes a `LaunchOption`.
/// Proves the field is actually read off `input` — not silently dropped.
#[tokio::test]
async fn wire_subagent_type_reaches_spawn_as_launch_option() {
    let observed =
        launch_options_for_wire_input(call_input(Some(serde_json::json!("plan-reality-recon"))))
            .await;
    assert_eq!(
        observed,
        Some(vec![LaunchOption::KiroPersona("plan-reality-recon".into())]),
        "a wire-level subagent_type must reach spawn as a Kiro persona nomination"
    );
}

/// Surrounding whitespace is trimmed, so the persona name that reaches the CLI
/// is the clean identifier (an untrimmed name would fail the grammar gate and
/// fail the whole delegation).
#[tokio::test]
async fn wire_subagent_type_is_trimmed() {
    let observed =
        launch_options_for_wire_input(call_input(Some(serde_json::json!("  recon-agent  ")))).await;
    assert_eq!(
        observed,
        Some(vec![LaunchOption::KiroPersona("recon-agent".into())]),
        "whitespace around a persona name must be trimmed, not passed through"
    );
}

/// A whitespace-only value degrades to "no persona" rather than a blank name.
/// Without the `.filter(|s| !s.is_empty())` this would reach the grammar gate
/// and FAIL the delegation outright — an LLM that emitted `"subagent_type": " "`
/// would lose its whole tool call instead of just running without a persona.
#[tokio::test]
async fn wire_blank_subagent_type_degrades_to_no_persona() {
    let observed = launch_options_for_wire_input(call_input(Some(serde_json::json!("   ")))).await;
    assert_eq!(
        observed,
        Some(vec![]),
        "a whitespace-only subagent_type must spawn with NO persona, not fail"
    );
}

/// Field omitted entirely (every pre-persona companion, and any call that just
/// doesn't want a persona) ⇒ no nomination, spawn proceeds normally.
#[tokio::test]
async fn wire_omitted_subagent_type_yields_no_persona() {
    let observed = launch_options_for_wire_input(call_input(None)).await;
    assert_eq!(
        observed,
        Some(vec![]),
        "an omitted subagent_type must spawn with no persona"
    );
}

/// Non-string JSON (`42`, `[]`, `{}`, `null`, `true`) must degrade to `None` via
/// `as_str()` rather than panicking or coercing. A misbehaving or
/// schema-violating companion must not be able to crash the listener.
#[tokio::test]
async fn wire_non_string_subagent_type_degrades_to_no_persona() {
    for bad in [
        serde_json::json!(42),
        serde_json::json!([]),
        serde_json::json!({}),
        serde_json::json!(null),
        serde_json::json!(true),
        serde_json::json!(["plan-reality-recon"]),
    ] {
        let observed = launch_options_for_wire_input(call_input(Some(bad.clone()))).await;
        assert_eq!(
            observed,
            Some(vec![]),
            "non-string subagent_type {bad} must degrade to no persona without panicking"
        );
    }
}
