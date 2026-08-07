import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Wiring gates for mid-turn steering. The behavioral tests live next to their
 * units (`steering-queue.test.ts`, `use-message-queue.test.ts`,
 * `message-queue-display.test.tsx`); those all pass while the pieces sit
 * unreferenced by the production panel, which is the "built but not wired"
 * failure. These assertions read the shipped source so a disconnected hop fails.
 */
const panelSource = readFileSync(
  resolve(
    process.cwd(),
    "src/components/conversations/conversation-detail-panel.tsx"
  ),
  "utf8"
)
const chatInputSource = readFileSync(
  resolve(process.cwd(), "src/components/chat/chat-input.tsx"),
  "utf8"
)
const apiSource = readFileSync(resolve(process.cwd(), "src/lib/api.ts"), "utf8")

describe("steering is wired from the queue item down to the transport", () => {
  it("api.ts calls the acp_steer endpoint through the transport", () => {
    // The one hop that did not exist: nothing in src/ reached the endpoint.
    expect(apiSource).toContain('getTransport().call("acp_steer"')
  })

  it("does NOT strip image payloads on the steer path", () => {
    // `ConnectionManager::steer` has no counterpart to the prompt path's
    // `hydrate_prompt_blocks`, so a stripped block would arrive with nothing to
    // rehydrate from and the attachment would silently vanish.
    const steerIdx = apiSource.indexOf('getTransport().call("acp_steer"')
    const steerCall = apiSource.slice(steerIdx, steerIdx + 260)
    expect(steerCall).not.toContain("stripUploadedImagePayloads")
  })

  it("the panel hands the queue display a send-now handler and the capability", () => {
    expect(panelSource).toContain("onQueueSendNow={handleQueueSendNow}")
    expect(panelSource).toContain("supportsSteering={conn.supportsSteering}")
  })

  it("the panel's send-now handler actually invokes conn.steer", () => {
    const handlerIdx = panelSource.indexOf("const handleQueueSendNow")
    expect(handlerIdx).toBeGreaterThan(-1)
    const handler = panelSource.slice(handlerIdx, handlerIdx + 2600)
    expect(handler).toContain("conn.steer(item.draft.blocks, item.messageId)")
  })

  it("chat-input forwards both steering props to the queue display", () => {
    const displayIdx = chatInputSource.indexOf("<MessageQueueDisplay")
    expect(displayIdx).toBeGreaterThan(-1)
    const display = chatInputSource.slice(displayIdx, displayIdx + 400)
    expect(display).toContain("supportsSteering={supportsSteering}")
    expect(display).toContain("onSendNow={onQueueSendNow}")
  })
})

