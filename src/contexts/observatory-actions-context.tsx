"use client"

/**
 * Row actions for the observatory: the cancel request and the two
 * reconciliation reads (spec R7.1-R7.13).
 *
 * Mounted at the WORKSPACE level beside the two projections it reads, for one
 * reason that is not stylistic: the reconnect reconciliation (R7.12) must fire
 * ONE authoritative read per still-running delegation, and a per-panel instance
 * would multiply that by the number of open conversation panes (split view
 * mounts several). One provider above the tab tree means one reconnect
 * subscription, so the read count is a property of the workspace rather than of
 * how many panes happen to be open. It also outlives the popover, so a cancel
 * still in flight when the user closes the panel settles correctly instead of
 * losing its marker on unmount.
 *
 * The division of responsibility this file exists to keep is R7.7-R7.10:
 *
 *   * The EVENT STREAM owns lifecycle. `DelegationProvider` flips a binding's
 *     status on `delegation_completed` / `delegation_session_update` — reading
 *     the outcome each event CARRIES, never inferring one from its arrival —
 *     and the selector derives lifecycle from that alone.
 *   * The CANCEL RESPONSE owns nothing but the in-flight marker. It reports
 *     whether the REQUEST was accepted; it never writes a lifecycle. That is
 *     what makes the displayed lifecycle independent of response ordering
 *     (Property 9) — structurally, there is no second writer to race with.
 *   * The RECONCILIATION READ may install a terminal the stream lost, and it
 *     does so through `applyAuthoritativeStatus` — the SAME binding map the
 *     events write. It is a second ARRIVAL ROUTE, not a second source of truth,
 *     which is why no ordering rule between the two is needed.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react"

import { useDelegation } from "@/contexts/delegation-context"
import {
  cancelDelegation,
  getDelegationTaskStatus,
  type DelegationTaskReport,
  type DelegationTaskStatus,
} from "@/lib/api"
import { onTransportReconnect } from "@/lib/platform"

export interface ObservatoryActionsValue {
  /** Child conversation ids with a cancel request in flight (R7.2). Doubles as
   *  the second-cancel guard (R7.6). */
  cancelPending: ReadonlySet<number>
  /** Child conversation ids whose last cancel request failed in TRANSPORT
   *  (R7.10). A task that reported a terminal state is NOT here — that is
   *  acceptance, not failure (R7.9). */
  cancelFailed: ReadonlySet<number>
  /** Request cancellation of one delegated child. Idempotent per row while a
   *  request is in flight; safe to call straight from a click handler. */
  requestCancel: (childConversationId: number) => void
}

const ObservatoryActionsContext = createContext<ObservatoryActionsValue | null>(
  null
)

export function useObservatoryActions(): ObservatoryActionsValue {
  const ctx = useContext(ObservatoryActionsContext)
  if (!ctx) {
    throw new Error(
      "useObservatoryActions must be used within ObservatoryActionsProvider"
    )
  }
  return ctx
}

/** A report status that settles the task. `unknown` is excluded on purpose: it
 *  means the broker cannot vouch for the task, not that it finished. */
function isTerminalStatus(status: DelegationTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled"
}

interface ActionState {
  pending: ReadonlySet<number>
  failed: ReadonlySet<number>
}

const EMPTY_STATE: ActionState = { pending: new Set(), failed: new Set() }

type ActionEvent =
  | { kind: "cancel-start"; id: number }
  | { kind: "cancel-settled"; id: number }
  | { kind: "cancel-failed"; id: number }

// A reducer rather than two `useState` sets: every transition touches both
// (starting a cancel must also clear a previous failure, so a retry never shows
// "failed" and "in progress" at once), and one dispatch keeps the async
// transitions clear of `react-hooks/set-state-in-effect` — the precedent
// `use-delegated-sub-session.ts` sets for the same reason.
function actionReducer(state: ActionState, event: ActionEvent): ActionState {
  switch (event.kind) {
    case "cancel-start": {
      if (state.pending.has(event.id)) return state
      const pending = new Set(state.pending)
      pending.add(event.id)
      const failed = new Set(state.failed)
      failed.delete(event.id)
      return { pending, failed }
    }
    case "cancel-settled": {
      if (!state.pending.has(event.id) && !state.failed.has(event.id)) {
        return state
      }
      const pending = new Set(state.pending)
      pending.delete(event.id)
      const failed = new Set(state.failed)
      failed.delete(event.id)
      return { pending, failed }
    }
    case "cancel-failed": {
      const pending = new Set(state.pending)
      pending.delete(event.id)
      const failed = new Set(state.failed)
      failed.add(event.id)
      return { pending, failed }
    }
  }
}

