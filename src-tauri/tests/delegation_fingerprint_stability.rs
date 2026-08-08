//! A per-call launch knob must not make a live session look "stale".
//!
//! # The defect this file pins
//!
//! `connection::spawn_agent_connection` stores a `config_fingerprint` for every
//! live connection. A later settings save recomputes a CANONICAL fingerprint via
//! `commands::acp::compute_session_config_fingerprint` → `build_session_runtime_env`
//! and `manager::refresh_connection_staleness` flags every connection whose
//! stored value differs. Delegation, however, injects per-call launch knobs
//! (`LaunchOption::KiroPersona` → `KIRO_AGENT`, `LaunchOption::Model` → the
//! agent's model key) into that same env map just before spawn. Those knobs are
//! per-CALL, so `build_session_runtime_env` never reproduces them and the
//! canonical fingerprint can never equal the stored one — every settings save
//! marked such a session "needs restart" even though the user changed nothing.
//!
//! # Why the exemption cannot be by key NAME
//!
//! `KIRO_AGENT` / `KIRO_MODEL` / `ANTHROPIC_MODEL` / `OPENAI_MODEL` are ALSO
//! legitimate user-configured keys that the settings panel writes into
//! `env_json`. Exempting them by name would mean a user genuinely switching
//! their configured model no longer marks running sessions stale — silently
//! disabling a working feature, which is worse than the bug being fixed.
//! `is_volatile_fingerprint_key` is therefore NOT the right lever: it excludes
//! keys that are per-launch *by name* (`OPENCLAW_RESET_SESSION`, never
//! user-configurable). A per-call knob shares its name with user config, so it
//! can only be excluded POSITIONALLY — by which map it is absent from.
//!
//! Hence `manager::spawn_env_and_fingerprint`: the merge and the fingerprint are
//! computed together, the child gets the MERGED env (delivery unchanged) while
//! the fingerprint is taken from the PRE-merge map (the user-config surface the
//! canonical recompute also sees). `spawn_agent_connection` stores that value
//! verbatim instead of re-deriving one from the post-merge env.
//!
//! # Why an integration test and not a `#[cfg(test)]` unit test
//!
//! Same reason `merge_launch_options_into_runtime_env` is `pub` and pinned from
//! `tests/persona_merge_order.rs`: on this Windows host a Tauri native
//! dependency aborts the `codeg_lib` lib-test binary at startup with
//! `STATUS_ENTRYPOINT_NOT_FOUND`, so the `fingerprint_config` unit tests inside
//! `commands::acp` never actually execute here. An integration crate links only
//! the public API and does run.

use std::collections::BTreeMap;

use codeg_lib::acp::delegation::persona::LaunchOption;
use codeg_lib::acp::manager::spawn_env_and_fingerprint;
use codeg_lib::commands::acp::fingerprint_config;
use codeg_lib::models::AgentType;

/// Written as literals rather than importing the `pub(crate)` constants, so a
/// rename of the constant cannot silently move the contract these tests pin
/// (same convention as `tests/persona_merge_order.rs`).
const KIRO_AGENT_ENV: &str = "KIRO_AGENT";
const KIRO_MODEL_ENV: &str = "KIRO_MODEL";

