import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { useObservatoryActions } from "./observatory-actions-context"
import { LiveObservabilityProviders } from "@/contexts/live-observability-providers"
import { useObservedSubAgents } from "@/hooks/use-observed-sub-agents"
import type { DelegationTaskReport } from "@/lib/api"
import type { EventEnvelope } from "@/lib/types"

/**
 * Property 9 — "the row's lifecycle is decided by the event stream, whatever
 * order the cancel response arrives in" — is the reason this file exists, and
 * it is written as an ORDERING sweep rather than one happy path: the failure it
 * guards against only appears in a specific interleaving, so a single ordering
 * would pass while the bug shipped.
 *
 * The whole stack under test is real (`DelegationProvider` + the selector +
 * the actions provider); only the event fanout, the runtime store's mapping and
 * the two API calls are substituted, because those are the inputs a browser
 * supplies. Asserting on the LIFECYCLE THE SELECTOR PRODUCES, rather than on
 * whether some setter was called, is what makes these tests about the property
 * instead of about the implementation.
 */

let capturedHandlers: ((envelope: EventEnvelope) => void)[] = []
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({
    attachDelegationChild: vi.fn(),
    detachDelegationChild: vi.fn(),
  }),
  useAcpEvent: (handler: (e: EventEnvelope) => void) => {
    if (!capturedHandlers.includes(handler)) capturedHandlers.push(handler)
  },
}))

vi.mock("@/stores/conversation-runtime-store", () => ({
  useConversationRuntimeStore: (selector: (s: unknown) => unknown) =>
    selector({ conversationIdByExternalId: new Map<string, number>() }),
}))

const mockCancel = vi.fn()
const mockStatus = vi.fn()
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api")
  return {
    ...actual,
    cancelDelegation: (...args: unknown[]) => mockCancel(...args),
    getDelegationTaskStatus: (...args: unknown[]) => mockStatus(...args),
  }
})

/** Reconnect callbacks registered by the provider. */
let reconnectCallbacks: (() => void)[] = []
const mockOnTransportReconnect = vi.fn((cb: () => void) => {
  reconnectCallbacks.push(cb)
  return () => {
    reconnectCallbacks = reconnectCallbacks.filter((c) => c !== cb)
  }
})
vi.mock("@/lib/platform", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform")
  return {
    ...actual,
    onTransportReconnect: (cb: () => void) => mockOnTransportReconnect(cb),
  }
})

const CHILD = 900

function started(
  parentToolUseId: string,
  childConversationId = CHILD
): EventEnvelope {
  return {
    seq: 1,
    connection_id: "conn-1",
    type: "delegation_started",
    parent_connection_id: "p1",
    parent_conversation_id: 1,
    parent_tool_use_id: parentToolUseId,
    child_connection_id: `c-${parentToolUseId}`,
    child_conversation_id: childConversationId,
    agent_type: "codex",
    task_preview: "investigate the thing",
    task_id: `task-${parentToolUseId}`,
  } as unknown as EventEnvelope
}

/** `delegation_completed` carrying the broker's cancel outcome — the shape
 *  `teardown_canceled_child` actually emits (`Err{error_code:"canceled"}`). */
function canceledEvent(
  parentToolUseId: string,
  childConversationId = CHILD
): EventEnvelope {
  return {
    seq: 2,
    connection_id: "conn-1",
    type: "delegation_completed",
    parent_connection_id: "p1",
    parent_conversation_id: 1,
    parent_tool_use_id: parentToolUseId,
    child_connection_id: `c-${parentToolUseId}`,
    child_conversation_id: childConversationId,
    agent_type: "codex",
    result: { kind: "err", error_code: "canceled" },
  } as unknown as EventEnvelope
}

function completedOkEvent(
  parentToolUseId: string,
  childConversationId = CHILD
): EventEnvelope {
  return {
    seq: 2,
    connection_id: "conn-1",
    type: "delegation_completed",
    parent_connection_id: "p1",
    parent_conversation_id: 1,
    parent_tool_use_id: parentToolUseId,
    child_connection_id: `c-${parentToolUseId}`,
    child_conversation_id: childConversationId,
    agent_type: "codex",
    result: { kind: "ok" },
  } as unknown as EventEnvelope
}

function report(over: Partial<DelegationTaskReport> = {}) {
  return {
    task_id: "task-pt-1",
    status: "canceled",
    child_conversation_id: CHILD,
    ...over,
  } as DelegationTaskReport
}

