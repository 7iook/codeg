/**
 * Row model for the resident sub-agent observatory — the single place where the
 * two kinds of observed sub-agent are normalized into one list.
 *
 * Pure by construction: no React, no store reads, no DB, no clock. Everything
 * needed to decide attribution and lifecycle arrives through the one input
 * object, including the external-id → conversation mapping snapshot and `now`.
 * That is what makes the correctness properties testable, and it is also what
 * makes attribution self-correcting: nothing derived is cached anywhere, so an
 * entry that was unattributable on one evaluation is attributed on the next as
 * soon as its mapping exists.
 *
 * The two kinds are NOT equivalent and this module does not pretend otherwise:
 *
 *   * A DELEGATED sub-agent (codeg's own broker) has a task id, its own child
 *     conversation, an authoritative status, and can be canceled and opened.
 *   * A BUILT-IN sub-agent (Claude's Agent/Task tool) has only a frame stream
 *     keyed by the parent tool-use id. It has no ACP address, so it can neither
 *     be canceled nor opened in a tab, and — critically — its event stream
 *     carries NO termination signal. Absence of frames is not completion: it is
 *     equally consistent with thinking, a blocked tool call, or a dropped
 *     connection. So a built-in row is only ever `running` or `silent`, and
 *     never claims a terminal outcome it cannot know.
 */

import type { DelegationBinding } from "@/contexts/delegation-context"
import type { SubagentTrackedEntry } from "@/lib/subagent-transcript"
import type { AgentType } from "@/lib/types"

/** Which conversation a row belongs to, relative to the one being viewed.
 *  Orthogonal to {@link ObservedLifecycle} — a finished task still belongs to
 *  some conversation. */
export type ObservedScope = "current" | "other" | "unattributed"

/** How alive a row is. `silent` is "no recent activity", NOT "succeeded" —
 *  only built-in rows can take it, and only built-in rows are barred from the
 *  three terminal values. */
export type ObservedLifecycle =
  | "running"
  | "silent"
  | "completed"
  | "canceled"
  | "failed"

/** The single visible bucket, projected from the two dimensions above with a
 *  fixed precedence (lifecycle first). See {@link partitionFor}. */
export type ObservedPartition =
  | "current"
  | "other"
  | "unattributed"
  | "completed"

export type ObservedSubAgentKind = "delegated" | "builtin"

export interface ObservedSubAgentRow {
  /** Stable identity across evaluations, unique within one result. Prefixed by
   *  kind so a delegation and a built-in SUB can never collide on a shared
   *  tool-use id. */
  id: string
  kind: ObservedSubAgentKind
  parentToolUseId: string
  /** Broker task id — the cancel/status addressing key. `null` for built-ins,
   *  which have none. */
  taskId: string | null
  /** The delegated child's own conversation (the Open-in-Tab target). `null`
   *  for built-ins, which reuse the parent session. */
  childConversationId: number | null
  /** Owning conversation: the delegation's parent conversation, or the built-in's
   *  resolved session. `null` ⇒ unattributed. */
  conversationId: number | null
  /** Raw external session id for built-ins (the attribution input); `null` for
   *  delegations, which are attributed by conversation id directly. */
  sessionId: string | null
  agentType: AgentType | null
  /** Non-blank internal identifier, NOT display text — nothing renders this.
   *  The panel localizes at the render site instead
   *  (`sub-agent-observatory-list.tsx:586`: `getAgentLabel(row.agentType)` when
   *  a type exists, `t("unknownAgent")` otherwise). Rendering this field would
   *  bypass both the custom-agent display registry and i18n. See
   *  {@link UNKNOWN_AGENT_LABEL}. */
  agentLabel: string
  /** What was delegated, when known. `null` for entries whose producer never
   *  carried the text (identity-less hosts, built-ins without a prompt frame). */
  taskText: string | null
  errorCode: string | null
  scope: ObservedScope
  lifecycle: ObservedLifecycle
  partition: ObservedPartition
  canCancel: boolean
  canOpenInTab: boolean
  /** Last observed activity: a built-in's last frame time. `null` when unknown
   *  (delegations have no per-row activity clock — their status is
   *  authoritative, so they do not need one). */
  lastActivityAt: number | null
  /** Frames retained for a built-in row, for in-place detail rendering. */
  frameCount: number
}

/** Mapping snapshot: external session id → runtime conversation id. Accepts a
 *  `Map` or a plain record so callers can pass whichever they hold. */
export type ConversationIdByExternalId =
  | ReadonlyMap<string, number>
  | Readonly<Record<string, number>>

export interface ObservedSubAgentsInput {
  delegations: readonly DelegationBinding[]
  subagents: readonly SubagentTrackedEntry[]
  /** The conversation being viewed. `null` on cold start — which makes rows
   *  `other`/`unattributed`, never silently `current`. */
  currentConversationId: number | null
  conversationIdByExternalId: ConversationIdByExternalId
  /** Evaluation instant, supplied by the caller so the silence check is
   *  deterministic and testable. */
  now: number
  /** Frames-quiet threshold after which a built-in row reads `silent`. */
  silenceThresholdMs?: number
}

