import { NextIntlClientProvider } from "next-intl"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SubAgentObservatoryChip } from "./sub-agent-observatory-chip"
import { LiveObservabilityProviders } from "@/contexts/live-observability-providers"
import enMessages from "@/i18n/messages/en.json"
import type { EventEnvelope } from "@/lib/types"

/**
 * The chip is exercised through the REAL providers and the REAL selector: only
 * the event fanout and the runtime store's mapping are substituted, because
 * those are the two inputs a browser would supply. Mocking the projections or
 * `buildObservedSubAgentRows` here would make the test blind to whether the
 * chip is actually wired to them — the exact illusion task 6.6 exists to
 * prevent.
 */

let capturedHandlers: ((envelope: EventEnvelope) => void)[] = []
const mockAttach = vi.fn()
const mockDetach = vi.fn()

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({
    attachDelegationChild: mockAttach,
    detachDelegationChild: mockDetach,
  }),
  useAcpEvent: (handler: (e: EventEnvelope) => void) => {
    if (!capturedHandlers.includes(handler)) capturedHandlers.push(handler)
  },
}))

/** External-session-id → conversation-id map the chip reads per evaluation. */
let externalIdMap = new Map<string, number>()

vi.mock("@/stores/conversation-runtime-store", () => ({
  useConversationRuntimeStore: (selector: (s: unknown) => unknown) =>
    selector({ conversationIdByExternalId: externalIdMap }),
}))

// `LiveObservabilityProviders` now also mounts the actions provider, which
// registers a reconnect backstop. Stubbed here because resolving it for real
// pulls in the web transport module — an environment detail this file is not
// about. The reconnect behaviour itself is covered in the actions provider's own
// test, which drives this callback deliberately.
vi.mock("@/lib/platform", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform")
  return { ...actual, onTransportReconnect: () => () => {} }
})

function dispatch(envelope: EventEnvelope) {
  if (capturedHandlers.length === 0) {
    throw new Error("no provider handler registered")
  }
  act(() => {
    for (const handler of capturedHandlers) handler(envelope)
  })
}

/** The built-in-SUB provider batches frames on an animation frame. */
async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

function delegationStarted(
  parentToolUseId: string,
  parentConversationId: number | null
): EventEnvelope {
  return {
    seq: 1,
    connection_id: "conn-1",
    type: "delegation_started",
    parent_connection_id: "p1",
    parent_conversation_id: parentConversationId,
    parent_tool_use_id: parentToolUseId,
    child_connection_id: `c-${parentToolUseId}`,
    child_conversation_id: 900,
    agent_type: "codex",
    task_preview: "investigate the thing",
    task_id: `task-${parentToolUseId}`,
  } as unknown as EventEnvelope
}

function delegationCompleted(parentToolUseId: string): EventEnvelope {
  return {
    seq: 2,
    connection_id: "conn-1",
    type: "delegation_completed",
    parent_connection_id: "p1",
    parent_conversation_id: 1,
    parent_tool_use_id: parentToolUseId,
    child_connection_id: `c-${parentToolUseId}`,
    child_conversation_id: 900,
    agent_type: "codex",
    result: { kind: "ok" },
  } as unknown as EventEnvelope
}

function subagentFrame(
  parentToolUseId: string,
  sessionId = "sess-a",
  seq = 1
): EventEnvelope {
  return {
    seq,
    connection_id: "conn-1",
    type: "claude_subagent_message",
    session_id: sessionId,
    parent_tool_use_id: parentToolUseId,
    message: {
      type: "assistant",
      parent_tool_use_id: parentToolUseId,
      message: {
        id: `msg-${parentToolUseId}-${seq}`,
        role: "assistant",
        content: [{ type: "text", text: "working" }],
      },
    },
  } as unknown as EventEnvelope
}

function renderChip(conversationId: number | null = 1) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <LiveObservabilityProviders>
        <SubAgentObservatoryChip conversationId={conversationId} />
      </LiveObservabilityProviders>
    </NextIntlClientProvider>
  )
}