function dispatch(envelope: EventEnvelope) {
  if (capturedHandlers.length === 0) {
    throw new Error("no provider handler registered")
  }
  act(() => {
    for (const handler of capturedHandlers) handler(envelope)
  })
}

/** Probe rendering the observable truth: the row lifecycle the panel would
 *  display, plus the action state driving the affordances. */
function Probe({ conversationId = 1 }: { conversationId?: number }) {
  const { rows } = useObservedSubAgents(conversationId)
  const { cancelPending, cancelFailed, requestCancel } = useObservatoryActions()
  return (
    <div>
      {rows.map((row) => (
        <div key={row.id}>
          <span data-testid={`lifecycle-${row.childConversationId}`}>
            {row.lifecycle}
          </span>
          <span data-testid={`pending-${row.childConversationId}`}>
            {cancelPending.has(row.childConversationId ?? -1) ? "yes" : "no"}
          </span>
          <span data-testid={`failed-${row.childConversationId}`}>
            {cancelFailed.has(row.childConversationId ?? -1) ? "yes" : "no"}
          </span>
          <button
            type="button"
            data-testid={`cancel-${row.childConversationId}`}
            onClick={() => requestCancel(row.childConversationId ?? -1)}
          >
            cancel
          </button>
        </div>
      ))}
    </div>
  )
}

// Mounted through `LiveObservabilityProviders`, the real composition, rather
// than by wrapping the actions provider by hand: the reconnect-read count is a
// property of that composition (one provider above the panes), and a bespoke
// tree here could satisfy the assertions while production nested it per pane.
function renderProbe(conversationId = 1) {
  return render(
    <LiveObservabilityProviders>
      <Probe conversationId={conversationId} />
    </LiveObservabilityProviders>
  )
}

beforeEach(() => {
  capturedHandlers = []
  reconnectCallbacks = []
  mockCancel.mockReset()
  mockStatus.mockReset()
  mockOnTransportReconnect.mockClear()
  // Default: the read finds the task still running, so a test that does not
  // care about reconciliation cannot accidentally get a terminal from it.
  mockStatus.mockResolvedValue(report({ status: "running" }))
  vi.useRealTimers()
})

