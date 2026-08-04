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
  type SubagentTrackedEntry,
} from "@/lib/subagent-transcript"

export interface SubagentTranscriptStoreApi {
  getFrames(parentToolUseId: string): readonly SubagentFrame[] | undefined
  subscribe(parentToolUseId: string, cb: () => void): () => void
  /** Every tracked sub-agent, oldest-first (insertion order — the same order
   *  eviction consumes). Read-only projection for the observatory; the
   *  per-capsule renderer keeps using `getFrames` + `subscribe`. */
  listEntries(): readonly SubagentTrackedEntry[]
  /** Entries dropped for capacity since this provider mounted. The provider is
   *  mounted at WORKSPACE level, so the scope is the workspace's lifetime —
   *  never one conversation's. Monotonic: a per-entry tombstone would defeat
   *  the cap, so only the aggregate is kept, which is enough for the panel to
   *  say "some earlier entries are no longer retained". */
  getEvictedCount(): number
  /** Subscribe to CHANGES IN THE ENTRY SET — a new sub-agent appearing, or one
   *  being evicted. Distinct from `subscribe`, which is per-`parentToolUseId`
   *  and therefore unusable by a consumer that does not yet know an id exists.
   *
   *  Frames are ref-stored precisely so a per-frame render never reaches the
   *  message subtree, but that also means an observatory consumer would never
   *  learn that its first entry arrived: with nothing rendering, no poll it
   *  could start would ever be scheduled. This listener set closes that gap
   *  without reintroducing provider state — only whoever subscribes here
   *  re-renders, and only when the SET changes (not on every frame of an
   *  already-tracked sub-agent). */
  subscribeEntries(cb: () => void): () => void
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
  listEntries: () => [],
  getEvictedCount: () => 0,
  subscribeEntries: () => () => {},
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
 * Distinct sub-agents retained for the provider's lifetime — which is the
 * WORKSPACE's, not one conversation's: the provider is mounted above the tab /
 * conversation tree, so this cap is global and a busy workspace can evict a
 * quieter conversation's older entries. A long autonomous session can dispatch
 * hundreds of Task calls; without a cap the map grows for as long as the app
 * stays open. Eviction is oldest-first by insertion order and only ever drops a
 * transcript the user can no longer see live (its capsule is far up the
 * scrollback; Phase 2's on-disk path is the recovery route). Each eviction bumps
 * a cumulative counter so the observatory can disclose that it happened.
 */
export const MAX_TRACKED_SUBAGENTS = 64

export function SubagentTranscriptProvider({
  children,
}: {
  children: ReactNode
}) {
  const framesRef = useRef(new Map<string, readonly SubagentFrame[]>())
  const listenersRef = useRef(new Map<string, Set<() => void>>())
  const pendingRef = useRef<SubagentFrame[]>([])
  const pendingIdsRef = useRef<string[]>([])
  // Per-entry metadata the observatory needs but the capsule renderer does not:
  // the raw `session_id` (attribution input) and the last accepted frame's
  // arrival time (the only liveness evidence this event stream offers). Keyed
  // exactly like `framesRef` and evicted with it.
  const metaRef = useRef(
    new Map<string, { sessionId: string | null; lastFrameAt: number }>()
  )
  // Session id carried by each pending frame's envelope, positionally aligned
  // with `pendingRef` / `pendingIdsRef`.
  const pendingSessionIdsRef = useRef<(string | null)[]>([])
  const evictedCountRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  // Listeners for entry-SET changes (see `subscribeEntries`). Separate from
  // `listenersRef`, which is keyed per sub-agent id.
  const entryListenersRef = useRef(new Set<() => void>())
  // Cached `listEntries()` result. Rebuilding on every call would break
  // `useSyncExternalStore` consumers, which require a reference-stable snapshot
  // (a fresh array each read is an infinite render loop). Invalidated by
  // `flush` whenever the set or any frame list actually changes, so the
  // reference is stable exactly as long as the projection is unchanged.
  const entriesSnapshotRef = useRef<readonly SubagentTrackedEntry[] | null>(
    null
  )

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
      listEntries() {
        const cached = entriesSnapshotRef.current
        if (cached) return cached
        const out: SubagentTrackedEntry[] = []
        for (const [parentToolUseId, frames] of framesRef.current) {
          const meta = metaRef.current.get(parentToolUseId)
          out.push({
            parentToolUseId,
            sessionId: meta?.sessionId ?? null,
            lastFrameAt: meta?.lastFrameAt ?? 0,
            frames,
          })
        }
        entriesSnapshotRef.current = out
        return out
      },
      getEvictedCount() {
        return evictedCountRef.current
      },
      subscribeEntries(cb) {
        entryListenersRef.current.add(cb)
        return () => {
          entryListenersRef.current.delete(cb)
        }
      },
    }),
    []
  )

  const flush = useCallback(() => {
    rafRef.current = null
    const frames = pendingRef.current
    const ids = pendingIdsRef.current
    const sessionIds = pendingSessionIdsRef.current
    if (frames.length === 0) return
    pendingRef.current = []
    pendingIdsRef.current = []
    pendingSessionIdsRef.current = []

    const changed = new Set<string>()
    // Tracked separately from `changed`: an added or evicted id changes the
    // entry SET (observatory-visible), whereas another frame on an id already
    // tracked only changes that capsule's frame list.
    let setChanged = false
    const now = Date.now()
    for (let i = 0; i < frames.length; i += 1) {
      const id = ids[i]!
      const frame = frames[i]!
      const existing = framesRef.current.get(id) ?? []
      const isNew = !framesRef.current.has(id)
      const next = appendSubagentFrame(existing, frame)
      // Reference-equal → a duplicate frame; nothing to notify.
      if (next === existing && framesRef.current.has(id)) continue
      framesRef.current.set(id, next)
      if (isNew) setChanged = true
      // Attribution input + liveness evidence. `sessionId` is refreshed on
      // every accepted frame (a resumed session can re-key), and stays raw:
      // resolving it here is exactly the caching that would strand entries
      // whose mapping arrives later.
      metaRef.current.set(id, {
        sessionId: sessionIds[i] ?? null,
        lastFrameAt: now,
      })
      changed.add(id)
    }

    // Bound the number of tracked sub-agents (insertion order = oldest first).
    while (framesRef.current.size > MAX_TRACKED_SUBAGENTS) {
      const oldest = framesRef.current.keys().next().value
      if (oldest === undefined) break
      framesRef.current.delete(oldest)
      metaRef.current.delete(oldest)
      // Cumulative and never reset: the panel's capacity notice is the only
      // trace a dropped entry leaves behind.
      evictedCountRef.current += 1
      changed.add(oldest)
      setChanged = true
    }

    for (const id of changed) {
      const listeners = listenersRef.current.get(id)
      if (!listeners) continue
      for (const cb of listeners) cb()
    }
    // Any accepted frame changes the projection: a new/evicted id changes the
    // set, and an extra frame on a tracked id updates its `lastFrameAt` and
    // frame count. Invalidate before notifying so every listener's next read
    // rebuilds from current state.
    if (changed.size > 0) entriesSnapshotRef.current = null
    // Notified after the per-id listeners so an observatory consumer reading
    // `listEntries()` sees the fully-applied batch, never a half-applied one.
    if (setChanged) {
      for (const cb of entryListenersRef.current) cb()
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
      pendingSessionIdsRef.current.push(envelope.session_id ?? null)
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
