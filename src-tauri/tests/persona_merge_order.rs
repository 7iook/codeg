//! Merge-order regression tests for the delegate-persona-passthrough spec —
//! review round-2 gap 1: the hop between "broker forwards a `LaunchOption` to
//! `spawn`" and "the Kiro CLI receives `--agent <name>` argv" had no test.
//!
//! # The chain, and what each test owns
//!
//! ```text
//! broker.start_delegation
//!   └─ spawner.spawn(.., launch_options)           ← tests/broker_persona.rs
//!        └─ spawn_child_inner
//!             └─ merge_launch_options_into_runtime_env  ← THIS FILE (gap 1)
//!                  └─ spawn_agent(runtime_env)     [consumes env BY VALUE]
//!                       └─ build_agent
//!                            ├─ kiro_launch_args(runtime_env) → `--agent <n>`
//!                            └─ apply_kiro_env_policy(&mut child_env, ..)
//! ```
//!
//! `spawn_agent` takes `runtime_env: BTreeMap<..>` **by value**, so a merge
//! performed after that call could not reach the child at all — the ordering is
//! therefore load-bearing, and these tests pin the merge's semantics at the one
//! point where the persona can still be injected.
//!
//! # Note on `apply_kiro_env_policy` (corrects a stale comment)
//!
//! The policy strips `KIRO_*` from the CHILD PROCESS env (`merged_env: Vec<..>`)
//! and takes `runtime_env` by SHARED reference — it cannot unset what
//! `kiro_launch_args` reads. `connection.rs`'s own
//! `kiro_env_policy_strips_codeg_launch_knobs_from_the_child` asserts exactly
//! that stripping, and it is CORRECT behaviour: `KIRO_AGENT` is a codeg-side
//! launch knob translated to argv, not an env var kiro-cli reads. So the real
//! invariant is "merge before `spawn_agent` consumes the env", not "merge before
//! the policy runs".
//!
//! Spec anchors: R2.5 (persona → `KIRO_AGENT` → `--agent` argv), R7.4 (a resume
//! never re-nominates a persona).

use std::collections::BTreeMap;

use codeg_lib::acp::delegation::persona::LaunchOption;
use codeg_lib::acp::manager::merge_launch_options_into_runtime_env;
use codeg_lib::models::AgentType;

/// The env key `connection::kiro_launch_args` reads to emit `--agent <name>`.
/// Written as a LITERAL rather than importing `connection::KIRO_AGENT_ENV`
/// (which is `pub(crate)`): the literal doubles as an independent assertion on
/// the wire name, so renaming the constant cannot silently move the contract.
const KIRO_AGENT_ENV: &str = "KIRO_AGENT";

/// Same reasoning as `KIRO_AGENT_ENV`: the key `kiro_launch_args` reads to emit
/// `--model <id>`, asserted as a literal so a rename cannot move the contract.
const KIRO_MODEL_ENV: &str = "KIRO_MODEL";

