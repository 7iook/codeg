//! Integration tests for stage 3 of the delegate-persona-passthrough spec.
//!
//! # Why this file exists (isolated from the inline `mod tests` in persona.rs)
//!
//! `persona.rs::mod tests` also contains a complete set of stage-3 tests,
//! but running them via `cargo test --lib` requires the whole `#[cfg(test)]`
//! subtree of the delegation module to compile. Stage 1 landed
//! `DelegationSuccess.applied_persona` and `DelegationRequest.subagent_type`
//! into the wire types but explicitly deferred the mock-literal backfill in
//! `broker.rs` / `listener.rs` / `manager.rs` / `lifecycle.rs` /
//! `web/handlers/delegation.rs` test modules to stage 4/5 (stage-1 Update
//! Log). Those test files still use the pre-stage-1 field set, so
//! `cargo test --lib` reports ~49 E0063 missing-field errors that stage 3 is
//! forbidden from touching.
//!
//! An integration test crate only compiles the library's *public* API, not
//! its inline `#[cfg(test)]` modules — so this file re-exercises the stage-3
//! contract (resolver safety + frontmatter) against the same public
//! `resolve_preamble_at` / `PersonaError` surface, and links even while the
//! blocked test-tree debt sits open.
//!
//! Stage-3 spec anchors covered:
//! - R2 F4 direct-child canonical guard + TOCTOU-safe open + `BufReader::take`
//!   hard read cap
//! - R2 F2 strict frontmatter parsing (unclosed fence → hard fail)
//! - Requirement 3-name-grammar (Property 6) defensive re-check inside the
//!   resolver
//! - Requirement 8.1 UTF-8 + BOM handling

use codeg_lib::acp::delegation::persona::{
    is_valid_persona_name, resolve_preamble_at, PersonaError,
};
use std::path::Path;
use tempfile::TempDir;

fn make_agents_root() -> TempDir {
    tempfile::tempdir().expect("tempdir for agents root")
}

fn write_persona(root: &Path, name: &str, contents: &[u8]) {
    std::fs::write(root.join(format!("{name}.md")), contents).expect("write persona");
}

// ─────────────────────────────────────────────────────────────────────────
// Frontmatter parametric matrix — six states from spec design §5 point 6
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn resolves_no_frontmatter_body() {
    let root = make_agents_root();
    write_persona(root.path(), "plain", b"hello world");
    let body = resolve_preamble_at("plain", root.path()).expect("ok");
    assert_eq!(body, "hello world");
}

#[test]
fn resolves_lf_frontmatter_and_strips_it() {
    let root = make_agents_root();
    write_persona(root.path(), "lf", b"---\nkey: v\n---\nbody\n");
    let body = resolve_preamble_at("lf", root.path()).expect("ok");
    assert_eq!(body, "body\n");
}

#[test]
fn resolves_crlf_frontmatter_and_strips_it() {
    let root = make_agents_root();
    write_persona(root.path(), "crlf", b"---\r\nkey: v\r\n---\r\nbody\r\n");
    let body = resolve_preamble_at("crlf", root.path()).expect("ok");
    assert_eq!(body, "body\r\n");
}

#[test]
fn resolves_bom_plus_frontmatter_stripping_bom_first() {
    let root = make_agents_root();
    // BOM must be stripped BEFORE fence probing; otherwise "\u{FEFF}---\n"
    // would fail the strip_prefix("---\n") check and the frontmatter would
    // flow downstream into the prompt.
    let mut buf = Vec::new();
    buf.extend_from_slice("\u{FEFF}".as_bytes());
    buf.extend_from_slice(b"---\nkey: v\n---\nbody\n");
    write_persona(root.path(), "bom", &buf);
    let body = resolve_preamble_at("bom", root.path()).expect("ok");
    assert_eq!(body, "body\n");
}

