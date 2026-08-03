//! Merge-order regression tests for the delegate-persona-passthrough spec —
//! review round-2 gap 1: the hop between "broker forwards a `LaunchOption` to
//! `spawn`" and "the Kiro CLI receives `--agent <name>` argv" had no test.
//!
//! # The chain, and what each test owns
//!
//! ```text
//! broker.start_delegation
//!   └─ spawner.spawn(.., launch_option)            ← tests/broker_persona.rs
//!        └─ spawn_child_inner
//!             └─ merge_launch_option_into_runtime_env   ← THIS FILE (gap 1)
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
use codeg_lib::acp::manager::merge_launch_option_into_runtime_env;

/// The env key `connection::kiro_launch_args` reads to emit `--agent <name>`.
/// Written as a LITERAL rather than importing `connection::KIRO_AGENT_ENV`
/// (which is `pub(crate)`): the literal doubles as an independent assertion on
/// the wire name, so renaming the constant cannot silently move the contract.
const KIRO_AGENT_ENV: &str = "KIRO_AGENT";

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
    let merged = merge_launch_option_into_runtime_env(
        BTreeMap::new(),
        Some(&LaunchOption::KiroPersona("plan-reality-recon".into())),
    );
    assert_eq!(
        merged.get(KIRO_AGENT_ENV).map(String::as_str),
        Some("plan-reality-recon"),
        "a Kiro persona must land as KIRO_AGENT=<name> — the key kiro_launch_args reads"
    );
}

/// No launch option ⇒ the runtime env is returned untouched. Legacy (non-persona)
/// delegations and `spawn_for_resume` (R7.4, which always passes `None`) must
/// spawn byte-identically to before the persona feature existed.
#[test]
fn launch_option_merge_without_option_is_identity() {
    let base = env_of(&[("PATH", "/usr/bin"), ("CODEG_X", "1")]);
    let merged = merge_launch_option_into_runtime_env(base.clone(), None);
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
    let merged = merge_launch_option_into_runtime_env(
        panel,
        Some(&LaunchOption::KiroPersona("requested-persona".into())),
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
    let merged = merge_launch_option_into_runtime_env(
        base.clone(),
        Some(&LaunchOption::KiroPersona("recon".into())),
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
    let runtime_env = merge_launch_option_into_runtime_env(
        env_of(&[("PATH", "/usr/bin")]),
        Some(&LaunchOption::KiroPersona("plan-reality-recon".into())),
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
    let runtime_env = merge_launch_option_into_runtime_env(env_of(&[("PATH", "/usr/bin")]), None);
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
    let runtime_env = merge_launch_option_into_runtime_env(
        env_of(&[(KIRO_AGENT_ENV, "panel-default")]),
        Some(&LaunchOption::KiroPersona("requested-persona".into())),
    );
    let argv = codeg_lib::acp::connection::kiro_launch_args(&runtime_env);
    assert_eq!(
        argv,
        vec!["--agent".to_string(), "requested-persona".to_string()],
        "the requested persona must be the one that reaches argv, exactly once"
    );
}