/**
 * A built-in sub-agent whose last frame is older than this reads as `silent`.
 *
 * Chosen over the two alternatives: showing `running` forever leaves finished
 * sub-agents spinning with no way to tell whether intervention is needed, and
 * showing only a raw timestamp pushes the arithmetic onto the user every time.
 * It deliberately does not claim success or failure, because the event stream
 * does not carry that information.
 */
export const DEFAULT_SILENCE_THRESHOLD_MS = 15_000

/**
 * Internal, non-UI default for {@link ObservedSubAgentRow.agentLabel} when a row
 * has no agent type (always a built-in: Claude's Task tool announces no agent
 * identity).
 *
 * NOT user-facing, and deliberately not localized. Display text for that case is
 * the `unknownAgent` message key, resolved at the render site
 * (`sub-agent-observatory-list.tsx:586`) — which is also where a known type
 * becomes `getAgentLabel(agentType)`. Keeping the fallback here as a plain
 * string means this module stays pure (no `next-intl` dependency, no locale in
 * its inputs) and the row model carries data rather than presentation.
 *
 * Consequence to preserve: `agentLabel` must stay out of JSX. If a future caller
 * renders it, an English string will leak into every locale — localize at the
 * render site instead.
 */
export const UNKNOWN_AGENT_LABEL = "sub-agent"

const TERMINAL_LIFECYCLES: ReadonlySet<ObservedLifecycle> = new Set([
  "completed",
  "canceled",
  "failed",
])

function isTerminal(lifecycle: ObservedLifecycle): boolean {
  return TERMINAL_LIFECYCLES.has(lifecycle)
}

/**
 * Project the two orthogonal dimensions onto one visible bucket, lifecycle
 * first: any terminal row goes to `completed` no matter which conversation it
 * belongs to; a live row is filed by scope. The precedence is fixed here rather
 * than at each call site so ordering, counting and the panel's sections can
 * never disagree about where a row belongs.
 */
function partitionFor(
  scope: ObservedScope,
  lifecycle: ObservedLifecycle
): ObservedPartition {
  return isTerminal(lifecycle) ? "completed" : scope
}

