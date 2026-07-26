import { describe, expect, it } from "vitest"
import { getAgentResumeCommand } from "@/lib/agent-resume-command"

describe("getAgentResumeCommand", () => {
  it("builds the per-CLI template for supported agents", () => {
    expect(getAgentResumeCommand("claude_code", "abc-123")).toBe(
      "claude --resume abc-123"
    )
    expect(getAgentResumeCommand("codex", "DEADBEEF")).toBe(
      "codex resume DEADBEEF"
    )
    expect(getAgentResumeCommand("kimi_code", "s_1")).toBe("kimi -r s_1")
  })

  it("returns null for agents without a verified CLI resume syntax", () => {
    expect(getAgentResumeCommand("kiro", "abc")).toBeNull()
    expect(getAgentResumeCommand("cursor", "abc")).toBeNull()
    expect(getAgentResumeCommand("open_code", "abc")).toBeNull()
  })

  it("fails closed on ids that could extend the shell command", () => {
    expect(getAgentResumeCommand("claude_code", "abc; rm -rf /")).toBeNull()
    expect(getAgentResumeCommand("claude_code", "a b")).toBeNull()
    expect(getAgentResumeCommand("claude_code", "a'b")).toBeNull()
    expect(getAgentResumeCommand("claude_code", "")).toBeNull()
    expect(getAgentResumeCommand("claude_code", null)).toBeNull()
    expect(getAgentResumeCommand("claude_code", undefined)).toBeNull()
  })
})
