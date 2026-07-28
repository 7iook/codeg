import { act, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  SubagentTranscriptProvider,
  useSubagentFrames,
} from "@/contexts/subagent-transcript-context"
import {
  buildSubagentTranscriptView,
  subagentFrameKey,
} from "@/lib/subagent-transcript"
import type { EventEnvelope } from "@/lib/types"

// The provider registers its handler through the connections-provider fanout
// (`useAcpEvent`), exactly like DelegationProvider. Capture it so each test can
// drive synthetic envelopes without mounting the whole ACP tree.
let capturedHandler: ((envelope: EventEnvelope) => void) | null = null

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpEvent: (handler: (e: EventEnvelope) => void) => {
    capturedHandler = handler
  },
}))

function dispatch(envelope: EventEnvelope) {
  if (!capturedHandler) throw new Error("provider handler not registered")
  act(() => {
    capturedHandler!(envelope)
  })
}

/** The provider batches frames on an animation frame (design card §3.4 #4 — no
 *  per-event dispatch), so tests wait one frame before asserting. */
async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
  })
}

function subagentEvent(
  parentToolUseId: string,
  message: unknown,
  seq = 1
): EventEnvelope {
  return {
    seq,
    connection_id: "conn-1",
    type: "claude_subagent_message",
    session_id: "sess-1",
    parent_tool_use_id: parentToolUseId,
    message,
  }
}

function assistantText(id: string, text: string) {
  return {
    type: "assistant",
    parent_tool_use_id: "toolu_parent",
    message: { id, role: "assistant", content: [{ type: "text", text }] },
  }
}

/** Renders the frame count + rendered text for one parent tool-use id. */
function Probe({ id }: { id: string }) {
  const frames = useSubagentFrames(id)
  const view = buildSubagentTranscriptView(frames ?? [])
  return (
    <div>
      <div data-testid={`count-${id}`}>{frames?.length ?? 0}</div>
      <div data-testid={`text-${id}`}>
        {view.blocks
          .map((b) => (b.type === "text" ? b.text : ""))
          .filter(Boolean)
          .join("|")}
      </div>
      <div data-testid={`msgs-${id}`}>{view.messageCount}</div>
      <div data-testid={`tools-${id}`}>{view.toolCount}</div>
    </div>
  )
}

beforeEach(() => {
  capturedHandler = null
})

describe("built-in sub-agent live transcript", () => {
  it("subagent_message_is_grouped_under_parent_tool_call", async () => {
    render(
      <SubagentTranscriptProvider>
        <Probe id="toolu_A" />
        <Probe id="toolu_B" />
      </SubagentTranscriptProvider>
    )

    dispatch(
      subagentEvent(
        "toolu_A",
        {
          type: "assistant",
          parent_tool_use_id: "toolu_A",
          message: {
            id: "msg_a1",
            role: "assistant",
            content: [{ type: "text", text: "A is working" }],
          },
        },
        1
      )
    )
    dispatch(
      subagentEvent(
        "toolu_B",
        {
          type: "assistant",
          parent_tool_use_id: "toolu_B",
          message: {
            id: "msg_b1",
            role: "assistant",
            content: [{ type: "text", text: "B is working" }],
          },
        },
        2
      )
    )

    await settle()

    // Each frame lands under ITS OWN parent tool-use id — never cross-filed.
    expect(screen.getByTestId("text-toolu_A").textContent).toBe("A is working")
    expect(screen.getByTestId("text-toolu_B").textContent).toBe("B is working")
    expect(screen.getByTestId("count-toolu_A").textContent).toBe("1")
    expect(screen.getByTestId("count-toolu_B").textContent).toBe("1")
  })

  it("subagent_messages_do_not_enter_parent_message_stream", async () => {
    // Invariant 2: a subagent frame is consumed ONLY by this store. The
    // connections reducer must never see it as parent content — which here
    // means the store keys strictly by parent_tool_use_id and an unrelated
    // capsule (a different tool call in the same turn) stays empty.
    render(
      <SubagentTranscriptProvider>
        <Probe id="toolu_sub" />
        <Probe id="toolu_other_tool" />
      </SubagentTranscriptProvider>
    )

    dispatch(subagentEvent("toolu_sub", assistantText("msg_1", "secret work")))
    await settle()

    expect(screen.getByTestId("text-toolu_sub").textContent).toBe("secret work")
    expect(screen.getByTestId("count-toolu_other_tool").textContent).toBe("0")
    expect(screen.getByTestId("text-toolu_other_tool").textContent).toBe("")
  })

  it("dedupe_key_distinguishes_frames_sharing_message_id", async () => {
    // Measured on real transcripts: ONE `message.id` spans MULTIPLE frames.
    // Keying on message.id alone would swallow the later frames.
    const first = {
      type: "assistant",
      parent_tool_use_id: "toolu_A",
      message: {
        id: "msg_same",
        role: "assistant",
        content: [{ type: "text", text: "first half" }],
      },
    }
    const second = {
      type: "assistant",
      parent_tool_use_id: "toolu_A",
      message: {
        id: "msg_same",
        role: "assistant",
        content: [{ type: "text", text: "second half" }],
      },
    }

    const k1 = subagentFrameKey("toolu_A", first)
    const k2 = subagentFrameKey("toolu_A", second)
    expect(k1).toBeTruthy()
    expect(k2).toBeTruthy()
    expect(k2).not.toBe(k1)
    // A genuine redelivery of the SAME frame still collapses.
    expect(subagentFrameKey("toolu_A", { ...first })).toBe(k1)

    render(
      <SubagentTranscriptProvider>
        <Probe id="toolu_A" />
      </SubagentTranscriptProvider>
    )
    dispatch(subagentEvent("toolu_A", first, 1))
    dispatch(subagentEvent("toolu_A", second, 2))
    dispatch(subagentEvent("toolu_A", { ...first }, 3)) // duplicate delivery
    await settle()

    expect(screen.getByTestId("count-toolu_A").textContent).toBe("2")
    expect(screen.getByTestId("text-toolu_A").textContent).toBe(
      "first half|second half"
    )
  })
})