export function ObservatoryActionsProvider({
  children,
}: {
  children: ReactNode
}) {
  const { listBindings, applyAuthoritativeStatus } = useDelegation()
  const [state, dispatch] = useReducer(actionReducer, EMPTY_STATE)

  // Latest projection + writer, mirrored into refs so the reconnect
  // subscription below binds ONCE. Keying that effect on the bindings would
  // re-subscribe on every delegation event, and a subscription that churns can
  // miss the reconnect it exists to catch.
  //
  // Written in an effect rather than during render: a render-phase ref write is
  // a side effect React may discard or replay, and the repo's lint rule blocks
  // it for that reason. An effect is also sufficient here — both refs are only
  // read from async callbacks (a click's continuation, a reconnect), never
  // during a render, so they are always committed by the time anything reads
  // them. The same pattern the delegation provider uses for its own mirrors.
  const listBindingsRef = useRef(listBindings)
  const applyStatusRef = useRef(applyAuthoritativeStatus)
  useEffect(() => {
    listBindingsRef.current = listBindings
  }, [listBindings])
  useEffect(() => {
    applyStatusRef.current = applyAuthoritativeStatus
  }, [applyAuthoritativeStatus])

  // Synchronous guard against a second cancel landing between the click and the
  // reducer's re-render. `state.pending` is the RENDERED truth (it drives the
  // row's in-progress affordance); this ref is the immediate one, because React
  // batches in between and two clicks inside one batch would both pass a check
  // made against state.
  const inFlightRef = useRef(new Set<number>())

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /** One authoritative read, applied through the bindings map (R7.13). */
  const reconcile = useCallback(async (childConversationId: number) => {
    try {
      const report: DelegationTaskReport =
        await getDelegationTaskStatus(childConversationId)
      if (!mountedRef.current) return
      applyStatusRef.current(childConversationId, report.status)
    } catch {
      // A failed reconciliation read leaves the row exactly as the event stream
      // last described it. Swallowing is the right handling HERE and only here:
      // this read is best-effort recovery for a terminal that may never have
      // been missed, it has no affordance of its own, and surfacing "could not
      // re-check" on a row that is very likely fine would be noise. Either way
      // the row keeps its honest event-derived lifecycle.
    }
  }, [])

  const requestCancel = useCallback(
    (childConversationId: number) => {
      if (!Number.isFinite(childConversationId) || childConversationId < 0) {
        return
      }
      // R7.6: one in-flight cancel per row. A repeat click is dropped here
      // rather than sent and de-duplicated later, so the broker sees one
      // request per user intent.
      if (inFlightRef.current.has(childConversationId)) return
      inFlightRef.current.add(childConversationId)
      dispatch({ kind: "cancel-start", id: childConversationId })

      void cancelDelegation(childConversationId)
        .then((report) => {
          inFlightRef.current.delete(childConversationId)
          if (!mountedRef.current) return
          // R7.9: ANY report — including an already-terminal one — means the
          // request was received and answered. Only the marker is cleared; the
          // report's status is never written to the row's lifecycle (R7.8).
          dispatch({ kind: "cancel-settled", id: childConversationId })

          // R7.11: the broker says this task is settled. If the stream has not
          // said so, that terminal may have been lost, so re-read once. Read
          // through the ref — `listBindings` captured at click time predates
          // the events that arrived while the request was in flight.
          if (!isTerminalStatus(report.status)) return
          const binding = listBindingsRef
            .current()
            .find((b) => b.childConversationId === childConversationId)
          if (binding && binding.status === "running") {
            void reconcile(childConversationId)
          }
        })
        .catch(() => {
          inFlightRef.current.delete(childConversationId)
          if (!mountedRef.current) return
          // R7.10: transport failure. Clear the marker, surface that the
          // REQUEST failed, and leave the lifecycle alone — a request that
          // never arrived says nothing about whether the sub-agent is running.
          // No reconciliation either: there is no terminal report to reconcile
          // against, and a read here would paper over the failed request.
          dispatch({ kind: "cancel-failed", id: childConversationId })
        })
    },
    [reconcile]
  )

  // R7.12: the broadcaster drops events while nothing is listening, so a
  // terminal that landed inside the disconnect window is simply gone. On
  // recovery, re-read every row still shown as running — once each. Rows the
  // stream already settled are skipped: they have nothing left to learn, and
  // re-reading them would scale the panel's traffic with total history instead
  // of with live work.
  useEffect(() => {
    const off = onTransportReconnect(() => {
      const running = listBindingsRef
        .current()
        .filter((b) => b.status === "running")
      const seen = new Set<number>()
      for (const binding of running) {
        // The binding map is keyed by parent tool-use id, so a re-announced
        // start can leave two entries pointing at one child. Dedupe by the id
        // the read is addressed with — that is what "one read per row" means.
        if (seen.has(binding.childConversationId)) continue
        seen.add(binding.childConversationId)
        void reconcile(binding.childConversationId)
      }
    })
    return () => {
      off?.()
    }
  }, [reconcile])

  const value = useMemo<ObservatoryActionsValue>(
    () => ({
      cancelPending: state.pending,
      cancelFailed: state.failed,
      requestCancel,
    }),
    [state, requestCancel]
  )

  return (
    <ObservatoryActionsContext.Provider value={value}>
      {children}
    </ObservatoryActionsContext.Provider>
  )
}
