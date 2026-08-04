import { act, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  DELEGATION_BINDING_CAP,
  DelegationProvider,
  useDelegation,
} from "@/contexts/delegation-context"
import type { EventEnvelope } from "@/lib/types"

let capturedHandler: ((envelope: EventEnvelope) => void) | null = null

const mockAttach = vi.fn()
const mockDetach = vi.fn()

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({
    attachDelegationChild: mockAttach,
    detachDelegationChild: mockDetach,
  }),
  useAcpEvent: (handler: (e: EventEnvelope) => void) => {
    capturedHandler = handler
  },
}))

/** Serializes the whole projection so tests can assert on membership,
 *  ordering and per-entry fields without any UI component. */
function ProjectionProbe() {
  const { listBindings } = useDelegation()
  const bindings = listBindings()
  return (
    <div>
      <div data-testid="count">{bindings.length}</div>
      <div data-testid="ids">
        {bindings.map((b) => b.parentToolUseId).join(",")}
      </div>
      <div data-testid="statuses">
        {bindings.map((b) => `${b.parentToolUseId}:${b.status}`).join(",")}
      </div>
      <div data-testid="parent-convs">
        {bindings
          .map((b) => `${b.parentToolUseId}:${b.parentConversationId ?? "-"}`)
          .join(",")}
      </div>
      <div data-testid="error-codes">
        {bindings
          .map((b) => `${b.parentToolUseId}:${b.errorCode ?? "-"}`)
          .join(",")}
      </div>
    </div>
  )
}

async function awaitHandlerCaptured() {
  await waitFor(() => expect(capturedHandler).not.toBeNull())
}

function dispatch(envelope: EventEnvelope) {
  if (!capturedHandler) throw new Error("provider handler not registered")
  act(() => {
    capturedHandler!(envelope)
  })
}

function started(
  parentToolUseId: string,
  overrides: Record<string, unknown> = {}
): EventEnvelope {
  return {
    type: "delegation_started",
    parent_connection_id: "p1",
    parent_tool_use_id: parentToolUseId,
    child_connection_id: `c-${parentToolUseId}`,
    child_conversation_id: 100,
    agent_type: "codex",
    task_id: `task-${parentToolUseId}`,
    ...overrides,
  } as unknown as EventEnvelope
}

function completed(
  parentToolUseId: string,
  result: Record<string, unknown> = { kind: "ok", duration_ms: 1 }
): EventEnvelope {
  return {
    type: "delegation_completed",
    parent_connection_id: "p1",
    parent_tool_use_id: parentToolUseId,
    child_connection_id: `c-${parentToolUseId}`,
    child_conversation_id: 100,
    agent_type: "codex",
    result,
  } as unknown as EventEnvelope
}

/**
 * `delegation_session_update` — the terminal announcement for a CONTINUED
 * round (turn_version > 1), which the broker sends INSTEAD of a second
 * `delegation_completed` (Requirement 2.8a). It is session-addressed, and it
 * carries the settled turn's real outcome, so the consumer never has to guess
 * one. Default here is the CANCEL shape, because that is the outcome the
 * consumer used to report as a success.
 */
function sessionUpdate(
  taskId: string,
  result: Record<string, unknown> = { kind: "err", error_code: "canceled" },
  overrides: Record<string, unknown> = {}
): EventEnvelope {
  return {
    type: "delegation_session_update",
    parent_connection_id: "p1",
    child_conversation_id: 100,
    task_id: taskId,
    turn_id: "turn-2",
    turn_version: 2,
    origin: "user",
    result,
    ...overrides,
  } as unknown as EventEnvelope
}

