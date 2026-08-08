//! Windows counterpart to `delegation_e2e_uds.rs`: drive a real named-pipe
//! round-trip through the listener → broker → mock spawner → `complete_call`
//! chain. Guards against regressions like generating a temp-file path
//! instead of a `\\.\pipe\...` address, or dropping the server instance
//! between accepts.

#![cfg(windows)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use codeg_lib::acp::delegation::broker::{
    ConversationDepthLookup, DelegationBroker, DelegationConfig,
};
use codeg_lib::acp::delegation::listener::{
    DelegationListener, ParentSessionLookup, TokenEntry, TokenRegistry,
};
use codeg_lib::acp::delegation::spawner::{mock::MockSpawner, ConnectionSpawner};
use codeg_lib::acp::delegation::transport::{
    client_round_trip, client_status_round_trip, BrokerRequest, BrokerResponse, BrokerStatusRequest,
};
use codeg_lib::acp::delegation::types::{DelegationError, DelegationOutcome, DelegationSuccess};
use codeg_lib::acp::question::{QuestionSpec, RegisteredQuestion, SessionQuestionAccess};
use codeg_lib::models::AgentType;
use serde_json::json;

struct AlwaysRoot;
#[async_trait]
impl ConversationDepthLookup for AlwaysRoot {
    async fn parent_of(&self, _id: i32) -> Result<Option<i32>, DelegationError> {
        Ok(None)
    }
}

struct FixedParent(i32);
#[async_trait]
impl ParentSessionLookup for FixedParent {
    async fn current_conversation_id(&self, _: &str) -> Option<i32> {
        Some(self.0)
    }
}

/// No-op feedback access — this e2e suite exercises delegation, not feedback.
struct NoFeedback;
#[async_trait]
impl codeg_lib::acp::feedback::SessionFeedbackAccess for NoFeedback {
    async fn read_pending_feedback(
        &self,
        _parent_connection_id: &str,
    ) -> Vec<codeg_lib::acp::feedback::PendingFeedback> {
        Vec::new()
    }
    async fn commit_feedback_delivered(&self, _parent_connection_id: &str, _ids: Vec<String>) {}
}

/// No-op question access — this e2e suite exercises delegation, not asks.
struct NoQuestions;
#[async_trait]
impl SessionQuestionAccess for NoQuestions {
    async fn register_question(
        &self,
        _parent_connection_id: &str,
        _questions: Vec<QuestionSpec>,
    ) -> Option<RegisteredQuestion> {
        None
    }
    async fn cancel_question(&self, _parent_connection_id: &str, _question_id: &str) {}
    async fn cancel_questions_by_parent(&self, _parent_connection_id: &str) {}
}

/// No-op session-info access — this e2e suite never drives `get_session_info`.
struct NoSessionInfo;
#[async_trait]
impl codeg_lib::acp::session_info::SessionInfoAccess for NoSessionInfo {
    async fn resolve(
        &self,
        session_id: i32,
        _max_messages: u32,
    ) -> codeg_lib::acp::session_info::SessionInfo {
        codeg_lib::acp::session_info::SessionInfo::not_found(session_id)
    }
}

/// Task-tool stub: the e2e delegation tests never exercise the task arms.
struct NoTaskTools;
#[async_trait]
impl codeg_lib::acp::work_task_tools::WorkTaskToolAccess for NoTaskTools {
    async fn report_progress(
        &self,
        _parent: &str,
        _message: &str,
    ) -> codeg_lib::acp::work_task_tools::TaskReportAck {
        codeg_lib::acp::work_task_tools::TaskReportAck::rejected("no engine")
    }
    async fn complete(
        &self,
        _parent: &str,
        _verdict: &str,
        _summary: Option<&str>,
    ) -> codeg_lib::acp::work_task_tools::TaskReportAck {
        codeg_lib::acp::work_task_tools::TaskReportAck::rejected("no engine")
    }
}

fn unique_pipe(tag: &str) -> String {
    format!(
        r"\\.\pipe\codeg-e2e-{}-{}-{}",
        tag,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    )
}

