//! Stage 6 of the delegate-persona-passthrough spec: the host's persona
//! inventory is discovered by the PARENT, shipped to the companion over a
//! `--persona-lists` argv flag, and substituted into the `<<PERSONA_LISTS>>`
//! placeholder that stage 1 embedded at the tail of `delegate_to_agent`'s
//! `subagent_type` description.
//!
//! # Why the parent scans and the companion does not
//!
//! `CompanionContext` already establishes the pattern for `custom_agents` /
//! `disabled_agents`: the companion is a pure stdio translation layer and the
//! PARENT decides what to advertise. The companion process' env view
//! (`KIRO_HOME` / `CLAUDE_CONFIG_DIR` / `CODEX_HOME`) is not guaranteed to
//! match the parent's, so a companion-side scan could advertise a different
//! inventory than the broker will actually resolve against.
//!
//! # The two P0s these tests pin
//!
//! * **P0-a — the flag MUST be omitted when there are no personas.**
//!   `codeg_mcp::parse_args` ends in `other => return Err(...)`, so an OLDER
//!   companion binary that predates this flag exits 2 on an unknown arg. That
//!   takes down delegation / ask_user_question / check_user_feedback /
//!   get_session_info wholesale — not just the persona feature. Encoded in the
//!   type system as `render_persona_lists -> Option<String>`, whose `None` the
//!   parent turns into an EMPTY arg vector (`persona_lists_args`).
//! * **P0-b — the placeholder must never leak.** No personas means the
//!   placeholder is replaced with the EMPTY STRING, not left unsubstituted;
//!   otherwise the literal `<<PERSONA_LISTS>>` reaches the LLM inside the
//!   schema description.
//!
//! Note P0-a and P0-b are two sides of the SAME scenario: parent omits the
//! flag, companion therefore sees `persona_lists: None`, and must still
//! substitute. Both are covered below.

use std::sync::Arc;

use codeg_lib::acp::delegation::companion::{
    dispatch_line, substitute_persona_lists, CompanionContext, CompanionFeatures, InflightCalls,
    LineAction, PERSONA_LISTS_PLACEHOLDER,
};
use codeg_lib::acp::delegation::persona::{
    decode_persona_lists_arg, list_personas_at, persona_lists_args, render_persona_lists,
    PersonaListEntry, PERSONA_LISTS_FLAG,
};
use serde_json::{json, Value};

fn entry(id: &str, description: Option<&str>) -> PersonaListEntry {
    PersonaListEntry {
        id: id.to_string(),
        description: description.map(str::to_string),
    }
}

fn ctx_with_persona_lists(persona_lists: Option<&str>) -> CompanionContext {
    CompanionContext {
        parent_connection_id: "p1".into(),
        socket_path: "/tmp/codeg-mcp-persona-lists-test-nope.sock".into(),
        token: "tok".into(),
        features: CompanionFeatures {
            delegation: true,
            feedback: false,
            ask: false,
            sessions: false,
            tasks: false,
            automations: false,
            taskboard: false,
        },
        custom_agents: Vec::new(),
        disabled_agents: Vec::new(),
        persona_lists: persona_lists.map(str::to_string),
    }
}

