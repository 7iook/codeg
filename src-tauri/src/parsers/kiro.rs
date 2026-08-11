//! Kiro CLI transcript parser.
//!
//! Kiro stores each CLI conversation as a single newline-delimited JSON file:
//!
//! ```text
//! <KIRO_HOME>/                     (default ~/.kiro, override via KIRO_HOME)
//! └── sessions/
//!     └── cli/
//!         └── <session-uuid>.jsonl
//! ```
//!
//! Every line is an envelope `{"version":"v1","kind":…,"data":{…}}`. codeg only
//! ever reads these files.
//!
//! The IDE/spec transcript layout (`<KIRO_HOME>/sessions/<hash>/sess_<uuid>/`)
//! is a different format and is deliberately out of scope.
//!
//! ## Envelope stream (measured over the 921 local sessions, 1.48 GB)
//!
//! Top-level `kind` has five values:
//!
//! - `Prompt` — a user prompt. `data.{message_id, content[], meta.timestamp}`
//!   (the unix-second `meta.timestamp` is the ONLY clock in the stream, and 61 of
//!   968 sampled prompts carried no `meta` at all). **Opens a new turn.**
//! - `AssistantMessage` — `data.{message_id, content[]}`; no timestamp. One
//!   assistant round: `thinking` / `text` / `toolUse` blocks in emit order.
//! - `ToolResults` — `data.{message_id, content[], results{}}`. `content[]` holds
//!   the `toolResult` blocks (`{toolUseId, content[], status:"success"|"error"}`);
//!   the sibling `results` map is Kiro's internal `{toolUseId: {tool, result}}`
//!   bookkeeping (its `tool.kind` a `{BuiltIn|Mcp: …}` tagged enum) and is NOT
//!   read here — everything rendered lives in `content[]`.
//! - `Clear` — `/clear`. The envelope carries **no `data` at all**. **Ends the
//!   current turn and drops its context association**, so no later `toolResult`
//!   can pair with a `toolUse` from before it.
//! - `Compaction` — `data.{summary, strategy, messages_snapshot[]}`; no
//!   `message_id`, no `content`. A context-compaction checkpoint, **not** a turn
//!   boundary (measured: it is followed by `ToolResults` as often as by `Prompt`,
//!   i.e. it lands mid-turn).
//!
//! Inner `data.content[].kind`:
//!
//! - `text` — `data` is a bare **string**.
//! - `thinking` — `data.{text, signature, redactedContent[], modelId}`. The only
//!   place a model id appears in the whole transcript.
//! - `toolUse` — `data.{toolUseId, name, input{}}`. `input` always carries
//!   Kiro's injected `__tool_use_purpose` key alongside the real arguments.
//! - `toolResult` — `data.{toolUseId, content[], status}`, whose inner
//!   `content[]` items are `{kind:"json"|"text"|"image", data}`.
//! - `image` — `data.{format, source:{kind:"bytes", data:[u8…]}}`: a **byte
//!   array**, not base64 (re-encoded here for the frontend's `ImageData`).
//!
//! ## Turn model
//!
//! `Prompt` opens a user turn; the following `AssistantMessage` / `ToolResults`
//! events accumulate into ONE assistant turn until the next `Prompt` or a
//! `Clear`. Each `toolResult` is matched to the `toolUse` of the same id **within
//! the open turn only** (R3.4.2): the id→slot map is cleared at every turn
//! boundary, so a result whose call belongs to an earlier turn can never be
//! hoisted backwards — it renders in place as an orphan tool result (R3.4.3).
//! This is why the shared `relocate_orphaned_tool_results` helper is deliberately
//! NOT used here: it moves a result to whichever turn holds the matching call,
//! which is exactly the cross-turn pairing R3.4.2 forbids.

use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use chrono::{DateTime, TimeZone, Utc};
use serde_json::Value;

use crate::models::{
    AgentType, ContentBlock, ConversationDetail, ConversationSummary, ImageData, MessageTurn,
    TurnRole,
};
use crate::parsers::{
    compute_session_stats, infer_context_window_max_tokens, merge_context_window_stats,
    structurize_read_tool_output, title_from_user_text, truncate_str, AgentParser, ParseError,
};

/// Cap for one rendered tool result. Kiro embeds whole command transcripts and
/// file reads verbatim (single sessions reach 60 MB), so bound each one.
const KIRO_TOOL_OUTPUT_CAP: usize = 100_000;
/// Cap for one rendered tool input preview (mirrors grok/cursor).
const KIRO_TOOL_INPUT_CAP: usize = 8_000;
/// Cap for a `Compaction.summary`. Measured max on this machine: 17 739 chars,
/// and the text can quote the user's private steering prompt verbatim — capped
/// for the payload and never logged (R3.5.1).
const KIRO_COMPACTION_SUMMARY_CAP: usize = 4_000;
/// Cap for the rendered `Compaction.messages_snapshot`. Measured max: 2.7 MB of
/// JSON for a single checkpoint — it must never travel to the frontend whole.
const KIRO_COMPACTION_SNAPSHOT_CAP: usize = 4_000;

/// Resolve Kiro's data home, honoring `KIRO_HOME`, else `~/.kiro`.
///
/// This is the single resolution point for every consumer of Kiro data
/// (transcripts, custom agent scan, MCP config read/write, and the ACP write
/// boundary) so they can never disagree on which root is in use.
pub(crate) fn resolve_kiro_home_dir() -> PathBuf {
    resolve_kiro_home_from(std::env::var_os("KIRO_HOME"), dirs::home_dir())
}

fn resolve_kiro_home_from(kiro_home_env: Option<OsString>, home_dir: Option<PathBuf>) -> PathBuf {
    kiro_home_env
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.unwrap_or_default().join(".kiro"))
}

/// Directory holding the CLI transcripts: `<KIRO_HOME>/sessions/cli`.
pub(crate) fn kiro_cli_sessions_dir() -> PathBuf {
    resolve_kiro_home_dir().join("sessions").join("cli")
}

pub struct KiroParser {
    base_dir: PathBuf,
}