/// Named pipes aren't file paths, so we can't `Path::exists` them. Retry the
/// round-trip a few times to ride out the brief window before the listener
/// task creates its first server instance.
async fn client_round_trip_with_retry(
    pipe: &str,
    req: &BrokerRequest,
) -> std::io::Result<BrokerResponse> {
    let mut last_err = None;
    for _ in 0..50 {
        match client_round_trip(pipe, req).await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("client_round_trip retries exhausted")))
}

/// `client_round_trip_with_retry` for the `get_delegation_status` follow-up
/// (collects the terminal result under the async protocol).
async fn client_status_round_trip_with_retry(
    pipe: &str,
    req: &BrokerStatusRequest,
) -> std::io::Result<BrokerResponse> {
    let mut last_err = None;
    for _ in 0..50 {
        match client_status_round_trip(pipe, req).await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
    Err(last_err
        .unwrap_or_else(|| std::io::Error::other("client_status_round_trip retries exhausted")))
}

#[tokio::test]
async fn end_to_end_named_pipe_happy_path() {
    let mock = Arc::new(MockSpawner::new());
    mock.queue_spawn(Ok("child-conn-1".into())).await;
    mock.queue_send(Ok(77)).await;

    let broker = Arc::new(DelegationBroker::new(
        mock.clone() as Arc<dyn ConnectionSpawner>,
        Arc::new(AlwaysRoot) as Arc<dyn ConversationDepthLookup>,
    ));
    broker
        .set_config(DelegationConfig {
            enabled: true,
            depth_limit: 8,
            ..DelegationConfig::default()
        })
        .await;

    let tokens = Arc::new(TokenRegistry::default());
    tokens
        .register(
            "tok".into(),
            TokenEntry {
                parent_connection_id: "p1".into(),
                working_dir: PathBuf::from(r"C:\Windows\Temp"),
            },
        )
        .await;

    let listener = DelegationListener::new(
        broker.clone(),
        tokens,
        Arc::new(FixedParent(1)) as Arc<dyn ParentSessionLookup>,
        Arc::new(NoFeedback) as Arc<dyn codeg_lib::acp::feedback::SessionFeedbackAccess>,
        Arc::new(NoQuestions) as Arc<dyn SessionQuestionAccess>,
        Arc::new(NoSessionInfo) as Arc<dyn codeg_lib::acp::session_info::SessionInfoAccess>,
        Arc::new(NoTaskTools) as Arc<dyn codeg_lib::acp::work_task_tools::WorkTaskToolAccess>,
    );

    let pipe = unique_pipe("happy");
    let pipe_for_listener = PathBuf::from(&pipe);
    let listener_task = tokio::spawn(async move {
        let _ = listener.run(pipe_for_listener).await;
    });

    // 1. delegate_to_agent → Running ack carrying the child conversation id and
    //    a task_id to follow up on.
    let req = BrokerRequest {
        token: "tok".into(),
        parent_connection_id: "p1".into(),
        parent_tool_use_id: "pt-1".into(),
        external_handle: None,
        input: json!({"agent_type": "codex", "task": "do x"}),
    };
    let ack = client_round_trip_with_retry(&pipe, &req)
        .await
        .expect("client round-trip");
    assert_eq!(ack.outcome["status"], "running");
    assert_eq!(ack.outcome["child_conversation_id"], 77);
    let task_id = ack.outcome["task_id"]
        .as_str()
        .expect("running ack carries a task_id")
        .to_string();

    // 2. The lifecycle resolves the child on TurnComplete; the task is already
    //    registered, so complete_call migrates it to completed deterministically.
    broker
        .complete_call(
            &task_id,
            DelegationOutcome::Ok(DelegationSuccess {
                text: "pipe-result".into(),
                child_conversation_id: 77,
                child_agent_type: AgentType::Codex,
                turn_count: 1,
                duration_ms: 12,
                token_usage: None,

                applied_persona: None,
                requested_model: None,
            }),
        )
        .await;

    // 3. get_delegation_status → Completed with the result text, over the pipe.
    //    The Status arm returns a `{ tasks: [..] }` envelope; one id → one entry.
    let status_req = BrokerStatusRequest {
        token: "tok".into(),
        task_ids: vec![task_id],
        wait_ms: Some(1_000),
    };
    let resp = client_status_round_trip_with_retry(&pipe, &status_req)
        .await
        .expect("status round-trip");
    listener_task.abort();

    assert_eq!(resp.outcome["tasks"][0]["status"], "completed");
    assert_eq!(resp.outcome["tasks"][0]["text"], "pipe-result");
    assert_eq!(resp.outcome["tasks"][0]["child_conversation_id"], 77);
}

#[tokio::test]
async fn end_to_end_named_pipe_back_to_back_requests() {
    // Two sequential round-trips against the same listener. If the Windows
    // accept loop ever regresses to "create server only after handling a
    // connection", the second call will race against a missing pipe and the
    // client will see "system cannot find the file specified".
    let mock = Arc::new(MockSpawner::new());
    mock.queue_spawn(Ok("child-1".into())).await;
    mock.queue_send(Ok(1)).await;
    mock.queue_spawn(Ok("child-2".into())).await;
    mock.queue_send(Ok(2)).await;

    let broker = Arc::new(DelegationBroker::new(
        mock.clone() as Arc<dyn ConnectionSpawner>,
        Arc::new(AlwaysRoot) as Arc<dyn ConversationDepthLookup>,
    ));
    broker
        .set_config(DelegationConfig {
            enabled: true,
            depth_limit: 8,
            ..DelegationConfig::default()
        })
        .await;

    let tokens = Arc::new(TokenRegistry::default());
    tokens
        .register(
            "tok".into(),
            TokenEntry {
                parent_connection_id: "p1".into(),
                working_dir: PathBuf::from(r"C:\Windows\Temp"),
            },
        )
        .await;
    let listener = DelegationListener::new(
        broker.clone(),
        tokens,
        Arc::new(FixedParent(1)) as Arc<dyn ParentSessionLookup>,
        Arc::new(NoFeedback) as Arc<dyn codeg_lib::acp::feedback::SessionFeedbackAccess>,
        Arc::new(NoQuestions) as Arc<dyn SessionQuestionAccess>,
        Arc::new(NoSessionInfo) as Arc<dyn codeg_lib::acp::session_info::SessionInfoAccess>,
        Arc::new(NoTaskTools) as Arc<dyn codeg_lib::acp::work_task_tools::WorkTaskToolAccess>,
    );

    let pipe = unique_pipe("repeat");
    let pipe_for_listener = PathBuf::from(&pipe);
    let listener_task = tokio::spawn(async move {
        let _ = listener.run(pipe_for_listener).await;
    });

    // A completer that resolves each call as it's registered.
    let broker_for_completion = broker.clone();
    let completer = tokio::spawn(async move {
        let mut completed = 0;
        while completed < 2 {
            if let Some(call_id) = broker_for_completion.peek_first_pending_call_id().await {
                broker_for_completion
                    .complete_call(
                        &call_id,
                        DelegationOutcome::Ok(DelegationSuccess {
                            text: format!("done-{completed}"),
                            child_conversation_id: completed + 1,
                            child_agent_type: AgentType::Codex,
                            turn_count: 1,
                            duration_ms: 5,
                            token_usage: None,

                            applied_persona: None,
                            requested_model: None,
                        }),
                    )
                    .await;
                completed += 1;
            } else {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
    });

    for i in 0..2 {
        let req = BrokerRequest {
            token: "tok".into(),
            parent_connection_id: "p1".into(),
            parent_tool_use_id: format!("pt-{i}"),
            external_handle: None,
            input: json!({"agent_type": "codex", "task": "x"}),
        };
        let resp = client_round_trip_with_retry(&pipe, &req)
            .await
            .unwrap_or_else(|e| panic!("round-trip {i} failed: {e}"));
        // Async protocol: each call returns a Running ack (the completer
        // resolves the task afterward). The point of this test is the pipe
        // re-accepting a second connection, not the terminal shape.
        assert_eq!(resp.outcome["status"], "running", "round-trip {i}");
    }

    completer.await.unwrap();
    listener_task.abort();
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 8 · persona pass-through wire e2e (4 cases)
//
// Everything above proves the pipe/listener/broker chain works for a plain
// `delegate_to_agent` call. The four tests below add the persona layer:
// carry a `subagent_type` on the same wire, and observe the full loop —
//   listener parse → broker dispatch → provider translate → spawn args
//   (or short-circuit) → tool_result / status carrying applied_persona.
//
// The broker unit tests (`tests/broker_persona*.rs`) already exercise these
// four situations at the broker API surface. What they don't cover is the
// LISTENER's `input.get("subagent_type")` parse and the STATUS query's
// projection of `applied_persona` — those two seams only exist when the
// call arrives as a real MCP wire frame and the caller polls with
// `get_delegation_status`. E-052 (test-green ≠ real integration) is the
// exact failure this closes: broker-layer green doesn't prove wire-layer
// wired.
//
// Windows-only by file cfg; the UDS counterpart is left for a future round
// since the parse path is transport-agnostic (same `input` JSON either way).
// ─────────────────────────────────────────────────────────────────────────

use codeg_lib::acp::delegation::persona::{AppliedPersona, LaunchOption};

/// Small helper shared by the four stage-8 e2e tests: build a fresh listener
/// bound to a fresh unique pipe, register one token, and return the pipe
/// path + mock + listener join handle. Cuts ~100 lines of boilerplate per
/// test while keeping the harness IDENTICAL to `end_to_end_named_pipe_happy_path`
/// so the four new tests can't accidentally drift into a rosier reality than
/// the original happy path.
async fn spawn_stage8_listener(
    tag: &str,
    mock: Arc<MockSpawner>,
) -> (String, Arc<DelegationBroker>, tokio::task::JoinHandle<()>) {
    let broker = Arc::new(DelegationBroker::new(
        mock as Arc<dyn ConnectionSpawner>,
        Arc::new(AlwaysRoot) as Arc<dyn ConversationDepthLookup>,
    ));
    broker
        .set_config(DelegationConfig {
            enabled: true,
            depth_limit: 8,
            ..DelegationConfig::default()
        })
        .await;

    let tokens = Arc::new(TokenRegistry::default());
    tokens
        .register(
            "tok".into(),
            TokenEntry {
                parent_connection_id: "p1".into(),
                working_dir: PathBuf::from(r"C:\Windows\Temp"),
            },
        )
        .await;

    let listener = DelegationListener::new(
        broker.clone(),
        tokens,
        Arc::new(FixedParent(1)) as Arc<dyn ParentSessionLookup>,
        Arc::new(NoFeedback) as Arc<dyn codeg_lib::acp::feedback::SessionFeedbackAccess>,
        Arc::new(NoQuestions) as Arc<dyn SessionQuestionAccess>,
        Arc::new(NoSessionInfo) as Arc<dyn codeg_lib::acp::session_info::SessionInfoAccess>,
        Arc::new(NoTaskTools) as Arc<dyn codeg_lib::acp::work_task_tools::WorkTaskToolAccess>,
    );

    let pipe = unique_pipe(tag);
    let pipe_for_listener = PathBuf::from(&pipe);
    let listener_task = tokio::spawn(async move {
        let _ = listener.run(pipe_for_listener).await;
    });
    (pipe, broker, listener_task)
}

/// **Verdict #1** (Kiro real persona · wire half of the argv chain):
/// a `subagent_type` of a known-valid Kiro persona name reaches `spawn` as
/// `LaunchOption::KiroPersona(name)`, and `get_delegation_status` reflects
/// `applied_persona.kind == "native"`. The argv translation is separately
/// pinned by `connection::kiro_launch_args_translate_persona_agent_verbatim`
/// (unit) + `persona_merge_order::*_end_to_end` (integration) — those two
/// plus this one form the full Kiro chain.
///
/// KIRO is chosen because its provider needs NO filesystem access: `Native`
/// resolves without touching `<KIRO_HOME>/agents/<name>.json`. Kiro-cli
/// reloads that file at process start; `codeg` only nominates the name via
/// argv. So a fresh temp env is unnecessary — the name never hits disk.
///
/// Positive assertion: the wire carries the persona all the way to
/// `SpawnCallArgs.launch_options` AND lands in the terminal status report.
///
/// Reverse assertion: `applied_persona.kind` is precisely `"native"` (never
/// silently downgraded to `"hint"` or `"ignored_unsupported_cli"` for Kiro).
#[tokio::test]
async fn stage8_wire_kiro_native_persona_reaches_spawn_and_status() {
    let mock = Arc::new(MockSpawner::new());
    mock.queue_spawn(Ok("child-kiro".into())).await;
    mock.queue_send(Ok(101)).await;

    let (pipe, broker, listener_task) = spawn_stage8_listener("kiro-native", mock.clone()).await;

    // 1. delegate_to_agent with a Kiro persona nomination → Running ack.
    let req = BrokerRequest {
        token: "tok".into(),
        parent_connection_id: "p1".into(),
        parent_tool_use_id: "pt-kiro".into(),
        external_handle: None,
        input: json!({
            "agent_type": "kiro",
            "task": "plan the recon",
            "subagent_type": "plan-reality-recon",
        }),
    };
    let ack = client_round_trip_with_retry(&pipe, &req)
        .await
        .expect("kiro persona round-trip");
    assert_eq!(ack.outcome["status"], "running");
    assert_eq!(ack.outcome["child_conversation_id"], 101);
    let task_id = ack.outcome["task_id"]
        .as_str()
        .expect("running ack carries a task_id")
        .to_string();

    // 2. The broker resolved persona → launch options; assert BEFORE completing
    //    so a later change that only wires the terminal-report field can't
    //    make this test go green while spawn silently loses the nomination.
    {
        let args = mock.spawn_args.lock().await;
        assert_eq!(args.len(), 1, "exactly one spawn for a single delegation");
        assert_eq!(
            args[0].launch_options,
            vec![LaunchOption::KiroPersona("plan-reality-recon".into())],
            "wire subagent_type must reach spawn as KiroPersona; got {:?}",
            args[0].launch_options
        );
    }

    // 3. Resolve the child → completed. `AppliedPersona::Native` is R3-A2
    //    timing: broker already stored the intent on spawn-Ok, so a successful
    //    complete promotes it into the success outcome.
    broker
        .complete_call(
            &task_id,
            DelegationOutcome::Ok(DelegationSuccess {
                text: "kiro-recon-done".into(),
                child_conversation_id: 101,
                child_agent_type: AgentType::Kiro,
                turn_count: 1,
                duration_ms: 42,
                token_usage: None,
                applied_persona: Some(AppliedPersona::Native {
                    name: "plan-reality-recon".into(),
                }),
                requested_model: None,
            }),
        )
        .await;

    // 4. get_delegation_status → applied_persona.kind == "native".
    let status_req = BrokerStatusRequest {
        token: "tok".into(),
        task_ids: vec![task_id],
        wait_ms: Some(1_000),
    };
    let resp = client_status_round_trip_with_retry(&pipe, &status_req)
        .await
        .expect("kiro status round-trip");
    listener_task.abort();

    let task = &resp.outcome["tasks"][0];
    assert_eq!(task["status"], "completed");
    assert_eq!(task["text"], "kiro-recon-done");
    assert_eq!(
        task["applied_persona"]["kind"], "native",
        "Kiro persona nomination must project as `native`, got {:?}",
        task["applied_persona"]
    );
    assert_eq!(task["applied_persona"]["name"], "plan-reality-recon");
}

/// **Verdict #4** (Unsupported CLI silent downgrade):
/// a `subagent_type` on `agent_type: "gemini"` must NEVER fail the
/// delegation — R4.1/R4.2/R4.3 pin this as a silent downgrade where the
/// child still runs, `applied_persona` attributes `IgnoredUnsupportedCli`,
/// and a `[note]` on the success text tells the LLM the request was
/// downgraded.
///
/// Positive assertion: status is `completed`, `applied_persona.kind`
/// is `"ignored_unsupported_cli"`, and the success text carries a `[note]`
/// with the persona name + `ignored` — the three tokens the broker's
/// `append_unsupported_note` guarantees.
///
/// Reverse assertion: `spawn_args[0].launch_options` is EMPTY. If the broker
/// ever forwarded the nomination to `spawn` for an unsupported CLI (e.g. a
/// naive future refactor that skipped the `supports_persona()` gate), this
/// assertion would fail even if `applied_persona` still looked right.
#[tokio::test]
async fn stage8_wire_unsupported_cli_silently_downgrades_with_note() {
    let mock = Arc::new(MockSpawner::new());
    mock.queue_spawn(Ok("child-gem".into())).await;
    mock.queue_send(Ok(202)).await;

    let (pipe, broker, listener_task) = spawn_stage8_listener("unsupported", mock.clone()).await;

    let req = BrokerRequest {
        token: "tok".into(),
        parent_connection_id: "p1".into(),
        parent_tool_use_id: "pt-gem".into(),
        external_handle: None,
        input: json!({
            "agent_type": "gemini",
            "task": "do gemini work",
            "subagent_type": "some-agent",
        }),
    };
    let ack = client_round_trip_with_retry(&pipe, &req)
        .await
        .expect("unsupported round-trip");
    assert_eq!(
        ack.outcome["status"], "running",
        "unsupported CLI must NOT fail delegation on setup; got {:?}",
        ack.outcome
    );
    let task_id = ack.outcome["task_id"]
        .as_str()
        .expect("running ack carries a task_id")
        .to_string();

    // Reverse guard: the nomination was DOWNGRADED, not forwarded. A future
    // refactor that skips `supports_persona()` would fail this line even if
    // it happened to still produce `IgnoredUnsupportedCli` downstream.
    {
        let args = mock.spawn_args.lock().await;
        assert_eq!(args.len(), 1);
        assert!(
            args[0].launch_options.is_empty(),
            "unsupported CLI must NEVER forward a launch option; got {:?}",
            args[0].launch_options
        );
    }

    // The child ran and produced ordinary output. The broker will splice a
    // `[note]` line onto this text before it reaches the status report.
    broker
        .complete_call(
            &task_id,
            DelegationOutcome::Ok(DelegationSuccess {
                text: "gemini-said-hi".into(),
                child_conversation_id: 202,
                child_agent_type: AgentType::Gemini,
                turn_count: 1,
                duration_ms: 33,
                token_usage: None,
                applied_persona: None, // broker overrides from stored intent
                requested_model: None, // ditto
            }),
        )
        .await;

    let status_req = BrokerStatusRequest {
        token: "tok".into(),
        task_ids: vec![task_id],
        wait_ms: Some(1_000),
    };
    let resp = client_status_round_trip_with_retry(&pipe, &status_req)
        .await
        .expect("unsupported status round-trip");
    listener_task.abort();

    let task = &resp.outcome["tasks"][0];
    assert_eq!(task["status"], "completed");
    assert_eq!(
        task["applied_persona"]["kind"], "ignored_unsupported_cli",
        "unsupported CLI must attribute IgnoredUnsupportedCli, got {:?}",
        task["applied_persona"]
    );
    assert_eq!(task["applied_persona"]["name"], "some-agent");

    let text = task["text"]
        .as_str()
        .expect("completed status carries success text");
    assert!(
        text.contains("[note]") && text.contains("some-agent") && text.contains("ignored"),
        "unsupported note must ride the result text (need [note] + persona name + `ignored`), got: {text}",
    );
}

/// **Verdict #5** (Invalid persona hard failure):
/// on a Claude Code delegation whose `subagent_type` refers to a persona
/// file that does not exist (empty tempdir override), the broker must FAIL
/// the delegation with wire code `invalid_persona` BEFORE any spawn attempt
/// — R3-F3 explicitly rejects a silent no-persona degradation, which would
/// hand the LLM a subagent that quietly ignored the requested role.
///
/// This test uses `temp_env` to make `CLAUDE_CONFIG_DIR` point at an empty
/// tempdir, so the resolver walks a real filesystem path and reports
/// `NotFound(name)` for the nonexistent persona. That, plus the reverse
/// spawn-args assertion, is the ONLY way to catch a regression that
/// swapped the failure path for a silent no-persona spawn.
///
/// Reverse assertion: `spawn_args` is empty. The broker must short-circuit
/// on `PersonaEffect::Failed` and never call `spawn`.
#[tokio::test]
async fn stage8_wire_invalid_persona_fails_before_spawn() {
    let home = tempfile::tempdir().expect("tempdir");
    // Deliberately no agents/ subdir at all — resolver reports NotFound.
    temp_env::async_with_vars([("CLAUDE_CONFIG_DIR", Some(home.path()))], async {
        let mock = Arc::new(MockSpawner::new());
        // No queue_spawn/queue_send — a spawn attempt would panic on
        // "no queued result", giving us an even louder failure signal
        // than the assertion below if the broker regresses.

        let (pipe, _broker, listener_task) =
            spawn_stage8_listener("invalid-persona", mock.clone()).await;

        let req = BrokerRequest {
            token: "tok".into(),
            parent_connection_id: "p1".into(),
            parent_tool_use_id: "pt-inv".into(),
            external_handle: None,
            input: json!({
                "agent_type": "claude_code",
                "task": "do it",
                "subagent_type": "nonexistent-xyz-stage8",
            }),
        };
        let resp = client_round_trip_with_retry(&pipe, &req)
            .await
            .expect("invalid-persona round-trip");
        listener_task.abort();

        assert_eq!(
            resp.outcome["status"], "failed",
            "an unresolvable persona must FAIL the delegation, not silently degrade; got {:?}",
            resp.outcome
        );
        assert_eq!(
            resp.outcome["error_code"], "invalid_persona",
            "wire code must be `invalid_persona`; got {:?}",
            resp.outcome["error_code"]
        );

        // Reverse guard: broker short-circuited before ever hitting the
        // spawner. If a future refactor moved the resolver AFTER spawn,
        // this would catch it even if the wire code still looked right.
        let args = mock.spawn_args.lock().await;
        assert!(
            args.is_empty(),
            "invalid-persona must abort BEFORE spawn; got {} spawn call(s)",
            args.len()
        );
    })
    .await;
}

/// **Verdict #6** (Persona-name grammar rejection):
/// three concrete grammar-violating names — a slashed path (`foo/bar`), a
/// dotted name (`a.b`), and a 65-char name (one over the cap) — must each
/// fail the delegation with `invalid_persona` and never reach `spawn`. The
/// grammar gate lives in the broker BEFORE `provider.resolve_persona_effect`
/// (R3-F1 order), so this fires on ANY persona-supporting CLI without
/// needing filesystem setup.
///
/// Each case runs on its OWN fresh listener + mock, so the spawn_args
/// emptiness assertion is per-case (a shared mock would let one case
/// legitimately spawn and mask another case that regressed to spawning).
#[tokio::test]
async fn stage8_wire_persona_name_grammar_rejected() {
    let cases: [(&str, &str); 3] = [
        ("slash", "foo/bar"),
        ("dot", "a.b"),
        // 65 characters — one over the 1..=64 grammar cap.
        (
            "too-long",
            "a123456789012345678901234567890123456789012345678901234567890123z",
        ),
    ];

    for (tag, bad_name) in cases {
        assert_eq!(
            bad_name.chars().count(),
            match tag {
                "too-long" => 65,
                "slash" => 7,
                "dot" => 3,
                _ => unreachable!(),
            },
            "case `{tag}` fixture length precheck"
        );

        let mock = Arc::new(MockSpawner::new());
        // Again, no queued results — a spawn attempt would panic first.

        let (pipe, _broker, listener_task) =
            spawn_stage8_listener(&format!("grammar-{tag}"), mock.clone()).await;

        // Use Kiro so `supports_persona()` is true (the grammar gate has to
        // fire — an unsupported CLI would short-circuit before it and land
        // us on the wrong assertion path).
        let req = BrokerRequest {
            token: "tok".into(),
            parent_connection_id: "p1".into(),
            parent_tool_use_id: format!("pt-bad-{tag}"),
            external_handle: None,
            input: json!({
                "agent_type": "kiro",
                "task": "do x",
                "subagent_type": bad_name,
            }),
        };
        let resp = client_round_trip_with_retry(&pipe, &req)
            .await
            .unwrap_or_else(|e| panic!("grammar case `{tag}` round-trip failed: {e}"));
        listener_task.abort();

        assert_eq!(
            resp.outcome["status"], "failed",
            "grammar case `{tag}` ({bad_name}) must FAIL delegation; got {:?}",
            resp.outcome
        );
        assert_eq!(
            resp.outcome["error_code"], "invalid_persona",
            "grammar case `{tag}` wire code must be `invalid_persona`; got {:?}",
            resp.outcome["error_code"]
        );

        // Reverse guard: broker rejected on grammar BEFORE reaching the
        // provider or the spawner. This is what proves R3-F1 order.
        let args = mock.spawn_args.lock().await;
        assert!(
            args.is_empty(),
            "grammar case `{tag}` must abort BEFORE spawn; got {} spawn call(s)",
            args.len()
        );
    }
}
