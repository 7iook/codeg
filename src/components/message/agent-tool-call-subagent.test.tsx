import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { AgentToolCallPart } from "./agent-tool-call"
import { SubagentTranscriptProvider } from "@/contexts/subagent-transcript-context"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import type { EventEnvelope } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

// Wired end-to-end EXCEPT the physical event source: the capsule reads the
// provider, the provider reads the same `useAcpEvent` fanout the real
// connections provider drives. Everything between the envelope and the pixels
// is the production path — the point of this file is that the last hop actually
// exists (a green unit test for the store would not prove the capsule mounts
// it).
let capturedHandler: ((envelope: EventEnvelope) => void) | null = null

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpEvent: (handler: (e: EventEnvelope) => void) => {
    capturedHandler = handler
  },
}))

type ToolCallPart = Extract<AdaptedContentPart, { type: "tool-call" }>

function taskPart(state: ToolCallPart["state"]): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId: "toolu_task_1",
    toolName: "agent",
    input: JSON.stringify({
      subagent_type: "general-purpose",
      description: "compare CLI versions",
    }),
    state,
  }
}

function renderCapsule(part: ToolCallPart) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SubagentTranscriptProvider>
        <AgentToolCallPart
          part={part}
          renderToolCall={(p, key) => (
            <div key={key} data-testid="inline-tool">
              {p.toolName}
            </div>
          )}
        />
      </SubagentTranscriptProvider>
    </NextIntlClientProvider>
  )
}

async function emit(message: unknown, seq = 1) {
  if (!capturedHandler) throw new Error("provider handler not registered")
  act(() => {
    capturedHandler!({
      seq,
      connection_id: "conn-1",
      type: "claude_subagent_message",
      session_id: "sess-1",
      parent_tool_use_id: "toolu_task_1",
      message,
    })
  })
  // The provider batches on an animation frame (no per-event dispatch).
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

beforeEach(() => {
  capturedHandler = null
})

describe("AgentToolCallPart built-in sub-agent transcript", () => {
  it("renders the live transcript inside the capsule body, read-only", async () => {
    renderCapsule(taskPart("input-available"))

    await emit({
      type: "assistant",
      parent_tool_use_id: "toolu_task_1",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [
          { type: "text", text: "Checking the three CLIs." },
          {
            type: "tool_use",
            id: "toolu_child_read",
            name: "Read",
            input: { file_path: "package.json" },
          },
        ],
      },
    })

    // Process-size badge on the collapsed pill tells the user there is
    // something inside worth opening.
    expect(screen.getByText("1 msg · 1 tools")).toBeInTheDocument()
    // Activity tail: one line, while running.
    expect(screen.getByTestId("subagent-activity-tail")).toBeInTheDocument()

    // Expand → prose + the inline tool call, rendered through the injected
    // parent renderer (never a second tool renderer).
    fireEvent.click(screen.getByRole("button", { name: "Running" }))
    expect(screen.getByTestId("subagent-transcript")).toBeInTheDocument()
    expect(screen.getByText("Checking the three CLIs.")).toBeInTheDocument()
    expect(screen.getByTestId("inline-tool").textContent).toBe("Read")

    // Read-only capability declaration present; no way to talk to it.
    expect(screen.getByText("Read-only")).toBeInTheDocument()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    for (const label of [
      /reply/i,
      /send/i,
      /cancel/i,
      /stop/i,
      /open in tab/i,
    ]) {
      expect(
        screen.queryByRole("button", { name: label })
      ).not.toBeInTheDocument()
    }
  })

  it("degrades to today's capsule when no live frames exist (historical turn)", () => {
    // E-3: `forwardSubagentText` only applies to sessions started after it was
    // enabled, so most historical turns carry no frames at all. The correct
    // rendering is the existing bare pill — NOT an invented "no data" card.
    renderCapsule({ ...taskPart("output-available"), output: null })

    expect(screen.queryByTestId("subagent-transcript")).not.toBeInTheDocument()
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument()
    expect(screen.queryByText(/msg ·/)).not.toBeInTheDocument()
    // Bodyless → bare pill, no expand affordance.
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(
      screen.getByText("general-purpose: compare CLI versions")
    ).toBeInTheDocument()
  })
})
