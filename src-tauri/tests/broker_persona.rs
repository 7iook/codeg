//! Integration tests for stage 5 of the delegate-persona-passthrough spec —
//! the spawn-arg wiring that closes P0-1 (a resolved persona `LaunchOption`
//! actually reaching `ConnectionSpawner::spawn`).
//!
//! # Why this file exists (isolated from the inline `mod tests` in broker.rs)
//!
//! `broker.rs::mod tests` carries the full persona suite, but running it via
//! `cargo test --lib` currently fails to launch on this Windows host: the
//! `codeg_lib` test binary aborts at startup with `STATUS_ENTRYPOINT_NOT_FOUND`
//! (0xC0000139) before any test logic runs — a Tauri native-dependency DLL is
//! missing an export. An integration test crate only links the library's
//! PUBLIC API (not the inline `#[cfg(test)]` tree) and has a far smaller native
//! surface, so it runs cleanly and gives a real red/green signal for the
//! stage-5 wiring.
//!
//! These re-exercise the spawn-arg contract against the same public
//! `DelegationBroker` + `test-utils` `MockSpawner` surface: the resolved
//! `LaunchOption` must land in `MockSpawner::spawn_args[..].launch_option`.

use std::sync::Arc;

use async_trait::async_trait;

use codeg_lib::acp::delegation::broker::{
    ConversationDepthLookup, DelegationBroker, DelegationConfig, StatusWait,
};
use codeg_lib::acp::delegation::persona::{AppliedPersona, LaunchOption};
use codeg_lib::acp::delegation::spawner::{mock::MockSpawner, ConnectionSpawner};
use codeg_lib::acp::delegation::types::{
    DelegationError, DelegationOutcome, DelegationRequest, DelegationSuccess, TaskStatus,
};
use codeg_lib::models::agent::AgentType;

/// Minimal in-memory `ConversationDepthLookup`: the parent conversation is the
/// chain root (depth 0), so no delegation is ever depth-rejected.
struct RootDepth;

#[async_trait]
impl ConversationDepthLookup for RootDepth {
    async fn parent_of(&self, _conversation_id: i32) -> Result<Option<i32>, DelegationError> {
        Ok(None)
    }
}

/// Build an enabled broker over a fresh `MockSpawner`, returning both so a test
/// can stage spawn/send results and read back `spawn_args`.
async fn enabled_broker() -> (DelegationBroker, Arc<MockSpawner>) {
    let mock = Arc::new(MockSpawner::new());
    let broker = DelegationBroker::new(
        mock.clone() as Arc<dyn ConnectionSpawner>,
        Arc::new(RootDepth) as Arc<dyn ConversationDepthLookup>,
    );
    broker
        .set_config(DelegationConfig {
            enabled: true,
            ..DelegationConfig::default()
        })
        .await;
    (broker, mock)
}

fn persona_request(
    agent_type: AgentType,
    tool_use: &str,
    subagent_type: Option<&str>,
) -> DelegationRequest {
    DelegationRequest {
        parent_connection_id: "parent-conn".into(),
        parent_conversation_id: 1,
        parent_tool_use_id: tool_use.into(),
        agent_type,
        task: "do x".into(),
        working_dir: None,
        requested_working_dir: None,
        external_handle: None,
        subagent_type: subagent_type.map(str::to_string),
    }
}

/// Drive one delegation to a clean `complete_call`, returning the terminal
/// report. Stages one spawn + one send result up front.
async fn settle(
    broker: &DelegationBroker,
    mock: &MockSpawner,
    child_conn: &str,
    child_conv: i32,
    req: DelegationRequest,
) -> codeg_lib::acp::delegation::types::DelegationTaskReport {
    mock.queue_spawn(Ok(child_conn.into())).await;
    mock.queue_send(Ok(child_conv)).await;
    let agent_type = req.agent_type;
    let ack = broker.start_delegation(req).await;
    let task_id = ack.task_id.expect("running ack carries a task id");
    broker
        .complete_call(
            &task_id,
            DelegationOutcome::Ok(DelegationSuccess {
                text: format!("result of {child_conn}"),
                child_conversation_id: child_conv,
                child_agent_type: agent_type,
                turn_count: 1,
                duration_ms: 5,
                token_usage: None,
                applied_persona: None,
            }),
        )
        .await;
    broker
        .get_task_status("parent-conn", Some(1), &task_id, StatusWait::Immediate)
        .await
}

/// P0-1 closure (R2.1 / R2.3): a Kiro persona nomination resolves to a Native
/// `LaunchOption::KiroPersona` that ACTUALLY reaches `spawn` — the spawn-arg
/// evidence the stage-4 tests could only assert observably via `applied_persona`.
#[tokio::test]
async fn kiro_persona_launch_option_reaches_spawn() {
    let (broker, mock) = enabled_broker().await;
    let report = settle(
        &broker,
        &mock,
        "c-kiro",
        50,
        persona_request(AgentType::Kiro, "pt-kiro", Some("plan-reality-recon")),
    )
    .await;

    assert_eq!(report.status, TaskStatus::Completed);
    assert_eq!(
        report.applied_persona,
        Some(AppliedPersona::Native {
            name: "plan-reality-recon".into()
        })
    );
    let args = mock.spawn_args.lock().await;
    assert_eq!(args.len(), 1, "exactly one spawn");
    assert_eq!(
        args[0].launch_option,
        Some(LaunchOption::KiroPersona("plan-reality-recon".into())),
        "the resolved Kiro LaunchOption must reach spawn (P0-1)"
    );
    // Native path leaves the first-turn task text unchanged (no Hint preamble).
    assert_eq!(
        mock.first_prompt_tasks.lock().await.as_slice(),
        &["do x".to_string()],
    );
}

