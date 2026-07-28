"use client"

/**
 * SubagentTranscriptProvider — live transcripts of Claude BUILT-IN sub-agents
 * (the Agent/Task tool), indexed by `parent_tool_use_id`.
 *
 * Mirrors `DelegationProvider`'s shape deliberately: the renderer that needs
 * this data (`AgentToolCallPart`, deep inside the message list) knows only the
 * tool call's own id, never a `contextKey` — so, exactly like a delegation
 * binding, the lookup has to be keyed by `parent_tool_use_id`. Fed by the
 * connections-provider fanout (`useAcpEvent`), which carries both the Tauri
 * firehose and the per-connection WS attach streams, so desktop and web behave
 * identically.
 *
 * Storage is a ref + explicit listener set (the `useConnectionStore` pattern),
 * NOT React state: a frame arrives per sub-agent message and, with several
 * sub-agents in flight, provider-level state would re-render the whole message
 * subtree on each one. Here only the capsules actually subscribed to the
 * affected `parent_tool_use_id` re-render, and only when its frame list
 * changes by reference.
 *
 * Batching: frames are buffered and flushed on an animation frame, mirroring
 * `scheduleToolCallUpdateFlush` in the connections provider — five concurrent
 * sub-agents must not each drive a synchronous render.
 *
 * Read-only by construction: codeg cannot address a built-in sub-agent (it
 * reuses the parent `sessionId`), so this context exposes no send/cancel path.
 */

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react"

import type { EventEnvelope } from "@/lib/types"
import { useAcpEvent } from "@/contexts/acp-connections-context"
import {
  appendSubagentFrame,
  parseSubagentFrame,
  type SubagentFrame,
} from "@/lib/subagent-transcript"

export interface SubagentTranscriptStoreApi {
  getFrames(parentToolUseId: string): readonly SubagentFrame[] | undefined
  subscribe(parentToolUseId: string, cb: () => void): () => void
}

const SubagentTranscriptContext =
  createContext<SubagentTranscriptStoreApi | null>(null)

export function useSubagentTranscriptStore(): SubagentTranscriptStoreApi {
  const ctx = useContext(SubagentTranscriptContext)
  if (!ctx) {
    throw new Error(
      "useSubagentTranscriptStore must be used within SubagentTranscriptProvider"
    )
  }
  return ctx
}

/** Store stand-in for trees rendered WITHOUT the provider (the read-only
 *  sub-agent dialog, isolated component tests). A live transcript is an
 *  enhancement on top of the existing capsule, so its absence must degrade to
 *  "no frames" rather than throw and take the message list down with it. */
const EMPTY_STORE: SubagentTranscriptStoreApi = {
  getFrames: () => undefined,
  subscribe: () => () => {},
}

/** Subscribe to one built-in sub-agent's live frames. `undefined` until its
 *  first frame arrives — the common case for historical turns, where the
 *  capsule must degrade to its existing bare pill (design card E-3). */
export function useSubagentFrames(
  parentToolUseId: string
): readonly SubagentFrame[] | undefined {
  const store = useContext(SubagentTranscriptContext) ?? EMPTY_STORE
  const subscribe = useCallback(
    (cb: () => void) => store.subscribe(parentToolUseId, cb),
    [store, parentToolUseId]
  )
  const getSnapshot = useCallback(
    () => store.getFrames(parentToolUseId),
    [store, parentToolUseId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Distinct sub-agents retained per session lifetime. A long autonomous session
 * can dispatch hundreds of Task calls; without a cap the map grows for as long
 * as the app stays open. Eviction is oldest-first by insertion order and only
 * ever drops a transcript the user can no longer see live (its capsule is far
 * up the scrollback; Phase 2's on-disk path is the recovery route).
 */
const MAX_TRACKED_SUBAGENTS = 64

export function SubagentTranscriptProvider({
  children,
}: {
  children: ReactNode
}) {
  const framesRef = useRef(new Map<string, readonly SubagentFrame[]>())
  const listenersRef = useRef(new Map<string, Set<() => void>>())
  const pendingRef = useRef<SubagentFrame[]>([])
  const pendingIdsRef = useRef<string[]>([])
  const rafRef = useRef<number | null>(null)

  const api = useMemo<SubagentTranscriptStoreApi>(
    () => ({
      getFrames(parentToolUseId) {
        return framesRef.current.get(parentToolUseId)
      },
      subscribe(parentToolUseId, cb) {
        let set = listenersRef.current.get(parentToolUseId)
        if (!set) {
          set = new Set()
          listenersRef.current.set(parentToolUseId, set)
        }
        set.add(cb)
        return () => {
          set.delete(cb)
          if (set.size === 0) listenersRef.current.delete(parentToolUseId)
        }
      },
    }),
    []
  )

  const flush = useCallback(() => {
    rafRef.current = null
    const frames = pendingRef.current
    const ids = pendingIdsRef.current
    if (frames.length === 0) return
    pendingRef.current = []
    pendingIdsRef.current = []

    const changed = new Set<string>()
    for (let i = 0; i < frames.length; i += 1) {
      const id = ids[i]!
      const frame = frames[i]!
      const existing = framesRef.current.get(id) ?? []
      const next = appendSubagentFrame(existing, frame)
      // Reference-equal → a duplicate frame; nothing to notify.
      if (next === existing && framesRef.current.has(id)) continue
      framesRef.current.set(id, next)
      changed.add(id)
    }

    // Bound the number of tracked sub-agents (insertion order = oldest first).
    while (framesRef.current.size > MAX_TRACKED_SUBAGENTS) {
      const oldest = framesRef.current.keys().next().value
      if (oldest === undefined) break
      framesRef.current.delete(oldest)
      changed.add(oldest)
    }

    for (const id of changed) {
      const listeners = listenersRef.current.get(id)
      if (!listeners) continue
      for (const cb of listeners) cb()
    }
  }, [])

  const handleEnvelope = useCallback(
    (envelope: EventEnvelope) => {
      if (envelope.type !== "claude_subagent_message") return
      const frame = parseSubagentFrame(
        envelope.parent_tool_use_id,
        envelope.message
      )
      if (!frame) return
      pendingRef.current.push(frame)
      pendingIdsRef.current.push(envelope.parent_tool_use_id)
      if (typeof requestAnimationFrame !== "function") {
        // Non-browser host (SSR/export prerender): apply synchronously.
        flush()
        return
      }
      if (rafRef.current !== null) return
      rafRef.current = requestAnimationFrame(flush)
    },
    [flush]
  )

  useAcpEvent(handleEnvelope)

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return (
    <SubagentTranscriptContext.Provider value={api}>
      {children}
    </SubagentTranscriptContext.Provider>
  )
}
