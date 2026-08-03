//! Integration tests for the **Hint** persona tier (Claude Code / Codex) of the
//! delegate-persona-passthrough spec — the review round-2 gap where every
//! existing persona test only covered Kiro (Native) / unsupported (Ignored) /
//! no-persona.
//!
//! # Why this is a SEPARATE crate from `broker_persona.rs`
//!
//! The Hint providers resolve a real persona file off disk:
//! `ClaudeCodeProvider` reads `<resolve_claude_config_dir()>/agents/<name>.md`
//! and `CodexProvider` reads `<resolve_codex_home_dir()>/agents/<name>.md`.
//! Both resolvers honour an env override (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`,
//! see `parsers::claude` / `parsers::codex`), so a deterministic test MUST point
//! them at a tempdir instead of the host's real config dir.
//!
//! Process env is global. Two isolation layers, matching this repo's existing
//! convention for env-dependent tests:
//!
//! 1. **A separate integration crate** — each Cargo integration test target is
//!    its own process, so nothing here can perturb `broker_persona.rs` (which
//!    asserts the Native / unsupported paths and must not see a hijacked
//!    config dir).
//! 2. **`temp_env::async_with_vars`** — serializes the mutation against other
//!    env readers *inside* this process via temp_env's own lock, and restores
//!    the previous value on scope exit. Same posture as the existing
//!    `commands/custom_skills.rs` / `commands/acp.rs` env tests.
//!
//! Spec anchors covered:
//! - R2.4 / R5.1: a Hint persona prepends the persona body to the FIRST-turn
//!   task as `{preamble}\n\n---\n\n{task}`
//! - Property P3 (Native <-> Hint mutual exclusion): the Hint path forwards
//!   `launch_option: None` — it must never also nominate a launch option
//! - R3 / stage-4: `applied_persona` settles as `Hint { name }`
//! - R3 F3: an UNRESOLVABLE persona on a persona-supporting CLI fails the
//!   delegation with `invalid_persona` rather than silently degrading

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;

use codeg_lib::acp::delegation::broker::{
    ConversationDepthLookup, DelegationBroker, DelegationConfig, StatusWait,
};
use codeg_lib::acp::delegation::persona::AppliedPersona;
use codeg_lib::acp::delegation::spawner::{mock::MockSpawner, ConnectionSpawner};
use codeg_lib::acp::delegation::types::{
    DelegationError, DelegationOutcome, DelegationRequest, DelegationSuccess, TaskStatus,
};
use codeg_lib::models::agent::AgentType;

/// Parent conversation is the chain root, so nothing is ever depth-rejected.
struct RootDepth;

#[async_trait]
impl ConversationDepthLookup for RootDepth {
    async fn parent_of(&self, _conversation_id: i32) -> Result<Option<i32>, DelegationError> {
        Ok(None)
    }
}

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
    subagent_type: &str,
    task: &str,
) -> DelegationRequest {
    DelegationRequest {
        parent_connection_id: "parent-conn".into(),
        parent_conversation_id: 1,
        parent_tool_use_id: tool_use.into(),
        agent_type,
        task: task.into(),
        working_dir: None,
        requested_working_dir: None,
        external_handle: None,
        subagent_type: Some(subagent_type.to_string()),
    }
}

/// Write `<config_root>/agents/<name>.md`, creating the agents dir.
fn write_persona(config_root: &Path, name: &str, body: &str) {
    let agents = config_root.join("agents");
    std::fs::create_dir_all(&agents).expect("create agents dir");
    std::fs::write(agents.join(format!("{name}.md")), body).expect("write persona file");
}

/// Drive one delegation to a clean terminal report.
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

/// Shared body for the two Hint-tier happy paths, so Claude Code and Codex are
/// held to the SAME contract without duplicating assertions. The caller supplies
/// the config-dir env override its resolver honours; this helper runs entirely
/// inside that override.
async fn assert_hint_tier(agent_type: AgentType, tool_use: &str, child_conn: &str) {
    let (broker, mock) = enabled_broker().await;
    let report = settle(
        &broker,
        &mock,
        child_conn,
        80,
        persona_request(agent_type, tool_use, "reviewer", "do x"),
    )
    .await;

    assert_eq!(report.status, TaskStatus::Completed);
    assert_eq!(
        report.applied_persona,
        Some(AppliedPersona::Hint {
            name: "reviewer".into()
        }),
        "{agent_type:?}: a resolvable persona must settle as Hint, not Native/Ignored"
    );

    // P3: the Hint tier is mutually exclusive with a launch option.
    {
        let args = mock.spawn_args.lock().await;
        assert_eq!(args.len(), 1, "exactly one spawn");
        assert_eq!(
            args[0].launch_option, None,
            "P3: a Hint persona must NEVER forward a launch option"
        );
    }

    // R5.1: the first-turn task carries the preamble, joined by the `---` fence.
    let tasks = mock.first_prompt_tasks.lock().await;
    assert_eq!(tasks.len(), 1, "exactly one first-turn prompt");
    assert_eq!(
        tasks[0], "You are a strict reviewer.\n\n---\n\ndo x",
        "the persona body must be prepended to the first-turn task verbatim"
    );
}

/// Claude Code Hint tier: `CLAUDE_CONFIG_DIR` -> `<dir>/agents/reviewer.md`.
#[tokio::test]
async fn claude_code_hint_prepends_preamble_and_forwards_no_launch_option() {
    let home = tempfile::tempdir().expect("tempdir");
    write_persona(home.path(), "reviewer", "You are a strict reviewer.");
    temp_env::async_with_vars(
        [("CLAUDE_CONFIG_DIR", Some(home.path()))],
        assert_hint_tier(AgentType::ClaudeCode, "pt-claude", "c-claude"),
    )
    .await;
}

/// Codex Hint tier: same contract, different env knob (`CODEX_HOME`). Proves the
/// tier is a property of the provider family, not a Claude-only special case.
#[tokio::test]
async fn codex_hint_prepends_preamble_and_forwards_no_launch_option() {
    let home = tempfile::tempdir().expect("tempdir");
    write_persona(home.path(), "reviewer", "You are a strict reviewer.");
    temp_env::async_with_vars(
        [("CODEX_HOME", Some(home.path()))],
        assert_hint_tier(AgentType::Codex, "pt-codex", "c-codex"),
    )
    .await;
}

/// R3 F3: a persona-supporting CLI whose persona file does NOT exist must FAIL
/// the delegation with `invalid_persona` — never silently degrade to a
/// no-persona run (which would hand the LLM a subagent that quietly ignored the
/// requested role). Complements the happy paths: it pins the Hint tier's failure
/// edge AND proves the tempdir override is actually in effect (the resolver
/// looked in the empty tempdir, not the host's real config dir).
#[tokio::test]
async fn claude_code_unresolvable_persona_fails_the_delegation() {
    let home = tempfile::tempdir().expect("tempdir");
    // Deliberately no agents/ dir at all.
    temp_env::async_with_vars([("CLAUDE_CONFIG_DIR", Some(home.path()))], async {
        let (broker, mock) = enabled_broker().await;
        mock.queue_spawn(Ok("c-missing".into())).await;
        mock.queue_send(Ok(90)).await;
        let report = broker
            .start_delegation(persona_request(
                AgentType::ClaudeCode,
                "pt-missing",
                "no-such-persona",
                "do x",
            ))
            .await;

        assert_eq!(report.status, TaskStatus::Failed);
        // The delegation aborted BEFORE spawn — no child was ever started.
        assert!(
            mock.spawn_args.lock().await.is_empty(),
            "a persona resolution failure must abort before spawning a child"
        );
    })
    .await;
}