impl KiroParser {
    pub fn new() -> Self {
        Self {
            base_dir: kiro_cli_sessions_dir(),
        }
    }

    /// Construct against an explicit transcript directory (tests inject a temp
    /// dir; mirrors the `_at` convention used elsewhere in the codebase).
    #[allow(dead_code)]
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// `<base_dir>/<conversation_id>.jsonl`, rejecting any id that is not a
    /// single safe filename component (the id arrives from the frontend/DB, so a
    /// `..` / separator / drive-colon must never be joined onto the base dir).
    fn transcript_path(&self, conversation_id: &str) -> Option<PathBuf> {
        if !super::is_safe_subagent_id(conversation_id) {
            return None;
        }
        let path = self.base_dir.join(format!("{conversation_id}.jsonl"));
        path.is_file().then_some(path)
    }

    fn build_summary(&self, path: &Path, session_id: &str) -> Option<ConversationSummary> {
        let parsed = parse_transcript(path);
        // A file that produced no renderable event (empty, all-invalid, or
        // metadata-only) is not a conversation — matches the other parsers.
        if parsed.content_events == 0 {
            return None;
        }
        Some(summary_from(session_id, path, &parsed))
    }
}

impl Default for KiroParser {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentParser for KiroParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut conversations = Vec::new();
        let Ok(entries) = fs::read_dir(&self.base_dir) else {
            // Missing/unreadable transcript dir: Kiro was never used here.
            return Ok(conversations);
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(session_id) = path
                .file_stem()
                .map(|n| n.to_string_lossy().into_owned())
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            // The summary is a pure function of this one file's bytes, so it may
            // route through the shared (mtime, size)-keyed memo.
            if let Ok(Some(summary)) =
                super::summary_cache::get_or_parse(AgentType::Kiro, &path, || {
                    Ok(self.build_summary(&path, &session_id))
                })
            {
                conversations.push(summary);
            }
        }
        conversations.sort_by_key(|c| std::cmp::Reverse(c.started_at));
        Ok(conversations)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        let path = self
            .transcript_path(conversation_id)
            .ok_or_else(|| ParseError::ConversationNotFound(conversation_id.to_string()))?;

        let mut parsed = parse_transcript(&path);
        // Kiro names file reads `read` / `desktop-commander-read_file`, whose
        // numbered-line output this normalizes into `{start_line, content}`.
        // Deliberately NOT `relocate_orphaned_tool_results` — see the module doc:
        // it would re-pair results across turn boundaries, violating R3.4.2.
        structurize_read_tool_output(&mut parsed.turns);

        // Kiro records no token usage anywhere in the CLI transcript, so
        // `compute_session_stats` yields `None`; still merge the model's context
        // window so the status bar can show the lane the session ran on.
        let session_stats = merge_context_window_stats(
            compute_session_stats(&parsed.turns),
            None,
            infer_context_window_max_tokens(parsed.model.as_deref()),
        );
        let summary = summary_from(conversation_id, &path, &parsed);

        Ok(ConversationDetail {
            summary,
            turns: parsed.turns,
            session_stats,
            transcript_watermark: None,
        })
    }
}

fn summary_from(session_id: &str, path: &Path, parsed: &ParsedTranscript) -> ConversationSummary {
    // Only `Prompt.meta.timestamp` carries a clock, and it can be absent on every
    // prompt in a session; fall back to the file's own mtime so the list still
    // sorts sensibly instead of collapsing onto `Utc::now()`.
    let fallback = file_mtime(path);
    ConversationSummary {
        id: session_id.to_string(),
        agent_type: AgentType::Kiro,
        // The CLI transcript records no working directory (verified across all
        // five kinds), so there is nothing to derive a folder from.
        folder_path: None,
        folder_name: None,
        title: parsed.first_user_text.as_deref().map(title_from_user_text),
        started_at: parsed.first_ts.or(fallback).unwrap_or_else(Utc::now),
        ended_at: parsed.last_ts.or(fallback),
        message_count: parsed.turns.len() as u32,
        model: parsed.model.clone(),
        git_branch: None,
        parent_id: None,
        parent_tool_use_id: None,
        delegation_call_id: None,
    }
}

fn file_mtime(path: &Path) -> Option<DateTime<Utc>> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(DateTime::<Utc>::from(modified))
}

// ---------------------------------------------------------------------------
// <uuid>.jsonl
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ParsedTranscript {
    turns: Vec<MessageTurn>,
    first_ts: Option<DateTime<Utc>>,
    last_ts: Option<DateTime<Utc>>,
    /// Number of renderable events (envelopes that produced a turn or blocks).
    /// Zero ⇒ not listed.
    content_events: u32,
    first_user_text: Option<String>,
    /// `thinking.data.modelId` — the only model marker in the transcript.
    model: Option<String>,
}

/// The mutable state of the turn currently being accumulated.
#[derive(Default)]
struct OpenTurn {
    /// The in-flight assistant turn (`None` until an assistant event arrives).
    assistant: Option<MessageTurn>,
    /// `toolUseId → index of its ToolResult placeholder` **inside `assistant`**.
    /// Cleared at every turn boundary, which is what makes cross-turn pairing
    /// structurally impossible (R3.4.2).
    tool_result_idx: std::collections::HashMap<String, usize>,
}

impl OpenTurn {
    /// Close the in-flight assistant turn and forget every pending tool call.
    fn flush(&mut self, turns: &mut Vec<MessageTurn>) {
        if let Some(turn) = self.assistant.take() {
            turns.push(turn);
        }
        self.tool_result_idx.clear();
    }

    fn assistant_at(&mut self, now: DateTime<Utc>) -> &mut MessageTurn {
        self.assistant
            .get_or_insert_with(|| new_assistant_turn(now))
    }