fn env_of(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

/// R2.5 core: a Kiro persona lands in the runtime env under exactly the key
/// `connection::kiro_launch_args` reads (`KIRO_AGENT`), with the name verbatim.
///
/// If someone moves the merge out of `spawn_child_inner` (or drops it), this
/// test's call site disappears / the key stops appearing and this goes red.
#[test]
fn launch_option_merge_inserts_kiro_agent_verbatim() {
    let merged = merge_launch_options_into_runtime_env(
        BTreeMap::new(),
        AgentType::Kiro,
        &[LaunchOption::KiroPersona("plan-reality-recon".into())],
    );
    assert_eq!(
        merged.get(KIRO_AGENT_ENV).map(String::as_str),
        Some("plan-reality-recon"),
        "a Kiro persona must land as KIRO_AGENT=<name> — the key kiro_launch_args reads"
    );
}

/// No launch option ⇒ the runtime env is returned untouched. Legacy (non-persona)
/// delegations and `spawn_for_resume` (R7.4, which always passes an empty slice)
/// must spawn byte-identically to before the persona feature existed.
#[test]
fn launch_option_merge_without_option_is_identity() {
    let base = env_of(&[("PATH", "/usr/bin"), ("CODEG_X", "1")]);
    let merged = merge_launch_options_into_runtime_env(base.clone(), AgentType::Kiro, &[]);
    assert_eq!(
        merged, base,
        "no launch option must leave the runtime env byte-identical"
    );
    assert!(
        !merged.contains_key(KIRO_AGENT_ENV),
        "no persona must never synthesize a KIRO_AGENT entry"
    );
}

/// A per-call nomination OVERRIDES a panel-stored `KIRO_AGENT` that
/// `build_session_runtime_env` seeded from `agent_setting.env_json`: the LLM's
/// explicit `subagent_type` wins over the persisted default. Without this, a
/// user who once picked a default agent in the Kiro panel would silently get
/// that agent for every delegated subagent, ignoring the requested persona.
#[test]
fn launch_option_merge_overrides_a_panel_stored_agent() {
    let panel = env_of(&[(KIRO_AGENT_ENV, "panel-default"), ("KIRO_MODEL", "m1")]);
    let merged = merge_launch_options_into_runtime_env(
        panel,
        AgentType::Kiro,
        &[LaunchOption::KiroPersona("requested-persona".into())],
    );
    assert_eq!(
        merged.get(KIRO_AGENT_ENV).map(String::as_str),
        Some("requested-persona"),
        "the per-call nomination must win over the panel-stored default"
    );
    // Sibling knobs are untouched — the merge is surgical, not a replace.
    assert_eq!(merged.get("KIRO_MODEL").map(String::as_str), Some("m1"));
}

/// The merge preserves every unrelated entry `build_session_runtime_env`
/// produced (git credential helper, provider creds, PATH, ...). A merge that
/// rebuilt the map instead of inserting into it would strip the child's
/// configuration — the exact class of bug the "inherit the parent's runtime env"
/// contract exists to prevent.
#[test]
fn launch_option_merge_preserves_unrelated_runtime_env() {
    let base = env_of(&[
        ("PATH", "/usr/bin"),
        ("GIT_ASKPASS", "/codeg/helper"),
        ("ANTHROPIC_API_KEY", "secret"),
    ]);
    let merged = merge_launch_options_into_runtime_env(
        base.clone(),
        AgentType::Kiro,
        &[LaunchOption::KiroPersona("recon".into())],
    );
    for (key, value) in &base {
        assert_eq!(
            merged.get(key),
            Some(value),
            "merge dropped pre-existing runtime env entry {key}"
        );
    }
    assert_eq!(
        merged.len(),
        base.len() + 1,
        "merge added exactly one entry"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// The gap-1 hop itself: merge output → argv, composed in ONE test
// ─────────────────────────────────────────────────────────────────────────────

/// **The review round-2 gap 1 closure.** Composes the two production functions
/// that sit on either side of the previously-untested hop: the merge that
/// `spawn_child_inner` performs, feeding the argv translation that
/// `connection::build_agent` performs. Neither existing test crossed this seam —
/// `connection.rs` started from a hand-built env, and `broker_persona.rs` stopped
/// at the `spawn` boundary.
///
/// Answers the reviewer's question "if someone breaks the merge, which test goes
/// red?" — this one: a merge that writes the wrong key, mangles the name, or
/// no-ops entirely yields argv without `--agent <name>`.
#[test]
fn merged_launch_option_translates_to_agent_argv_end_to_end() {
    // 1. What spawn_child_inner does with the broker's LaunchOption.
    let runtime_env = merge_launch_options_into_runtime_env(
        env_of(&[("PATH", "/usr/bin")]),
        AgentType::Kiro,
        &[LaunchOption::KiroPersona("plan-reality-recon".into())],
    );
    // 2. What build_agent then does with that runtime env.
    let argv = codeg_lib::acp::connection::kiro_launch_args(&runtime_env);

    assert_eq!(
        argv,
        vec!["--agent".to_string(), "plan-reality-recon".to_string()],
        "a merged Kiro persona must reach the CLI as `--agent <name>`"
    );
}

/// The negative half: no launch option ⇒ no `--agent` flag. Guards against a
/// merge that unconditionally inserts a key (which would pin every legacy
/// delegation and every resume to some default agent).
#[test]
fn no_launch_option_yields_no_agent_argv_end_to_end() {
    let runtime_env = merge_launch_options_into_runtime_env(
        env_of(&[("PATH", "/usr/bin")]),
        AgentType::Kiro,
        &[],
    );
    let argv = codeg_lib::acp::connection::kiro_launch_args(&runtime_env);
    assert!(
        !argv.iter().any(|a| a == "--agent"),
        "a delegation with no persona must not emit --agent, got {argv:?}"
    );
}

/// A per-call nomination beats the panel default all the way to argv — the
/// override asserted at the map level above, carried through the translation so
/// exactly ONE `--agent` pair is emitted (a duplicate would make kiro-cli reject
/// the launch).
#[test]
fn per_call_persona_beats_panel_default_in_argv() {
    let runtime_env = merge_launch_options_into_runtime_env(
        env_of(&[(KIRO_AGENT_ENV, "panel-default")]),
        AgentType::Kiro,
        &[LaunchOption::KiroPersona("requested-persona".into())],
    );
    let argv = codeg_lib::acp::connection::kiro_launch_args(&runtime_env);
    assert_eq!(
        argv,
        vec!["--agent".to_string(), "requested-persona".to_string()],
        "the requested persona must be the one that reaches argv, exactly once"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-call MODEL dimension (stage-2-model) — same seam, second variant
// ─────────────────────────────────────────────────────────────────────────────

/// The core per-agent-key claim: the SAME `LaunchOption::Model` variant must
/// land under a DIFFERENT env key depending on the agent type, because that is
/// what each CLI actually reads at launch.
///
/// Kiro is the load-bearing case: it has no arm in `agent_env_keys`, so naively
/// reusing that triple's model slot would write `OPENAI_MODEL` — a key
/// `kiro_launch_args` never reads, producing a delegation that silently ignores
/// the requested model.
#[test]
fn model_merge_uses_the_per_agent_launch_key() {
    let cases: &[(AgentType, &str)] = &[
        (AgentType::Kiro, KIRO_MODEL_ENV),
        (AgentType::ClaudeCode, "ANTHROPIC_MODEL"),
        (AgentType::Gemini, "GEMINI_MODEL"),
        (AgentType::KimiCode, "KIMI_MODEL_NAME"),
        (AgentType::Grok, "GROK_DEFAULT_MODEL"),
        (AgentType::Cursor, "CURSOR_MODEL"),
        // Catch-all family: no dedicated key, so the OpenAI-compatible default.
        (AgentType::Codex, "OPENAI_MODEL"),
        (AgentType::OpenCode, "OPENAI_MODEL"),
    ];
    for (agent_type, expected_key) in cases {
        let merged = merge_launch_options_into_runtime_env(
            BTreeMap::new(),
            *agent_type,
            &[LaunchOption::Model("some-model-id".into())],
        );
        assert_eq!(
            merged.get(*expected_key).map(String::as_str),
            Some("some-model-id"),
            "{agent_type:?}: a per-call model must land under {expected_key}"
        );
        assert_eq!(
            merged.len(),
            1,
            "{agent_type:?}: a per-call model must write exactly ONE key, got {merged:?}"
        );
    }
}

/// Claude Code takes the MAIN key only. The three alias slots
/// (`ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`) and the customOption trio
/// belong to the panel/provider cascade (`CLAUDE_MODEL_KEY_MAP`), and writing
/// them from a per-call argument would redefine what "sonnet" means for the
/// whole child session — a much broader semantic than "this delegation runs on
/// this model".
#[test]
fn model_merge_for_claude_never_touches_the_alias_slots() {
    let merged = merge_launch_options_into_runtime_env(
        BTreeMap::new(),
        AgentType::ClaudeCode,
        &[LaunchOption::Model("claude-opus-5".into())],
    );
    assert_eq!(
        merged.get("ANTHROPIC_MODEL").map(String::as_str),
        Some("claude-opus-5")
    );
    for alias in [
        "ANTHROPIC_REASONING_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_CUSTOM_MODEL_OPTION",
        "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
        "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
    ] {
        assert!(
            !merged.contains_key(alias),
            "a per-call model must NOT write the alias slot {alias}"
        );
    }
}

/// The model id is passed through VERBATIM — no allowlist, no canonicalization.
/// The endpoint may be a relay fronting any vendor, so an id this build has
/// never heard of is legitimate (`normalize_requested_model` already rejected
/// the one unusable class: control characters).
#[test]
fn model_merge_passes_arbitrary_ids_through_verbatim() {
    for id in [
        "claude-sonnet-5",
        "gpt-5.1-codex-max",
        "deepseek-v4",
        "my-relay/Weird_Name:v2",
        "モデル-1",
    ] {
        let merged = merge_launch_options_into_runtime_env(
            BTreeMap::new(),
            AgentType::Kiro,
            &[LaunchOption::Model(id.into())],
        );
        assert_eq!(
            merged.get(KIRO_MODEL_ENV).map(String::as_str),
            Some(id),
            "model id must reach the env verbatim"
        );
    }
}

/// A per-call model OVERRIDES the panel-stored one, for the same reason a
/// per-call persona does: the LLM's explicit argument is scoped to THIS
/// delegation and must win over the persisted default.
#[test]
fn model_merge_overrides_a_panel_stored_model() {
    let panel = env_of(&[(KIRO_MODEL_ENV, "panel-model"), ("KIRO_EFFORT", "high")]);
    let merged = merge_launch_options_into_runtime_env(
        panel,
        AgentType::Kiro,
        &[LaunchOption::Model("requested-model".into())],
    );
    assert_eq!(
        merged.get(KIRO_MODEL_ENV).map(String::as_str),
        Some("requested-model"),
        "the per-call model must win over the panel-stored default"
    );
    // Surgical: an unrelated sibling knob survives.
    assert_eq!(merged.get("KIRO_EFFORT").map(String::as_str), Some("high"));
}

/// **The coexistence claim.** Persona and model are independent dimensions, so
/// "run as persona X on model Y" must produce BOTH env entries — neither
/// clobbers the other. A representation that could only carry one knob (the
/// pre-stage-2 `Option<LaunchOption>`) would silently drop one of them.
#[test]
fn persona_and_model_coexist_in_one_merge() {
    let merged = merge_launch_options_into_runtime_env(
        env_of(&[("PATH", "/usr/bin")]),
        AgentType::Kiro,
        &[
            LaunchOption::KiroPersona("plan-reality-recon".into()),
            LaunchOption::Model("claude-sonnet-5".into()),
        ],
    );
    assert_eq!(
        merged.get(KIRO_AGENT_ENV).map(String::as_str),
        Some("plan-reality-recon"),
        "persona must survive alongside a model"
    );
    assert_eq!(
        merged.get(KIRO_MODEL_ENV).map(String::as_str),
        Some("claude-sonnet-5"),
        "model must survive alongside a persona"
    );
    assert_eq!(merged.get("PATH").map(String::as_str), Some("/usr/bin"));
    assert_eq!(merged.len(), 3, "exactly PATH + the two knobs: {merged:?}");
}

/// Slice order is irrelevant — each variant owns its own key, so the two
/// orderings must produce byte-identical maps. Pins that the merge composes
/// rather than overwriting.
#[test]
fn persona_and_model_merge_is_order_independent() {
    let persona = LaunchOption::KiroPersona("recon".into());
    let model = LaunchOption::Model("m-9".into());
    let a = merge_launch_options_into_runtime_env(
        BTreeMap::new(),
        AgentType::Kiro,
        &[persona.clone(), model.clone()],
    );
    let b =
        merge_launch_options_into_runtime_env(BTreeMap::new(), AgentType::Kiro, &[model, persona]);
    assert_eq!(a, b, "merge must not depend on slice order");
}

/// Absent model ⇒ the runtime env is byte-identical to today, and specifically
/// no model key is synthesized for ANY agent type. This is the regression guard
/// for every legacy delegation: a merge that unconditionally inserted a model
/// key would pin every child to an empty / default model.
#[test]
fn no_model_option_synthesizes_no_model_key_for_any_agent() {
    let base = env_of(&[("PATH", "/usr/bin"), ("GIT_ASKPASS", "/codeg/helper")]);
    for agent_type in [
        AgentType::Kiro,
        AgentType::ClaudeCode,
        AgentType::Gemini,
        AgentType::Codex,
        AgentType::Cursor,
        AgentType::Grok,
        AgentType::KimiCode,
    ] {
        // Persona-only (Kiro adds exactly one key) and empty slice.
        let empty = merge_launch_options_into_runtime_env(base.clone(), agent_type, &[]);
        assert_eq!(
            empty, base,
            "{agent_type:?}: an empty slice must leave runtime_env byte-identical"
        );
        let persona_only = merge_launch_options_into_runtime_env(
            base.clone(),
            agent_type,
            &[LaunchOption::KiroPersona("recon".into())],
        );
        for key in [
            KIRO_MODEL_ENV,
            "ANTHROPIC_MODEL",
            "GEMINI_MODEL",
            "OPENAI_MODEL",
            "CURSOR_MODEL",
            "GROK_DEFAULT_MODEL",
            "KIMI_MODEL_NAME",
        ] {
            assert!(
                !persona_only.contains_key(key),
                "{agent_type:?}: a persona-only call must not synthesize {key}"
            );
        }
    }
}

/// The model half of the gap-1 hop: merge output → argv, for the one agent whose
/// argv translation is verified in-repo. `kiro_launch_args` turns `KIRO_MODEL`
/// into `--model <id>`, so this composes the two production functions and proves
/// a per-call model actually reaches the child's command line.
#[test]
fn merged_model_translates_to_model_argv_end_to_end() {
    let runtime_env = merge_launch_options_into_runtime_env(
        env_of(&[("PATH", "/usr/bin")]),
        AgentType::Kiro,
        &[LaunchOption::Model("claude-sonnet-5".into())],
    );
    let argv = codeg_lib::acp::connection::kiro_launch_args(&runtime_env);
    assert_eq!(
        argv,
        vec!["--model".to_string(), "claude-sonnet-5".to_string()],
        "a merged per-call model must reach the CLI as `--model <id>`"
    );
}

/// Persona + model, all the way to argv: both flags present, each exactly once,
/// in `kiro_launch_args`' fixed order (model → effort → trust → agent). A
/// duplicate pair would make kiro-cli reject the launch.
#[test]
fn merged_persona_and_model_both_reach_argv() {
    let runtime_env = merge_launch_options_into_runtime_env(
        env_of(&[("PATH", "/usr/bin")]),
        AgentType::Kiro,
        &[
            LaunchOption::KiroPersona("plan-reality-recon".into()),
            LaunchOption::Model("claude-sonnet-5".into()),
        ],
    );
    let argv = codeg_lib::acp::connection::kiro_launch_args(&runtime_env);
    assert_eq!(
        argv,
        vec![
            "--model".to_string(),
            "claude-sonnet-5".to_string(),
            "--agent".to_string(),
            "plan-reality-recon".to_string(),
        ],
        "persona and model must BOTH reach argv, each exactly once"
    );
}

/// A per-call model beats the panel default all the way to argv, with exactly
/// one `--model` pair emitted.
#[test]
fn per_call_model_beats_panel_default_in_argv() {
    let runtime_env = merge_launch_options_into_runtime_env(
        env_of(&[(KIRO_MODEL_ENV, "panel-model")]),
        AgentType::Kiro,
        &[LaunchOption::Model("requested-model".into())],
    );
    let argv = codeg_lib::acp::connection::kiro_launch_args(&runtime_env);
    assert_eq!(
        argv,
        vec!["--model".to_string(), "requested-model".to_string()],
        "the requested model must be the one that reaches argv, exactly once"
    );
}

/// Negative half: no model option ⇒ no `--model` flag reaches argv.
#[test]
fn no_model_option_yields_no_model_argv_end_to_end() {
    let runtime_env = merge_launch_options_into_runtime_env(
        env_of(&[("PATH", "/usr/bin")]),
        AgentType::Kiro,
        &[LaunchOption::KiroPersona("recon".into())],
    );
    let argv = codeg_lib::acp::connection::kiro_launch_args(&runtime_env);
    assert!(
        !argv.iter().any(|a| a == "--model"),
        "a delegation with no per-call model must not emit --model, got {argv:?}"
    );
}