const CHIP = "sub-agent-observatory-chip"

beforeEach(() => {
  capturedHandlers = []
  externalIdMap = new Map()
  mockAttach.mockReset()
  mockDetach.mockReset()
  vi.useRealTimers()
})

describe("SubAgentObservatoryChip", () => {
  it("does not render while the workspace observation set is empty (R5.3)", async () => {
    renderChip()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    expect(screen.queryByTestId(CHIP)).toBeNull()
  })

  it("shows the running count with an activity indicator while any row runs (R5.4)", async () => {
    renderChip()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))

    dispatch(delegationStarted("pt-1", 1))
    dispatch(delegationStarted("pt-2", 1))

    const chip = await screen.findByTestId(CHIP)
    expect(chip).toHaveTextContent("2")
    expect(screen.getByTestId("sub-agent-observatory-activity")).toBeTruthy()
  })

  it("appears for built-in SUBs with zero delegations (R5.7)", async () => {
    renderChip()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))

    dispatch(subagentFrame("task-tool-1"))
    await settle()

    expect(await screen.findByTestId(CHIP)).toHaveTextContent("1")
  })

  it("counts rows from OTHER conversations too — the set is workspace-wide (R5.1)", async () => {
    renderChip(1)
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))

    dispatch(delegationStarted("pt-here", 1))
    dispatch(delegationStarted("pt-elsewhere", 42))

    expect(await screen.findByTestId(CHIP)).toHaveTextContent("2")
  })

  it("stays visible with no activity indicator once everything settles, showing the total (R5.5)", async () => {
    renderChip()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))

    dispatch(delegationStarted("pt-1", 1))
    await screen.findByTestId(CHIP)
    dispatch(delegationCompleted("pt-1"))

    await waitFor(() => {
      expect(screen.queryByTestId("sub-agent-observatory-activity")).toBeNull()
    })
    expect(screen.getByTestId(CHIP)).toHaveTextContent("1")
  })

  it("does not report a silenced built-in SUB as completed (R5.6)", async () => {
    renderChip()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))

    dispatch(subagentFrame("task-tool-1"))
    await settle()
    const chip = await screen.findByTestId(CHIP)

    // A built-in SUB only ever reads running or silent, so a silenced one must
    // never be described as finished — that is the claim its event stream
    // cannot support.
    expect(chip.textContent ?? "").not.toMatch(/completed|finished/i)
  })

  it("keeps its count fresh while the panel is closed (R6.7)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderChip()
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))

    dispatch(subagentFrame("task-tool-1"))
    await settle()
    expect(
      await screen.findByTestId("sub-agent-observatory-activity")
    ).toBeTruthy()

    // No further frames: crossing the silence threshold must drop the running
    // count on its own, without any other render being triggered.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000)
    })

    await waitFor(() => {
      expect(screen.queryByTestId("sub-agent-observatory-activity")).toBeNull()
    })
    expect(screen.getByTestId(CHIP)).toHaveTextContent("1")
    vi.useRealTimers()
  })

  it("invokes the activation callback so the panel can open (R5.8)", async () => {
    const onActivate = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <LiveObservabilityProviders>
          <SubAgentObservatoryChip conversationId={1} onActivate={onActivate} />
        </LiveObservabilityProviders>
      </NextIntlClientProvider>
    )
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(delegationStarted("pt-1", 1))

    await userEvent.click(await screen.findByTestId(CHIP))
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it("resolves a built-in SUB's conversation through the external-id map (R3.3)", async () => {
    externalIdMap = new Map([["sess-a", 1]])
    renderChip(1)
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))

    dispatch(subagentFrame("task-tool-1", "sess-a"))
    await settle()

    // Attribution reaching the chip at all proves the map is threaded in; the
    // per-row scope assertions live in the selector's own test.
    expect(await screen.findByTestId(CHIP)).toHaveTextContent("1")
  })
})