describe("send-now failure paths (R1.6 / design §2.5.1)", () => {
  it("routes every outcome through the shared state machine", () => {
    // Not an inline `if (outcome === ...)` ladder: the classification is the
    // whole correctness argument and lives in one tested place.
    const handlerIdx = panelSource.indexOf("const handleQueueSendNow")
    const handler = panelSource.slice(handlerIdx, handlerIdx + 2600)
    expect(handler).toContain("nextStatusForOutcome(outcome)")
  })

  it("claims the item through markInFlight and bails when the claim is lost", () => {
    // Send-now and auto-flush use different claims. Their safety comes from both
    // synchronously reading, checking, and committing the same authoritative
    // queueRef; this return is the losing claim's no-delivery branch.
    const handlerIdx = panelSource.indexOf("const handleQueueSendNow")
    const handler = panelSource.slice(handlerIdx, handlerIdx + 2600)
    expect(handler).toContain("if (!mqMarkInFlight(id)) return")
  })

  it("classifies a thrown transport error as unknown, never as a refusal", () => {
    // A throw means we never learned whether the agent got the message. Treating
    // it as `failed` would put the item back as retryable and risk running the
    // user's instruction twice.
    const handlerIdx = panelSource.indexOf("const handleQueueSendNow")
    const handler = panelSource.slice(handlerIdx, handlerIdx + 2600)
    const catchIdx = handler.indexOf("} catch (e) {")
    expect(catchIdx).toBeGreaterThan(-1)
    expect(handler.slice(catchIdx, catchIdx + 200)).toContain(
      'outcome = "unknown"'
    )
  })

  it("never auto-retries: no resend call inside the handler", () => {
    const handlerIdx = panelSource.indexOf("const handleQueueSendNow")
    const handler = panelSource.slice(handlerIdx, handlerIdx + 2600)
    // Exactly ONE steer call in the handler — a retry loop would add another.
    const steerCalls = handler.match(/conn\.steer\(/g) ?? []
    expect(steerCalls).toHaveLength(1)
    expect(handler).not.toMatch(/setTimeout|retry|while\s*\(/)
  })
})

describe("optimistic display reuses the existing rollback (design §2.6)", () => {
  it("appends an optimistic turn before the request and removes it on failure", () => {
    const handlerIdx = panelSource.indexOf("const handleQueueSendNow")
    const handler = panelSource.slice(handlerIdx, handlerIdx + 2600)
    expect(handler).toContain("appendOptimisticTurn(")
    expect(handler).toContain("removeOptimisticTurn(")
    // The append must precede the await, so the user's message is necessarily
    // ordered before any agent output the injection causes.
    expect(handler.indexOf("appendOptimisticTurn(")).toBeLessThan(
      handler.indexOf("conn.steer(")
    )
  })

  it("reuses REMOVE_OPTIMISTIC_TURN rather than adding a ROLLBACK_* twin", () => {
    // The existing action already no-ops on an unknown id and settles syncState
    // back to `idle` when the last optimistic turn goes — a lingering
    // `awaiting_persist` would suppress the next detail reconciliation.
    const storeSource = readFileSync(
      resolve(process.cwd(), "src/stores/conversation-runtime-store.ts"),
      "utf8"
    )
    expect(storeSource).toContain('case "REMOVE_OPTIMISTIC_TURN"')
    expect(storeSource).not.toContain("ROLLBACK_OPTIMISTIC_TURN")
  })

  it("does NOT write the injected message to the transcript", () => {
    // Built-in agents' history is the agent's own <session_id>.jsonl, which the
    // injected message reaches via the agent's input stream. A second copy is
    // the two-disagreeing-histories problem.
    const handlerIdx = panelSource.indexOf("const handleQueueSendNow")
    const handler = panelSource.slice(handlerIdx, handlerIdx + 2600)
    expect(handler).not.toContain("acp_transcript")
    expect(handler).not.toContain("recordEntry")
  })

  it("does NOT reuse the UserMessage apply path (which clears live state)", () => {
    // `AcpEvent::UserMessage`'s apply overwrites the single-slot
    // `pending_user_message`, clears `feedback`, and drops `pending_question` /
    // `pending_plan_approval` — a question card or plan approval the user is
    // being asked would be erased. An injection is not a new user turn.
    const handlerIdx = panelSource.indexOf("const handleQueueSendNow")
    const handler = panelSource.slice(handlerIdx, handlerIdx + 2600)
    expect(handler).not.toContain("appendViewerUserTurn")
    expect(handler).not.toContain("pendingUserMessage")
    expect(handler).not.toContain("feedback.clear")
  })
})

describe("the composer keeps send available while the agent works (R3.1)", () => {
  // Behavioral coverage of the prompting form lives in
  // `src/components/chat/message-input.test.tsx` ("MessageInput native
  // steering"): it renders the component and queries the DOM for Stop, Send and
  // the steer dropdown. Reading `message-input.tsx` as a STRING to assert on
  // rendered chrome is the anti-pattern those tests replace — the shape of the
  // source is not the behavior, and a slice boundary like
  // `indexOf(") : onForkSend ? (")` silently voids the gate the moment an
  // unrelated neighbouring branch is edited.
  it.todo("covered behaviorally in message-input.test.tsx")
})