function lookupConversationId(
  mapping: ConversationIdByExternalId | undefined,
  externalId: string | null
): number | null {
  if (!externalId || !mapping) return null
  const value =
    typeof (mapping as ReadonlyMap<string, number>).get === "function"
      ? (mapping as ReadonlyMap<string, number>).get(externalId)
      : (mapping as Record<string, number>)[externalId]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Scope from an owning conversation id. An absent id is `unattributed` and is
 *  never assumed to be the current conversation — a wrongly-attributed row
 *  makes the whole list untrustworthy, whereas an honestly unattributed one is
 *  merely less useful. */
function scopeFor(
  conversationId: number | null,
  currentConversationId: number | null
): ObservedScope {
  if (conversationId === null) return "unattributed"
  if (currentConversationId === null) return "other"
  return conversationId === currentConversationId ? "current" : "other"
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Map a delegation binding's status to a lifecycle. `err` splits by error
 *  code: a user-requested cancel is not a failure, and conflating them would
 *  report cancellations as errors. */
function delegationLifecycle(
  status: unknown,
  errorCode: string | null
): ObservedLifecycle {
  if (status === "ok") return "completed"
  if (status === "err") {
    return errorCode === "canceled" ? "canceled" : "failed"
  }
  // `running`, and anything unrecognized: treat as live rather than inventing
  // a terminal state for a delegation that may well still be working.
  return "running"
}

/**
 * Lifecycle for a built-in sub-agent — only ever `running` or `silent`.
 *
 * A frame stamped in the future (clock skew, or a caller passing an older `now`)
 * yields a non-positive age and so reads `running`: erring toward "still alive"
 * is the safe direction, since calling a live sub-agent silent invites the user
 * to conclude it is finished.
 */
function builtinLifecycle(
  lastFrameAt: number | null,
  now: number,
  thresholdMs: number
): ObservedLifecycle {
  if (lastFrameAt === null) return "silent"
  const nowValue = finiteNumber(now) ?? 0
  return nowValue - lastFrameAt > thresholdMs ? "silent" : "running"
}

function rowFromDelegation(
  binding: DelegationBinding,
  currentConversationId: number | null
): ObservedSubAgentRow {
  const parentToolUseId = nonEmptyString(binding?.parentToolUseId) ?? ""
  const taskId = nonEmptyString(binding?.taskId)
  const errorCode = nonEmptyString(binding?.errorCode)
  const conversationId = finiteNumber(binding?.parentConversationId)
  const agentType = nonEmptyString(binding?.agentType) as AgentType | null
  const scope = scopeFor(conversationId, currentConversationId)
  const lifecycle = delegationLifecycle(binding?.status, errorCode)
  return {
    // Task id is the more stable identity (it survives a re-announcement on a
    // continuation), with the tool-use id as fallback.
    id: `delegated:${taskId ?? parentToolUseId}`,
    kind: "delegated",
    parentToolUseId,
    taskId,
    childConversationId: finiteNumber(binding?.childConversationId),
    conversationId,
    sessionId: null,
    agentType,
    // Internal identifier only — the panel localizes at the render site.
    agentLabel: agentType ?? UNKNOWN_AGENT_LABEL,
    taskText: nonEmptyString(binding?.task),
    errorCode,
    scope,
    lifecycle,
    partition: partitionFor(scope, lifecycle),
    // Only a live delegation can be canceled; a settled one has nothing left
    // to stop. Opening the child session stays available afterwards — reading
    // what it did is the main reason to keep terminal rows listed at all.
    canCancel: lifecycle === "running",
    canOpenInTab: true,
    lastActivityAt: null,
    frameCount: 0,
  }
}

function rowFromSubagent(
  entry: SubagentTrackedEntry,
  input: ObservedSubAgentsInput,
  thresholdMs: number
): ObservedSubAgentRow {
  const parentToolUseId = nonEmptyString(entry?.parentToolUseId) ?? ""
  const sessionId = nonEmptyString(entry?.sessionId)
  const conversationId = lookupConversationId(
    input.conversationIdByExternalId,
    sessionId
  )
  const lastFrameAt = finiteNumber(entry?.lastFrameAt)
  const scope = scopeFor(conversationId, input.currentConversationId)
  const lifecycle = builtinLifecycle(lastFrameAt, input.now, thresholdMs)
  return {
    id: `builtin:${parentToolUseId}`,
    kind: "builtin",
    parentToolUseId,
    taskId: null,
    childConversationId: null,
    conversationId,
    sessionId,
    // Claude's Task tool announces no agent identity, so this is always the
    // neutral placeholder rather than a guess at the host agent.
    agentType: null,
    // Internal identifier only; the panel renders `t("unknownAgent")` here.
    agentLabel: UNKNOWN_AGENT_LABEL,
    taskText: null,
    errorCode: null,
    scope,
    lifecycle,
    partition: partitionFor(scope, lifecycle),
    // Physically impossible, not merely disabled: there is no ACP address to
    // cancel and no separate conversation to open.
    canCancel: false,
    canOpenInTab: false,
    lastActivityAt: lastFrameAt,
    frameCount: Array.isArray(entry?.frames) ? entry.frames.length : 0,
  }
}

/** Partition display order, so the list groups the same way every evaluation. */
const PARTITION_ORDER: Record<ObservedPartition, number> = {
  current: 0,
  other: 1,
  unattributed: 2,
  completed: 3,
}

/** Within a partition: live rows above quiet ones, then a stable id tiebreak. */
const LIFECYCLE_ORDER: Record<ObservedLifecycle, number> = {
  running: 0,
  silent: 1,
  completed: 2,
  canceled: 3,
  failed: 4,
}

/**
 * Normalize both sources into one ordered row list.
 *
 * Total and lossless: every input entry produces exactly one row — nothing is
 * merged, nothing is dropped, and a missing field degrades to a defined
 * placeholder rather than throwing. A list that silently omits a sub-agent is
 * worse than one showing it with unknown fields, because the user cannot tell
 * the difference between "not running" and "not displayed".
 *
 * Ordering is fully determined by row content, never by input iteration order,
 * so the panel can diff on it and tests can assert on it.
 */
export function buildObservedSubAgentRows(
  input: ObservedSubAgentsInput
): ObservedSubAgentRow[] {
  const safe: ObservedSubAgentsInput = {
    delegations: Array.isArray(input?.delegations) ? input.delegations : [],
    subagents: Array.isArray(input?.subagents) ? input.subagents : [],
    currentConversationId: finiteNumber(input?.currentConversationId),
    conversationIdByExternalId: input?.conversationIdByExternalId ?? new Map(),
    now: finiteNumber(input?.now) ?? 0,
    silenceThresholdMs: input?.silenceThresholdMs,
  }
  const thresholdMs =
    finiteNumber(safe.silenceThresholdMs) ?? DEFAULT_SILENCE_THRESHOLD_MS

  const rows: ObservedSubAgentRow[] = []
  for (const binding of safe.delegations) {
    if (!binding) continue
    rows.push(rowFromDelegation(binding, safe.currentConversationId))
  }
  for (const entry of safe.subagents) {
    if (!entry) continue
    rows.push(rowFromSubagent(entry, safe, thresholdMs))
  }

  rows.sort((a, b) => {
    const byPartition =
      PARTITION_ORDER[a.partition] - PARTITION_ORDER[b.partition]
    if (byPartition !== 0) return byPartition
    const byLifecycle =
      LIFECYCLE_ORDER[a.lifecycle] - LIFECYCLE_ORDER[b.lifecycle]
    if (byLifecycle !== 0) return byLifecycle
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return rows
}