describe("DelegationProvider read-only projection", () => {
  beforeEach(() => {
    capturedHandler = null
    mockAttach.mockReset()
    mockDetach.mockReset()
  })

  it("projection_lists_every_binding_including_terminal_ones", async () => {
    render(
      <DelegationProvider>
        <ProjectionProbe />
      </DelegationProvider>
    )
    await awaitHandlerCaptured()

    dispatch(started("pt-1"))
    dispatch(started("pt-2"))
    dispatch(started("pt-3"))
    expect(screen.getByTestId("count").textContent).toBe("3")

    dispatch(completed("pt-2"))
    dispatch(completed("pt-3", { kind: "err", error_code: "timeout" }))

    // R2.1 / R2.2 — terminal entries stay visible in the projection.
    expect(screen.getByTestId("count").textContent).toBe("3")
    expect(screen.getByTestId("statuses").textContent).toBe(
      "pt-1:running,pt-2:ok,pt-3:err"
    )
  })

  it("delegation_completed_flips_status_without_removing_the_entry", async () => {
    render(
      <DelegationProvider>
        <ProjectionProbe />
      </DelegationProvider>
    )
    await awaitHandlerCaptured()

    dispatch(started("pt-1"))
    expect(screen.getByTestId("statuses").textContent).toBe("pt-1:running")
    dispatch(completed("pt-1", { kind: "err", error_code: "canceled" }))
    // R2.4 — the entry is updated in place; the projection never shrinks here.
    expect(screen.getByTestId("count").textContent).toBe("1")
    expect(screen.getByTestId("statuses").textContent).toBe("pt-1:err")
  })

  it("projection_carries_parent_conversation_id_from_the_started_event", async () => {
    render(
      <DelegationProvider>
        <ProjectionProbe />
      </DelegationProvider>
    )
    await awaitHandlerCaptured()

    dispatch(started("pt-1", { parent_conversation_id: 42 }))
    // R2.7 — retained on the binding, indistinguishable from a seeded one.
    expect(screen.getByTestId("parent-convs").textContent).toBe("pt-1:42")
  })

  it("absent_parent_conversation_id_stays_absent_and_is_not_guessed", async () => {
    render(
      <DelegationProvider>
        <ProjectionProbe />
      </DelegationProvider>
    )
    await awaitHandlerCaptured()

    // R2.8 — an older backend omits the field; the binding must not invent one
    // (e.g. from child_conversation_id, which is a DIFFERENT conversation).
    dispatch(started("pt-1"))
    expect(screen.getByTestId("parent-convs").textContent).toBe("pt-1:-")
  })

  it("cap_evicts_the_oldest_terminal_entry_by_terminal_arrival_time", async () => {
    render(
      <DelegationProvider>
        <ProjectionProbe />
      </DelegationProvider>
    )
    await awaitHandlerCaptured()

    // Fill to exactly the cap, all terminal, then settle them in an order
    // that DIFFERS from insertion order so the test distinguishes
    // "oldest inserted" from "oldest settled" (the AC says settled).
    for (let i = 0; i < DELEGATION_BINDING_CAP; i += 1) {
      dispatch(started(`pt-${i}`))
    }
    expect(screen.getByTestId("count").textContent).toBe(
      String(DELEGATION_BINDING_CAP)
    )
    // Settle #5 FIRST, then #0..#4 and the rest.
    dispatch(completed("pt-5"))
    for (let i = 0; i < DELEGATION_BINDING_CAP; i += 1) {
      if (i !== 5) dispatch(completed(`pt-${i}`))
    }

    dispatch(started("pt-overflow"))
    expect(screen.getByTestId("count").textContent).toBe(
      String(DELEGATION_BINDING_CAP)
    )
    const ids = screen.getByTestId("ids").textContent!.split(",")
    // R2.12 — the entry that reached its terminal state FIRST is evicted.
    expect(ids).not.toContain("pt-5")
    expect(ids).toContain("pt-0")
    expect(ids).toContain("pt-overflow")
  })

  it("cap_never_evicts_a_running_entry_even_when_over_the_cap", async () => {
    render(
      <DelegationProvider>
        <ProjectionProbe />
      </DelegationProvider>
    )
    await awaitHandlerCaptured()

    // Every entry running → nothing is evictable, so the projection is
    // allowed to exceed the cap rather than drop a live delegation (R2.13).
    for (let i = 0; i < DELEGATION_BINDING_CAP + 3; i += 1) {
      dispatch(started(`pt-${i}`))
    }
    expect(screen.getByTestId("count").textContent).toBe(
      String(DELEGATION_BINDING_CAP + 3)
    )
    const statuses = screen.getByTestId("statuses").textContent!
    expect(statuses.includes("pt-0:running")).toBe(true)
  })

  it("cap_evicts_only_terminal_entries_when_the_map_is_mixed", async () => {
    render(
      <DelegationProvider>
        <ProjectionProbe />
      </DelegationProvider>
    )
    await awaitHandlerCaptured()

    // First two run forever; the rest settle. Overflow must take a settled
    // one, never one of the two runners.
    for (let i = 0; i < DELEGATION_BINDING_CAP; i += 1) {
      dispatch(started(`pt-${i}`))
    }
    for (let i = 2; i < DELEGATION_BINDING_CAP; i += 1) {
      dispatch(completed(`pt-${i}`))
    }
    dispatch(started("pt-overflow"))

    const ids = screen.getByTestId("ids").textContent!.split(",")
    expect(ids).toHaveLength(DELEGATION_BINDING_CAP)
    expect(ids).toContain("pt-0")
    expect(ids).toContain("pt-1")
    expect(ids).not.toContain("pt-2")
  })
})

