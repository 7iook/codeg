/**
 * Built-in sub-agent (Claude Agent/Task tool) LIVE transcript model.
 *
 * Pure functions only — the React provider
 * (`@/contexts/subagent-transcript-context`) owns storage and the capsule owns
 * presentation. Phase 2 (parsing the persisted `subagents/*.jsonl`) reuses the
 * SAME dedupe key and view builder, which is why neither lives in a component.
 *
 * Input shape: the VERBATIM SDK frame forwarded by
 * `AcpEvent::ClaudeSubagentMessage` — `{ type, parent_tool_use_id, message: {
 * id, role, content } }`. Normalizing it into the project's own `ContentBlock`
 * union here (rather than in the renderer) keeps the third-party JSON shape
 * behind one boundary and lets the transcript reuse the existing tool-call and
 * markdown renderers.
 */

import type { ContentBlock } from "@/lib/types"

export type SubagentFrameRole = "assistant" | "user"

export interface SubagentFrame {
  /** Stable dedupe identity — see {@link subagentFrameKey}. */
  key: string
  role: SubagentFrameRole
  /** Normalized to the project's own `ContentBlock` shape (SSOT). */
  blocks: ContentBlock[]
}

export interface SubagentTranscriptView {
  /** The prompt the sub-agent was launched with, when it arrived. */
  taskPrompt: string | null
  /** Assistant prose/thinking/tool_use + the matching tool_results, in order. */
  blocks: ContentBlock[]
  messageCount: number
  toolCount: number
  /** One-line "still alive" evidence for the collapsed pill. */
  tailText: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** djb2 — a short, stable, dependency-free digest. Only ever compared against
 *  other digests of the same field set; never a security primitive. */
function digest(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

function stringifyInput(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return value.length > 0 ? value : null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

/**
 * Dedupe identity for ONE forwarded sub-agent frame.
 *
 * ⚠️ `message.id` alone is NOT a valid key. Measured against real Claude
 * transcripts on this machine: a single `msg_…` id spans MULTIPLE frames (each
 * on-disk row carries its own distinct `uuid`), because one logical message is
 * delivered/persisted in several pieces. Keying on `message.id` would treat
 * every piece after the first as a duplicate and silently swallow it — the same
 * class of failure as upstream #33651's dropped messages.
 *
 * Key, in priority order:
 *   1. `uuid` when present — the per-frame identity the on-disk rows carry.
 *      Live events do NOT have it (the event forwards a verbatim SDK frame with
 *      no id attached), but Phase 2's jsonl path does, and both paths must
 *      dedupe against each other through one key function (decision card K3).
 *   2. `(parent_tool_use_id, message.id, content fingerprint)` — the same
 *      message id with different content is a DIFFERENT frame; a genuine
 *      redelivery of the same frame fingerprints identically and collapses.
 *
 * The fingerprint covers block types plus their text / thinking / tool ids /
 * tool input — everything that distinguishes two pieces of one message.
 */
export function subagentFrameKey(
  parentToolUseId: string,
  message: unknown
): string | null {
  const frame = asRecord(message)
  if (!frame) return null

  const uuid = asText(frame.uuid)
  if (uuid) return `${parentToolUseId}|uuid|${uuid}`

  const inner = asRecord(frame.message)
  const messageId = asText(inner?.id) ?? asText(frame.id) ?? "no-id"
  const content = inner?.content ?? frame.content

  let fingerprint: string
  if (typeof content === "string") {
    fingerprint = `s${content.length}-${digest(content)}`
  } else if (Array.isArray(content)) {
    const parts = content.map((block) => {
      const record = asRecord(block)
      if (!record) return "?"
      const type = asText(record.type) ?? "?"
      const payload =
        asText(record.text) ??
        asText(record.thinking) ??
        asText(record.id) ??
        asText(record.tool_use_id) ??
        stringifyInput(record.input ?? record.content)
      return `${type}:${payload?.length ?? 0}:${digest(payload ?? "")}`
    })
    fingerprint = `a${parts.length}-${digest(parts.join(" "))}`
  } else {
    // No content at all (a bookkeeping frame): the message id plus the frame
    // type is all the identity available, so two such frames are equal.
    fingerprint = `n${asText(frame.type) ?? "?"}`
  }

  return `${parentToolUseId}|${messageId}|${fingerprint}`
}

const MAX_TOOL_INPUT_CHARS = 4_000
const MAX_TEXT_CHARS = 20_000

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

/** A `tool_result`'s content is either a string or a block array. */
function toolResultText(content: unknown): string | null {
  if (typeof content === "string") return content.length > 0 ? content : null
  if (!Array.isArray(content)) return stringifyInput(content)
  const texts: string[] = []
  for (const item of content) {
    const record = asRecord(item)
    const text = asText(record?.text)
    if (text) texts.push(text)
  }
  return texts.length > 0 ? texts.join("\n") : null
}

/** Normalize ONE verbatim SDK content block into the project's `ContentBlock`.
 *  Unknown block types return null (dropped) rather than leaking raw JSON. */
function normalizeBlock(block: unknown): ContentBlock | null {
  const record = asRecord(block)
  if (!record) return null
  switch (asText(record.type)) {
    case "text": {
      const text = asText(record.text)
      return text
        ? { type: "text", text: truncate(text, MAX_TEXT_CHARS) }
        : null
    }
    case "thinking": {
      const text = asText(record.thinking) ?? asText(record.text)
      return text
        ? { type: "thinking", text: truncate(text, MAX_TEXT_CHARS) }
        : null
    }
    case "tool_use": {
      const name = asText(record.name) ?? asText(record.tool_name)
      if (!name) return null
      const input = stringifyInput(record.input)
      return {
        type: "tool_use",
        tool_use_id: asText(record.id) ?? null,
        tool_name: name,
        input_preview: input ? truncate(input, MAX_TOOL_INPUT_CHARS) : null,
      }
    }
    case "tool_result": {
      const output = toolResultText(record.content)
      return {
        type: "tool_result",
        tool_use_id: asText(record.tool_use_id) ?? null,
        output_preview: output ? truncate(output, MAX_TEXT_CHARS) : null,
        is_error: record.is_error === true,
      }
    }
    default:
      return null
  }
}

/**
 * Parse one forwarded frame into a renderable {@link SubagentFrame}, or null
 * when there is nothing to show (non-assistant/user frame, empty content, or an
 * unrecognized shape). Returning null is deliberate: the store must not
 * accumulate frames that render as blank rows.
 */
export function parseSubagentFrame(
  parentToolUseId: string,
  message: unknown
): SubagentFrame | null {
  const frame = asRecord(message)
  if (!frame) return null

  const inner = asRecord(frame.message)
  const role = asText(inner?.role) ?? asText(frame.type)
  if (role !== "assistant" && role !== "user") return null

  const key = subagentFrameKey(parentToolUseId, message)
  if (!key) return null

  const rawContent = inner?.content ?? frame.content
  const blocks: ContentBlock[] = []
  if (typeof rawContent === "string") {
    const text = truncate(rawContent, MAX_TEXT_CHARS)
    if (text.length > 0) blocks.push({ type: "text", text })
  } else if (Array.isArray(rawContent)) {
    for (const item of rawContent) {
      const normalized = normalizeBlock(item)
      if (normalized) blocks.push(normalized)
    }
  }
  if (blocks.length === 0) return null

  return { key, role, blocks }
}

/**
 * Cap on retained frames per sub-agent. The collapsed-pill design keeps N
 * concurrent sub-agents at N pill rows, so the store must stay bounded too;
 * oldest frames drop first (the transcript reads newest-at-the-bottom, and the
 * tail is what a user watches).
 */
export const MAX_SUBAGENT_FRAMES = 400

/** Append unless `frame.key` is already present (idempotent redelivery), and
 *  keep the retained window bounded. Returns the SAME array reference when
 *  nothing changed so `useSyncExternalStore` consumers don't re-render. */
export function appendSubagentFrame(
  frames: readonly SubagentFrame[],
  frame: SubagentFrame
): readonly SubagentFrame[] {
  for (const existing of frames) {
    if (existing.key === frame.key) return frames
  }
  const next = [...frames, frame]
  return next.length > MAX_SUBAGENT_FRAMES
    ? next.slice(next.length - MAX_SUBAGENT_FRAMES)
    : next
}

function firstLine(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? ""
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}

/**
 * Flatten frames into a single ordered block list for rendering, plus the
 * collapsed-pill summary (counts + activity tail).
 *
 * The FIRST `user` frame carrying only text is the launch prompt (the task the
 * sub-agent was given) and is surfaced separately rather than as a conversation
 * row; later `user` frames are tool results, which stay inline under the
 * `tool_use` that produced them. The distinction is by content-block type, not
 * message type — both arrive as `user`.
 */
export function buildSubagentTranscriptView(
  frames: readonly SubagentFrame[]
): SubagentTranscriptView {
  const blocks: ContentBlock[] = []
  let taskPrompt: string | null = null
  let messageCount = 0
  let toolCount = 0
  let tailText: string | null = null

  for (const frame of frames) {
    const isToolResultOnly = frame.blocks.every(
      (block) => block.type === "tool_result"
    )
    if (
      taskPrompt === null &&
      frame.role === "user" &&
      !isToolResultOnly &&
      blocks.length === 0
    ) {
      const text = frame.blocks
        .map((block) => (block.type === "text" ? block.text : ""))
        .filter((value) => value.length > 0)
        .join("\n")
      if (text.trim().length > 0) {
        taskPrompt = text
        continue
      }
    }

    messageCount += 1
    for (const block of frame.blocks) {
      blocks.push(block)
      if (block.type === "tool_use") {
        toolCount += 1
        tailText = firstLine(
          block.input_preview
            ? `${block.tool_name} ${block.input_preview}`
            : block.tool_name
        )
      } else if (block.type === "text" && block.text.trim().length > 0) {
        tailText = firstLine(block.text)
      }
    }
  }

  return { taskPrompt, blocks, messageCount, toolCount, tailText }
}