    /// Append one `AssistantMessage`'s blocks, registering a paired result slot
    /// for every tool call so a later same-turn `toolResult` can fill it.
    ///
    /// The two fields are borrowed disjointly on purpose: `self.assistant` holds
    /// the in-flight turn while `self.tool_result_idx` is written in the same
    /// loop, which a `&mut self` accessor for the turn would make impossible.
    fn push_assistant_blocks(
        &mut self,
        blocks: Vec<ContentBlock>,
        now: DateTime<Utc>,
        model: Option<String>,
    ) {
        let turn = self
            .assistant
            .get_or_insert_with(|| new_assistant_turn(now));
        if turn.model.is_none() {
            turn.model = model;
        }
        for block in blocks {
            // Register each call's paired result slot, then push both so an
            // in-flight call still renders as a well-formed pair.
            if let ContentBlock::ToolUse {
                tool_use_id: Some(id),
                ..
            } = &block
            {
                let id = id.clone();
                turn.blocks.push(block);
                turn.blocks.push(ContentBlock::ToolResult {
                    tool_use_id: Some(id.clone()),
                    output_preview: None,
                    is_error: false,
                    agent_stats: None,
                    images: Vec::new(),
                });
                self.tool_result_idx.insert(id, turn.blocks.len() - 1);
                continue;
            }
            turn.blocks.push(block);
        }
        turn.completed_at = Some(now);
    }

    /// Fold one `ToolResults` event into the open turn.
    ///
    /// Same-turn match only: `tool_result_idx` was cleared at the last boundary,
    /// so a call from an earlier turn is simply absent from the map and its
    /// result stays in place as an orphan (R3.4.3) instead of migrating back
    /// (R3.4.2).
    fn fill_tool_results(&mut self, blocks: Vec<ContentBlock>, now: DateTime<Utc>) {
        let turn = self
            .assistant
            .get_or_insert_with(|| new_assistant_turn(now));
        for block in blocks {
            let slot = match &block {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    ..
                } => self.tool_result_idx.get(id).copied(),
                _ => None,
            };
            let Some(idx) = slot else {
                turn.blocks.push(block);
                continue;
            };
            let ContentBlock::ToolResult {
                output_preview,
                is_error,
                images,
                ..
            } = block
            else {
                turn.blocks.push(block);
                continue;
            };
            if let Some(ContentBlock::ToolResult {
                output_preview: slot_output,
                is_error: slot_error,
                images: slot_images,
                ..
            }) = turn.blocks.get_mut(idx)
            {
                *slot_output = output_preview;
                *slot_error = is_error;
                *slot_images = images;
            }
        }
        turn.completed_at = Some(now);
    }
}

/// A fresh, empty assistant turn. The id is assigned in a final pass once the
/// turn's position in the stream is known.
fn new_assistant_turn(now: DateTime<Utc>) -> MessageTurn {
    MessageTurn {
        id: String::new(),
        role: TurnRole::Assistant,
        blocks: Vec::new(),
        timestamp: now,
        usage: None,
        duration_ms: None,
        model: None,
        completed_at: None,
    }
}

/// Parse one Kiro CLI transcript. Every failure mode is line-local: an unreadable
/// line, a line that is not JSON, an unknown top-level `kind`, and an unknown
/// inner `content[].kind` each affect only themselves (P-1 / R3.6).
fn parse_transcript(path: &Path) -> ParsedTranscript {
    let mut out = ParsedTranscript::default();
    // Read-only access (R3.7).
    let Ok(file) = fs::File::open(path) else {
        return out;
    };

    let mut open = OpenTurn::default();
    let mut last_ts: Option<DateTime<Utc>> = None;

    for line in BufReader::new(file).lines() {
        // A line with invalid UTF-8 / an IO hiccup is skipped, not fatal.
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(envelope) = serde_json::from_str::<Value>(&line) else {
            continue; // R3.6: not valid JSON ⇒ skip, keep going.
        };

        let kind = envelope.get("kind").and_then(Value::as_str).unwrap_or("");
        let data = envelope.get("data");
        // Only `Prompt` carries a clock; every other event inherits the last one.
        let now = if kind == "Prompt" {
            let ts = data
                .and_then(|d| d.pointer("/meta/timestamp"))
                .and_then(Value::as_i64)
                .and_then(|secs| Utc.timestamp_opt(secs, 0).single());
            if let Some(t) = ts {
                if out.first_ts.is_none() {
                    out.first_ts = Some(t);
                }
                out.last_ts = Some(t);
                last_ts = Some(t);
            }
            ts.or(last_ts).unwrap_or_else(Utc::now)
        } else {
            last_ts.unwrap_or_else(Utc::now)
        };

        match kind {
            // A user prompt starts a new turn (R3.4).
            "Prompt" => {
                open.flush(&mut out.turns);
                let blocks = content_blocks(data, &mut out);
                out.content_events += 1;
                if out.first_user_text.is_none() {
                    out.first_user_text = blocks.iter().find_map(|b| match b {
                        ContentBlock::Text { text } if !text.trim().is_empty() => {
                            Some(text.clone())
                        }
                        _ => None,
                    });
                }
                out.turns.push(MessageTurn {
                    id: String::new(),
                    role: TurnRole::User,
                    blocks,
                    timestamp: now,
                    usage: None,
                    duration_ms: None,
                    model: None,
                    completed_at: None,
                });
            }
            // Assistant output: thinking / text / tool calls, in emit order.
            "AssistantMessage" => {
                let blocks = content_blocks(data, &mut out);
                out.content_events += 1;
                let model = out.model.clone();
                open.push_assistant_blocks(blocks, now, model);
            }
            // Tool results for calls made in THIS turn. `data.results` is Kiro's
            // internal bookkeeping and is not read.
            "ToolResults" => {
                let blocks = content_blocks(data, &mut out);
                out.content_events += 1;
                open.fill_tool_results(blocks, now);
            }
            // `/clear`: ends the turn AND drops the context association, so no
            // later result can pair with an earlier call (R3.4.1).
            "Clear" => {
                open.flush(&mut out.turns);
            }
            // A context-compaction checkpoint. Rendered as the shared
            // `ContextCompactionCard` pair, and explicitly NOT a turn boundary
            // (R3.5) — it is appended to whatever turn is open.
            "Compaction" => {
                out.content_events += 1;
                let blocks = compaction_blocks(data, out.content_events);
                let turn = open.assistant_at(now);
                turn.blocks.extend(blocks);
            }
            // Unknown top-level kind: keep a labelled placeholder so the event is
            // visible rather than silently dropped (R3.6.1).
            other => {
                out.content_events += 1;
                let turn = open.assistant_at(now);
                turn.blocks.push(ContentBlock::Text {
                    text: format!("[unsupported Kiro event: {}]", label_of(other)),
                });
            }
        }
    }

    open.flush(&mut out.turns);

    // Stable, index-based ids (the transcript is append-only, so positional ids
    // are stable across re-parses).
    for (i, turn) in out.turns.iter_mut().enumerate() {
        turn.id = format!("kiro-turn-{i}");
    }
    out
}

