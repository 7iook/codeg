//! Isolation guard for the per-call launch knobs: the merge must write ONLY
//! into the per-spawn env map it was handed, never into process-global state.
//!
//! # Why this file exists
//!
//! `delegate_to_agent` accepts a per-call `model`, and two delegations
//! dispatched in the same round must not interfere. `broker_persona.rs` pins
//! that at the SPAWN-ARG boundary (each call's `Vec<LaunchOption>` is its own);
//! `persona_merge_order.rs` pins the merge SEMANTICS (which key, which
//! precedence). Neither one would notice if the merge reached its result by
//! calling `std::env::set_var`: the returned map would still look right, and a
//! single-delegation test would still pass — while every concurrent child in
//! the process silently inherited the last writer's model.
//!
//! That failure mode is invisible to a correctness test and only shows up under
//! concurrency, which is exactly why it gets its own guard.
//!
//! # What each test here owns
//!
//! * `merge_does_not_publish_into_process_env` — behavioural: the model the
//!   merge writes must NOT be observable via `std::env::var`, under any key.
//! * `concurrent_merges_on_threads_keep_own_model` — behavioural: real OS
//!   threads merging distinct models simultaneously; catches a shared static
//!   map, which the env check alone would not.
//! * `delegation_spawn_path_has_no_process_env_writes` — source guard for the
//!   part of the path a test binary cannot call (`spawn_child_inner` needs a
//!   live `ConnectionManager` + Tauri handle).

use std::collections::BTreeMap;

use codeg_lib::acp::delegation::persona::LaunchOption;
use codeg_lib::acp::manager::merge_launch_options_into_runtime_env;
use codeg_lib::models::AgentType;

/// Asserted as a literal (same reasoning as `persona_merge_order.rs`): the key
/// `kiro_launch_args` reads to emit `--model <id>`.
const KIRO_MODEL_ENV: &str = "KIRO_MODEL";

/// Behavioural half: after merging a per-call model, that model must NOT be
/// readable out of the PROCESS environment. The merge's only output channel is
/// its return value.
///
/// A `set_var`-based implementation passes every existing merge test (the
/// returned map is still correct) and fails only this one.
#[test]
fn merge_does_not_publish_into_process_env() {
    // A value no other test or parent process would ever set, so a hit is
    // unambiguously ours rather than ambient environment.
    const SENTINEL: &str = "codeg-isolation-sentinel-model-4f2a91";

    // Pre-condition: the sentinel is absent from the env before the merge, so a
    // post-merge hit can only have come FROM the merge. Without this the test
    // could pass vacuously against an env that happened to be dirty.
    let keys_before: Vec<String> = std::env::vars()
        .filter(|(_, v)| v == SENTINEL)
        .map(|(k, _)| k)
        .collect();
    assert!(
        keys_before.is_empty(),
        "test precondition: sentinel must not already be in the env, found under {keys_before:?}"
    );

    let merged = merge_launch_options_into_runtime_env(
        BTreeMap::new(),
        AgentType::Kiro,
        &[LaunchOption::Model(SENTINEL.into())],
    );

    // The value DID reach the returned map — otherwise this test would pass for
    // the wrong reason (a merge that dropped the model entirely).
    assert_eq!(
        merged.get(KIRO_MODEL_ENV).map(String::as_str),
        Some(SENTINEL),
        "sanity: the model must reach the per-spawn map, else this test is vacuous"
    );

    // Scan the WHOLE process env by value, not just the expected key: a broken
    // implementation might publish under `MODEL`, `ANTHROPIC_MODEL`, or any
    // other name, and a single-key check would miss it.
    let leaked: Vec<String> = std::env::vars()
        .filter(|(_, v)| v == SENTINEL)
        .map(|(k, _)| k)
        .collect();
    assert!(
        leaked.is_empty(),
        "the per-call model leaked into the PROCESS environment under {leaked:?} — \
         a process-global env carrier breaks isolation for every concurrent child, \
         since the last writer wins for all of them. The merge must write only \
         into the per-spawn map it returns."
    );
    assert!(
        std::env::var(KIRO_MODEL_ENV).is_err(),
        "KIRO_MODEL must not exist in the process env at all after a merge"
    );
}