/// A delegation WITHOUT a persona nomination forwards `launch_option: None` —
/// legacy callers spawn exactly as before.
#[tokio::test]
async fn no_persona_forwards_no_launch_option() {
    let (broker, mock) = enabled_broker().await;
    let report = settle(
        &broker,
        &mock,
        "c-legacy",
        42,
        persona_request(AgentType::ClaudeCode, "pt-legacy", None),
    )
    .await;

    assert_eq!(report.status, TaskStatus::Completed);
    assert!(report.applied_persona.is_none());
    let args = mock.spawn_args.lock().await;
    assert_eq!(args[0].launch_option, None);
}

/// An unsupported CLI (Gemini) with a persona nomination forwards NO launch
/// option — the nomination is downgraded to a note, never a spawn arg.
#[tokio::test]
async fn unsupported_cli_forwards_no_launch_option() {
    let (broker, mock) = enabled_broker().await;
    let report = settle(
        &broker,
        &mock,
        "c-gem",
        60,
        persona_request(AgentType::Gemini, "pt-gem", Some("some-agent")),
    )
    .await;

    assert_eq!(report.status, TaskStatus::Completed);
    assert_eq!(
        report.applied_persona,
        Some(AppliedPersona::IgnoredUnsupportedCli {
            name: "some-agent".into()
        })
    );
    let args = mock.spawn_args.lock().await;
    assert_eq!(
        args[0].launch_option, None,
        "an unsupported CLI must never forward a launch option"
    );
}

/// R3-A2 timing: a spawn failure forwards the launch option (the persona did
/// resolve) but leaves `applied_persona` = `None` — attribution is only
/// committed after spawn returns Ok.
#[tokio::test]
async fn spawn_failure_leaves_applied_persona_none_but_still_forwarded_option() {
    let (broker, mock) = enabled_broker().await;
    mock.queue_spawn(Err(
        codeg_lib::acp::delegation::spawner::SpawnerError::Spawn("boom".into()),
    ))
    .await;
    let report = broker
        .start_delegation(persona_request(
            AgentType::Kiro,
            "pt-fail",
            Some("plan-reality-recon"),
        ))
        .await;

    assert_eq!(report.status, TaskStatus::Failed);
    assert!(
        report.applied_persona.is_none(),
        "R3-A2: no attribution on failed spawn"
    );
    // The option was still forwarded to spawn — the failure is downstream.
    let args = mock.spawn_args.lock().await;
    assert_eq!(
        args[0].launch_option,
        Some(LaunchOption::KiroPersona("plan-reality-recon".into())),
    );
}

/// P5 (R7.1 / R7.2): two CONCURRENT delegations of the SAME agent_type (both
/// Kiro) but DIFFERENT subagent_type must keep independent launch options — one
/// call's persona never bleeds into the other's spawn. This is the real
/// concurrency shape (same CLI family, distinct personas), not a Kiro-then-Gemini
/// sequence where the agent_type alone would disambiguate.
#[tokio::test]
async fn concurrent_same_agent_distinct_personas_do_not_cross() {
    let (broker, mock) = enabled_broker().await;

    // Two spawns + two sends staged. The shared queues mean pop order under
    // concurrency is nondeterministic, so both spawn results map to a real
    // child and we assert on the SET of recorded launch options, not position.
    mock.queue_spawn(Ok("c-a".into())).await;
    mock.queue_spawn(Ok("c-b".into())).await;
    mock.queue_send(Ok(70)).await;
    mock.queue_send(Ok(71)).await;

    let req_a = persona_request(AgentType::Kiro, "pt-a", Some("recon-agent"));
    let req_b = persona_request(AgentType::Kiro, "pt-b", Some("review-agent"));

    let (ack_a, ack_b) = tokio::join!(
        broker.start_delegation(req_a),
        broker.start_delegation(req_b)
    );
    assert_eq!(ack_a.status, TaskStatus::Running);
    assert_eq!(ack_b.status, TaskStatus::Running);

    let args = mock.spawn_args.lock().await;
    assert_eq!(args.len(), 2, "both concurrent delegations spawned");
    let mut options: Vec<Option<String>> = args
        .iter()
        .map(|a| match &a.launch_option {
            Some(LaunchOption::KiroPersona(n)) => Some(n.clone()),
            None => None,
        })
        .collect();
    options.sort();
    assert_eq!(
        options,
        vec![
            Some("recon-agent".to_string()),
            Some("review-agent".to_string())
        ],
        "each concurrent spawn keeps its own persona — no cross-contamination"
    );
}
