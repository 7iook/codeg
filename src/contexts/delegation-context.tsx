"use client"

/**
 * DelegationContext — tracks live parent ↔ child delegation bindings
 * indexed by `parent_tool_use_id`.
 *
 * The parent's `delegate_to_agent` ToolCallBlock needs to render the child
 * sub-session inline. Both wire events (`delegation_started` /
 * `delegation_completed`) are emitted on the *parent*'s connection stream by
 * the broker, so this context subscribes via the provider's `useAcpEvent`
 * fanout — which is fed by the Tauri firehose AND the per-connection attach
 * streams, so it behaves identically in desktop and web/server runtimes. It
 * filters the two delegation variants and exposes a tool-use-id-keyed lookup
 * so ToolCallBlock can resolve the binding by the field it already has in hand.
 *
 * Scope intentionally minimal for Phase 8:
 *   * State stays in-memory; persistence across reloads relies on the
 *     parent_tool_use_id stored on the child's DB row (Phase 7).
 *   * Inline permission routing (child's `permission_request` surfaced on
 *     parent's ToolCallBlock) is deferred — the existing permission store
 *     is per-connection and would require a broader reducer change.
 */

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"

import type { AgentType, EventEnvelope } from "@/lib/types"
import { useAcpActions, useAcpEvent } from "@/contexts/acp-connections-context"

export type DelegationStatus = "running" | "ok" | "err"

export interface DelegationBinding {
  parentConnectionId: string
  parentToolUseId: string
  childConnectionId: string
  childConversationId: number
  agentType: AgentType
  status: DelegationStatus
  errorCode?: string
  /** Bounded task text from `delegation_started`. The card's fallback when
   *  the tool call's `raw_input` never carried the arguments (Cursor's
   *  identity-less announcements). */
  task: string | null
  /** Broker-minted task id from `delegation_started`. */
  taskId: string | null
  /** The PARENT's conversation id, carried by `delegation_started` (live) and
   *  by the snapshot seed (replay) — the two producers yield the same value.
   *  `null` when the producer had none: the observatory then shows the entry as
   *  unattributed rather than guessing (it is NOT `childConversationId`). */
  parentConversationId: number | null
}

interface DelegationContextValue {
  findByParentToolUseId(id: string): DelegationBinding | undefined
  findByChildConversationId(id: number): DelegationBinding | undefined
  /** Every tracked binding, running AND terminal, in insertion order.
   *  Read-only projection for the sub-agent observatory: terminal entries stay
   *  listed (the backend's `active_delegations` is running-only, so a
   *  "completed" view has to be kept here) until the cap evicts them or the
   *  workspace unmounts. */
  listBindings(): readonly DelegationBinding[]
}

const DelegationContext = createContext<DelegationContextValue | null>(null)

export function useDelegation(): DelegationContextValue {
  const ctx = useContext(DelegationContext)
  if (!ctx) {
    throw new Error("useDelegation must be used within DelegationProvider")
  }
  return ctx
}

/** Grace period after `delegation_completed` before tearing down the
 *  synthetic child ConnectionState. Long enough for the parent UI to
 *  finish rendering the child's final assistant text from live state
 *  before falling through to the DB-persisted view. */
const CHILD_DETACH_GRACE_MS = 2_000

/**
 * Cap on tracked bindings. This map used to be unbounded: the providers are
 * mounted at the WORKSPACE level (`src/app/workspace/layout.tsx`), outside the
 * tab/conversation tree, so switching or closing a conversation never unmounts
 * them and entries only ever accumulated for as long as the app stayed open.
 *
 * 256 (~100 KB of string+enum metadata) rather than the backend's much smaller
 * `kept_alive_cap` of 8, because that one bounds live child CONNECTIONS (a heavy
 * resource) while this bounds a few fields per delegation. It exists to stop
 * unbounded growth over a long workday, not to limit concurrency — too small a
 * value would drop records the user still wants to look back at.
 *
 * Eviction only ever takes entries that have REACHED A TERMINAL STATE, oldest
 * terminal-arrival first. A running delegation is never evicted, so with more
 * than 256 concurrent runners the map is allowed to exceed the cap: dropping a
 * live binding would tear down the child stream of work still in flight, which
 * is strictly worse than holding some extra metadata.
 */
export const DELEGATION_BINDING_CAP = 256

/** A binding is evictable once its status is terminal. */
function isTerminal(binding: DelegationBinding): boolean {
  return binding.status === "ok" || binding.status === "err"
}

/**
 * Drop the oldest TERMINAL entries until the map is within the cap.
 *
 * "Oldest" is by terminal-arrival order (`terminalSeq`), not insertion order:
 * a long-running delegation started first can settle last, and the entry the
 * user is least likely to still care about is the one that finished earliest.
 * Entries with no recorded terminal seq (defensive) sort last so a real,
 * observed terminal is always preferred as the victim.
 *
 * Returns the SAME map reference when nothing had to be evicted.
 */