/// Behavioural half 2: N OS threads merge distinct models at the same time and
/// each must get back only its own. Catches a shared/static map (which the env
/// scan above would not see) and any interior-mutability accumulator.
///
/// Real threads rather than async tasks on purpose: a single-threaded executor
/// could serialise async tasks into non-overlapping windows and hide a shared
/// map, whereas these genuinely run at once.
#[test]
fn concurrent_merges_on_threads_keep_own_model() {
    let models: Vec<String> = (0..8).map(|i| format!("iso-model-{i}")).collect();

    let results: Vec<(String, BTreeMap<String, String>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = models
            .iter()
            .map(|model| {
                scope.spawn(move || {
                    let merged = merge_launch_options_into_runtime_env(
                        // Each call starts from its own base map, exactly as
                        // `build_session_runtime_env` produces a fresh one per
                        // spawn. The base key is THREAD-UNIQUE on purpose: with
                        // a shared base key, a merge that folded every call into
                        // one accumulating map would still return the right
                        // entry count (the shared keys just overwrite), so the
                        // accumulation would be invisible. A unique key per call
                        // makes another call's presence observable.
                        BTreeMap::from([(format!("CODEG_BASE_{model}"), "1".to_string())]),
                        AgentType::Kiro,
                        &[LaunchOption::Model(model.clone())],
                    );
                    (model.clone(), merged)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("merge thread must not panic"))
            .collect()
    });

    for (requested, merged) in &results {
        assert_eq!(
            merged.get(KIRO_MODEL_ENV).map(String::as_str),
            Some(requested.as_str()),
            "a concurrent merge returned another thread's model — requested {requested}, \
             got {:?}. The knobs are sharing state across calls.",
            merged.get(KIRO_MODEL_ENV)
        );
        // Exactly this call's own base key + its one knob. A merge that folded
        // calls into a shared accumulating map shows up here as extra
        // `CODEG_BASE_*` entries belonging to other calls, even when the model
        // key itself happens to be right.
        assert_eq!(
            merged.len(),
            2,
            "expected exactly CODEG_BASE_{requested} + KIRO_MODEL for {requested}, \
             got {merged:?} — extra entries mean another call's state is in this map"
        );
        assert!(
            merged.contains_key(&format!("CODEG_BASE_{requested}")),
            "{requested}: own base key missing from {merged:?}"
        );
    }
}

/// Source guard for the stretch of the path a test binary cannot execute.
///
/// # Why a source guard here and not a behavioural assertion
///
/// The two tests above cover `merge_launch_options_into_runtime_env`, which is
/// pure and callable. The rest of the chain is not reachable from an
/// integration test: `spawn_child_inner` needs a live `ConnectionManager` with a
/// registered parent connection, a real `AppDatabase`, and an `EventEmitter`,
/// and `spawn_agent` launches an actual child process. Calling into it to
/// observe "did it touch the process env" would mean standing up an agent
/// process — and on this host the lib test binary cannot even load
/// (`STATUS_ENTRYPOINT_NOT_FOUND`). So for that stretch, reading the source is
/// the only mechanism available; it is a deliberate second choice, not a
/// shortcut, and it is scoped as narrowly as the question allows.
///
/// # Scope, and why the legitimate writers are not flagged
///
/// This scans ONLY `src/acp/delegation/` — the modules that handle a per-call
/// delegation request. The repo has legitimate `std::env::set_var` calls, all
/// OUTSIDE this directory and all process-global by intent:
///
/// * `network/proxy.rs` — process-wide proxy vars, set once at startup
/// * `process.rs` — PATH preparation for spawned children
/// * `lib.rs` / `bin/codeg_server.rs` / `git_credential.rs` — `CODEG_DATA_DIR`
///   and the credential-helper token, at startup / in a single-threaded helper
/// * `idle_sweep.rs`, `manager.rs`, `office_watch/mod.rs` — inside `#[cfg(test)]`
///   modules, reading back their own knob
///
/// Those are correct: they are per-process configuration, not per-spawn. The
/// invariant this guard states is narrower — *a per-call knob must not be
/// carried process-globally* — so restricting the scan to the per-call
/// delegation modules is what makes it precise rather than a blanket ban.
///
/// Note `manager.rs` is deliberately NOT scanned despite hosting the merge: it
/// is a 7k-line module whose `#[cfg(test)]` block legitimately sets a timeout
/// env var, so a file-level scan there would flag a false positive. The merge
/// function itself is covered behaviourally by the two tests above, which is
/// the stronger mechanism.
#[test]
fn delegation_spawn_path_has_no_process_env_writes() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/acp/delegation");
    assert!(
        dir.is_dir(),
        "delegation module dir not found at {dir:?} — this guard silently covers \
         nothing if the path moves, so it fails loudly instead"
    );

    let mut scanned = 0usize;
    let mut offenders: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("read delegation dir") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let src = std::fs::read_to_string(&path).expect("read source file");
        scanned += 1;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("<unknown>")
            .to_string();
        for (idx, line) in src.lines().enumerate() {
            // Ignore comments: the modules legitimately DISCUSS why they must
            // not write process env (and this very invariant), so matching
            // prose would make the guard unmaintainable.
            let code = line.split("//").next().unwrap_or("");
            for needle in ["set_var", "remove_var", "set_current_dir"] {
                if code.contains(needle) {
                    offenders.push(format!("{name}:{} → {}", idx + 1, line.trim()));
                }
            }
        }
    }

    // A scan that found no files would pass vacuously forever.
    assert!(
        scanned >= 10,
        "expected to scan the delegation modules, only saw {scanned} .rs files — \
         the guard is not looking where it thinks it is"
    );
    assert!(
        offenders.is_empty(),
        "the per-call delegation path must not mutate PROCESS-GLOBAL state: a \
         `set_var` here would make one delegation's model/persona visible to \
         every concurrent child (last writer wins), which no per-spawn env map \
         can undo. Found:\n  {}",
        offenders.join("\n  ")
    );
}
