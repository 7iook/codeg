import { describe, expect, it } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import {
  canSubmitFollowUp,
  DEFAULT_FOLLOW_UP_INTENT,
  followUpScenario,
  FOLLOW_UP_SCENARIOS,
} from "@/lib/task-follow-up"

describe("follow-up scenarios", () => {
  it("defaults to the scenario that reproduces the old behaviour", () => {
    // `revise` composes the prompt the action sent before scenarios existed,
    // so an untouched chip row means an unchanged workflow.
    expect(DEFAULT_FOLLOW_UP_INTENT).toBe("revise")
    expect(FOLLOW_UP_SCENARIOS[0].intent).toBe("revise")
  })

  it("mirrors the backend enum", () => {
    expect(FOLLOW_UP_SCENARIOS.map((s) => s.intent)).toEqual([
      "revise",
      "continue",
      "question",
      "verify",
    ])
  })

  it("has a translated label and placeholder for every scenario", () => {
    const tasks = enMessages.Tasks as Record<string, string>
    for (const scenario of FOLLOW_UP_SCENARIOS) {
      expect(tasks[scenario.labelKey]).toBeTruthy()
      expect(tasks[scenario.placeholderKey]).toBeTruthy()
    }
  })

  it("only lets the self-check be sent empty", () => {
    for (const scenario of FOLLOW_UP_SCENARIOS) {
      expect(canSubmitFollowUp(scenario.intent, "")).toBe(scenario.allowsEmpty)
      expect(canSubmitFollowUp(scenario.intent, "   ")).toBe(
        scenario.allowsEmpty
      )
      expect(canSubmitFollowUp(scenario.intent, "do the thing")).toBe(true)
    }
    expect(canSubmitFollowUp("verify", "")).toBe(true)
    expect(canSubmitFollowUp("question", "")).toBe(false)
  })

  it("resolves a scenario by intent", () => {
    expect(followUpScenario("question").labelKey).toBe("followUpIntentQuestion")
  })
})