/**
 * A CONTINUED round's terminal arrives as `delegation_session_update`, and it
 * is the terminal for EVERY outcome of that round — natural settle
 * (`broker.rs` complete_call) and cancel/failure alike
 * (`teardown_canceled_child`, whose `turn_version > 1` arm emits this event
 * instead of a completion).
 *
 * The consumer therefore must not derive the outcome from the fact that the
 * event arrived: doing so reported a canceled or failed continuation as
 * "completed", and — because a wrong terminal is still terminal — the
 * reconciliation read could not correct it afterwards
 * (`applyAuthoritativeStatus` only moves bindings that are still running).
 * The event carries the settled turn's real result, so the binding mirrors it.
 */
describe("continued-round terminal (delegation_session_update)", () => {
  beforeEach(() => {
    capturedHandler = null
    mockAttach.mockReset()
    mockDetach.mockReset()
  })

  function renderProjection() {
    return render(
      <DelegationProvider>
        <ProjectionProbe />
      </DelegationProvider>
    )
  }

  it("a_canceled_continued_round_shows_canceled_not_completed", async () => {
    renderProjection()
    await awaitHandlerCaptured()

    dispatch(started("pt-1"))
    // The continuation re-announces its start (broker.rs:5572) before settling.
    dispatch(started("pt-1"))
    dispatch(
      sessionUpdate("task-pt-1", { kind: "err", error_code: "canceled" })
    )

    expect(screen.getByTestId("statuses").textContent).toBe("pt-1:err")
    // The stable `canceled` code is what the selector reads to render "canceled"
    // rather than a generic failure.
    expect(screen.getByTestId("error-codes").textContent).toBe("pt-1:canceled")
  })

  it("a_failed_continued_round_shows_failed", async () => {
    renderProjection()
    await awaitHandlerCaptured()

    dispatch(started("pt-1"))
    dispatch(sessionUpdate("task-pt-1", { kind: "err", error_code: "timeout" }))

    expect(screen.getByTestId("statuses").textContent).toBe("pt-1:err")
    expect(screen.getByTestId("error-codes").textContent).toBe("pt-1:timeout")
  })

  it("a_successful_continued_round_still_shows_completed", async () => {
    renderProjection()
    await awaitHandlerCaptured()

    dispatch(started("pt-1"))
    dispatch(sessionUpdate("task-pt-1", { kind: "ok", duration_ms: 12 }))

    expect(screen.getByTestId("statuses").textContent).toBe("pt-1:ok")
    expect(screen.getByTestId("error-codes").textContent).toBe("pt-1:-")
  })

  it("settles_the_row_so_a_re_announced_start_cannot_leave_it_running_forever", async () => {
    // The regression the old unconditional flip-to-ok existed to prevent: a
    // continuation re-announces `delegation_started`, which resets the row to
    // running. SOMETHING terminal must land afterwards, or the row spins
    // forever. Consuming the update settles it — now with the true outcome.
    renderProjection()
    await awaitHandlerCaptured()

    dispatch(started("pt-1"))
    dispatch(completed("pt-1"))
    expect(screen.getByTestId("statuses").textContent).toBe("pt-1:ok")

    // Continuation dispatched: the row legitimately goes back to running.
    dispatch(started("pt-1"))
    expect(screen.getByTestId("statuses").textContent).toBe("pt-1:running")

    // ...and settles again on the continued round's terminal.
    dispatch(sessionUpdate("task-pt-1", { kind: "ok", duration_ms: 3 }))
    expect(screen.getByTestId("statuses").textContent).toBe("pt-1:ok")
  })

  it("matches_the_binding_by_child_conversation_id_when_the_task_id_is_absent", async () => {
    // Older backend / a binding seeded without a task id: the event is still
    // child-addressed, so the fallback match must keep working.
    renderProjection()
    await awaitHandlerCaptured()

    dispatch(started("pt-1", { task_id: undefined }))
    dispatch(
      sessionUpdate("task-unrelated", { kind: "err", error_code: "canceled" })
    )

    expect(screen.getByTestId("statuses").textContent).toBe("pt-1:err")
    expect(screen.getByTestId("error-codes").textContent).toBe("pt-1:canceled")
  })

  it("an_update_with_no_result_leaves_the_row_running_for_reconciliation", async () => {
    // Older backend that predates the outcome field: guessing is exactly the
    // defect, so the row stays running and the authoritative read supplies the
    // terminal (R7.13) rather than the consumer inventing one.
    renderProjection()
    await awaitHandlerCaptured()

    dispatch(started("pt-1"))
    // Built without the field at all — a default parameter would substitute
    // one and make this assertion vacuous.
    dispatch({
      type: "delegation_session_update",
      parent_connection_id: "p1",
      child_conversation_id: 100,
      task_id: "task-pt-1",
      turn_id: "turn-2",
      turn_version: 2,
      origin: "user",
    } as unknown as EventEnvelope)

    expect(screen.getByTestId("statuses").textContent).toBe("pt-1:running")
  })
})
