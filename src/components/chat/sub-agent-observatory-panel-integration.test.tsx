import { NextIntlClientProvider } from "next-intl"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SubAgentObservatoryPanel } from "./sub-agent-observatory-panel"
import { LiveObservabilityProviders } from "@/contexts/live-observability-providers"
import enMessages from "@/i18n/messages/en.json"
import type { EventEnvelope } from "@/lib/types"

/**
 * Panel ↔ chip ↔ providers, wired end-to-end except the physical event source.
 * The list body's own behaviour is covered by `sub-agent-observatory-panel.test`
 * with injected rows; what this file establishes is that opening the chip yields
 * a panel populated from the REAL projections and the REAL selector, and that
 * the silence clock keeps running with the panel shut.
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

let externalIdMap = new Map<string, number>()
vi.mock("@/stores/conversation-runtime-store", () => ({
  useConversationRuntimeStore: (selector: (s: unknown) => unknown) =>
    selector({ conversationIdByExternalId: externalIdMap }),
}))

// The actions provider inside `LiveObservabilityProviders` registers a reconnect
// backstop; stubbing it keeps this file off the web transport module. Its real
// behaviour lives in `observatory-actions-context.test.tsx`.
vi.mock("@/lib/platform", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform")
  return { ...actual, onTransportReconnect: () => () => {} }
})

const mockGetFolderConversation = vi.fn()
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api")
  return {
    ...actual,
    getFolderConversation: (...args: unknown[]) =>
      mockGetFolderConversation(...args),
  }
})

function dispatch(envelope: EventEnvelope) {
  if (capturedHandlers.length === 0) {
    throw new Error("no provider handler registered")
  }
  act(() => {
    for (const handler of capturedHandlers) handler(envelope)
  })
}

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
        content: [{ type: "text", text: "working on it" }],
      },
    },
  } as unknown as EventEnvelope
}

function renderPanel(conversationId: number | null = 1) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <LiveObservabilityProviders>
        <SubAgentObservatoryPanel conversationId={conversationId} />
      </LiveObservabilityProviders>
    </NextIntlClientProvider>
  )
}

const CHIP = "sub-agent-observatory-chip"
const PANEL = "sub-agent-observatory-panel"

beforeEach(() => {
  capturedHandlers = []
  externalIdMap = new Map()
  mockGetFolderConversation.mockReset()
  mockGetFolderConversation.mockResolvedValue({
    summary: { id: 900, folder_id: 7, agent_type: "codex" },
    turns: [],
  })
  vi.useRealTimers()
})

describe("SubAgentObservatoryPanel", () => {
  it("opens from the chip and lists the workspace's rows (R5.8, R6.1)", async () => {
    renderPanel(1)
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(delegationStarted("pt-1", 1))

    const chip = await screen.findByTestId(CHIP)
    expect(screen.queryByTestId(PANEL)).toBeNull()

    await userEvent.click(chip)

    const panel = await screen.findByTestId(PANEL)
    // Rows come from the real providers + real selector, not from fixtures.
    expect(await screen.findByTestId("observatory-row")).toBeTruthy()
    expect(panel).toBeTruthy()
  })

  it("reports its expanded state on the chip once a panel exists (R5.8)", async () => {
    renderPanel(1)
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(delegationStarted("pt-1", 1))

    const chip = await screen.findByTestId(CHIP)
    expect(chip).toHaveAttribute("aria-expanded", "false")

    await userEvent.click(chip)
    await waitFor(() => expect(chip).toHaveAttribute("aria-expanded", "true"))
  })

  it("closes again on a second activation, unmounting the list (R6.6)", async () => {
    renderPanel(1)
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(subagentFrame("task-tool-1"))
    await settle()

    const chip = await screen.findByTestId(CHIP)
    await userEvent.click(chip)
    await screen.findByTestId(PANEL)

    await userEvent.click(chip)

    // The body unmounting IS the stop-clock: its interval goes with it, leaving
    // only the chip's closed-cadence timer.
    await waitFor(() => expect(screen.queryByTestId(PANEL)).toBeNull())
    expect(screen.queryByTestId("observatory-list")).toBeNull()
  })

  it("advances the silence verdict while the panel is OPEN (R6.5)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPanel(1)
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(subagentFrame("task-tool-1"))
    await settle()

    await userEvent.click(await screen.findByTestId(CHIP))
    await screen.findByTestId(PANEL)
    // Fresh frame: the row is in the running section, not the quiet state.
    expect(
      screen.getByTestId("observatory-row-lifecycle").textContent
    ).not.toMatch(/No recent activity/i)

    // No further frames. Crossing the 15s threshold must flip the row with the
    // panel open and nothing else re-rendering.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })

    await waitFor(() => {
      expect(
        screen.getByTestId("observatory-row-lifecycle").textContent ?? ""
      ).toMatch(/No recent activity/i)
    })
    vi.useRealTimers()
  })

  it("keeps the chip's count ticking while the panel is CLOSED (R6.7)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPanel(1)
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))
    dispatch(subagentFrame("task-tool-1"))
    await settle()

    // Never opened: the chip's own instance owns the clock here.
    expect(
      await screen.findByTestId("sub-agent-observatory-activity")
    ).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })

    await waitFor(() => {
      expect(screen.queryByTestId("sub-agent-observatory-activity")).toBeNull()
    })
    expect(screen.getByTestId(CHIP)).toHaveTextContent("1")
    vi.useRealTimers()
  })

  it("renders nothing at all — chip or panel — with an empty observation set (R5.3)", async () => {
    renderPanel(1)
    await waitFor(() => expect(capturedHandlers.length).toBeGreaterThan(0))

    expect(screen.queryByTestId(CHIP)).toBeNull()
    expect(screen.queryByTestId(PANEL)).toBeNull()
  })
})