#[test]
fn rejects_unclosed_frontmatter_hard() {
    // R2 F2: an opening fence with no closer is a hard MalformedFrontmatter,
    // NOT a lenient fall-through to treating the whole file as a body. A
    // truncated persona file with YAML instructions leaked into the prompt
    // would be a silent security regression.
    let root = make_agents_root();
    write_persona(root.path(), "unclosed", b"---\nkey: v\nno close fence");
    match resolve_preamble_at("unclosed", root.path()) {
        Err(PersonaError::MalformedFrontmatter(msg)) => {
            assert!(
                msg.contains("unclosed"),
                "reason should name persona: {msg}"
            );
        }
        other => panic!("expected MalformedFrontmatter, got {other:?}"),
    }
}

#[test]
fn rejects_frontmatter_only_as_empty_body() {
    // "---\nk: v\n---\n" — frontmatter closes cleanly, but body is empty.
    let root = make_agents_root();
    write_persona(root.path(), "empty", b"---\nk: v\n---\n");
    match resolve_preamble_at("empty", root.path()) {
        Err(PersonaError::EmptyBody(name)) => assert_eq!(name, "empty"),
        other => panic!("expected EmptyBody, got {other:?}"),
    }
}

#[test]
fn rejects_frontmatter_only_with_eof_closer_as_empty_body() {
    // "---\nk: v\n---" — closer at EOF with no trailing newline. Body is
    // still empty; guards the strip_frontmatter EOF-terminator branch.
    let root = make_agents_root();
    write_persona(root.path(), "eof-close", b"---\nk: v\n---");
    match resolve_preamble_at("eof-close", root.path()) {
        Err(PersonaError::EmptyBody(name)) => assert_eq!(name, "eof-close"),
        other => panic!("expected EmptyBody, got {other:?}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────
// R2 F4 · read cap + path safety
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn read_cap_boundary_at_cap_and_over_cap() {
    // Cap = 200 KiB. `cap` bytes → Ok; `cap+1` → TooLarge.
    const CAP: usize = 200 * 1024;

    let root_ok = make_agents_root();
    write_persona(root_ok.path(), "at-cap", &vec![b'a'; CAP]);
    let ok_body = resolve_preamble_at("at-cap", root_ok.path()).expect("cap bytes ok");
    assert_eq!(ok_body.len(), CAP);

    let root_over = make_agents_root();
    write_persona(root_over.path(), "over-cap", &vec![b'a'; CAP + 1]);
    match resolve_preamble_at("over-cap", root_over.path()) {
        Err(PersonaError::TooLarge { name, cap }) => {
            assert_eq!(name, "over-cap");
            assert_eq!(cap, CAP);
        }
        other => panic!("expected TooLarge at cap+1, got {other:?}"),
    }
}

#[test]
fn missing_file_reports_not_found() {
    let root = make_agents_root();
    match resolve_preamble_at("ghost", root.path()) {
        Err(PersonaError::NotFound(name)) => assert_eq!(name, "ghost"),
        other => panic!("expected NotFound, got {other:?}"),
    }
}

#[test]
fn nested_subdirectory_hits_not_found_because_grammar_bars_slashes() {
    // A "path/traversal" name never gets to the filesystem — the grammar
    // gate rejects it first. If we WERE willing to construct a path like
    // <root>/sub/foo.md the resolver's direct-child check would still
    // catch it (via canonical.parent() != Some(canonical_root)), but the
    // grammar gate is a stronger upstream barrier. This test documents
    // that layered defence.
    let root = make_agents_root();
    std::fs::create_dir(root.path().join("sub")).expect("mkdir sub");
    std::fs::write(root.path().join("sub").join("foo.md"), b"nested body").expect("write");
    // The candidate <root>/foo.md doesn't exist → NotFound.
    match resolve_preamble_at("foo", root.path()) {
        Err(PersonaError::NotFound(name)) => assert_eq!(name, "foo"),
        other => panic!("expected NotFound, got {other:?}"),
    }
    // And a name that TRIED to walk into the subdirectory dies at grammar.
    match resolve_preamble_at("sub/foo", root.path()) {
        Err(PersonaError::InvalidName(name)) => assert_eq!(name, "sub/foo"),
        other => panic!("expected InvalidName for 'sub/foo', got {other:?}"),
    }
}

/// Symlink-based path-escape test. Unix only — file symlinks on Windows
/// require administrator privileges or Developer Mode which is not
/// guaranteed on every CI runner. The Unix path exercises exactly the R2 F4
/// canonical direct-child guard (`canonical.parent() == Some(canonical_root)`
/// rather than `starts_with`).
#[cfg(unix)]
#[test]
fn rejects_symlink_escape_via_direct_child_check_unix() {
    use std::os::unix::fs::symlink;
    let outer = tempfile::tempdir().expect("outer tempdir");
    let secret_path = outer.path().join("secret.md");
    std::fs::write(&secret_path, b"escaped body").expect("write secret");

    let root_dir = outer.path().join("agents");
    std::fs::create_dir(&root_dir).expect("mkdir agents");
    // <root>/escape.md → ../secret.md; canonical resolves to
    // <outer>/secret.md whose parent is <outer>, NOT <outer>/agents.
    symlink(&secret_path, root_dir.join("escape.md")).expect("symlink");

    match resolve_preamble_at("escape", &root_dir) {
        Err(PersonaError::PathEscape(reason)) => {
            assert!(
                reason.contains("escape"),
                "reason should name persona: {reason}"
            );
        }
        other => panic!("expected PathEscape via symlink, got {other:?}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Property 6 (name grammar) · defensive re-check inside the resolver
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn defensive_name_check_rejects_before_touching_disk() {
    let root = make_agents_root();
    // Even if a caller skipped the broker's pre-check, the resolver MUST
    // not probe the filesystem with a hostile name.
    match resolve_preamble_at("path/traversal", root.path()) {
        Err(PersonaError::InvalidName(name)) => assert_eq!(name, "path/traversal"),
        other => panic!("expected InvalidName for slash, got {other:?}"),
    }
    match resolve_preamble_at("back\\slash", root.path()) {
        Err(PersonaError::InvalidName(_)) => {}
        other => panic!("expected InvalidName for backslash, got {other:?}"),
    }
    match resolve_preamble_at(".", root.path()) {
        Err(PersonaError::InvalidName(_)) => {}
        other => panic!("expected InvalidName for dot, got {other:?}"),
    }
    match resolve_preamble_at("", root.path()) {
        Err(PersonaError::InvalidName(_)) => {}
        other => panic!("expected InvalidName for empty, got {other:?}"),
    }
    match resolve_preamble_at(&"a".repeat(65), root.path()) {
        Err(PersonaError::InvalidName(_)) => {}
        other => panic!("expected InvalidName for 65-char, got {other:?}"),
    }
    match resolve_preamble_at("中文", root.path()) {
        Err(PersonaError::InvalidName(_)) => {}
        other => panic!("expected InvalidName for CJK, got {other:?}"),
    }
    match resolve_preamble_at("emoji-🤖", root.path()) {
        Err(PersonaError::InvalidName(_)) => {}
        other => panic!("expected InvalidName for emoji, got {other:?}"),
    }
}

#[test]
fn is_valid_persona_name_public_gate_still_matches_resolver_gate() {
    // Sanity: the public grammar gate the broker calls in stage 4 and
    // the internal defensive gate the resolver runs MUST agree, or
    // there is a two-tier hole. This is a schema-level contract test.
    for good in ["a", "plan-reality-recon", "Agent_01", &"a".repeat(64)] {
        assert!(is_valid_persona_name(good), "{good:?} should be valid");
    }
    for bad in [
        "",
        " ",
        "a b",
        "foo.bar",
        "path/traversal",
        "back\\slash",
        "..",
        "./foo",
        "中文",
        &"a".repeat(65),
    ] {
        assert!(!is_valid_persona_name(bad), "{bad:?} should be rejected");
    }
}
