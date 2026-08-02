//! Per-launch persona nomination — the plumbing that lets an LLM say "run
//! this delegation AS the `plan-reality-recon` persona of the target CLI"
//! and lands with the right semantic strength on each CLI family.
//!
//! # Semantic split (three tiers)
//!
//! * **Kiro — REAL persona.** Translated to `kiro-cli acp --agent <name>`;
//!   kiro-cli reloads the full persona definition from
//!   `<KIRO_HOME>/agents/<name>.json` (permissions, tools, system prompt all
//!   take effect). This is the only tier where the sub-agent's *authority*
//!   changes — everything else is just prompt-shaping.
//! * **Claude Code / Codex — BEST-EFFORT hint.** No native `--agent` in the
//!   upstream wrapper today; the broker reads
//!   `~/.claude/agents/<name>.md` / `~/.codex/agents/<name>.md`, strips
//!   frontmatter, and prepends the markdown BODY as a first-turn text hint.
//!   Frontmatter high-order fields (permission mode / tool allowlist /
//!   model / hook) DO NOT take effect on this leg.
//! * **Any other agent_type — Ignored.** Broker attaches a `[note]` to
//!   `DelegationSuccess.text` explaining the CLI has no persona support;
//!   never fails the delegation.
//!
//! # Stage 1 boundary
//!
//! This module lands the **type base only**:
//!
//! - [`LaunchOption`] — closed enum, one variant per launch-time knob (v1 =
//!   `KiroPersona`). Extend by adding a variant, NEVER by widening into an
//!   opaque map (R2 A4: opaque maps grow infra surface without business
//!   need).
//! - [`AppliedPersona`] — three-state outcome the frontend renders. No
//!   `Failed` variant (R3 F2 收窄): failures ride the wrapping
//!   `DelegationOutcome::Err` instead.
//! - [`PersonaEffect`] — broker-internal intermediate: what the resolver
//!   produced, before the broker turns it into `applied_persona`.
//! - [`PersonaError`] — resolver failure taxonomy. Emitted by
//!   [`resolve_preamble_at`], which is only wired in stage 3.
//! - [`is_valid_persona_name`] — the grammar gate shared across all three
//!   tiers, applied BEFORE any filesystem access.
//! - [`PersonaCapability`] — trait each `AgentType` implements in stage 2
//!   to say whether persona has any meaning for it and how to resolve it.
//! - [`resolve_preamble_at`] — signature only; body panics on call in
//!   stage 1, and the real implementation with symlink-safety / read
//!   caps / frontmatter parsing lands in stage 3.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Type-safe per-call CLI launch option.
///
/// v1 only carries the Kiro persona nomination. Future CLIs get a NEW
/// variant (e.g. `ClaudePersonaEnv(String)` once upstream
/// `@agentclientprotocol/claude-agent-acp` grows native `CLAUDE_ACP_AGENT`
/// support). NEVER extend by adding an opaque `BTreeMap<String, String>`
/// override — that widens infra control surface without a business driver
/// (R2 A4 rejected).
///
/// Consumed downstream by `manager::spawn_child_inner`, which inserts
/// `KIRO_AGENT=<name>` into `runtime_env` BEFORE
/// `apply_kiro_env_policy` runs; `connection::kiro_launch_args` then
/// translates the env var into `--agent <name>` argv (stage 5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchOption {
    /// Nominates a Kiro persona whose definition lives at
    /// `<KIRO_HOME>/agents/<name>.json`. `name` has already been through
    /// [`is_valid_persona_name`] by the time it reaches the spawner.
    KiroPersona(String),
    // Future: ClaudePersonaEnv(String) — pending upstream claude-agent-acp PR
    // Future: CodexPersonaEnv(String)  — pending upstream codex-acp PR
}

/// What actually got applied to the delegation, from the frontend's point
/// of view. Rendered on the delegation card next to the child agent label.
///
/// # Why only three variants (R3 F2 收窄)
///
/// A `Failed` variant would double-book the failure state: the broker
/// already returns `DelegationOutcome::Err { code, message, .. }` when a
/// persona cannot be resolved (`code == "invalid_persona"` — see
/// `DelegationError::InvalidPersona` in [`super::types`]). The UI reads
/// the outcome's `Err` and, if the original request carried a
/// `subagent_type`, echoes it as a `requested: @<name>` line — no separate
/// `AppliedPersona::Failed` needed.
///
/// # Timing invariant (R3 A2)
///
/// The broker MUST produce this AFTER the spawn / send actually returned
/// Ok. Producing it earlier would let a failed spawn ship a false
/// `applied_persona: Native` to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AppliedPersona {
    /// The target CLI accepted the persona natively (Kiro). The sub-agent
    /// is running with `<name>`'s permissions, tools, and prompt.
    Native { name: String },
    /// The target CLI has no native persona support; the broker prepended
    /// the persona file's body to the first-turn prompt as a best-effort
    /// text hint (Claude Code / Codex). Frontmatter high-order fields
    /// (permission mode / tool allowlist / model) do NOT take effect here.
    Hint { name: String },
    /// The caller nominated a persona but the target CLI has no persona
    /// concept at all (any agent_type outside Kiro / Claude Code / Codex).
    /// The delegation still ran; a `[note]` was attached to the tool
    /// result so the LLM sees the request was silently downgraded.
    IgnoredUnsupportedCli { name: String },
}