/// Render an unknown `kind` string for a placeholder: bounded, and never empty.
fn label_of(kind: &str) -> String {
    if kind.is_empty() {
        "?".to_string()
    } else {
        truncate_str(kind, 80)
    }
}

/// Map `data.content[]` to display blocks, preserving order and element count:
/// every element yields exactly one block, so an unknown inner `kind` cannot
/// discard its siblings (R3.6.2).
fn content_blocks(data: Option<&Value>, out: &mut ParsedTranscript) -> Vec<ContentBlock> {
    let Some(items) = data
        .and_then(|d| d.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    items.iter().map(|item| content_block(item, out)).collect()
}

fn content_block(item: &Value, out: &mut ParsedTranscript) -> ContentBlock {
    let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
    let data = item.get("data");
    match kind {
        // `text.data` is a bare string.
        "text" => ContentBlock::Text {
            text: data.and_then(Value::as_str).unwrap_or_default().to_string(),
        },
        "thinking" => {
            if out.model.is_none() {
                out.model = data
                    .and_then(|d| d.get("modelId"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from);
            }
            ContentBlock::Thinking {
                text: data
                    .and_then(|d| d.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            }
        }
        "toolUse" => ContentBlock::ToolUse {
            tool_use_id: data
                .and_then(|d| d.get("toolUseId"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            tool_name: data
                .and_then(|d| d.get("name"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("tool")
                .to_string(),
            input_preview: tool_input_preview(data.and_then(|d| d.get("input"))),
            status: None,
            meta: None,
        },
        "toolResult" => tool_result_block(data),
        "image" => image_block(data),
        // Unknown inner kind: a labelled placeholder in the element's own slot
        // (R3.6.2) — its siblings are untouched because this is a 1:1 map.
        other => ContentBlock::Text {
            text: format!("[unsupported Kiro content: {}]", label_of(other)),
        },
    }
}

/// A `toolResult` element: `{toolUseId, content[], status}`. The inner
/// `content[]` items are `{kind:"json"|"text"|"image", data}`; text/json fold
/// into one output preview, images ride along as `ImageData`.
fn tool_result_block(data: Option<&Value>) -> ContentBlock {
    let is_error = data
        .and_then(|d| d.get("status"))
        .and_then(Value::as_str)
        .is_some_and(|s| !s.eq_ignore_ascii_case("success"));

    let mut text = String::new();
    let mut images = Vec::new();
    for item in data
        .and_then(|d| d.get("content"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
        let payload = item.get("data");
        match kind {
            "text" => {
                if let Some(s) = payload.and_then(Value::as_str) {
                    push_line(&mut text, s);
                }
            }
            "json" => {
                if let Some(value) = payload {
                    // Prefer the MCP-ish `{content:[{type:"text",text}]}` shape
                    // Kiro wraps most tool output in; fall back to raw JSON.
                    match mcp_content_text(value) {
                        Some(s) => push_line(&mut text, &s),
                        None => {
                            if let Ok(s) = serde_json::to_string(value) {
                                push_line(&mut text, &s);
                            }
                        }
                    }
                }
            }
            "image" => {
                if let ContentBlock::Image {
                    data: bytes,
                    mime_type,
                    uri,
                } = image_block(payload)
                {
                    images.push(ImageData {
                        data: bytes,
                        mime_type,
                        uri,
                    });
                }
            }
            other => push_line(
                &mut text,
                &format!("[unsupported Kiro tool output: {}]", label_of(other)),
            ),
        }
    }

    ContentBlock::ToolResult {
        tool_use_id: data
            .and_then(|d| d.get("toolUseId"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        output_preview: (!text.is_empty()).then(|| truncate_str(&text, KIRO_TOOL_OUTPUT_CAP)),
        is_error,
        agent_stats: None,
        images,
    }
}

fn push_line(buf: &mut String, text: &str) {
    if text.is_empty() {
        return;
    }
    if !buf.is_empty() {
        buf.push('\n');
    }
    buf.push_str(text);
}

/// Concatenate the text parts of an MCP-style `{content:[{type:"text",text}]}`
/// payload. `None` when the value is not that shape, so the caller falls back to
/// raw JSON rather than silently rendering nothing.
fn mcp_content_text(value: &Value) -> Option<String> {
    let items = value.get("content")?.as_array()?;
    let mut buf = String::new();
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("text") {
            return None;
        }
        push_line(&mut buf, item.get("text").and_then(Value::as_str)?);
    }
    (!buf.is_empty()).then_some(buf)
}

/// An `image` element: `data.{format, source:{kind:"bytes", data:[u8…]}}`. Kiro
/// stores the raw bytes as a JSON number array (verified: 62/62 samples), which
/// is re-encoded to base64 for the frontend's `ImageData` contract.
fn image_block(data: Option<&Value>) -> ContentBlock {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let format = data
        .and_then(|d| d.get("format"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("png");
    // Bytes array (the measured shape), else an already-base64 string.
    let encoded = match data
        .and_then(|d| d.get("source"))
        .and_then(|s| s.get("data"))
    {
        Some(Value::Array(items)) => {
            let bytes: Vec<u8> = items
                .iter()
                .filter_map(Value::as_u64)
                .map(|b| b as u8)
                .collect();
            STANDARD.encode(bytes)
        }
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    ContentBlock::Image {
        data: encoded,
        mime_type: format!("image/{format}"),
        uri: None,
    }
}

/// Serialize a `toolUse.input` object, bounded by `KIRO_TOOL_INPUT_CAP` while
/// staying valid JSON (the frontend `JSON.parse`s the preview for the todo /
/// delegation cards, so opaque byte truncation would corrupt it). Mirrors
/// `grok::grok_mcp_input_preview`.
fn tool_input_preview(input: Option<&Value>) -> Option<String> {
    let input = input?;
    if input.is_null() {
        return None;
    }
    let mut per_string = KIRO_TOOL_INPUT_CAP;
    loop {
        let serialized = serde_json::to_string(&cap_json_string_values(input, per_string)).ok()?;
        if serialized.len() <= KIRO_TOOL_INPUT_CAP || per_string == 0 {
            return Some(serialized);
        }
        per_string /= 2;
    }
}

/// Truncate every string value in a JSON value to `cap` chars, preserving
/// structure so the result re-serializes to valid JSON.
fn cap_json_string_values(value: &Value, cap: usize) -> Value {
    match value {
        Value::String(s) => Value::String(truncate_str(s, cap)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| cap_json_string_values(v, cap))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), cap_json_string_values(v, cap)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Render a `Compaction` checkpoint as the shared context-compaction card: a
/// completed `ToolUse` tagged `meta.contextCompaction` plus its paired
/// `ToolResult` (same convention as codex-acp #288 and `parsers::grok`).
///
/// `summary` and `messages_snapshot` are hard-capped (R3.5.1): the snapshot
/// reached 2.7 MB of JSON on this machine and the summary can quote the user's
/// private steering text verbatim. Neither is ever logged.
fn compaction_blocks(data: Option<&Value>, seq: u32) -> Vec<ContentBlock> {
    let mut meta = serde_json::Map::new();
    meta.insert("contextCompaction".to_string(), Value::Bool(true));

    let mut text = String::new();
    if let Some(summary) = data
        .and_then(|d| d.get("summary"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        push_line(
            &mut text,
            &truncate_str(summary, KIRO_COMPACTION_SUMMARY_CAP),
        );
    }
    if let Some(snapshot) = data.and_then(|d| d.get("messages_snapshot")) {
        let count = snapshot.as_array().map(Vec::len).unwrap_or(0);
        meta.insert("messagesSnapshotCount".to_string(), count.into());
        if let Ok(serialized) = serde_json::to_string(snapshot) {
            push_line(
                &mut text,
                &truncate_str(&serialized, KIRO_COMPACTION_SNAPSHOT_CAP),
            );
        }
    }

    // A deterministic id (position in the stream) so a re-parse produces the
    // same block identity.
    let id = format!("kiro-compaction-{seq}");
    vec![
        ContentBlock::ToolUse {
            tool_use_id: Some(id.clone()),
            tool_name: "context_compaction".to_string(),
            input_preview: None,
            status: None,
            meta: Some(Value::Object(meta)),
        },
        ContentBlock::ToolResult {
            tool_use_id: Some(id),
            output_preview: (!text.is_empty()).then_some(text),
            is_error: false,
            agent_stats: None,
            images: Vec::new(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Write a transcript into a unique temp directory and return a parser bound
    /// to it. Rooted at `std::env::temp_dir()` — never a hardcoded `/tmp`, which
    /// is not absolute on Windows.
    fn fixture(name: &str, contents: &str) -> (tempfile::TempDir, KiroParser) {
        let tmp = tempfile::Builder::new()
            .prefix("codeg-kiro-parser")
            .tempdir_in(std::env::temp_dir())
            .unwrap();
        let cli = tmp.path().join("sessions").join("cli");
        fs::create_dir_all(&cli).unwrap();
        let mut f = fs::File::create(cli.join(format!("{name}.jsonl"))).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        f.flush().unwrap();
        (tmp, KiroParser::with_base_dir(cli))
    }

    const SESSION: &str = "417d1daa-4e94-4ebe-b795-fdd5042af467";

    fn envelope(kind: &str, data: Value) -> String {
        serde_json::json!({"version": "v1", "kind": kind, "data": data}).to_string()
    }

    fn prompt(text: &str, ts: i64) -> String {
        envelope(
            "Prompt",
            serde_json::json!({
                "message_id": "m-prompt",
                "content": [{"kind": "text", "data": text}],
                "meta": {"timestamp": ts},
            }),
        )
    }

    fn tool_use(id: &str, name: &str) -> String {
        envelope(
            "AssistantMessage",
            serde_json::json!({
                "message_id": "m-asst",
                "content": [{
                    "kind": "toolUse",
                    "data": {"toolUseId": id, "name": name, "input": {"command": "ls"}},
                }],
            }),
        )
    }

    fn tool_results(id: &str, output: &str) -> String {
        envelope(
            "ToolResults",
            serde_json::json!({
                "message_id": "m-res",
                "content": [{
                    "kind": "toolResult",
                    "data": {
                        "toolUseId": id,
                        "content": [{"kind": "text", "data": output}],
                        "status": "success",
                    },
                }],
                // Kiro's internal bookkeeping sibling — deliberately not read.
                "results": {id: {"tool": null, "result": "Cancelled"}},
            }),
        )
    }

    fn assistant_text(text: &str) -> String {
        envelope(
            "AssistantMessage",
            serde_json::json!({"content": [{"kind": "text", "data": text}]}),
        )
    }

    fn all_blocks(detail: &ConversationDetail) -> Vec<&ContentBlock> {
        detail.turns.iter().flat_map(|t| &t.blocks).collect()
    }

    #[test]
    fn parses_a_prompt_assistant_tool_round_trip() {
        let transcript = [
            prompt("列一下目录", 1_782_266_936),
            envelope(
                "AssistantMessage",
                serde_json::json!({
                    "message_id": "m1",
                    "content": [
                        {"kind": "thinking", "data": {
                            "text": "need to list",
                            "signature": "sig",
                            "redactedContent": [],
                            "modelId": "claude-opus-4.8",
                        }},
                        {"kind": "text", "data": "好的"},
                        {"kind": "toolUse", "data": {
                            "toolUseId": "toolu_1",
                            "name": "desktop-commander-start_process",
                            "input": {"__tool_use_purpose": "列目录", "command": "ls"},
                        }},
                    ],
                }),
            ),
            tool_results("toolu_1", "a.txt\nb.txt"),
            assistant_text("两个文件"),
        ]
        .join("\n");
        let (_tmp, parser) = fixture(SESSION, &transcript);

        let list = parser.list_conversations().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, SESSION);
        assert_eq!(list[0].agent_type, AgentType::Kiro);
        assert_eq!(list[0].title.as_deref(), Some("列一下目录"));
        assert_eq!(list[0].model.as_deref(), Some("claude-opus-4.8"));
        assert_eq!(list[0].started_at.timestamp(), 1_782_266_936);

        let detail = parser.get_conversation(SESSION).unwrap();
        // One user turn + ONE assistant turn spanning both AssistantMessage
        // events and the ToolResults between them.
        assert_eq!(detail.turns.len(), 2);
        assert!(matches!(detail.turns[0].role, TurnRole::User));
        assert!(matches!(detail.turns[1].role, TurnRole::Assistant));
        assert_eq!(detail.turns[1].model.as_deref(), Some("claude-opus-4.8"));
        assert_eq!(detail.turns[0].id, "kiro-turn-0");
        // Kiro logs no token usage, so only the context window is derivable.
        let stats = detail.session_stats.expect("context window stats");
        assert_eq!(stats.context_window_max_tokens, Some(200_000));

        let asst = &detail.turns[1].blocks;
        assert!(matches!(asst[0], ContentBlock::Thinking { .. }));
        assert!(matches!(&asst[1], ContentBlock::Text { text } if text == "好的"));
        // The call is immediately followed by its paired result.
        match (&asst[2], &asst[3]) {
            (
                ContentBlock::ToolUse {
                    tool_use_id: Some(call),
                    tool_name,
                    input_preview: Some(input),
                    ..
                },
                ContentBlock::ToolResult {
                    tool_use_id: Some(result),
                    output_preview: Some(output),
                    is_error,
                    ..
                },
            ) => {
                assert_eq!(call, "toolu_1");
                assert_eq!(result, "toolu_1");
                assert_eq!(tool_name, "desktop-commander-start_process");
                // The input preview stays valid JSON for the frontend cards.
                assert!(serde_json::from_str::<Value>(input).is_ok());
                assert!(input.contains("\"command\""));
                assert_eq!(output, "a.txt\nb.txt");
                assert!(!is_error);
            }
            other => panic!("expected a paired tool call, got {other:?}"),
        }
        assert!(matches!(&asst[4], ContentBlock::Text { text } if text == "两个文件"));
    }

    #[test]
    fn invalid_lines_are_skipped_and_valid_lines_keep_their_order() {
        // P-1: valid and invalid lines interleaved arbitrarily. No panic, no
        // error, and the emitted events correspond 1:1 and in order to the valid
        // lines (2 prompts + 2 assistant texts + 1 unknown-kind placeholder).
        let transcript = [
            "{ not json at all".to_string(),
            prompt("first", 1_782_266_900),
            String::new(),
            "}}}".to_string(),
            assistant_text("one"),
            "[1,2,3".to_string(),
            envelope("FutureKind", serde_json::json!({"whatever": true})),
            "null-ish garbage {".to_string(),
            prompt("second", 1_782_266_999),
            assistant_text("two"),
            "\u{feff}broken".to_string(),
        ]
        .join("\n");
        let (_tmp, parser) = fixture(SESSION, &transcript);

        let detail = parser.get_conversation(SESSION).unwrap();
        let texts: Vec<String> = all_blocks(&detail)
            .iter()
            .map(|b| match b {
                ContentBlock::Text { text } => text.clone(),
                other => panic!("unexpected block {other:?}"),
            })
            .collect();
        assert_eq!(
            texts,
            vec![
                "first".to_string(),
                "one".to_string(),
                "[unsupported Kiro event: FutureKind]".to_string(),
                "second".to_string(),
                "two".to_string(),
            ]
        );
        // Turn structure survives: prompt, assistant(+placeholder), prompt,
        // assistant.
        assert_eq!(detail.turns.len(), 4);
        // The whole file is still listable despite the garbage.
        assert_eq!(parser.list_conversations().unwrap().len(), 1);
    }

    #[test]
    fn a_tool_result_never_pairs_with_a_tool_use_from_another_turn() {
        // P-1b: same `toolUseId`, but the call is in turn 1 and the result
        // arrives in turn 2 (after a new `Prompt`). It must render as an orphan
        // result in turn 2 and must NOT be hoisted into turn 1.
        let transcript = [
            prompt("run it", 1_782_266_900),
            tool_use("toolu_cross", "shell"),
            prompt("next question", 1_782_266_950),
            tool_results("toolu_cross", "late output"),
        ]
        .join("\n");
        let (_tmp, parser) = fixture(SESSION, &transcript);
        let detail = parser.get_conversation(SESSION).unwrap();

        // turn 0: prompt, turn 1: the call (+ its empty placeholder),
        // turn 2: prompt, turn 3: the orphan result.
        assert_eq!(detail.turns.len(), 4);
        let first_assistant = &detail.turns[1].blocks;
        assert!(matches!(
            &first_assistant[0],
            ContentBlock::ToolUse { tool_use_id: Some(id), .. } if id == "toolu_cross"
        ));
        // The placeholder in the call's own turn stays EMPTY — the late result
        // did not migrate back into it.
        match &first_assistant[1] {
            ContentBlock::ToolResult {
                output_preview,
                tool_use_id: Some(id),
                ..
            } => {
                assert_eq!(id, "toolu_cross");
                assert!(
                    output_preview.is_none(),
                    "cross-turn result must not fill the earlier turn's slot"
                );
            }
            other => panic!("expected the paired placeholder, got {other:?}"),
        }
        assert_eq!(first_assistant.len(), 2);

        // The result renders in place, in its own (later) turn.
        let orphan_turn = &detail.turns[3].blocks;
        assert_eq!(orphan_turn.len(), 1);
        assert!(matches!(
            &orphan_turn[0],
            ContentBlock::ToolResult { tool_use_id: Some(id), output_preview: Some(o), .. }
                if id == "toolu_cross" && o == "late output"
        ));
    }

    #[test]
    fn clear_ends_the_turn_and_drops_the_context_association() {
        // R3.4.1: a `Clear` between the call and its result breaks the pairing
        // even though no new `Prompt` intervened. Note the real envelope has NO
        // `data` key at all.
        let transcript = [
            prompt("run it", 1_782_266_900),
            tool_use("toolu_cleared", "shell"),
            serde_json::json!({"version": "v1", "kind": "Clear"}).to_string(),
            tool_results("toolu_cleared", "after clear"),
        ]
        .join("\n");
        let (_tmp, parser) = fixture(SESSION, &transcript);
        let detail = parser.get_conversation(SESSION).unwrap();

        // prompt turn, the call's turn (closed by Clear), the post-Clear turn.
        assert_eq!(detail.turns.len(), 3);
        assert!(matches!(
            &detail.turns[1].blocks[1],
            ContentBlock::ToolResult {
                output_preview: None,
                ..
            }
        ));
        assert!(matches!(
            &detail.turns[2].blocks[0],
            ContentBlock::ToolResult { output_preview: Some(o), .. } if o == "after clear"
        ));
    }

    #[test]
    fn an_orphan_result_with_no_call_anywhere_renders_in_place() {
        // R3.4.3: a result whose call never appears at all is still shown.
        let transcript = [
            prompt("hi", 1_782_266_900),
            tool_results("toolu_never_called", "stray"),
        ]
        .join("\n");
        let (_tmp, parser) = fixture(SESSION, &transcript);
        let detail = parser.get_conversation(SESSION).unwrap();
        assert_eq!(detail.turns.len(), 2);
        assert!(matches!(
            &detail.turns[1].blocks[0],
            ContentBlock::ToolResult { output_preview: Some(o), .. } if o == "stray"
        ));
    }

    #[test]
    fn compaction_does_not_split_the_turn_and_caps_its_long_fields() {
        // R3.5 / R3.5.1: the checkpoint lands INSIDE the open assistant turn, and
        // both long fields are truncated with the shared marker.
        let steering = "私密 steering 全文".repeat(2_000);
        let snapshot: Vec<Value> = (0..30)
            .map(|i| {
                serde_json::json!({
                    "id": format!("m{i}"),
                    "role": "user",
                    "content": [{"kind": "text", "data": "x".repeat(4_000)}],
                })
            })
            .collect();
        let transcript = [
            prompt("keep going", 1_782_266_900),
            assistant_text("before"),
            envelope(
                "Compaction",
                serde_json::json!({
                    "summary": steering,
                    "strategy": {"message_pairs_to_exclude": 2, "max_message_length": 25_000},
                    "messages_snapshot": snapshot,
                }),
            ),
            assistant_text("after"),
        ]
        .join("\n");
        let (_tmp, parser) = fixture(SESSION, &transcript);
        let detail = parser.get_conversation(SESSION).unwrap();

        // NOT a turn boundary: one user turn + one assistant turn, with the
        // compaction pair sitting between "before" and "after".
        assert_eq!(detail.turns.len(), 2);
        let asst = &detail.turns[1].blocks;
        assert_eq!(asst.len(), 4);
        assert!(matches!(&asst[0], ContentBlock::Text { text } if text == "before"));
        assert!(matches!(&asst[3], ContentBlock::Text { text } if text == "after"));

        let meta = match &asst[1] {
            ContentBlock::ToolUse {
                tool_name,
                meta: Some(meta),
                ..
            } => {
                assert_eq!(tool_name, "context_compaction");
                meta.clone()
            }
            other => panic!("expected the compaction tool_use, got {other:?}"),
        };
        // The shared `ContextCompactionCard` recognises the block by this flag.
        assert_eq!(
            meta.get("contextCompaction").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            meta.get("messagesSnapshotCount").and_then(Value::as_u64),
            Some(30)
        );

        let output = match &asst[2] {
            ContentBlock::ToolResult {
                output_preview: Some(output),
                ..
            } => output.clone(),
            other => panic!("expected the compaction tool_result, got {other:?}"),
        };
        // Both fields are capped and explicitly marked; neither travels whole.
        assert!(output.contains("..."), "truncation marker missing");
        assert!(
            output.chars().count()
                <= KIRO_COMPACTION_SUMMARY_CAP + KIRO_COMPACTION_SNAPSHOT_CAP + 8,
            "compaction render exceeded the caps: {} chars",
            output.chars().count()
        );
        assert!(
            output.chars().count() < steering.chars().count(),
            "the raw steering text must not be rendered whole"
        );
    }

    #[test]
    fn unknown_inner_kinds_keep_a_placeholder_without_dropping_siblings() {
        // R3.6.2: the unknown element yields its own placeholder in position; the
        // surrounding text/thinking blocks of the SAME event survive.
        let transcript = [
            prompt("hi", 1_782_266_900),
            envelope(
                "AssistantMessage",
                serde_json::json!({
                    "content": [
                        {"kind": "text", "data": "before"},
                        {"kind": "audio", "data": {"whatever": 1}},
                        {"kind": "thinking", "data": {"text": "hmm", "modelId": "claude-opus-5"}},
                        {"data": "no kind field at all"},
                        {"kind": "text", "data": "after"},
                    ],
                }),
            ),
        ]
        .join("\n");
        let (_tmp, parser) = fixture(SESSION, &transcript);
        let detail = parser.get_conversation(SESSION).unwrap();

        let asst = &detail.turns[1].blocks;
        // 5 elements in ⇒ 5 blocks out, in order.
        assert_eq!(asst.len(), 5);
        assert!(matches!(&asst[0], ContentBlock::Text { text } if text == "before"));
        assert!(
            matches!(&asst[1], ContentBlock::Text { text } if text == "[unsupported Kiro content: audio]")
        );
        assert!(matches!(&asst[2], ContentBlock::Thinking { text } if text == "hmm"));
        assert!(
            matches!(&asst[3], ContentBlock::Text { text } if text == "[unsupported Kiro content: ?]")
        );
        assert!(matches!(&asst[4], ContentBlock::Text { text } if text == "after"));
        // The model was still recovered from the surviving thinking block.
        assert_eq!(detail.summary.model.as_deref(), Some("claude-opus-5"));
    }

    #[test]
    fn tool_result_json_images_and_error_status_are_surfaced() {
        // Kiro's dominant tool-output shape is `{kind:"json", data:{content:[
        // {type:"text",text}]}}`; `status:"error"` marks the failure, and a PNG
        // rides as a byte array that must reach the frontend as base64.
        let transcript = [
            prompt("read it", 1_782_266_900),
            tool_use("toolu_json", "read"),
            envelope(
                "ToolResults",
                serde_json::json!({
                    "content": [{
                        "kind": "toolResult",
                        "data": {
                            "toolUseId": "toolu_json",
                            "content": [
                                {"kind": "json", "data": {"content": [{"type": "text", "text": "hello"}]}},
                                {"kind": "json", "data": {"exit_status": 1, "stderr": "boom"}},
                                {"kind": "image", "data": {
                                    "format": "png",
                                    "source": {"kind": "bytes", "data": [65, 66, 67]},
                                }},
                                {"kind": "hologram", "data": {}},
                            ],
                            "status": "error",
                        },
                    }],
                }),
            ),
        ]
        .join("\n");
        let (_tmp, parser) = fixture(SESSION, &transcript);
        let detail = parser.get_conversation(SESSION).unwrap();

        match &detail.turns[1].blocks[1] {
            ContentBlock::ToolResult {
                output_preview: Some(output),
                is_error,
                images,
                ..
            } => {
                assert!(*is_error, "status \"error\" must set is_error");
                // MCP-shaped json unwraps to its text; a non-MCP json keeps raw JSON.
                assert!(output.starts_with("hello"));
                assert!(output.contains("\"exit_status\":1"));
                // An unknown inner output kind is labelled, not dropped.
                assert!(output.contains("[unsupported Kiro tool output: hologram]"));
                assert_eq!(images.len(), 1);
                assert_eq!(images[0].mime_type, "image/png");
                assert_eq!(images[0].data, "QUJD"); // base64("ABC")
            }
            other => panic!("expected a filled tool result, got {other:?}"),
        }
    }

    #[test]
    fn user_image_attachments_become_image_blocks() {
        let transcript = envelope(
            "Prompt",
            serde_json::json!({
                "content": [
                    {"kind": "text", "data": "这是什么"},
                    {"kind": "image", "data": {
                        "format": "jpeg",
                        "source": {"kind": "bytes", "data": [65, 66, 67]},
                    }},
                ],
                "meta": {"timestamp": 1_782_266_900},
            }),
        );
        let (_tmp, parser) = fixture(SESSION, &transcript);
        let detail = parser.get_conversation(SESSION).unwrap();
        let user = &detail.turns[0].blocks;
        assert_eq!(user.len(), 2);
        assert!(matches!(
            &user[1],
            ContentBlock::Image { data, mime_type, .. } if data == "QUJD" && mime_type == "image/jpeg"
        ));
        // Only the prose seeds the title — never the image.
        assert_eq!(detail.summary.title.as_deref(), Some("这是什么"));
    }

    #[test]
    fn a_prompt_without_meta_falls_back_to_the_file_mtime() {
        // 61 of 968 sampled prompts carry no `meta` at all, so a session can have
        // no in-stream clock whatsoever; the list must still sort by something
        // real rather than "now".
        let transcript = envelope(
            "Prompt",
            serde_json::json!({"content": [{"kind": "text", "data": "no clock"}]}),
        );
        let (_tmp, parser) = fixture(SESSION, &transcript);
        let after_write = Utc::now();
        let list = parser.list_conversations().unwrap();
        assert_eq!(list.len(), 1);
        // The mtime was set when the fixture was written, i.e. before this call.
        assert!(list[0].started_at <= after_write);
        assert!(list[0].ended_at.is_some());
    }

    #[test]
    fn empty_and_missing_transcripts_are_not_conversations() {
        let (_tmp, parser) = fixture(SESSION, "\n\n{ garbage\n");
        // All lines unusable ⇒ no content events ⇒ not listed…
        assert!(parser.list_conversations().unwrap().is_empty());
        // …but the file exists, so a direct fetch yields an empty detail rather
        // than an error.
        let detail = parser.get_conversation(SESSION).unwrap();
        assert!(detail.turns.is_empty());
        assert_eq!(detail.summary.message_count, 0);

        // An unknown id is a miss, and a traversal attempt never escapes the dir.
        assert!(matches!(
            parser.get_conversation("00000000-0000-0000-0000-000000000000"),
            Err(ParseError::ConversationNotFound(_))
        ));
        for hostile in ["../secrets", "..\\secrets", "C:evil", ""] {
            assert!(
                matches!(
                    parser.get_conversation(hostile),
                    Err(ParseError::ConversationNotFound(_))
                ),
                "expected rejection for {hostile:?}"
            );
        }
    }

    #[test]
    fn a_missing_sessions_dir_lists_nothing() {
        let parser =
            KiroParser::with_base_dir(std::env::temp_dir().join("codeg-kiro-does-not-exist"));
        assert!(parser.list_conversations().unwrap().is_empty());
    }

    #[test]
    fn kiro_home_prefers_the_env_override() {
        let root = std::env::temp_dir().join("codeg-kiro-home-test");
        let resolved = resolve_kiro_home_from(
            Some(OsString::from(root.as_os_str())),
            Some(PathBuf::from("/should-not-be-used")),
        );
        assert_eq!(resolved, root);
    }

    #[test]
    fn kiro_home_falls_back_to_the_home_directory() {
        let home = std::env::temp_dir().join("codeg-kiro-fake-home");
        let resolved = resolve_kiro_home_from(None, Some(home.clone()));
        assert_eq!(resolved, home.join(".kiro"));
    }

    #[test]
    fn blank_kiro_home_falls_through_to_the_home_directory() {
        let home = std::env::temp_dir().join("codeg-kiro-fake-home");
        let resolved = resolve_kiro_home_from(Some(OsString::new()), Some(home.clone()));
        assert_eq!(resolved, home.join(".kiro"));
    }
}
