import { describe, expect, it } from "vitest"

import {
  canSendNow,
  isSteeringSupported,
  nextStatusForOutcome,
  type QueueItemStatus,
  type SteerOutcome,
} from "@/lib/steering-queue"

describe("isSteeringSupported — capability three-state (R2.2)", () => {
  it("treats a confirmed true as supported", () => {
    expect(isSteeringSupported(true)).toBe(true)
  })

  it("treats a confirmed false as unsupported", () => {
    expect(isSteeringSupported(false)).toBe(false)
  })

  it("treats unknown (undefined) as unsupported, NOT as supported", () => {
    // The conservative default: the `initialize` probe may not have landed, or
    // an older server omitted the field. Offering "send now" then would promise
    // an interruption the agent may be unable to perform.
    expect(isSteeringSupported(undefined)).toBe(false)
  })
})

describe("nextStatusForOutcome — the four transitions (design §2.5.1)", () => {
  it("injected → delivered", () => {
    expect(nextStatusForOutcome("injected")).toBe("delivered")
  })

  it("startedNewTurn → delivered, NOT back to queued", () => {
    // The trap: it looks like a fallback, but the agent is already executing the
    // message in a turn we cannot observe. Re-queueing it would run the user's
    // instruction a second time.
    expect(nextStatusForOutcome("startedNewTurn")).toBe("delivered")
  })

  it("failed → queued (explicit refusal is definitively not accepted)", () => {
    expect(nextStatusForOutcome("failed")).toBe("queued")
  })

  it("unknown → unknown (neither success nor failure)", () => {
    expect(nextStatusForOutcome("unknown")).toBe("unknown")
  })

  it("delivered is terminal: no outcome maps back out of it", () => {
    const outcomes: SteerOutcome[] = [
      "injected",
      "startedNewTurn",
      "failed",
      "unknown",
    ]
    // Every outcome that produces `delivered` is a delivery-success outcome; no
    // outcome can turn a delivered item back into a sendable one. Asserted over
    // the whole union so a future variant cannot quietly open that path.
    const deliveredFrom = outcomes.filter(
      (o) => nextStatusForOutcome(o) === "delivered"
    )
    expect(deliveredFrom).toEqual(["injected", "startedNewTurn"])
  })
})

describe("canSendNow — single dequeue + capability gating", () => {
  it("offers the action on a queued item when steering is supported", () => {
    expect(canSendNow("queued", true)).toBe(true)
  })

  it("does NOT offer it on an in_flight item (no double dequeue)", () => {
    // Auto-flush and "send now" share the in_flight flag; a second click would
    // deliver the same message twice.
    expect(canSendNow("in_flight", true)).toBe(false)
  })

  it("does NOT offer it on a delivered item", () => {
    expect(canSendNow("delivered", true)).toBe(false)
  })

  it("does NOT offer the ordinary action on an unknown item", () => {
    // `unknown` gets its own explicit resend affordance — re-sending is a real
    // duplicate-execution risk and must be a deliberate user decision.
    expect(canSendNow("unknown", true)).toBe(false)
  })

  it("does NOT offer it when the capability is unsupported or unknown", () => {
    expect(canSendNow("queued", false)).toBe(false)
    expect(canSendNow("queued", undefined)).toBe(false)
  })

  it("gates every status when the capability is unknown", () => {
    const statuses: QueueItemStatus[] = [
      "queued",
      "in_flight",
      "delivered",
      "unknown",
    ]
    expect(statuses.every((s) => !canSendNow(s, undefined))).toBe(true)
  })
})