/// Drive a real `tools/list` through the dispatcher and hand back
/// `delegate_to_agent`'s `subagent_type.description` — the exact string an
/// LLM would receive.
async fn subagent_type_description(persona_lists: Option<&str>) -> String {
    let ctx = ctx_with_persona_lists(persona_lists);
    let line = r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#;
    let action = dispatch_line(&ctx, Arc::new(InflightCalls::new()), line).await;
    let resp = match action {
        LineAction::Respond(r) => r,
        _ => panic!("tools/list must answer synchronously"),
    };
    resp.result.expect("tools/list result")["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .find(|t| t["name"] == "delegate_to_agent")
        .expect("delegate_to_agent present under the delegation feature")["inputSchema"]
        ["properties"]["subagent_type"]["description"]
        .as_str()
        .expect("subagent_type description is a string")
        .to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-b — the placeholder never leaks to the LLM
// ─────────────────────────────────────────────────────────────────────────────

/// The load-bearing P0-b assertion, made against a REAL `tools/list` round
/// trip rather than the helper in isolation: with no personas on the host the
/// description must not contain the placeholder literal.
///
/// Mutating `substitute_persona_lists`' `None` arm into an early `return`
/// (i.e. "skip the substitution when there is nothing to inject") turns this
/// red.
#[tokio::test]
async fn tools_list_never_leaks_the_placeholder_when_no_personas_exist() {
    let description = subagent_type_description(None).await;
    assert!(
        !description.contains(PERSONA_LISTS_PLACEHOLDER),
        "placeholder leaked into the schema served to the LLM: {description}"
    );
    // And the surrounding prose survives — substitution must not eat the
    // description it is embedded in.
    assert!(description.contains("Optional persona / sub-agent name INSIDE the target CLI"));
}

/// The `Some` side of the same round trip: the rendered inventory is spliced
/// in where the placeholder stood, and the placeholder itself is gone.
#[tokio::test]
async fn tools_list_splices_the_rendered_inventory_in_place_of_the_placeholder() {
    let rendered = render_persona_lists(
        &[entry("plan-reality-recon", Some("scout the code reality"))],
        &[],
        &[],
    )
    .expect("one kiro persona renders");

    let description = subagent_type_description(Some(&rendered)).await;
    assert!(!description.contains(PERSONA_LISTS_PLACEHOLDER));
    assert!(description.contains("plan-reality-recon"));
    assert!(description.contains("scout the code reality"));
    // Spliced at the TAIL, after the semantic-tier prose stage 1 wrote.
    let prose_at = description
        .find("Ignored, with a `[note]`")
        .expect("stage-1 prose still present");
    let inventory_at = description
        .find("plan-reality-recon")
        .expect("inventory present");
    assert!(
        prose_at < inventory_at,
        "inventory must be appended after the tier prose, not spliced into it"
    );
}

/// Defensive posture inherited from `append_custom_agents_to_delegate_enum`: a
/// tools array that has been feature-filtered down (or whose schema shape
/// changed) leaves the value untouched instead of erroring or panicking.
#[test]
fn substitute_is_a_no_op_when_the_tool_or_property_is_absent() {
    // delegate_to_agent filtered out entirely.
    let mut without_tool = json!([{ "name": "ask_user_question", "inputSchema": {} }]);
    let before = without_tool.clone();
    substitute_persona_lists(&mut without_tool, Some("anything"));
    assert_eq!(without_tool, before);

    // Present, but no subagent_type property.
    let mut without_property = json!([{
        "name": "delegate_to_agent",
        "inputSchema": { "properties": { "task": { "type": "string" } } },
    }]);
    let before = without_property.clone();
    substitute_persona_lists(&mut without_property, Some("anything"));
    assert_eq!(without_property, before);

    // Not even an array.
    let mut not_an_array = json!({ "tools": "nope" });
    let before = not_an_array.clone();
    substitute_persona_lists(&mut not_an_array, None);
    assert_eq!(not_an_array, before);

    // Description present but not a string.
    let mut wrong_type = json!([{
        "name": "delegate_to_agent",
        "inputSchema": { "properties": { "subagent_type": { "description": 42 } } },
    }]);
    let before = wrong_type.clone();
    substitute_persona_lists(&mut wrong_type, Some("anything"));
    assert_eq!(wrong_type, before);
}

/// A description with no placeholder in it (a companion whose embedded schema
/// predates stage 1) is left byte-identical — substitution must not append
/// blindly.
#[test]
fn substitute_leaves_a_placeholderless_description_untouched() {
    let mut tools = json!([{
        "name": "delegate_to_agent",
        "inputSchema": { "properties": { "subagent_type": { "description": "no marker here" } } },
    }]);
    substitute_persona_lists(&mut tools, Some("inventory"));
    assert_eq!(
        tools[0]["inputSchema"]["properties"]["subagent_type"]["description"],
        Value::String("no marker here".into())
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-a — the flag is omitted entirely when the host has no personas
// ─────────────────────────────────────────────────────────────────────────────

/// P0-a at the type level: three empty inventories render to `None`, which is
/// what `persona_lists_args` turns into an EMPTY arg vector. An older
/// codeg-mcp binary rejects unknown flags at startup with exit 2, so pushing
/// `--persona-lists` unconditionally would break delegation /
/// ask_user_question / check_user_feedback / get_session_info on every
/// installation whose companion predates this flag.
#[test]
fn render_returns_none_when_all_three_inventories_are_empty() {
    assert_eq!(render_persona_lists(&[], &[], &[]), None);
}

/// The parent-side consequence of the above, asserted on the argv the
/// connection builder appends. This is the test that goes red if someone
/// replaces `connection.rs`'s `if let Some(rendered)` with an unconditional
/// push.
#[test]
fn persona_lists_args_are_empty_when_nothing_to_advertise() {
    assert!(
        persona_lists_args(&[], &[], &[]).is_empty(),
        "P0-a: --persona-lists must be omitted, not sent empty"
    );
}

/// The positive side: one persona anywhere produces exactly the two-token
/// `[--persona-lists, <base64>]` pair, and the payload round-trips back to the
/// same string the companion will substitute.
#[test]
fn persona_lists_args_round_trip_through_base64() {
    let kiro = vec![entry("debugger", Some("anti-anchoring review"))];
    let args = persona_lists_args(&kiro, &[], &[]);
    assert_eq!(args.len(), 2);
    assert_eq!(args[0], PERSONA_LISTS_FLAG);
    assert_eq!(args[0], "--persona-lists");

    let decoded = decode_persona_lists_arg(&args[1]).expect("parent-encoded payload decodes");
    assert_eq!(decoded, render_persona_lists(&kiro, &[], &[]).unwrap());
    assert!(decoded.contains("debugger"));

    // The encoded token must be a single shell-safe argv word: no whitespace,
    // no quotes, no `=` padding (URL_SAFE_NO_PAD).
    assert!(
        args[1]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
        "payload must be URL-safe unpadded base64, got {}",
        args[1]
    );
}

/// A corrupt / truncated payload degrades to `None` rather than panicking or
/// failing the launch. The parent always encodes correctly, so this only fires
/// on a parent/companion version skew — and serving the schema without the
/// inventory is strictly better than not serving tools at all.
#[test]
fn decode_rejects_garbage_without_panicking() {
    assert_eq!(decode_persona_lists_arg("!!!not base64!!!"), None);
    // Valid base64, invalid UTF-8 (a lone continuation byte).
    assert_eq!(decode_persona_lists_arg("gA"), None);
    // Valid base64 of an empty string is treated as "nothing to advertise".
    assert_eq!(decode_persona_lists_arg(""), None);
}

// ─────────────────────────────────────────────────────────────────────────────
// Render format
// ─────────────────────────────────────────────────────────────────────────────

/// Each CLI family is labelled with its SEMANTIC TIER, not just its name — the
/// whole point of the spec is that `kiro` is a real persona while
/// `claude_code` / `codex` are best-effort prompt hints. A model reading the
/// inventory has to be able to tell those apart.
#[test]
fn render_labels_each_family_with_its_semantic_tier() {
    let rendered = render_persona_lists(
        &[entry("recon", Some("k"))],
        &[entry("executor", Some("c"))],
        &[entry("reviewer", None)],
    )
    .expect("non-empty renders");

    assert!(rendered.contains("kiro (real persona)"));
    assert!(rendered.contains("claude_code (best-effort hint)"));
    assert!(rendered.contains("codex (best-effort hint)"));
    // Names are rendered `@name` so they read as nominations, and every one of
    // the three families' entries shows up.
    assert!(rendered.contains("@recon"));
    assert!(rendered.contains("@executor"));
    assert!(rendered.contains("@reviewer"));
}

/// A family with nothing defined still gets a line, so the model can tell
/// "this CLI has no personas" apart from "this CLI was not scanned". Only the
/// all-three-empty case collapses to `None` (P0-a).
#[test]
fn render_marks_an_empty_family_as_none_defined() {
    let rendered = render_persona_lists(&[entry("recon", None)], &[], &[]).unwrap();
    assert!(rendered.contains("@recon"));
    assert_eq!(
        rendered.matches("(none defined)").count(),
        2,
        "claude_code and codex both have nothing: {rendered}"
    );
}

/// An entry with no description renders as a bare `@name` — no dangling
/// separator.
#[test]
fn render_omits_the_separator_for_a_descriptionless_entry() {
    let rendered = render_persona_lists(&[entry("bare", None)], &[], &[]).unwrap();
    assert!(rendered.contains("@bare"));
    assert!(
        !rendered.contains("@bare —"),
        "no em-dash separator without a description: {rendered}"
    );
}

/// Length guard: argv has a hard platform ceiling (~32 KiB on Windows) and
/// base64 inflates by a third, so an inventory that would blow the budget
/// degrades to ids-only rather than being truncated mid-entry (a half-written
/// description would read as a corrupted schema) or dropped entirely (the
/// model would lose the inventory precisely on the machines that have the most
/// personas).
#[test]
fn render_degrades_to_ids_only_when_descriptions_blow_the_budget() {
    let long = "d".repeat(300);
    let many: Vec<PersonaListEntry> = (0..80)
        .map(|i| entry(&format!("persona-{i:03}"), Some(&long)))
        .collect();

    let rendered = render_persona_lists(&many, &many, &many).expect("non-empty renders");

    assert!(
        !rendered.contains(&long),
        "descriptions must be dropped wholesale in the degraded form"
    );
    // Every id survives — the degraded form loses prose, never entries.
    assert!(rendered.contains("@persona-000"));
    assert!(rendered.contains("@persona-079"));
    assert!(
        rendered.len() <= 16 * 1024,
        "rendered {} bytes",
        rendered.len()
    );
}

/// The budget only kicks in when it has to: a normal-sized inventory keeps its
/// descriptions.
#[test]
fn render_keeps_descriptions_for_a_realistic_inventory() {
    let ten: Vec<PersonaListEntry> = (0..10)
        .map(|i| entry(&format!("p{i}"), Some("a normal one-line description")))
        .collect();
    let rendered = render_persona_lists(&ten, &ten, &ten).unwrap();
    assert!(rendered.contains("a normal one-line description"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory scanning
// ─────────────────────────────────────────────────────────────────────────────

fn write(dir: &std::path::Path, name: &str, body: &str) {
    std::fs::write(dir.join(name), body).unwrap();
}

/// A missing directory is the common case on a fresh install and must yield an
/// empty list, never an error — the same posture as
/// `list_kiro_custom_agents_at`.
#[test]
fn list_personas_at_returns_empty_for_a_missing_directory() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(list_personas_at(&tmp.path().join("does-not-exist")).is_empty());
}

/// The happy path: `*.md` stems become ids, sorted stably so the advertised
/// inventory does not reshuffle between reads, with the frontmatter
/// `description` lifted out.
#[test]
fn list_personas_at_reads_stems_and_frontmatter_descriptions() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(
        dir,
        "zulu.md",
        "---\ndescription: last alphabetically\n---\nbody\n",
    );
    write(
        dir,
        "alpha.md",
        "---\nname: ignored\ndescription: first one\n---\nbody\n",
    );

    let found = list_personas_at(dir);
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].id, "alpha");
    assert_eq!(found[0].description.as_deref(), Some("first one"));
    assert_eq!(found[1].id, "zulu");
    assert_eq!(found[1].description.as_deref(), Some("last alphabetically"));
}

/// `name` is the documented fallback when there is no `description`, and a
/// body-only file degrades to a leading-prose summary so the entry is still
/// self-describing.
#[test]
fn list_personas_at_falls_back_to_name_then_body() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(
        dir,
        "named.md",
        "---\nname: The Named One\n---\nbody text\n",
    );
    write(dir, "bodyonly.md", "# Heading\n\nDoes the reviewing.\n");

    let found = list_personas_at(dir);
    let by = |id: &str| {
        found
            .iter()
            .find(|e| e.id == id)
            .unwrap_or_else(|| panic!("{id} listed"))
    };
    assert_eq!(by("named").description.as_deref(), Some("The Named One"));
    let body = by("bodyonly").description.as_deref().unwrap();
    assert!(body.contains("Does the reviewing."), "got {body}");
    // Markdown heading syntax is not useful to the model reading the list.
    assert!(!body.starts_with('#'), "got {body}");
}

/// The gate the Kiro scanner does not need: an advertised persona MUST be one
/// `subagent_type` will actually accept. Advertising `foo.bar` (a dot fails
/// `is_valid_persona_name`) would have the model nominate a name the broker
/// then rejects with `invalid_persona` — the inventory contradicting itself.
#[test]
fn list_personas_at_filters_names_the_subagent_type_grammar_rejects() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(dir, "good-one_2.md", "ok\n");
    write(dir, "foo.bar.md", "dotted stem\n");
    write(dir, "spaced out.md", "whitespace\n");
    write(dir, &format!("{}.md", "x".repeat(65)), "too long\n");
    write(
        dir,
        &format!("{}.md", "y".repeat(64)),
        "exactly at the cap\n",
    );
    write(dir, "中文.md", "non-ascii\n");

    let ids: Vec<String> = list_personas_at(dir).into_iter().map(|e| e.id).collect();
    assert!(ids.contains(&"good-one_2".to_string()));
    assert!(ids.contains(&"y".repeat(64)));
    assert_eq!(ids.len(), 2, "everything else must be filtered: {ids:?}");
}

/// Non-`.md` files are ignored, extension casing is the filesystem's business
/// rather than the user's, and subdirectories never become entries.
#[test]
fn list_personas_at_ignores_non_markdown_and_directories() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(dir, "real.md", "yes\n");
    write(dir, "upper.MD", "also yes\n");
    write(dir, "notes.txt", "no\n");
    write(dir, "config.json", "no\n");
    write(dir, ".md", "empty stem\n");
    std::fs::create_dir(dir.join("nested.md")).unwrap();

    let ids: Vec<String> = list_personas_at(dir).into_iter().map(|e| e.id).collect();
    assert_eq!(ids, vec!["real".to_string(), "upper".to_string()]);
}

