import { act, render } from "@testing-library/react"
import { useEffect } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  MAX_TRACKED_SUBAGENTS,
  SubagentTranscriptProvider,
  useSubagentTranscriptStore,
} from "@/contexts/subagent-transcript-context"
import type { SubagentTrackedEntry } from "@/lib/subagent-transcript"
import type { EventEnvelope } from "@/lib/types"

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

/** The provider batches on an animation frame; wait one before asserting. */
async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
  })
}

function subagentEvent(
  parentToolUseId: string,
  text: string,
  sessionId = "sess-1",
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
        content: [{ type: "text", text }],
      },
    },
  } as unknown as EventEnvelope
}

/** Reads the projection through the store api (not a per-id subscription).
 *  Held in one mutable object rather than reassigned module bindings, which the
 *  react-compiler lint rule forbids inside a component. */
const probe: {
  entries: (() => readonly SubagentTrackedEntry[]) | null
  evicted: (() => number) | null
} = { entries: null, evicted: null }

function ProjectionProbe() {
  const store = useSubagentTranscriptStore()
  // Capture in an effect, not during render: mutating outer state while
  // rendering is what the react-compiler rule forbids.
  useEffect(() => {
    probe.entries = () => store.listEntries()
    probe.evicted = () => store.getEvictedCount()
  }, [store])
  const entries = store.listEntries()
  return (
    <div>
      <div data-testid="count">{entries.length}</div>
      <div data-testid="ids">
        {entries.map((e) => e.parentToolUseId).join(",")}
      </div>
      <div data-testid="sessions">
        {entries
          .map((e) => `${e.parentToolUseId}:${e.sessionId ?? "-"}`)
          .join(",")}
      </div>
      <div data-testid="evicted">{store.getEvictedCount()}</div>
    </div>
  )
}

/** Non-null accessors so each test reads the live projection. */
function readEntries(): readonly SubagentTrackedEntry[] {
  if (!probe.entries) throw new Error("probe not mounted")
  return probe.entries()
}
function readEvicted(): number {
  if (!probe.evicted) throw new Error("probe not mounted")
  return probe.evicted()
}

beforeEach(() => {
  capturedHandler = null
  probe.entries = null
  probe.evicted = null
})

describe("SubagentTranscriptProvider read-only projection", () => {
  it("projection_lists_every_tracked_entry_with_its_frames", async () => {
    render(
      <SubagentTranscriptProvider>
        <ProjectionProbe />
      </SubagentTranscriptProvider>
    )

    dispatch(subagentEvent("toolu_A", "A works", "sess-1", 1))
    dispatch(subagentEvent("toolu_B", "B works", "sess-2", 2))
    await settle()

    // R3.1 �?the projection covers all tracked entries, not one lookup.
    const entries = readEntries()
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.parentToolUseId).sort()).toEqual([
      "toolu_A",
      "toolu_B",
    ])
    for (const entry of entries) {
      expect(entry.frames.length).toBe(1)
    }
  })

  it("projection_retains_the_events_session_id_per_entry", async () => {
    render(
      <SubagentTranscriptProvider>
        <ProjectionProbe />
      </SubagentTranscriptProvider>
    )

    dispatch(subagentEvent("toolu_A", "A works", "sess-alpha", 1))
    dispatch(subagentEvent("toolu_B", "B works", "sess-beta", 2))
    await settle()

    // R3.2 �?session_id is on the envelope today but discarded; the selector
    // needs it to resolve conversation attribution.
    const byId = new Map(readEntries().map((e) => [e.parentToolUseId, e]))
    expect(byId.get("toolu_A")!.sessionId).toBe("sess-alpha")
    expect(byId.get("toolu_B")!.sessionId).toBe("sess-beta")
  })

  it("projection_records_a_last_frame_timestamp_that_advances_per_frame", async () => {
    const nowSpy = vi.spyOn(Date, "now")
    try {
      nowSpy.mockReturnValue(1_000)
      render(
        <SubagentTranscriptProvider>
          <ProjectionProbe />
        </SubagentTranscriptProvider>
      )
      dispatch(subagentEvent("toolu_A", "first", "sess-1", 1))
      await settle()
      const first = readEntries()[0]!.lastFrameAt
      expect(first).toBe(1_000)

      nowSpy.mockReturnValue(9_500)
      dispatch(subagentEvent("toolu_A", "second", "sess-1", 2))
      await settle()
      // R3.10 �?the silence check compares this against `now`, so it has to
      // move forward on each accepted frame.
      expect(readEntries()[0]!.lastFrameAt).toBe(9_500)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("evicted_count_is_zero_until_the_cap_is_exceeded_then_increments", async () => {
    render(
      <SubagentTranscriptProvider>
        <ProjectionProbe />
      </SubagentTranscriptProvider>
    )

    for (let i = 0; i < MAX_TRACKED_SUBAGENTS; i += 1) {
      dispatch(subagentEvent(`toolu_${i}`, `work ${i}`, "sess-1", i + 1))
    }
    await settle()
    expect(readEntries()).toHaveLength(MAX_TRACKED_SUBAGENTS)
    expect(readEvicted()).toBe(0)

    dispatch(subagentEvent("toolu_over_1", "overflow 1", "sess-1", 1_001))
    dispatch(subagentEvent("toolu_over_2", "overflow 2", "sess-1", 1_002))
    await settle()

    // R3.6 / R3.7 �?oldest-first eviction, and a cumulative counter so the
    // panel can say "earlier entries are no longer retained".
    expect(readEntries()).toHaveLength(MAX_TRACKED_SUBAGENTS)
    expect(readEvicted()).toBe(2)
    const ids = readEntries().map((e) => e.parentToolUseId)
    expect(ids).not.toContain("toolu_0")
    expect(ids).not.toContain("toolu_1")
    expect(ids).toContain("toolu_over_2")
  })

  it("evicted_count_is_cumulative_across_the_provider_lifetime", async () => {
    render(
      <SubagentTranscriptProvider>
        <ProjectionProbe />
      </SubagentTranscriptProvider>
    )
    for (let i = 0; i < MAX_TRACKED_SUBAGENTS + 5; i += 1) {
      dispatch(subagentEvent(`toolu_${i}`, `work ${i}`, "sess-1", i + 1))
      // Flush per event so eviction happens across several batches �?the
      // counter must accumulate, not reflect only the last flush.
      await settle()
    }
    // R3.7 �?scope is the workspace (provider) lifetime, never per session.
    // Read through the store api: this store is ref-backed by design (see the
    // provider's module doc �?provider-level state would re-render the whole
    // message subtree per frame), so the count is pulled at evaluation time
    // rather than pushed into a render. The panel re-evaluates on an interval
    // (R6.5-R6.7), which is where it observes this.
    expect(readEvicted()).toBe(5)
  })

  it("provider_does_not_resolve_conversation_attribution_itself", async () => {
    render(
      <SubagentTranscriptProvider>
        <ProjectionProbe />
      </SubagentTranscriptProvider>
    )
    dispatch(subagentEvent("toolu_A", "A works", "sess-late", 1))
    await settle()

    // B8 / R3.3 �?the raw session_id is stored; a derived conversationId must
    // NOT be baked in here, or an entry whose mapping arrives later would be
    // stranded as unattributed forever.
    const entry = readEntries()[0]! as unknown as Record<string, unknown>
    expect(entry.sessionId).toBe("sess-late")
    expect("conversationId" in entry).toBe(false)
  })
})
