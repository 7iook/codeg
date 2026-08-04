"use client"

/**
 * Observed sub-agents, evaluated for the resident chip (and, later, the panel).
 *
 * This is the seam where the pure selector meets React: it gathers the four
 * live inputs `buildObservedSubAgentRows` refuses to read for itself (the two
 * provider projections, the external-id mapping snapshot, and `now`) and
 * re-evaluates them on a fixed tick.
 *
 * Why a tick at all. Two of the inputs change WITHOUT any React update:
 *
 *   * A built-in SUB's `silent` verdict is a function of elapsed time, not of
 *     any event — the last frame having arrived is precisely the thing that
 *     stops producing renders. Without a clock of its own the count would
 *     freeze at whatever the last unrelated render happened to observe.
 *   * The evicted count is ref-backed in its provider by design (per-frame
 *     provider state would re-render the whole message subtree), so it changes
 *     silently too.
 *
 * The tick therefore reads both, rather than pretending event-driven updates
 * cover them. It runs only while there is something to observe, so an idle
 * workspace schedules nothing.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { useDelegation } from "@/contexts/delegation-context"
import { useSubagentTranscriptStore } from "@/contexts/subagent-transcript-context"
import {
  buildObservedSubAgentRows,
  type ObservedSubAgentRow,
} from "@/lib/observed-sub-agents"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"

/**
 * Re-evaluation interval while the panel is CLOSED (R6.7). Same order as the
 * selector's 15s silence threshold: fine enough that a sub-agent going quiet is
 * reflected within a few seconds, coarse enough to be irrelevant to render cost
 * (one pass over a bounded list).
 */
export const OBSERVED_SUB_AGENTS_TICK_MS = 5_000

/**
 * Re-evaluation interval while the panel is OPEN (R6.5). Finer than the closed
 * cadence because the user is looking straight at the rows: a sub-agent whose
 * last frame just aged past the threshold should read `silent` while they are
 * still watching, not on whichever tick happens next.
 *
 * Both cadences are driven by the ONE timer below. The panel does not start a
 * competing interval of its own, so there is a single scheduler for the silence
 * clock and no way for two of them to disagree about `now`.
 */
export const OBSERVED_SUB_AGENTS_PANEL_TICK_MS = 2_000

export interface ObservedSubAgentsOptions {
  /** Set by the panel body while it is mounted. Selects the faster cadence;
   *  the stop-clock itself is structural — the panel body unmounts with the
   *  popover, taking its interval with it (R6.6), while the chip's own
   *  instance keeps ticking at the closed cadence (R6.7). */
  panelOpen?: boolean
}

export interface ObservedSubAgentsSnapshot {
  /** Normalized rows, ordered by the selector. */
  rows: readonly ObservedSubAgentRow[]
  /** Rows currently running. Built-in SUBs count while not yet silent. */
  runningCount: number
  /** Every observable row. R5.5's "total" — deliberately NOT a completed count,
   *  since a silenced built-in SUB has not been shown to have completed. */
  totalCount: number
  /** Built-in SUB entries dropped for capacity since the workspace loaded. */
  evictedCount: number
}

/**
 * @param currentConversationId The DB conversation id of the conversation being
 *   viewed (NOT a tab id — a different id space entirely). Used only to label
 *   rows current-vs-other; it never narrows the observation set, which is
 *   workspace-wide per R5.1.
 */
export function useObservedSubAgents(
  currentConversationId: number | null,
  options?: ObservedSubAgentsOptions
): ObservedSubAgentsSnapshot {
  const { listBindings } = useDelegation()
  const subagentStore = useSubagentTranscriptStore()

  // Subscribing to the map itself (not to a derived lookup) keeps the selector
  // pure — the mapping arrives as an input snapshot — while still re-evaluating
  // when the store swaps the map in. This is what lets an entry that was
  // unattributable on one pass become attributed on the next (R3.5).
  const conversationIdByExternalId = useConversationRuntimeStore(
    (s) => s.conversationIdByExternalId
  )

  const [tick, setTick] = useState(0)
  const advance = useCallback(() => setTick((n) => n + 1), [])

  const delegations = listBindings()
  // Frames live in a ref, so an arriving sub-agent produces no render of its
  // own; without subscribing to set changes the first entry would go unnoticed
  // and the tick below — gated on there being something to observe — would
  // never start. `subscribeEntries` fires only when the SET changes, so this
  // does not reintroduce the per-frame render the ref exists to avoid.
  const subagents = useSyncExternalStore(
    subagentStore.subscribeEntries,
    subagentStore.listEntries,
    subagentStore.listEntries
  )

  // Whether a timer is needed is derived from the inputs, not from the last
  // computed snapshot: keying the effect on the result would make the timer
  // that produces the change depend on the change it produces.
  const hasObservable = delegations.length > 0 || subagents.length > 0
  // Only a built-in SUB has a time-derived lifecycle, so it is the only reason
  // the OPEN panel needs the faster clock (R6.5 scopes its re-evaluation to
  // "there are built-in SUB entries" for exactly this reason). With delegations
  // alone, status arrives by event and the faster cadence would buy nothing.
  const hasBuiltin = subagents.length > 0
  const intervalMs =
    options?.panelOpen && hasBuiltin
      ? OBSERVED_SUB_AGENTS_PANEL_TICK_MS
      : OBSERVED_SUB_AGENTS_TICK_MS

  useEffect(() => {
    if (!hasObservable) return
    const timer = setInterval(advance, intervalMs)
    return () => clearInterval(timer)
  }, [hasObservable, intervalMs, advance])

  // `now` is read here, once per evaluation, and handed to the selector so the
  // silence decision stays a pure function of its inputs.
  const rows = useMemo(
    () =>
      buildObservedSubAgentRows({
        delegations,
        subagents,
        currentConversationId,
        conversationIdByExternalId,
        now: Date.now(),
      }),
    // `tick` is a real dependency: it is the only input that changes when a
    // sub-agent goes quiet with no further events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      delegations,
      subagents,
      currentConversationId,
      conversationIdByExternalId,
      tick,
    ]
  )

  // Read through the same tick as the rows. Ref-backed in its provider, so it
  // would otherwise never reach a consumer; mirrored into a ref only to keep
  // the returned object stable when nothing changed.
  const evictedRef = useRef(0)
  evictedRef.current = subagentStore.getEvictedCount()

  return useMemo(() => {
    let running = 0
    for (const row of rows) if (row.lifecycle === "running") running += 1
    return {
      rows,
      runningCount: running,
      totalCount: rows.length,
      evictedCount: evictedRef.current,
    }
  }, [rows])
}