/// A file that cannot be read (or is not UTF-8) is still ADVERTISED — the stem
/// is the identifier and it is valid; only the description is unavailable.
/// Dropping the entry would hide a persona the broker can still resolve.
#[test]
fn list_personas_at_keeps_an_unreadable_entry_without_a_description() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    std::fs::write(dir.join("binary.md"), [0xff, 0xfe, 0x00, 0x01]).unwrap();
    write(dir, "fine.md", "---\ndescription: readable\n---\nbody\n");

    let found = list_personas_at(dir);
    assert_eq!(found.len(), 2);
    let binary = found.iter().find(|e| e.id == "binary").unwrap();
    assert_eq!(binary.description, None);
    let fine = found.iter().find(|e| e.id == "fine").unwrap();
    assert_eq!(fine.description.as_deref(), Some("readable"));
}

/// An unclosed frontmatter fence must not swallow the whole file as
/// frontmatter — the entry survives, description-less, rather than leaking raw
/// YAML into the schema.
#[test]
fn list_personas_at_survives_malformed_frontmatter() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    write(dir, "unclosed.md", "---\ndescription: never closed\nbody\n");

    let found = list_personas_at(dir);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, "unclosed");
    assert!(
        !found[0]
            .description
            .as_deref()
            .unwrap_or_default()
            .contains("---"),
        "raw fence must never reach the schema: {:?}",
        found[0].description
    );
}

/// Descriptions are capped so one user with a paragraph-long persona blurb
/// cannot dominate the argv budget.
#[test]
fn list_personas_at_caps_a_long_description() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let long = "x".repeat(4000);
    write(
        dir,
        "verbose.md",
        &format!("---\ndescription: {long}\n---\nbody\n"),
    );

    let description = list_personas_at(dir)[0].description.clone().unwrap();
    assert!(description.len() < 400, "got {} bytes", description.len());
}