describe("Property 9 — lifecycle comes from the event stream, not the response", () => {
  it("keeps the event-derived lifecycle when the RESPONSE lands first", async () => {
    // Ordering A: response (terminal) → event. The response must not write the
    // lifecycle even though it knows the answer; the event that follows is what
    // moves the row.
    let resolveCancel: ((r: DelegationTaskReport) => void) | null = null
    mockCancel.mockReturnValue(
      new Promise<DelegationTaskReport>((r) => {
        resolveCancel = r
      })
    )
    renderProbe()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1"))

    await userEvent.click(await screen.findByTestId(`cancel-${CHILD}`))
    await waitFor(() =>
      expect(screen.getByTestId(`pending-${CHILD}`)).toHaveTextContent("yes")
    )

    await act(async () => {
      resolveCancel?.(report({ status: "canceled" }))
    })

    // In-flight marker cleared, request treated as accepted (R7.9) — and the
    // lifecycle is STILL running, because no event has arrived yet.
    await waitFor(() =>
      expect(screen.getByTestId(`pending-${CHILD}`)).toHaveTextContent("no")
    )
    expect(screen.getByTestId(`failed-${CHILD}`)).toHaveTextContent("no")

    dispatch(canceledEvent("pt-1"))
    await waitFor(() =>
      expect(screen.getByTestId(`lifecycle-${CHILD}`)).toHaveTextContent(
        "canceled"
      )
    )
  })

  it("keeps the event-derived lifecycle when the EVENT lands first", async () => {
    // Ordering B: event → response. The already-terminal row must not be
    // dragged back to running (or to some other terminal) by the late response.
    let resolveCancel: ((r: DelegationTaskReport) => void) | null = null
    mockCancel.mockReturnValue(
      new Promise<DelegationTaskReport>((r) => {
        resolveCancel = r
      })
    )
    renderProbe()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1"))

    await userEvent.click(await screen.findByTestId(`cancel-${CHILD}`))
    dispatch(canceledEvent("pt-1"))
    await waitFor(() =>
      expect(screen.getByTestId(`lifecycle-${CHILD}`)).toHaveTextContent(
        "canceled"
      )
    )

    await act(async () => {
      resolveCancel?.(report({ status: "canceled" }))
    })

    await waitFor(() =>
      expect(screen.getByTestId(`pending-${CHILD}`)).toHaveTextContent("no")
    )
    expect(screen.getByTestId(`lifecycle-${CHILD}`)).toHaveTextContent(
      "canceled"
    )
  })

  it("does not invent a lifecycle when NO event ever arrives, reconciling instead", async () => {
    // Ordering C: response terminal, event never arrives — the R7.11 window.
    // The response still writes no lifecycle; the authoritative READ it triggers
    // is what supplies one, and that read is the explicit exception (R7.13).
    mockCancel.mockResolvedValue(report({ status: "canceled" }))
    mockStatus.mockResolvedValue(report({ status: "canceled" }))
    renderProbe()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1"))

    await userEvent.click(await screen.findByTestId(`cancel-${CHILD}`))

    // The reconciliation read fires because the stream stayed silent.
    await waitFor(() => expect(mockStatus).toHaveBeenCalledWith(CHILD))
    await waitFor(() =>
      expect(screen.getByTestId(`lifecycle-${CHILD}`)).toHaveTextContent(
        "canceled"
      )
    )
  })

  it("does not reconcile when the event already delivered the terminal", async () => {
    // The event stream is the normal path; a redundant authoritative read on
    // every cancel would make the panel chattier for no information gain.
    //
    // The ordering has to be FORCED rather than assumed: with an immediately
    // resolved cancel the response lands first, at which point the stream
    // really has not delivered a terminal, and R7.11 correctly fires a read.
    // So the response is held until after the event has been applied — that is
    // the state this assertion is about.
    let resolveCancel: ((r: DelegationTaskReport) => void) | null = null
    mockCancel.mockReturnValue(
      new Promise<DelegationTaskReport>((r) => {
        resolveCancel = r
      })
    )
    renderProbe()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1"))

    await userEvent.click(await screen.findByTestId(`cancel-${CHILD}`))
    dispatch(canceledEvent("pt-1"))
    await waitFor(() =>
      expect(screen.getByTestId(`lifecycle-${CHILD}`)).toHaveTextContent(
        "canceled"
      )
    )

    await act(async () => {
      resolveCancel?.(report({ status: "canceled" }))
    })

    await waitFor(() =>
      expect(screen.getByTestId(`pending-${CHILD}`)).toHaveTextContent("no")
    )
    expect(mockStatus).not.toHaveBeenCalled()
  })

  it("lets the event stream disagree with the response and still wins", async () => {
    // The cancel raced a natural completion: the response says `canceled`, the
    // stream says `ok`. Reporting `canceled` here would tell the user their
    // click stopped work that had in fact finished on its own.
    mockCancel.mockResolvedValue(report({ status: "canceled" }))
    renderProbe()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1"))

    await userEvent.click(await screen.findByTestId(`cancel-${CHILD}`))
    dispatch(completedOkEvent("pt-1"))

    await waitFor(() =>
      expect(screen.getByTestId(`pending-${CHILD}`)).toHaveTextContent("no")
    )
    expect(screen.getByTestId(`lifecycle-${CHILD}`)).toHaveTextContent(
      "completed"
    )
  })
})