fn env_of(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

/// `AgentType::Kiro` and `AgentType::OpenClaw` are used throughout because
/// neither folds an on-disk native config into the fingerprint
/// (`agent_local_config_path` returns `None` for both, and neither is one of the
/// Codex / Cline / KimiCode / Grok / Cursor special cases). The assertions
/// therefore depend only on the env maps, with no `temp_env` scope needed.
#[test]
fn per_call_model_does_not_flip_the_fingerprint() {
    // The user has a model configured in the settings panel.
    let configured = env_of(&[
        ("KIRO_HOME", "/home/u/.kiro"),
        (KIRO_MODEL_ENV, "user-configured-model"),
    ]);

    let (merged, fingerprint) = spawn_env_and_fingerprint(
        configured.clone(),
        AgentType::Kiro,
        &[LaunchOption::Model("per-call-model".into())],
    );

    // Delivery is unchanged: the child really does launch on the nominated
    // model, overriding the panel-stored default for this call.
    assert_eq!(
        merged.get(KIRO_MODEL_ENV).map(String::as_str),
        Some("per-call-model"),
        "the per-call model must still reach the child's runtime env"
    );

    // Staleness is unaffected: the stored fingerprint equals the one the
    // canonical recompute produces from user config alone.
    assert_eq!(
        fingerprint,
        fingerprint_config(AgentType::Kiro, &configured),
        "a per-call model must NOT flip the fingerprint — otherwise every \
         settings save marks this live session stale"
    );
}

/// The persona case, latent since that feature landed: same defect, same fix.
#[test]
fn per_call_persona_does_not_flip_the_fingerprint() {
    let configured = env_of(&[
        ("KIRO_HOME", "/home/u/.kiro"),
        (KIRO_AGENT_ENV, "user-configured-agent"),
    ]);

    let (merged, fingerprint) = spawn_env_and_fingerprint(
        configured.clone(),
        AgentType::Kiro,
        &[LaunchOption::KiroPersona("plan-reality-recon".into())],
    );

    assert_eq!(
        merged.get(KIRO_AGENT_ENV).map(String::as_str),
        Some("plan-reality-recon"),
        "the per-call persona must still reach the child's runtime env"
    );
    assert_eq!(
        fingerprint,
        fingerprint_config(AgentType::Kiro, &configured),
        "a per-call persona must NOT flip the fingerprint"
    );
}

/// Both knobs at once — "run as persona X on model Y" is a legitimate call.
#[test]
fn both_per_call_knobs_together_do_not_flip_the_fingerprint() {
    let configured = env_of(&[("KIRO_HOME", "/home/u/.kiro")]);

    let (merged, fingerprint) = spawn_env_and_fingerprint(
        configured.clone(),
        AgentType::Kiro,
        &[
            LaunchOption::KiroPersona("executor".into()),
            LaunchOption::Model("sonnet-x".into()),
        ],
    );

    assert_eq!(
        merged.get(KIRO_AGENT_ENV).map(String::as_str),
        Some("executor")
    );
    assert_eq!(
        merged.get(KIRO_MODEL_ENV).map(String::as_str),
        Some("sonnet-x")
    );
    assert_eq!(
        fingerprint,
        fingerprint_config(AgentType::Kiro, &configured),
        "neither knob may flip the fingerprint, together or alone"
    );
}

/// THE ANTI-REGRESSION FOR THE TRAP. A user genuinely changing their configured
/// model — under the SAME key a per-call knob would occupy — MUST still flip the
/// fingerprint and mark running sessions stale.
///
/// Exempting `KIRO_MODEL` by NAME inside `is_volatile_fingerprint_key` (or by
/// dropping the key from the hash) makes these two fingerprints equal and this
/// test goes red. That is the failure mode being guarded against: it would
/// silently disable a working staleness feature, which is worse than the bug
/// this file's other tests fix.
#[test]
fn a_user_configured_change_under_the_same_key_still_flips_the_fingerprint() {
    let per_call = [LaunchOption::Model("per-call-model".into())];

    let (_, fp_m1) = spawn_env_and_fingerprint(
        env_of(&[("KIRO_HOME", "/home/u/.kiro"), (KIRO_MODEL_ENV, "model-1")]),
        AgentType::Kiro,
        &per_call,
    );
    let (_, fp_m2) = spawn_env_and_fingerprint(
        env_of(&[("KIRO_HOME", "/home/u/.kiro"), (KIRO_MODEL_ENV, "model-2")]),
        AgentType::Kiro,
        &per_call,
    );

    assert_ne!(
        fp_m1, fp_m2,
        "a user-configured model change under the same key MUST still flip the \
         fingerprint — exempting the key by name would break this"
    );
}

/// Same guarantee for the persona key.
#[test]
fn a_user_configured_persona_change_still_flips_the_fingerprint() {
    let per_call = [LaunchOption::KiroPersona("per-call-agent".into())];

    let (_, fp_a) = spawn_env_and_fingerprint(
        env_of(&[(KIRO_AGENT_ENV, "configured-a")]),
        AgentType::Kiro,
        &per_call,
    );
    let (_, fp_b) = spawn_env_and_fingerprint(
        env_of(&[(KIRO_AGENT_ENV, "configured-b")]),
        AgentType::Kiro,
        &per_call,
    );

    assert_ne!(
        fp_a, fp_b,
        "a user-configured persona change under the same key MUST still flip \
         the fingerprint"
    );
}

/// Any other user-config change still flips it too — the fix must not have
/// widened into "ignore the env entirely".
#[test]
fn an_unrelated_user_config_change_still_flips_the_fingerprint() {
    let per_call = [LaunchOption::Model("per-call-model".into())];

    let (_, fp_k1) = spawn_env_and_fingerprint(
        env_of(&[("KIRO_API_KEY", "k1")]),
        AgentType::Kiro,
        &per_call,
    );
    let (_, fp_k2) = spawn_env_and_fingerprint(
        env_of(&[("KIRO_API_KEY", "k2")]),
        AgentType::Kiro,
        &per_call,
    );

    assert_ne!(
        fp_k1, fp_k2,
        "an unrelated config change must still flip it"
    );
}

/// No launch options = the plain path every non-delegation spawn takes. The
/// fingerprint must be exactly what it was before this change: the digest of
/// the env as handed in.
#[test]
fn without_launch_options_the_fingerprint_is_the_plain_env_digest() {
    let env = env_of(&[("KIRO_HOME", "/home/u/.kiro"), (KIRO_MODEL_ENV, "m")]);

    let (merged, fingerprint) = spawn_env_and_fingerprint(env.clone(), AgentType::Kiro, &[]);

    assert_eq!(merged, env, "an empty option slice must not alter the env");
    assert_eq!(fingerprint, fingerprint_config(AgentType::Kiro, &env));
}

/// The pre-existing volatile-key behaviour is untouched: `OPENCLAW_RESET_SESSION`
/// is set iff `session_id` is None at spawn, so it must stay excluded by NAME —
/// it is never user-configurable, which is exactly what distinguishes it from a
/// per-call knob.
#[test]
fn openclaw_reset_session_remains_excluded_by_name() {
    let base = env_of(&[("OPENAI_API_KEY", "k")]);
    let mut with_reset = base.clone();
    with_reset.insert("OPENCLAW_RESET_SESSION".to_string(), "1".to_string());

    let (_, fp_base) = spawn_env_and_fingerprint(base, AgentType::OpenClaw, &[]);
    let (_, fp_reset) = spawn_env_and_fingerprint(with_reset, AgentType::OpenClaw, &[]);

    assert_eq!(
        fp_base, fp_reset,
        "OPENCLAW_RESET_SESSION must remain excluded from the fingerprint"
    );
}