function evictOverCap(
  map: Map<string, DelegationBinding>,
  terminalSeq: Map<string, number>
): Map<string, DelegationBinding> {
  if (map.size <= DELEGATION_BINDING_CAP) return map
  const victims = [...map.values()]
    .filter(isTerminal)
    .sort(
      (a, b) =>
        (terminalSeq.get(a.parentToolUseId) ?? Number.MAX_SAFE_INTEGER) -
        (terminalSeq.get(b.parentToolUseId) ?? Number.MAX_SAFE_INTEGER)
    )
  let over = map.size - DELEGATION_BINDING_CAP
  if (over <= 0 || victims.length === 0) return map
  for (const victim of victims) {
    if (over <= 0) break
    map.delete(victim.parentToolUseId)
    terminalSeq.delete(victim.parentToolUseId)
    over -= 1
  }
  return map
}

export function DelegationProvider({ children }: { children: ReactNode }) {
  const { attachDelegationChild, detachDelegationChild } = useAcpActions()
  const [byToolUseId, setByToolUseId] = useState<
    Map<string, DelegationBinding>
  >(() => new Map())

  // Ref mirror so `handleEnvelope` (stable callback) can look bindings up by
  // task id / child conversation id without re-subscribing on every state
  // change — `delegation_session_update` is session-addressed, not keyed by
  // the map's `parent_tool_use_id`.
  const byToolUseIdRef = useRef(byToolUseId)
  useEffect(() => {
    byToolUseIdRef.current = byToolUseId
  }, [byToolUseId])

  // Stable refs so the event-subscription effect doesn't tear down on
  // every action identity change (the actions object is memoized but
  // its members are stable callbacks; still, defensive ref-pinning
  // keeps the subscription stable across React's StrictMode double-effect).
  const attachRef = useRef(attachDelegationChild)
  const detachRef = useRef(detachDelegationChild)
  useEffect(() => {
    attachRef.current = attachDelegationChild
  }, [attachDelegationChild])
  useEffect(() => {
    detachRef.current = detachDelegationChild
  }, [detachDelegationChild])

  // Pending detach timers — one per parent_tool_use_id. Started on
  // `delegation_completed`, cleared if a fresh `delegation_started`
  // arrives for the same parent_tool_use_id before the timer fires.
  const detachTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  )

  // Terminal-arrival order per parent_tool_use_id, used only to pick eviction
  // victims (see `evictOverCap`). A monotonic counter rather than a wall clock:
  // several terminals can land inside one event batch, and only their relative
  // order matters.
  const terminalSeqRef = useRef(new Map<string, number>())
  const terminalCounterRef = useRef(0)
  const markTerminal = useCallback((parentToolUseId: string) => {
    terminalCounterRef.current += 1
    terminalSeqRef.current.set(parentToolUseId, terminalCounterRef.current)
  }, [])

  const cancelDetachTimer = useCallback((parentToolUseId: string) => {
    const timers = detachTimersRef.current
    const t = timers.get(parentToolUseId)
    if (t) {
      clearTimeout(t)
      timers.delete(parentToolUseId)
    }
  }, [])

  const handleEnvelope = useCallback(
    (envelope: EventEnvelope) => {
      if (envelope.type === "delegation_started") {
        const next: DelegationBinding = {
          parentConnectionId: envelope.parent_connection_id,
          parentToolUseId: envelope.parent_tool_use_id,
          childConnectionId: envelope.child_connection_id,
          childConversationId: envelope.child_conversation_id,
          agentType: envelope.agent_type,
          status: "running",
          task: envelope.task_preview ?? null,
          taskId: envelope.task_id ?? null,
          // Absent on an older backend / a snapshot with no conversation id.
          // Left absent on purpose (R2.8) — a guessed value would attribute
          // the row to the wrong conversation, which is worse than showing it
          // as unattributed.
          parentConversationId: envelope.parent_conversation_id ?? null,
        }
        setByToolUseId((prev) => {
          const m = new Map(prev)
          m.set(envelope.parent_tool_use_id, next)
          // A re-announced start (reconnect / continuation) is no longer
          // terminal, so it must leave the eviction queue.
          terminalSeqRef.current.delete(envelope.parent_tool_use_id)
          return evictOverCap(m, terminalSeqRef.current)
        })
        // Cancel any pending detach for this parent_tool_use_id —
        // delegation_started can be replayed after a partial flow
        // (e.g. reconnect), and an in-flight detach would tear the
        // child state down right as it returns.
        cancelDetachTimer(envelope.parent_tool_use_id)
        // Pull the child connection into the reducer so its
        // streaming text / tool calls / pendingPermission reach
        // the parent's DelegatedSubThread inline.
        attachRef.current({
          connectionId: envelope.child_connection_id,
          parentConnectionId: envelope.parent_connection_id,
          parentToolUseId: envelope.parent_tool_use_id,
          agentType: envelope.agent_type,
        })
        return
      }
      if (envelope.type === "delegation_session_update") {
        // Terminal announcement for a CONTINUED round (turn_version > 1) —
        // the broker suppresses the second `delegation_completed` against the
        // already-terminal tool call (Requirement 2.8a) and sends this
        // session-addressed replacement instead. Without consuming it the
        // card would flip to "running" on the continuation's re-announced
        // `delegation_started` and never settle back. The event carries no
        // outcome (pure notification; the authoritative result comes from
        // `get_delegation_status`), so flip to "ok" and let the detail views
        // re-query, mirroring the completed path's detach scheduling.
        let settled: DelegationBinding | undefined
        for (const b of byToolUseIdRef.current.values()) {
          if (
            (envelope.task_id && b.taskId === envelope.task_id) ||
            b.childConversationId === envelope.child_conversation_id
          ) {
            settled = b
            break
          }
        }
        if (!settled || settled.status !== "running") return
        const parentToolUseId = settled.parentToolUseId
        const childConnectionId = settled.childConnectionId
        setByToolUseId((prev) => {
          const existing = prev.get(parentToolUseId)
          if (!existing || existing.status !== "running") return prev
          const m = new Map(prev)
          m.set(parentToolUseId, { ...existing, status: "ok" })
          markTerminal(parentToolUseId)
          return evictOverCap(m, terminalSeqRef.current)
        })
        cancelDetachTimer(parentToolUseId)
        const timer = setTimeout(() => {
          detachTimersRef.current.delete(parentToolUseId)
          detachRef.current(childConnectionId)
        }, CHILD_DETACH_GRACE_MS)
        detachTimersRef.current.set(parentToolUseId, timer)
        return
      }
      if (envelope.type === "delegation_completed") {
        setByToolUseId((prev) => {
          const existing = prev.get(envelope.parent_tool_use_id)
          // If we missed the start event (e.g. context mounted mid-flight,
          // reconnect, or snapshot replay that only re-delivered the
          // completion), synthesize a minimal binding so the parent UI still
          // shows the result — with the real agent_type the event now carries,
          // so the card renders the correct agent icon/label.
          const base: DelegationBinding = existing ?? {
            parentConnectionId: envelope.parent_connection_id,
            parentToolUseId: envelope.parent_tool_use_id,
            childConnectionId: envelope.child_connection_id,
            childConversationId: envelope.child_conversation_id,
            agentType: envelope.agent_type,
            status: "running",
            // Missed-start synthesis: the completion event carries no task
            // label; the card recovers it from the terminal meta instead.
            task: null,
            taskId: null,
            // Attribution from the completion itself — same rationale as
            // `agent_type` above. Absent (older backend) stays null =
            // unattributed; never derived from `child_conversation_id`,
            // which is a DIFFERENT conversation.
            parentConversationId: envelope.parent_conversation_id ?? null,
          }
          const updated: DelegationBinding =
            envelope.result.kind === "ok"
              ? {
                  ...base,
                  status: "ok",
                }
              : {
                  ...base,
                  status: "err",
                  errorCode: envelope.result.error_code,
                }
          const m = new Map(prev)
          m.set(envelope.parent_tool_use_id, updated)
          markTerminal(envelope.parent_tool_use_id)
          return evictOverCap(m, terminalSeqRef.current)
        })

        // Schedule detach of the synthetic child entry. We keep it
        // around briefly so the final assistant text rendered from
        // live state survives long enough for the user to read it
        // before the parent UI falls back to the DB-persisted view.
        const parentToolUseId = envelope.parent_tool_use_id
        const childConnectionId = envelope.child_connection_id
        cancelDetachTimer(parentToolUseId)
        const timer = setTimeout(() => {
          detachTimersRef.current.delete(parentToolUseId)
          detachRef.current(childConnectionId)
        }, CHILD_DETACH_GRACE_MS)
        detachTimersRef.current.set(parentToolUseId, timer)
      }
    },
    [cancelDetachTimer, markTerminal]
  )

  // Single subscription via the provider's fanout. `useAcpEvent` fires for
  // every mapped envelope on both the Tauri firehose and the per-connection
  // attach streams, so the parent-stream delegation events reach us in both
  // desktop and web/server runtimes; non-delegation types are ignored above.
  useAcpEvent(handleEnvelope)

  // Clear any pending detach timers on unmount. The synthetic children are
  // also cleaned up by the connections context's own teardown.
  useEffect(() => {
    const timers = detachTimersRef.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  const findByParentToolUseId = useCallback(
    (id: string): DelegationBinding | undefined => byToolUseId.get(id),
    [byToolUseId]
  )

  const findByChildConversationId = useCallback(
    (id: number): DelegationBinding | undefined => {
      for (const b of byToolUseId.values()) {
        if (b.childConversationId === id) return b
      }
      return undefined
    },
    [byToolUseId]
  )

  const listBindings = useCallback(
    (): readonly DelegationBinding[] => [...byToolUseId.values()],
    [byToolUseId]
  )

  return (
    <DelegationContext.Provider
      value={{ findByParentToolUseId, findByChildConversationId, listBindings }}
    >
      {children}
    </DelegationContext.Provider>
  )
}