/// Broker-internal intermediate: what a `PersonaCapability` resolver
/// produced, before the broker decides how to translate it into a
/// `spawn(...)` call, a first-turn prompt prepend, and finally an
/// `AppliedPersona`.
///
/// This is NEVER serialized. It only lives in the broker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersonaEffect {
    /// Native support: the broker passes `launch_option` to the spawner;
    /// nothing prepended to the task text.
    Native { launch_option: LaunchOption },
    /// Best-effort: the broker prepends `preamble` (already frontmatter-
    /// stripped, BOM-stripped, UTF-8-validated body) to the task text on
    /// the FIRST turn. No launch option.
    Hint { preamble: String },
    /// The target CLI has no persona concept. The broker attaches a
    /// `[note]` to `DelegationSuccess.text` explaining the ignore, then
    /// spawns normally.
    Ignored,
    /// Persona resolution failed (file not found / name grammar / read
    /// cap / malformed frontmatter / path escape / IO). The broker
    /// short-circuits into `DelegationError::InvalidPersona(reason)`
    /// BEFORE spawning; `wire_code` is the stable string the outer
    /// `DelegationOutcome::Err.code` will carry.
    Failed {
        wire_code: &'static str,
        reason: String,
    },
}

/// Persona resolver failure taxonomy. Every variant maps to a broker-side
/// `DelegationError::InvalidPersona(reason)` where `reason` is this enum's
/// `Display` form; the wire code the frontend / LLM sees is always
/// `"invalid_persona"` (see [`super::types::DelegationOutcome::from_err`]).
///
/// Kept enum-shaped (not stringly-typed) so the resolver's callers can
/// pattern-match on the concrete cause for tracing / testing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersonaError {
    /// Name failed [`is_valid_persona_name`] — 1..=64 chars,
    /// `[A-Za-z0-9_-]` only.
    InvalidName,
    /// `<root>/<name>.md` does not exist / cannot be stat'd.
    NotFound,
    /// File is not valid UTF-8.
    NotUtf8,
    /// File body exceeds the hard read cap. `cap` is bytes.
    TooLarge { name: String, cap: usize },
    /// The persona file's body (after optional frontmatter stripping) is
    /// empty / whitespace-only.
    EmptyBody,
    /// The file opens with `---\n` (or `---\r\n`) but the closing `---`
    /// delimiter is never found. Hard failure — R2 F2 rejects tolerant
    /// fall-through since a truncated file is likely a persona the user
    /// meant to work but a save error corrupted.
    MalformedFrontmatter,
    /// After canonicalization, the resolved file is not a direct child of
    /// the canonical agents root (symlink escape / nested subdir / `..`
    /// traversal). Uses `canonical.parent() == Some(canonical_root)`, not
    /// `starts_with`, so `<root>/sub/foo.md` also fails.
    PathEscape,
    /// Any other filesystem IO error. Kept a single string to avoid
    /// leaking `std::io::Error` (not `Clone`) through the enum.
    IoError(String),
}

impl std::fmt::Display for PersonaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PersonaError::InvalidName => {
                write!(f, "persona name must match [A-Za-z0-9_-]{{1,64}}")
            }
            PersonaError::NotFound => write!(f, "persona file not found"),
            PersonaError::NotUtf8 => write!(f, "persona file is not valid UTF-8"),
            PersonaError::TooLarge { name, cap } => {
                write!(f, "persona '{name}' body exceeds the {cap}-byte read cap")
            }
            PersonaError::EmptyBody => {
                write!(f, "persona body is empty after frontmatter stripping")
            }
            PersonaError::MalformedFrontmatter => write!(
                f,
                "persona file starts with '---' but never closes the frontmatter block"
            ),
            PersonaError::PathEscape => write!(
                f,
                "persona path is not a direct child of the agents root (symlink or traversal)"
            ),
            PersonaError::IoError(msg) => write!(f, "persona IO error: {msg}"),
        }
    }
}

impl std::error::Error for PersonaError {}