describe("cancel request contract (R7.1, R7.6, R7.9, R7.10)", () => {
  it("addresses the cancel by child conversation id (R7.1)", async () => {
    mockCancel.mockResolvedValue(report())
    renderProbe()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1"))

    await userEvent.click(await screen.findByTestId(`cancel-${CHILD}`))
    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith(CHILD))
  })

  it("blocks a second cancel on the same row while one is in flight (R7.6)", async () => {
    let resolveCancel: ((r: DelegationTaskReport) => void) | null = null
    mockCancel.mockReturnValue(
      new Promise<DelegationTaskReport>((r) => {
        resolveCancel = r
      })
    )
    renderProbe()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1"))

    const button = await screen.findByTestId(`cancel-${CHILD}`)
    await userEvent.click(button)
    await waitFor(() =>
      expect(screen.getByTestId(`pending-${CHILD}`)).toHaveTextContent("yes")
    )
    await userEvent.click(button)
    await userEvent.click(button)

    // A double-click must not become three broker requests.
    expect(mockCancel).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCancel?.(report())
    })
  })

  it("treats a terminal report as ACCEPTED, not as an error (R7.9)", async () => {
    // Cancelling an already-finished task: the broker answers with that task's
    // existing terminal report. Reporting failure here is exactly the
    // double-click-manufactures-an-error bug.
    mockCancel.mockResolvedValue(report({ status: "completed" }))
    renderProbe()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1"))

    await userEvent.click(await screen.findByTestId(`cancel-${CHILD}`))

    await waitFor(() =>
      expect(screen.getByTestId(`pending-${CHILD}`)).toHaveTextContent("no")
    )
    expect(screen.getByTestId(`failed-${CHILD}`)).toHaveTextContent("no")
  })

  it("keeps the event-derived lifecycle after a TRANSPORT error (R7.10)", async () => {
    mockCancel.mockRejectedValue(new Error("offline"))
    renderProbe()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1"))

    await userEvent.click(await screen.findByTestId(`cancel-${CHILD}`))

    await waitFor(() =>
      expect(screen.getByTestId(`failed-${CHILD}`)).toHaveTextContent("yes")
    )
    expect(screen.getByTestId(`pending-${CHILD}`)).toHaveTextContent("no")
    // Crucially the row is untouched: a failed REQUEST says nothing about
    // whether the sub-agent is running, so claiming a terminal would be a lie.
    expect(screen.getByTestId(`lifecycle-${CHILD}`)).toHaveTextContent(
      "running"
    )
    // And a failed request must not silently masquerade as a reconciliation
    // trigger — there is no terminal report to reconcile against.
    expect(mockStatus).not.toHaveBeenCalled()
  })
})

describe("reconnect reconciliation (R7.12, R7.13)", () => {
  it("reads once per still-running row after a reconnect", async () => {
    renderProbe()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1", 901))
    dispatch(started("pt-2", 902))
    dispatch(started("pt-3", 903))
    dispatch(completedOkEvent("pt-3", 903))

    await waitFor(() =>
      expect(screen.getByTestId("lifecycle-903")).toHaveTextContent("completed")
    )
    expect(reconnectCallbacks.length).toBeGreaterThan(0)

    await act(async () => {
      for (const cb of reconnectCallbacks) cb()
    })

    // Exactly the two still-running rows, exactly once each. The already
    // terminal row is not re-read: it has nothing left to learn.
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(2))
    expect(mockStatus.mock.calls.map(([id]) => id).sort()).toEqual([901, 902])
  })

  it("registers ONE reconnect subscription however many consumers render", async () => {
    // The read count must be a property of the workspace, not of how many
    // panes are open: two panels behind one provider must not double the reads.
    render(
      <LiveObservabilityProviders>
        <Probe conversationId={1} />
        <Probe conversationId={1} />
      </LiveObservabilityProviders>
    )
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1", 901))

    await act(async () => {
      for (const cb of reconnectCallbacks) cb()
    })

    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1))
  })

  it("applies the authoritative terminal the stream never delivered (R7.13)", async () => {
    mockStatus.mockResolvedValue(report({ status: "canceled" }))
    renderProbe()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1"))

    await act(async () => {
      for (const cb of reconnectCallbacks) cb()
    })

    await waitFor(() =>
      expect(screen.getByTestId(`lifecycle-${CHILD}`)).toHaveTextContent(
        "canceled"
      )
    )
  })

  it("leaves a row running when the authoritative read says it still is", async () => {
    mockStatus.mockResolvedValue(report({ status: "running" }))
    renderProbe()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1"))

    await act(async () => {
      for (const cb of reconnectCallbacks) cb()
    })

    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId(`lifecycle-${CHILD}`)).toHaveTextContent(
      "running"
    )
  })

  it("ignores an `unknown` verdict rather than inventing a terminal", async () => {
    // `unknown` is what the broker answers when it cannot vouch for the task
    // (evicted from its completed cache, or an ownership mismatch). Treating
    // that as "finished" would report an outcome nobody observed.
    mockStatus.mockResolvedValue(report({ status: "unknown" }))
    renderProbe()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1"))

    await act(async () => {
      for (const cb of reconnectCallbacks) cb()
    })

    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId(`lifecycle-${CHILD}`)).toHaveTextContent(
      "running"
    )
  })

  it("survives a failing authoritative read without changing any row", async () => {
    mockStatus.mockRejectedValue(new Error("offline"))
    renderProbe()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(started("pt-1"))

    await act(async () => {
      for (const cb of reconnectCallbacks) cb()
    })

    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId(`lifecycle-${CHILD}`)).toHaveTextContent(
      "running"
    )
  })
})
