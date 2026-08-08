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
//! `LaunchOption`s must land in `MockSpawner::spawn_args[..].launch_options`.
//! Since stage-2-model that vector carries TWO independent dimensions — a
//! persona nomination and/or a per-call model — so the tail of this file also
//! pins that they coexist rather than clobbering each other.

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
    request_with(agent_type, tool_use, subagent_type, None)
}

/// Full-control request builder: both per-call launch dimensions.
fn request_with(
    agent_type: AgentType,
    tool_use: &str,
    subagent_type: Option<&str>,
    model: Option<&str>,
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
        model: model.map(str::to_string),
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
                requested_model: None,
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
        args[0].launch_options,
        vec![LaunchOption::KiroPersona("plan-reality-recon".into())],
        "the resolved Kiro LaunchOption must reach spawn (P0-1)"
    );
    // Native path leaves the first-turn task text unchanged (no Hint preamble).
    assert_eq!(
        mock.first_prompt_tasks.lock().await.as_slice(),
        &["do x".to_string()],
    );
}

/// A delegation WITHOUT a persona nomination forwards NO launch option —
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
    assert!(args[0].launch_options.is_empty());
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
    assert!(
        args[0].launch_options.is_empty(),
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
        args[0].launch_options,
        vec![LaunchOption::KiroPersona("plan-reality-recon".into())],
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
        // RUNTIME shape sentinel, not a compile-time one. A slice pattern
        // cannot be exhaustive over length, so the `other =>` arm below is
        // unavoidable and a THIRD `LaunchOption` variant will NOT break this
        // test at compile time — it fails here only if such an option actually
        // reaches spawn in this scenario. The compile-time exhaustiveness
        // guarantee lives in exactly two places, both matching on the enum
        // itself: `launch_option_variants_are_exactly_kiro_persona_and_model_v2`
        // in `persona.rs`, and the `match option` in
        // `manager::merge_launch_options_into_runtime_env` (no `_ =>` arm).
        // Neither request here sets `model`, so `Model` is asserted absent
        // rather than wildcarded, which keeps the failure message specific.
        .map(|a| match a.launch_options.as_slice() {
            [] => None,
            [LaunchOption::KiroPersona(n)] => Some(n.clone()),
            [LaunchOption::Model(m)] => {
                panic!("no request set `model`, yet a Model option reached spawn: {m}")
            }
            other => panic!("unexpected launch option set reached spawn: {other:?}"),
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

// ─────────────────────────────────────────────────────────────────────────────
// Per-call MODEL dimension at the spawn-arg boundary (stage-2-model)
// ─────────────────────────────────────────────────────────────────────────────

/// The model half of the P0 wiring: a `model` on the request must reach `spawn`
/// as `LaunchOption::Model`. Without this the field would be parsed and carried
/// (stage 1) but have no consumer — exactly the "built but not wired" shape.
#[tokio::test]
async fn per_call_model_reaches_spawn_as_launch_option() {
    let (broker, mock) = enabled_broker().await;
    let report = settle(
        &broker,
        &mock,
        "c-model",
        80,
        request_with(AgentType::Kiro, "pt-model", None, Some("claude-sonnet-5")),
    )
    .await;

    assert_eq!(report.status, TaskStatus::Completed);
    let args = mock.spawn_args.lock().await;
    assert_eq!(args.len(), 1, "exactly one spawn");
    assert_eq!(
        args[0].launch_options,
        vec![LaunchOption::Model("claude-sonnet-5".into())],
        "a per-call model must reach spawn as LaunchOption::Model"
    );
}

/// **Coexistence at the broker boundary.** Persona and model are independent
/// launch dimensions, so a call setting both must forward BOTH to `spawn`. The
/// pre-stage-2 single-`Option` parameter could not express this — one knob would
/// have been silently dropped.
#[tokio::test]
async fn persona_and_model_both_reach_spawn() {
    let (broker, mock) = enabled_broker().await;
    let report = settle(
        &broker,
        &mock,
        "c-both",
        81,
        request_with(
            AgentType::Kiro,
            "pt-both",
            Some("plan-reality-recon"),
            Some("claude-sonnet-5"),
        ),
    )
    .await;

    assert_eq!(report.status, TaskStatus::Completed);
    // Persona attribution is unaffected by the model riding along.
    assert_eq!(
        report.applied_persona,
        Some(AppliedPersona::Native {
            name: "plan-reality-recon".into()
        }),
        "a per-call model must not disturb persona attribution"
    );
    let args = mock.spawn_args.lock().await;
    let opts = &args[0].launch_options;
    assert_eq!(opts.len(), 2, "both knobs must be forwarded, got {opts:?}");
    assert!(
        opts.contains(&LaunchOption::KiroPersona("plan-reality-recon".into())),
        "persona missing from {opts:?}"
    );
    assert!(
        opts.contains(&LaunchOption::Model("claude-sonnet-5".into())),
        "model missing from {opts:?}"
    );
    // Native path still leaves the first-turn task text alone.
    assert_eq!(
        mock.first_prompt_tasks.lock().await.as_slice(),
        &["do x".to_string()],
    );
}

/// A per-call model is forwarded even when the CLI has NO persona concept
/// (Gemini): the two dimensions are independent, so the persona downgrade must
/// not swallow the model. Asserts the model survives while the persona is
/// dropped.
#[tokio::test]
async fn model_survives_a_persona_downgrade_on_an_unsupported_cli() {
    let (broker, mock) = enabled_broker().await;
    let report = settle(
        &broker,
        &mock,
        "c-gem-model",
        82,
        request_with(
            AgentType::Gemini,
            "pt-gem-model",
            Some("some-agent"),
            Some("gemini-3-pro"),
        ),
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
        args[0].launch_options,
        vec![LaunchOption::Model("gemini-3-pro".into())],
        "the model must survive while the unsupported persona is dropped"
    );
}

/// A Hint-tier persona (Claude Code / Codex) prepends to the task text and
/// forwards NO persona launch option — but a per-call model still must reach
/// spawn. Guards against the model being tied to the Native leg.
#[tokio::test]
async fn model_reaches_spawn_on_the_hint_leg_too() {
    let (broker, mock) = enabled_broker().await;
    // No persona nominated, so no filesystem dependency: this isolates the
    // model dimension for a non-Kiro CLI whose model key is ANTHROPIC_MODEL.
    let report = settle(
        &broker,
        &mock,
        "c-claude-model",
        83,
        request_with(
            AgentType::ClaudeCode,
            "pt-claude-model",
            None,
            Some("claude-opus-5"),
        ),
    )
    .await;

    assert_eq!(report.status, TaskStatus::Completed);
    let args = mock.spawn_args.lock().await;
    assert_eq!(
        args[0].launch_options,
        vec![LaunchOption::Model("claude-opus-5".into())],
    );
}

/// Absent model ⇒ no `Model` option is forwarded, for any agent. The regression
/// guard for every pre-stage-2 delegation.
#[tokio::test]
async fn no_model_forwards_no_model_option() {
    let (broker, mock) = enabled_broker().await;
    let report = settle(
        &broker,
        &mock,
        "c-nomodel",
        84,
        request_with(
            AgentType::Kiro,
            "pt-nomodel",
            Some("plan-reality-recon"),
            None,
        ),
    )
    .await;

    assert_eq!(report.status, TaskStatus::Completed);
    let args = mock.spawn_args.lock().await;
    assert_eq!(
        args[0].launch_options,
        vec![LaunchOption::KiroPersona("plan-reality-recon".into())],
        "with no per-call model, only the persona may be forwarded"
    );
}

/// Concurrency: two simultaneous delegations with DIFFERENT models keep
/// independent launch options — one call's model never bleeds into the other's
/// spawn. Same shape as the persona cross-contamination test.
#[tokio::test]
async fn concurrent_distinct_models_do_not_cross() {
    let (broker, mock) = enabled_broker().await;
    mock.queue_spawn(Ok("c-m-a".into())).await;
    mock.queue_spawn(Ok("c-m-b".into())).await;
    mock.queue_send(Ok(90)).await;
    mock.queue_send(Ok(91)).await;

    let (ack_a, ack_b) = tokio::join!(
        broker.start_delegation(request_with(
            AgentType::Kiro,
            "pt-m-a",
            None,
            Some("model-a")
        )),
        broker.start_delegation(request_with(
            AgentType::Kiro,
            "pt-m-b",
            None,
            Some("model-b")
        ))
    );
    assert_eq!(ack_a.status, TaskStatus::Running);
    assert_eq!(ack_b.status, TaskStatus::Running);

    let args = mock.spawn_args.lock().await;
    assert_eq!(args.len(), 2, "both concurrent delegations spawned");
    let mut models: Vec<String> = args
        .iter()
        // Runtime shape assertion (a slice pattern cannot be exhaustive over
        // length). Compile-time variant exhaustiveness is enforced elsewhere —
        // see the note on the same pattern earlier in this file.
        .map(|a| match a.launch_options.as_slice() {
            [LaunchOption::Model(m)] => m.clone(),
            other => panic!("expected exactly one Model option, got {other:?}"),
        })
        .collect();
    models.sort();
    assert_eq!(
        models,
        vec!["model-a".to_string(), "model-b".to_string()],
        "each concurrent spawn keeps its own model — no cross-contamination"
    );
}

/// Cross-dimension isolation under concurrency: A carries a persona and NO
/// model, B carries a model and NO persona, dispatched simultaneously. Neither
/// may acquire the other's knob.
///
/// # Why this is not covered by the two tests above
///
/// `concurrent_same_agent_distinct_personas_do_not_cross` varies ONE dimension
/// (two personas, no model anywhere) and `concurrent_distinct_models_do_not_cross`
/// varies the other (two models, no persona anywhere). In both, the absent
/// dimension is absent from BOTH requests, so a leak of it has nothing to leak
/// FROM — a broker that appended every call's knobs to one shared vector would
/// still pass them as long as the two calls agreed on which dimensions were set.
/// `persona_and_model_coexist_on_one_delegation` covers two knobs in ONE call,
/// which is a different property again (composition, not isolation).
///
/// This test is the asymmetric case: each request sets exactly one dimension,
/// and they are DIFFERENT dimensions. A shared / reused knob vector shows up
/// here as a spawn carrying BOTH options while its request asked for one.
#[tokio::test]
async fn concurrent_persona_only_and_model_only_do_not_bleed() {
    let (broker, mock) = enabled_broker().await;
    mock.queue_spawn(Ok("c-mix-a".into())).await;
    mock.queue_spawn(Ok("c-mix-b".into())).await;
    mock.queue_send(Ok(92)).await;
    mock.queue_send(Ok(93)).await;

    // Both Kiro so `agent_type` cannot disambiguate the two spawns, and so the
    // persona takes the Native leg (a real launch option) rather than a Hint.
    let (ack_a, ack_b) = tokio::join!(
        broker.start_delegation(request_with(
            AgentType::Kiro,
            "pt-mix-a",
            Some("recon-agent"),
            None,
        )),
        broker.start_delegation(request_with(
            AgentType::Kiro,
            "pt-mix-b",
            None,
            Some("model-only-b"),
        ))
    );
    assert_eq!(ack_a.status, TaskStatus::Running);
    assert_eq!(ack_b.status, TaskStatus::Running);

    let args = mock.spawn_args.lock().await;
    assert_eq!(args.len(), 2, "both concurrent delegations spawned");

    // Pop order under `join!` is nondeterministic, so classify by CONTENT and
    // assert on the resulting set. Each arm is exhaustive on purpose (mirroring
    // the sibling concurrency tests): a third `LaunchOption` variant, or a
    // spawn carrying two options when its request set one, lands in a `panic!`
    // arm that names the leak rather than silently sorting into place.
    let mut seen: Vec<Vec<String>> = args
        .iter()
        .map(|a| match a.launch_options.as_slice() {
            [LaunchOption::KiroPersona(n)] => vec![format!("persona={n}")],
            [LaunchOption::Model(m)] => vec![format!("model={m}")],
            [] => panic!(
                "a spawn received NO launch option, but each request set exactly one: {:?}",
                a.launch_options
            ),
            other => panic!(
                "a spawn received {} launch options but its request set exactly ONE — \
                 the other call's knob bled across: {other:?}",
                other.len()
            ),
        })
        .collect();
    seen.sort();
    assert_eq!(
        seen,
        vec![
            vec!["model=model-only-b".to_string()],
            vec!["persona=recon-agent".to_string()],
        ],
        "the persona-only call must not acquire B's model and the model-only \
         call must not acquire A's persona"
    );
}

/// The report must echo the per-call model that was actually delivered to the
/// child's launch, on BOTH the running ack and the terminal report — the
/// polling path (`get_delegation_status`) reads the latter, so a field carried
/// only on the ack would silently vanish for anyone who polls.
///
/// Deliberately named `requested_model`: codeg guarantees DELIVERY, never that
/// the endpoint honoured the id (a relay may answer with its own default).
#[tokio::test]
async fn requested_model_rides_both_the_ack_and_the_terminal_report() {
    let (broker, mock) = enabled_broker().await;
    mock.queue_spawn(Ok("c-model-echo".into())).await;
    mock.queue_send(Ok(90)).await;

    let ack = broker
        .start_delegation(request_with(
            AgentType::Kiro,
            "pt-model-echo",
            None,
            Some("claude-sonnet-5"),
        ))
        .await;
    // The ack is what the card renders while the child is still running.
    assert_eq!(ack.status, TaskStatus::Running);
    assert_eq!(
        ack.requested_model.as_deref(),
        Some("claude-sonnet-5"),
        "the running ack must carry the model so the card can show it mid-run"
    );

    let task_id = ack.task_id.expect("running ack carries a task id");
    broker
        .complete_call(
            &task_id,
            DelegationOutcome::Ok(DelegationSuccess {
                text: "done".into(),
                child_conversation_id: 90,
                child_agent_type: AgentType::Kiro,
                turn_count: 1,
                duration_ms: 5,
                token_usage: None,
                applied_persona: None,
                requested_model: None, // broker overrides from stored intent
            }),
        )
        .await;
    let report = broker
        .get_task_status("parent-conn", Some(1), &task_id, StatusWait::Immediate)
        .await;

    assert_eq!(report.status, TaskStatus::Completed);
    assert_eq!(
        report.requested_model.as_deref(),
        Some("claude-sonnet-5"),
        "the terminal report (the polling path) must carry it too"
    );
}

/// A call that nominated NO model leaves the field `None` on both payloads —
/// the card then renders nothing rather than inventing "default".
#[tokio::test]
async fn no_model_nomination_leaves_requested_model_none() {
    let (broker, mock) = enabled_broker().await;
    let report = settle(
        &broker,
        &mock,
        "c-no-model",
        91,
        request_with(AgentType::Kiro, "pt-no-model", None, None),
    )
    .await;

    assert_eq!(report.status, TaskStatus::Completed);
    assert!(
        report.requested_model.is_none(),
        "no nomination must yield no model on the report"
    );
}

/// Timing invariant, mirroring R3-A2 for the persona: a spawn FAILURE leaves
/// `requested_model` = `None`. The id never reached a running child, so
/// reporting it would tell the user a model was requested of a sub-agent that
/// does not exist.
#[tokio::test]
async fn spawn_failure_leaves_requested_model_none() {
    let (broker, mock) = enabled_broker().await;
    mock.queue_spawn(Err(
        codeg_lib::acp::delegation::spawner::SpawnerError::Spawn("boom".into()),
    ))
    .await;
    let report = broker
        .start_delegation(request_with(
            AgentType::Kiro,
            "pt-model-fail",
            None,
            Some("claude-sonnet-5"),
        ))
        .await;

    assert_eq!(report.status, TaskStatus::Failed);
    assert!(
        report.requested_model.is_none(),
        "a failed spawn must not claim a model was requested of a live child"
    );
    // The option WAS forwarded — the failure is downstream of the nomination.
    let args = mock.spawn_args.lock().await;
    assert_eq!(
        args[0].launch_options,
        vec![LaunchOption::Model("claude-sonnet-5".into())],
    );
}

/// Per-call isolation for the echoed field: two concurrent delegations with
/// DIFFERENT models must each report their own. A shared/global read would
/// make both reports show whichever call spawned last.
#[tokio::test]
async fn concurrent_calls_report_their_own_requested_model() {
    let (broker, mock) = enabled_broker().await;
    mock.queue_spawn(Ok("c-m-a".into())).await;
    mock.queue_send(Ok(95)).await;
    mock.queue_spawn(Ok("c-m-b".into())).await;
    mock.queue_send(Ok(96)).await;

    let ack_a = broker
        .start_delegation(request_with(
            AgentType::Kiro,
            "pt-m-a",
            None,
            Some("model-alpha"),
        ))
        .await;
    let ack_b = broker
        .start_delegation(request_with(
            AgentType::Kiro,
            "pt-m-b",
            None,
            Some("model-beta"),
        ))
        .await;

    assert_eq!(ack_a.requested_model.as_deref(), Some("model-alpha"));
    assert_eq!(
        ack_b.requested_model.as_deref(),
        Some("model-beta"),
        "the second call's model must not be overwritten by the first"
    );
}