/// Persona name grammar shared across all three tiers (Requirement
/// 3-name-grammar):
///
/// - length 1..=64 characters (counting Unicode scalar values, but the
///   allowed set is ASCII-only so char count == byte count in practice)
/// - each character is in `[A-Za-z0-9_-]`
///
/// Enforced by the broker BEFORE any filesystem access AND before any
/// `spawn` argv translation — an invalid name never touches disk or the
/// child process.
///
/// Rejects: empty string, 65+ chars, `.`, `/`, `\`, whitespace, any
/// non-ASCII including CJK / emoji, dots (blocks `../` traversal at the
/// syntax layer before path canonicalization even runs).
// gate:allow-unwired stage-2 provider dispatch wires this via impls
#[allow(dead_code)]
pub fn is_valid_persona_name(name: &str) -> bool {
    // gate:allow-unwired stage-2 wires it
    let len = name.chars().count();
    if !(1..=64).contains(&len) {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Whether an `AgentType` participates in persona nomination, and — if
/// yes — how the broker should turn a `(name, home_dir)` pair into a
/// [`PersonaEffect`].
///
/// # Broker call order (R3 F1 采纳)
///
/// The broker MUST walk this trait in this order, so unsupported CLIs
/// short-circuit BEFORE any name grammar check or HOME lookup:
///
/// 1. `if provider.supports_persona() == false` → `PersonaEffect::Ignored`,
///    **do NOT** call `resolve_persona_effect`, do NOT check name grammar,
///    do NOT resolve HOME.
/// 2. `is_valid_persona_name(name)` → false ⇒ `DelegationError::InvalidPersona`.
/// 3. `provider.resolve_persona_effect(name, &home_dir)` — which may itself
///    return `Native` (no filesystem), `Hint` (reads a file), or `Failed`.
///
/// Kiro's implementation returns `Native` without touching `home_dir` at
/// all; Claude Code / Codex read `<home_dir>/.claude/agents/<name>.md`
/// or `<home_dir>/.codex/agents/<name>.md` respectively via
/// [`resolve_preamble_at`].
// gate:allow-unwired stage-2 registers AgentType impls that consume this trait
#[allow(dead_code)]
pub trait PersonaCapability {
    // gate:allow-unwired stage-2 registers impls
    /// Whether persona nomination has any meaning for this CLI family.
    ///
    /// - Kiro / Claude Code / Codex → `true`
    /// - All other agents → `false`
    ///
    /// A `false` provider is a hard short-circuit: the broker MUST NOT
    /// call [`Self::resolve_persona_effect`] on it.
    fn supports_persona(&self) -> bool;

    /// Turn a `(name, home_dir)` pair into a resolver result. Only called
    /// when [`Self::supports_persona`] returned `true` AND the name has
    /// already cleared [`is_valid_persona_name`].
    ///
    /// `home_dir` is the platform HOME (Unix `$HOME`, Windows
    /// `%USERPROFILE%`); Kiro's impl ignores it, Claude Code / Codex use
    /// it as the root under which they build the agents subdirectory
    /// path.
    fn resolve_persona_effect(&self, name: &str, home_dir: &Path) -> PersonaEffect;
}

/// Read and validate a persona file at `<root>/<name>.md`, returning its
/// frontmatter-stripped body ready to prepend to a first-turn prompt.
///
/// # Stage boundary
///
/// **Body is a stage-1 panicking stub.** The real implementation — with
/// canonical-path direct-child check (R2 F4), `BufReader::take` hard read
/// cap (R2 F4), UTF-8 + BOM validation, and strict frontmatter parsing
/// (R2 F2: unclosed `---` → `MalformedFrontmatter`, not a lenient
/// fall-through) — lands in stage 3.
///
/// # Contract (stage 3 target)
///
/// - `name` MUST have already passed [`is_valid_persona_name`]; the
///   function still checks it defensively and returns
///   `PersonaError::InvalidName` if the caller forgot.
/// - `root` is the CLI-specific canonical agents directory, e.g.
///   `<HOME>/.claude/agents` for Claude Code.
/// - On success returns the file's body with any leading `---` YAML
///   frontmatter stripped and any BOM removed. Empty body →
///   `PersonaError::EmptyBody`.
/// - Path safety: `<candidate>` must canonicalize to a *direct child* of
///   canonical `<root>`; nested subdirectories and symlinks pointing
///   outside `<root>` are `PathEscape`.
/// - Read cap: 200 KiB by default (stage 3 wires the constant); files
///   exceeding it return `TooLarge { name, cap }` without loading the
///   overflow into memory.
// gate:allow-unwired stage-3 lands the real body and stage-2 providers call it
#[allow(dead_code)]
pub fn resolve_preamble_at(_name: &str, _root: &Path) -> Result<String, PersonaError> {
    // stage 3: implement per §5 of docs/specs/delegate-persona-passthrough/design.md
    todo!("resolve_preamble_at lands in stage 3 (persona.rs safety impl)") // gate:allow-stub stage-1 signature-only landing; stage 3 lands the body
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn is_valid_persona_name_accepts_alnum_dash_underscore_1_to_64() {
        assert!(is_valid_persona_name("a"));
        assert!(is_valid_persona_name("plan-reality-recon"));
        assert!(is_valid_persona_name("Plan_Reality_Recon"));
        assert!(is_valid_persona_name("agent-01"));
        assert!(is_valid_persona_name(&"a".repeat(64)));
    }

    #[test]
    fn is_valid_persona_name_rejects_bad_inputs() {
        assert!(!is_valid_persona_name(""));
        assert!(!is_valid_persona_name(&"a".repeat(65)));
        assert!(!is_valid_persona_name("has space"));
        assert!(!is_valid_persona_name("dot.name"));
        assert!(!is_valid_persona_name("path/traversal"));
        assert!(!is_valid_persona_name("back\\slash"));
        assert!(!is_valid_persona_name(".."));
        assert!(!is_valid_persona_name("./foo"));
        // Non-ASCII (CJK / emoji) rejected — the allowed set is ASCII only.
        assert!(!is_valid_persona_name("中文"));
        assert!(!is_valid_persona_name("emoji-🤖"));
    }

    #[test]
    fn applied_persona_serde_round_trips_three_variants() {
        let cases = [
            AppliedPersona::Native {
                name: "plan-reality-recon".into(),
            },
            AppliedPersona::Hint {
                name: "code-reviewer".into(),
            },
            AppliedPersona::IgnoredUnsupportedCli {
                name: "unused".into(),
            },
        ];
        for original in cases {
            let json = serde_json::to_string(&original).expect("serialize");
            let back: AppliedPersona = serde_json::from_str(&json).expect("deserialize round trip");
            assert_eq!(original, back, "round trip mismatch for {json}");
        }

        // The tag is `kind` with snake_case renaming — spot-check the wire
        // shape so a rename can't silently drift.
        let native = serde_json::to_value(AppliedPersona::Native { name: "x".into() }).unwrap();
        assert_eq!(native["kind"], "native");
        let hint = serde_json::to_value(AppliedPersona::Hint { name: "y".into() }).unwrap();
        assert_eq!(hint["kind"], "hint");
        let ignored =
            serde_json::to_value(AppliedPersona::IgnoredUnsupportedCli { name: "z".into() })
                .unwrap();
        assert_eq!(ignored["kind"], "ignored_unsupported_cli");
    }

    #[test]
    fn persona_effect_variants_construct_without_panic() {
        let _native = PersonaEffect::Native {
            launch_option: LaunchOption::KiroPersona("plan-reality-recon".into()),
        };
        let _hint = PersonaEffect::Hint {
            preamble: "You are a careful reviewer.".into(),
        };
        let _ignored = PersonaEffect::Ignored;
        let _failed = PersonaEffect::Failed {
            wire_code: "invalid_persona",
            reason: "persona file not found".into(),
        };
    }

    #[test]
    fn launch_option_has_only_kiro_persona_variant_v1() {
        // Compile-time contract: exhaustive match on LaunchOption must
        // pattern-match `KiroPersona(_)` and nothing else. If a future
        // variant lands, this test forces the author to update the
        // stage-2 provider dispatch and the stage-5 spawner translation
        // in the same change.
        let opt = LaunchOption::KiroPersona("plan-reality-recon".into());
        let name = match opt {
            LaunchOption::KiroPersona(n) => n,
        };
        assert_eq!(name, "plan-reality-recon");
    }

    #[test]
    fn persona_error_display_carries_useful_context() {
        assert_eq!(
            PersonaError::InvalidName.to_string(),
            "persona name must match [A-Za-z0-9_-]{1,64}"
        );
        assert!(PersonaError::NotFound.to_string().contains("not found"));
        let too_large = PersonaError::TooLarge {
            name: "big".into(),
            cap: 204_800,
        };
        let msg = too_large.to_string();
        assert!(msg.contains("big"), "got: {msg}");
        assert!(msg.contains("204800"), "got: {msg}");
    }

    #[test]
    #[should_panic(expected = "resolve_preamble_at lands in stage 3")]
    fn resolve_preamble_at_is_not_yet_implemented() {
        // Guards the stage boundary: any code that accidentally starts
        // calling the resolver in stage 1 / 2 must fail loudly.
        let _ = resolve_preamble_at("plan-reality-recon", &PathBuf::from("/tmp"));
    }
}
