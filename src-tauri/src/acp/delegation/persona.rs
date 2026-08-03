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
//! # Module surface
//!
//! - [`LaunchOption`] — closed enum, one variant per launch-time knob (v1 =
//!   `KiroPersona`). Extend by adding a variant, NEVER by widening into an
//!   opaque map (R2 A4: opaque maps grow infra surface without business
//!   need). Consumed by `manager::spawn_child_inner`, which turns
//!   `KiroPersona(name)` into a `KIRO_AGENT=<name>` runtime-env entry.
//! - [`AppliedPersona`] — three-state outcome the frontend renders. No
//!   `Failed` variant (R3 F2 收窄): failures ride the wrapping
//!   `DelegationOutcome::Err` instead.
//! - [`PersonaEffect`] — broker-internal intermediate: what the resolver
//!   produced, before the broker turns it into `applied_persona`.
//! - [`PersonaError`] — resolver failure taxonomy. Emitted by
//!   [`resolve_preamble_at`].
//! - [`is_valid_persona_name`] — the grammar gate shared across all three
//!   tiers, applied BEFORE any filesystem access.
//! - [`PersonaCapability`] + [`provider_for`] — per-`AgentType` dispatch the
//!   broker walks to decide whether persona has meaning for a CLI and how to
//!   resolve it.
//! - [`resolve_preamble_at`] — canonical direct-child safety check (R2 F4),
//!   open on the canonical path (not the candidate) to reduce a symlink-swap
//!   race (does NOT eliminate it — see the fn doc), `BufReader::take` hard
//!   read cap at 200 KiB (R2 F4, not `metadata().len()`), UTF-8 + BOM
//!   validation, strict frontmatter parsing (R2 F2: unclosed `---` → hard
//!   fail, not lenient fall-through). Consumed by the Claude Code / Codex
//!   providers below.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::models::agent::AgentType;

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
///
/// # Variant shape (spec design §5 §5-line 250)
///
/// Every named-context variant carries a `String` payload — the persona
/// name for name-scoped errors, or a fuller reason for path/parse
/// failures. Stage 1 briefly landed these as unit variants (undocumented
/// drift from design §5); stage 3 restored the tuple-variant shape so
/// error messages surfaced through `DelegationError::InvalidPersona`
/// name the offending persona and cite the specific failure — the
/// broker's `wire_code` is always the stable `"invalid_persona"` but the
/// user-facing `reason` (frontend / LLM tool result) MUST distinguish
/// "file not found" from "path escape" from "too large".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersonaError {
    /// Name failed [`is_valid_persona_name`] — 1..=64 chars,
    /// `[A-Za-z0-9_-]` only. Payload = the offending name.
    InvalidName(String),
    /// `<root>/<name>.md` does not exist. Payload = persona name.
    /// `canonicalize` reporting `NotFound` for the candidate is folded
    /// into this variant so the LLM sees "persona X not found" rather
    /// than a filesystem stat detail.
    NotFound(String),
    /// File is not valid UTF-8. Payload = the offending name + inner error.
    NotUtf8(String),
    /// File body exceeds the hard read cap. `cap` is bytes.
    TooLarge { name: String, cap: usize },
    /// The persona file's body (after optional frontmatter stripping) is
    /// empty / whitespace-only. Payload = persona name.
    EmptyBody(String),
    /// The file opens with `---\n` (or `---\r\n`) but the closing `---`
    /// delimiter is never found. Hard failure — R2 F2 rejects tolerant
    /// fall-through since a truncated file is likely a persona the user
    /// meant to work but a save error corrupted. Payload = detailed
    /// reason including persona name.
    MalformedFrontmatter(String),
    /// After canonicalization, the resolved file is not a direct child of
    /// the canonical agents root (symlink escape / nested subdir / `..`
    /// traversal). Uses `canonical.parent() == Some(canonical_root)`, not
    /// `starts_with`, so `<root>/sub/foo.md` also fails. Payload =
    /// detailed reason including persona name.
    PathEscape(String),
    /// Any other filesystem IO error. Kept a single string to avoid
    /// leaking `std::io::Error` (not `Clone`) through the enum.
    IoError(String),
}

impl std::fmt::Display for PersonaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PersonaError::InvalidName(name) => {
                write!(f, "persona name '{name}' must match [A-Za-z0-9_-]{{1,64}}")
            }
            PersonaError::NotFound(name) => {
                write!(f, "persona '{name}' file not found")
            }
            PersonaError::NotUtf8(detail) => {
                write!(f, "persona file is not valid UTF-8: {detail}")
            }
            PersonaError::TooLarge { name, cap } => {
                write!(f, "persona '{name}' body exceeds the {cap}-byte read cap")
            }
            PersonaError::EmptyBody(name) => {
                write!(
                    f,
                    "persona '{name}' body is empty after frontmatter stripping"
                )
            }
            PersonaError::MalformedFrontmatter(detail) => write!(f, "{detail}"),
            PersonaError::PathEscape(detail) => write!(f, "{detail}"),
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
pub fn is_valid_persona_name(name: &str) -> bool {
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
pub trait PersonaCapability {
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
/// # Contract (spec design §5, R2 F4 + R2 F2 采纳)
///
/// - `name` MUST have already passed [`is_valid_persona_name`]; the
///   function still checks it defensively and returns
///   `PersonaError::InvalidName` if the caller forgot.
/// - `root` is the CLI-specific canonical agents directory, e.g.
///   `<HOME>/.claude/agents` for Claude Code (resolved by
///   `crate::parsers::claude::resolve_claude_config_dir()`).
/// - On success returns the file's body with any leading `---` YAML
///   frontmatter stripped and any BOM removed. Empty body →
///   `PersonaError::EmptyBody`.
/// - Path safety (R2 F4): `<candidate>` must canonicalize to a *direct
///   child* of canonical `<root>`; nested subdirectories and symlinks
///   pointing outside `<root>` are `PathEscape`. Direct-child is checked
///   via `canonical.parent() == Some(canonical_root)`, NOT `starts_with`
///   — `starts_with` would let a persona in a subdirectory pass.
/// - Symlink-swap race (R2 F4): the file is opened on the canonical path
///   itself, not the candidate, so a symlink swapped between canonicalize
///   and open still hits the original entity. This REDUCES the check/use
///   (TOCTOU) race but does NOT eliminate it — canonicalize resolves the
///   path, then open re-traverses it by name, so a swap in that window is
///   still theoretically possible. Acceptable under the single-tenant
///   trust model (R1 A2): the agents directory is the user's own, and a
///   local attacker who can swap symlinks there already has the user's
///   privileges.
/// - Read cap (R2 F4): 200 KiB hard ceiling via `BufReader::take` — the
///   `+1` sentinel byte plus a `bytes.len() > cap` check detects
///   overflow without buffering the overflow content. `metadata().len()`
///   is NEVER trusted (sparse files, procfs-style special files).
/// - Frontmatter parsing (R2 F2): opening `---\n` / `---\r\n` MUST be
///   followed by a closing lone `---` line; a missing closer is a hard
///   `MalformedFrontmatter` error, NOT a lenient fall-through
///   (frontmatter YAML injected into a downstream prompt would be a
///   silent security regression). No `serde_yaml` / markdown parser
///   dependency — a hand-rolled state machine matches the fences.
pub fn resolve_preamble_at(name: &str, root: &Path) -> Result<String, PersonaError> {
    // 1. Name grammar gate — defence-in-depth. Broker also pre-checks,
    //    but a caller that skipped it must still get a typed error, not
    //    an accidental filesystem probe with a `../` name.
    if !is_valid_persona_name(name) {
        return Err(PersonaError::InvalidName(name.to_string()));
    }

    // 2. Canonicalize root and candidate separately. Canonicalizing the
    //    root as well means a root that itself lives under a symlink
    //    still resolves to the same real path used for the parent
    //    equality check below (design §5 point 2: 避免根目录本身是
    //    symlink 时相等判断失败).
    let candidate = root.join(format!("{name}.md"));
    let canonical_root = std::fs::canonicalize(root).map_err(|e| {
        PersonaError::IoError(format!(
            "canonicalize persona root {}: {}",
            root.display(),
            e
        ))
    })?;
    let canonical = std::fs::canonicalize(&candidate).map_err(|e| {
        // NotFound is the common case; caller-facing message names the
        // persona (design §5, echoes R1-F1 error taxonomy).
        if e.kind() == std::io::ErrorKind::NotFound {
            PersonaError::NotFound(name.to_string())
        } else {
            PersonaError::IoError(format!(
                "canonicalize persona candidate {}: {}",
                candidate.display(),
                e
            ))
        }
    })?;

    // 3. Direct-child check via `canonical.parent()` equality (R2 F4).
    //    `starts_with(canonical_root)` would let <root>/sub/foo.md pass —
    //    that is exactly the shape a nested-directory or symlink-escape
    //    attack takes.
    if canonical.parent() != Some(canonical_root.as_path()) {
        return Err(PersonaError::PathEscape(format!(
            "persona '{}' canonical path {} is not a direct child of {}",
            name,
            canonical.display(),
            canonical_root.display()
        )));
    }

    // 4. Open the CANONICAL path, not the candidate. If a symlink was
    //    swapped between canonicalize() and open(), the open still lands on
    //    the original inode (or fails cleanly). This narrows — but does not
    //    fully close — the check/use (TOCTOU) window; residual race is
    //    acceptable under the single-tenant trust model (R1 A2, see fn doc).
    let file = std::fs::File::open(&canonical).map_err(|e| {
        PersonaError::IoError(format!("open persona {}: {}", canonical.display(), e))
    })?;

    // 5. Hard read cap via BufReader::take. `+1` sentinel byte lets us
    //    detect overflow with a length compare, without ever buffering
    //    the overflow content. metadata().len() is NEVER trusted —
    //    sparse files / special files lie.
    const CAP: usize = 200 * 1024;
    let mut reader = std::io::BufReader::new(file).take((CAP as u64) + 1);
    let mut bytes = Vec::with_capacity(4096);
    use std::io::Read;
    reader
        .read_to_end(&mut bytes)
        .map_err(|e| PersonaError::IoError(format!("read persona '{name}': {e}")))?;
    if bytes.len() > CAP {
        return Err(PersonaError::TooLarge {
            name: name.to_string(),
            cap: CAP,
        });
    }

    // 6. UTF-8 decode + BOM strip. BOM must come off BEFORE the
    //    frontmatter fence probe, or a BOM'd file that starts with
    //    "\u{FEFF}---\n" would be treated as having no frontmatter.
    let mut text = String::from_utf8(bytes)
        .map_err(|e| PersonaError::NotUtf8(format!("persona '{name}' not UTF-8: {e}")))?;
    if let Some(stripped) = text.strip_prefix('\u{FEFF}') {
        text = stripped.to_string();
    }

    // 7. Frontmatter strip (R2 F2 — hard fail on unclosed fence).
    let body = strip_frontmatter(&text, name)?;
    if body.trim().is_empty() {
        return Err(PersonaError::EmptyBody(name.to_string()));
    }
    Ok(body)
}

/// Hand-rolled frontmatter state machine. Returns the body (frontmatter
/// removed); a missing closing fence is a hard `MalformedFrontmatter`.
///
/// Spec design §5 point 6: opening `---\n` / `---\r\n` must be followed
/// by a lone `---` line (LF, CRLF, or EOF terminator). No `serde_yaml`,
/// no markdown parser — just fence matching. Frontmatter content itself
/// is discarded; only the body flows downstream.
fn strip_frontmatter(text: &str, name: &str) -> Result<String, PersonaError> {
    // Detect the opening fence. Lone "---" at file top with no newline
    // is NOT a fence (a one-line "---" file is a body, not an unclosed
    // block); require a following newline so we know where to start the
    // scan for the closer.
    let after_start = if let Some(rest) = text.strip_prefix("---\n") {
        // Length of the consumed opener; used to key back into `text`
        // rather than `rest` to keep offsets aligned.
        let _ = rest;
        4
    } else if let Some(rest) = text.strip_prefix("---\r\n") {
        let _ = rest;
        5
    } else {
        return Ok(text.to_string());
    };

    // Scan for a lone "---" line inside the region after the opener.
    // Every line starts either at `after_start` or right after a `\n`
    // we've already seen. On each candidate line start, check whether
    // the line's content (up to the next line terminator or EOF) is
    // exactly "---" — that's the closing fence.
    let mut line_start = after_start;
    let text_bytes = text.as_bytes();
    while line_start <= text_bytes.len() {
        // Find the end of this line (index of `\n`, or EOF).
        let next_nl = text[line_start..].find('\n');
        let (line_end, next_start) = match next_nl {
            Some(off) => (line_start + off, line_start + off + 1),
            None => (text_bytes.len(), text_bytes.len() + 1),
        };
        // Strip a trailing `\r` for CRLF lines.
        let effective_end = if line_end > line_start && text_bytes[line_end - 1] == b'\r' {
            line_end - 1
        } else {
            line_end
        };
        let line = &text[line_start..effective_end];
        if line == "---" {
            // Closer found — body starts at `next_start`. If we ran off
            // the end (no trailing newline after the closer), body is
            // empty; upstream `EmptyBody` check will catch it.
            if next_start > text_bytes.len() {
                return Ok(String::new());
            }
            return Ok(text[next_start..].to_string());
        }
        // Advance. If we hit EOF without seeing the closer, break.
        if next_nl.is_none() {
            break;
        }
        line_start = next_start;
    }

    Err(PersonaError::MalformedFrontmatter(format!(
        "persona '{name}' has an opening '---' fence but no closing fence"
    )))
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage-2 · Provider capability dispatch
// ─────────────────────────────────────────────────────────────────────────────
//
// broker.rs consumes `provider_for(agent_type)` (stage 4) and never matches
// on `AgentType` variants itself. Adding a fourth persona-supporting CLI is
// a single new unit-struct + a match arm below; broker stays untouched.
//
// Rust does NOT allow `impl Trait for AgentType::Kiro` (variants are values,
// not types), so each family gets a zero-sized unit-struct bridge. These
// structs are static singletons — they hold no state and are handed out as
// `&'static dyn PersonaCapability` from `provider_for`.
//
// **Stage-3 landing**: `ClaudeCodeProvider` / `CodexProvider` now call
// [`resolve_preamble_at`] with the CLI-specific canonical agents root
// resolved via `crate::parsers::claude::resolve_claude_config_dir()` /
// `crate::parsers::codex::resolve_codex_home_dir()` (which each honour
// `CLAUDE_CONFIG_DIR` / `CODEX_HOME` env overrides before falling back to
// `$HOME`). The `home_dir` trait argument is deliberately unused on this
// path — the parser helpers already encapsulate the HOME + env lookup so
// broker never has to duplicate it — but the parameter is kept on the
// trait for interface symmetry (a future upstream `CLAUDE_ACP_AGENT` env
// support might resolve without touching disk and want the raw HOME).

/// Unit-struct bridge that hangs [`PersonaCapability`] off the `Kiro`
/// [`AgentType`] variant. Zero-sized; a single static reference is handed
/// out via [`provider_for`].
pub struct KiroProvider;

impl PersonaCapability for KiroProvider {
    fn supports_persona(&self) -> bool {
        true
    }

    fn resolve_persona_effect(&self, name: &str, _home_dir: &Path) -> PersonaEffect {
        // Grammar gate — defence-in-depth. Broker also pre-checks, but a
        // Provider caller that skips it must still get a typed Failed back
        // rather than a panic in the downstream spawner.
        if !is_valid_persona_name(name) {
            return PersonaEffect::Failed {
                wire_code: "invalid_persona",
                reason: format!("persona name '{name}' violates grammar"),
            };
        }
        // Kiro is the only tier with a REAL launch-option: kiro-cli reloads
        // <KIRO_HOME>/agents/<name>.json at spawn (permissions / tools /
        // prompt all take effect). `home_dir` is ignored — the KIRO_HOME
        // resolution happens inside kiro-cli itself, not on this side.
        PersonaEffect::Native {
            launch_option: LaunchOption::KiroPersona(name.to_string()),
        }
    }
}

/// Claude Code persona provider. Reads
/// `<resolve_claude_config_dir()>/agents/<name>.md`, strips frontmatter,
/// and returns the body as a `Hint` preamble. On any resolver failure
/// (not found / not UTF-8 / too large / path escape / malformed
/// frontmatter / empty body / IO) returns `Failed{invalid_persona}` with
/// the concrete cause in `reason`.
///
/// Note: `home_dir` is intentionally unused — `resolve_claude_config_dir`
/// already handles `CLAUDE_CONFIG_DIR` env → `$HOME/.claude` fallback
/// (see `crate::parsers::claude`). Keeping the parameter preserves the
/// trait interface symmetry.
pub struct ClaudeCodeProvider;

impl PersonaCapability for ClaudeCodeProvider {
    fn supports_persona(&self) -> bool {
        true
    }

    fn resolve_persona_effect(&self, name: &str, _home_dir: &Path) -> PersonaEffect {
        if !is_valid_persona_name(name) {
            return PersonaEffect::Failed {
                wire_code: "invalid_persona",
                reason: format!("persona name '{name}' violates grammar"),
            };
        }
        let root = crate::parsers::claude::resolve_claude_config_dir().join("agents");
        match resolve_preamble_at(name, &root) {
            Ok(preamble) => PersonaEffect::Hint { preamble },
            Err(err) => PersonaEffect::Failed {
                wire_code: "invalid_persona",
                reason: err.to_string(),
            },
        }
    }
}

/// Codex persona provider. Reads
/// `<resolve_codex_home_dir()>/agents/<name>.md` and follows the same
/// shape as [`ClaudeCodeProvider`]. `resolve_codex_home_dir` honours the
/// `CODEX_HOME` env variable (see `crate::parsers::codex`).
pub struct CodexProvider;

impl PersonaCapability for CodexProvider {
    fn supports_persona(&self) -> bool {
        true
    }

    fn resolve_persona_effect(&self, name: &str, _home_dir: &Path) -> PersonaEffect {
        if !is_valid_persona_name(name) {
            return PersonaEffect::Failed {
                wire_code: "invalid_persona",
                reason: format!("persona name '{name}' violates grammar"),
            };
        }
        let root = crate::parsers::codex::resolve_codex_home_dir().join("agents");
        match resolve_preamble_at(name, &root) {
            Ok(preamble) => PersonaEffect::Hint { preamble },
            Err(err) => PersonaEffect::Failed {
                wire_code: "invalid_persona",
                reason: err.to_string(),
            },
        }
    }
}

/// Catch-all provider for CLIs with no persona concept (Gemini, OpenCode,
/// OpenClaw, Cline, Hermes, CodeBuddy, KimiCode, Pi, Grok, Cursor, and any
/// user-registered `AgentType::Custom(...)`).
///
/// `supports_persona() == false` short-circuits the broker BEFORE any name
/// grammar check or HOME lookup (R3 F1). `resolve_persona_effect` is
/// defensive: if a caller ignores `supports_persona()` and calls anyway,
/// it must still get [`PersonaEffect::Ignored`] rather than a panic.
pub struct UnsupportedProvider;

impl PersonaCapability for UnsupportedProvider {
    fn supports_persona(&self) -> bool {
        false
    }

    fn resolve_persona_effect(&self, _name: &str, _home_dir: &Path) -> PersonaEffect {
        PersonaEffect::Ignored
    }
}

// Static singletons — every provider is zero-sized, so `&'static Self` is
// free and lets `provider_for` return a `&'static dyn PersonaCapability`.
static KIRO_PROVIDER: KiroProvider = KiroProvider;
static CLAUDE_CODE_PROVIDER: ClaudeCodeProvider = ClaudeCodeProvider;
static CODEX_PROVIDER: CodexProvider = CodexProvider;
static UNSUPPORTED_PROVIDER: UnsupportedProvider = UnsupportedProvider;

/// Dispatch an [`AgentType`] to its [`PersonaCapability`] provider.
///
/// # Broker call order (R3 F1, must be followed)
///
/// 1. `let provider = provider_for(agent_type);`
/// 2. `if !provider.supports_persona() { /* Ignored — no name check, no HOME */ }`
/// 3. `if !is_valid_persona_name(name) { /* InvalidPersona */ }`
/// 4. `provider.resolve_persona_effect(name, &home_dir)`
///
/// # Adding a new supported CLI
///
/// 1. Add a `<Name>Provider` unit struct + `impl PersonaCapability`.
/// 2. Add a `static <NAME>_PROVIDER: <Name>Provider = ...;`.
/// 3. Add a `match` arm below.
///
/// broker.rs does NOT change.
pub fn provider_for(agent_type: AgentType) -> &'static dyn PersonaCapability {
    match agent_type {
        AgentType::Kiro => &KIRO_PROVIDER,
        AgentType::ClaudeCode => &CLAUDE_CODE_PROVIDER,
        AgentType::Codex => &CODEX_PROVIDER,
        // Every other built-in CLI + `Custom(...)` user-registered agents
        // fall to the unsupported path. Adding a new supported family
        // means adding a new provider unit-struct and a match arm here,
        // NOT touching broker.rs.
        AgentType::OpenCode
        | AgentType::Gemini
        | AgentType::OpenClaw
        | AgentType::Cline
        | AgentType::Hermes
        | AgentType::CodeBuddy
        | AgentType::KimiCode
        | AgentType::Pi
        | AgentType::Grok
        | AgentType::Cursor
        | AgentType::Custom(_) => &UNSUPPORTED_PROVIDER,
    }
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
            PersonaError::InvalidName("bad!".into()).to_string(),
            "persona name 'bad!' must match [A-Za-z0-9_-]{1,64}"
        );
        assert!(PersonaError::NotFound("missing".into())
            .to_string()
            .contains("not found"));
        let too_large = PersonaError::TooLarge {
            name: "big".into(),
            cap: 204_800,
        };
        let msg = too_large.to_string();
        assert!(msg.contains("big"), "got: {msg}");
        assert!(msg.contains("204800"), "got: {msg}");
    }

    // ─────────────────────────────────────────────────────────────────────
    // Stage-2 · Provider capability dispatch tests
    // ─────────────────────────────────────────────────────────────────────

    /// Small helper — Kiro ignores the arg entirely; Claude/Codex delegate
    /// to `resolve_claude_config_dir()` / `resolve_codex_home_dir()` on
    /// stage 3 and also ignore the trait parameter. Any literal works.
    fn dummy_home() -> PathBuf {
        PathBuf::from("/nonexistent-home-for-provider-tests")
    }

    #[test]
    fn provider_for_kiro_returns_native_kiro_persona() {
        let provider = provider_for(AgentType::Kiro);
        assert!(provider.supports_persona(), "Kiro must support persona");
        let effect = provider.resolve_persona_effect("plan-reality-recon", &dummy_home());
        match effect {
            PersonaEffect::Native {
                launch_option: LaunchOption::KiroPersona(name),
            } => assert_eq!(name, "plan-reality-recon"),
            other => panic!("expected Native{{KiroPersona}}, got {other:?}"),
        }
    }

    #[test]
    fn provider_for_claude_code_supports_persona_and_dispatches_to_resolver() {
        // Stage-3 landing: ClaudeCodeProvider now calls resolve_preamble_at
        // against resolve_claude_config_dir().join("agents"). We can't
        // deterministically assert the resolver's outcome here (depends on
        // whether the CI host happens to have ~/.claude/agents/<name>.md),
        // but we CAN assert (a) capability = true and (b) name-grammar
        // failure still short-circuits before the resolver — that
        // behaviour is env-independent. Full resolver semantics are
        // exercised in the resolve_preamble_at_* tests further down using
        // an isolated tempdir.
        let provider = provider_for(AgentType::ClaudeCode);
        assert!(
            provider.supports_persona(),
            "ClaudeCode must support persona"
        );
    }

    #[test]
    fn provider_for_codex_supports_persona_and_dispatches_to_resolver() {
        let provider = provider_for(AgentType::Codex);
        assert!(provider.supports_persona(), "Codex must support persona");
    }

    #[test]
    fn provider_for_gemini_is_unsupported_and_returns_ignored() {
        // Spot-check for the whole unsupported catch-all family.
        let provider = provider_for(AgentType::Gemini);
        assert!(
            !provider.supports_persona(),
            "Gemini must NOT support persona (R3 F1 short-circuit)"
        );
        let effect = provider.resolve_persona_effect("any-name", &dummy_home());
        assert_eq!(effect, PersonaEffect::Ignored);
    }

    #[test]
    fn provider_for_all_unsupported_variants_agree() {
        // Guard against half-listed match arm drift: every non-supported
        // built-in must resolve to the same UnsupportedProvider behaviour.
        let unsupported = [
            AgentType::OpenCode,
            AgentType::Gemini,
            AgentType::OpenClaw,
            AgentType::Cline,
            AgentType::Hermes,
            AgentType::CodeBuddy,
            AgentType::KimiCode,
            AgentType::Pi,
            AgentType::Grok,
            AgentType::Cursor,
        ];
        for agent in unsupported {
            let provider = provider_for(agent);
            assert!(
                !provider.supports_persona(),
                "{agent:?} unexpectedly claims persona support"
            );
            assert_eq!(
                provider.resolve_persona_effect("x", &dummy_home()),
                PersonaEffect::Ignored,
                "{agent:?} did not produce Ignored"
            );
        }
    }

    #[test]
    fn provider_for_custom_agent_is_unsupported() {
        // Custom(...) user-registered agents ride the unsupported path;
        // hard-code an interned slug so we don't need the acp custom_registry.
        let custom = AgentType::custom("goose").expect("valid custom slug");
        let provider = provider_for(custom);
        assert!(!provider.supports_persona());
        assert_eq!(
            provider.resolve_persona_effect("anything", &dummy_home()),
            PersonaEffect::Ignored
        );
    }

    #[test]
    fn kiro_provider_rejects_invalid_name_defensively() {
        // Broker also pre-checks, but the trait method must still guard
        // itself. Invalid name never turns into a Native{KiroPersona}
        // that the downstream spawner would happily hand to kiro-cli argv.
        let provider = provider_for(AgentType::Kiro);
        for bad in ["", "foo.bar", "path/traversal", &"a".repeat(65)] {
            match provider.resolve_persona_effect(bad, &dummy_home()) {
                PersonaEffect::Failed { wire_code, reason } => {
                    assert_eq!(wire_code, "invalid_persona");
                    assert!(
                        reason.contains("grammar"),
                        "expected grammar reason for {bad:?}, got: {reason}"
                    );
                }
                other => panic!("Kiro accepted invalid name {bad:?}: {other:?}"),
            }
        }
    }

    #[test]
    fn claude_and_codex_providers_reject_invalid_name_before_touching_disk() {
        // Invalid name must short-circuit at the grammar gate BEFORE the
        // provider tries to canonicalize the agents root — otherwise a
        // path-shaped name like "foo.bar" or "path/traversal" would
        // reach `resolve_preamble_at` and get a filesystem error
        // instead of the grammar error the LLM needs to see.
        for agent in [AgentType::ClaudeCode, AgentType::Codex] {
            let provider = provider_for(agent);
            match provider.resolve_persona_effect("foo.bar", &dummy_home()) {
                PersonaEffect::Failed { wire_code, reason } => {
                    assert_eq!(wire_code, "invalid_persona");
                    assert!(
                        reason.contains("grammar"),
                        "{agent:?}: expected grammar reason, got: {reason}"
                    );
                }
                other => panic!("{agent:?} accepted invalid name: {other:?}"),
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Stage-3 · resolve_preamble_at safety + frontmatter tests
    // ─────────────────────────────────────────────────────────────────────
    //
    // Property 6 (name grammar) is already covered by
    // `is_valid_persona_name_rejects_bad_inputs`; this section covers the
    // filesystem-facing R2 F4 safety guarantees and the R2 F2 frontmatter
    // parser. All tests use `tempfile::TempDir` for isolation — an
    // ambient `~/.claude/agents/...` on the CI host must NOT influence
    // outcomes.

    use tempfile::TempDir;

    /// Build an isolated agents-root tempdir plus a fresh persona name
    /// suffixed with the process id and a counter so parallel test runs
    /// never collide.
    fn make_agents_root() -> TempDir {
        tempfile::tempdir().expect("tempdir for agents root")
    }

    fn write_persona(root: &std::path::Path, name: &str, contents: &[u8]) {
        std::fs::write(root.join(format!("{name}.md")), contents).expect("write persona");
    }

    #[test]
    fn resolve_preamble_at_ok_no_frontmatter() {
        let root = make_agents_root();
        write_persona(root.path(), "plain", b"hello world");
        let body = resolve_preamble_at("plain", root.path()).expect("ok");
        assert_eq!(body, "hello world");
    }

    #[test]
    fn resolve_preamble_at_ok_lf_frontmatter() {
        let root = make_agents_root();
        write_persona(root.path(), "lf", b"---\nkey: v\n---\nbody\n");
        let body = resolve_preamble_at("lf", root.path()).expect("ok");
        assert_eq!(body, "body\n");
    }

    #[test]
    fn resolve_preamble_at_ok_crlf_frontmatter() {
        let root = make_agents_root();
        write_persona(root.path(), "crlf", b"---\r\nkey: v\r\n---\r\nbody\r\n");
        let body = resolve_preamble_at("crlf", root.path()).expect("ok");
        assert_eq!(body, "body\r\n");
    }

    #[test]
    fn resolve_preamble_at_ok_bom_plus_lf_frontmatter() {
        let root = make_agents_root();
        // BOM must be stripped BEFORE the fence probe; otherwise the file
        // reads as "no frontmatter" and the YAML block flows downstream.
        let mut buf = Vec::new();
        buf.extend_from_slice("\u{FEFF}".as_bytes());
        buf.extend_from_slice(b"---\nkey: v\n---\nbody\n");
        write_persona(root.path(), "bom", &buf);
        let body = resolve_preamble_at("bom", root.path()).expect("ok");
        assert_eq!(body, "body\n");
    }

    #[test]
    fn resolve_preamble_at_rejects_unclosed_frontmatter() {
        let root = make_agents_root();
        write_persona(root.path(), "unclosed", b"---\nkey: v\nno close fence");
        match resolve_preamble_at("unclosed", root.path()) {
            Err(PersonaError::MalformedFrontmatter(msg)) => {
                assert!(
                    msg.contains("unclosed"),
                    "expected persona name in reason, got: {msg}"
                );
            }
            other => panic!("expected MalformedFrontmatter, got {other:?}"),
        }
    }

    #[test]
    fn resolve_preamble_at_rejects_frontmatter_only_as_empty_body() {
        let root = make_agents_root();
        // "---\nk: v\n---\n" — frontmatter closes cleanly, body empty.
        write_persona(root.path(), "empty", b"---\nk: v\n---\n");
        match resolve_preamble_at("empty", root.path()) {
            Err(PersonaError::EmptyBody(name)) => {
                assert_eq!(name, "empty");
            }
            other => panic!("expected EmptyBody, got {other:?}"),
        }
    }

    #[test]
    fn resolve_preamble_at_rejects_frontmatter_only_no_trailing_newline() {
        // "---\nk: v\n---" (no trailing newline after closer). Body is
        // still empty; EmptyBody applies. Guards the strip_frontmatter
        // EOF-terminated-fence branch.
        let root = make_agents_root();
        write_persona(root.path(), "eof-close", b"---\nk: v\n---");
        match resolve_preamble_at("eof-close", root.path()) {
            Err(PersonaError::EmptyBody(name)) => {
                assert_eq!(name, "eof-close");
            }
            other => panic!("expected EmptyBody, got {other:?}"),
        }
    }

    #[test]
    fn resolve_preamble_at_read_cap_boundary() {
        // Cap = 200 KiB. `cap` bytes → Ok, `cap+1` → TooLarge.
        // Filler is a single ASCII byte to make counting easy; body
        // is non-empty so EmptyBody doesn't trip.
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
    fn resolve_preamble_at_rejects_direct_child_violation_via_subdirectory() {
        // <root>/sub/foo.md — starts_with(root) is true but
        // canonical.parent() != Some(canonical_root), so PathEscape.
        // This is the core reason `starts_with` was rejected in the
        // R2 F4 review.
        let root = make_agents_root();
        std::fs::create_dir(root.path().join("sub")).expect("mkdir sub");
        std::fs::write(root.path().join("sub").join("foo.md"), b"body").expect("write");
        // The candidate is <root>/foo.md (doesn't exist) — subdir was a
        // decoy; the real defense is that a name must map to a *direct*
        // child. Since <root>/foo.md doesn't exist, we get NotFound
        // instead of PathEscape here; the real subdirectory-escape
        // vector is via symlink (next test).
        match resolve_preamble_at("foo", root.path()) {
            Err(PersonaError::NotFound(name)) => assert_eq!(name, "foo"),
            other => panic!("expected NotFound for <root>/foo.md absent, got {other:?}"),
        }
    }

    #[test]
    fn resolve_preamble_at_rejects_missing_file_as_not_found() {
        let root = make_agents_root();
        match resolve_preamble_at("ghost", root.path()) {
            Err(PersonaError::NotFound(name)) => assert_eq!(name, "ghost"),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn resolve_preamble_at_defensively_rejects_invalid_name() {
        // Broker should have pre-checked, but the resolver's own defence
        // must return InvalidName without probing the filesystem.
        let root = make_agents_root();
        match resolve_preamble_at("path/traversal", root.path()) {
            Err(PersonaError::InvalidName(name)) => assert_eq!(name, "path/traversal"),
            other => panic!("expected InvalidName, got {other:?}"),
        }
        match resolve_preamble_at(&"a".repeat(65), root.path()) {
            Err(PersonaError::InvalidName(_)) => {}
            other => panic!("expected InvalidName for 65-char name, got {other:?}"),
        }
        match resolve_preamble_at("中文", root.path()) {
            Err(PersonaError::InvalidName(_)) => {}
            other => panic!("expected InvalidName for CJK name, got {other:?}"),
        }
    }

    /// Symlink-based path-escape test. Only runs on Unix — creating file
    /// symlinks on Windows requires either administrator privileges or
    /// Developer Mode, which is not guaranteed on CI runners. The Unix
    /// path exercises the same R2 F4 canonical direct-child guard.
    #[cfg(unix)]
    #[test]
    fn resolve_preamble_at_rejects_symlink_escape_unix() {
        use std::os::unix::fs::symlink;
        let outer = tempfile::tempdir().expect("outer tempdir");
        // Place the real secret file OUTSIDE the agents root.
        let secret_path = outer.path().join("secret.md");
        std::fs::write(&secret_path, b"escaped").expect("write secret");
        // Now the agents root, sibling to secret.md.
        let root_dir = outer.path().join("agents");
        std::fs::create_dir(&root_dir).expect("mkdir agents");
        // <root>/escape.md → ../secret.md
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
}
