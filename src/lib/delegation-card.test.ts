import { describe, expect, it } from "vitest"

import { ALL_AGENT_TYPES } from "@/lib/types"
import {
  isAffirmedResume,
  isRefusedResume,
  parseAppliedPersona,
  parseDelegateTaskId,
  parseDelegationMeta,
  parseInput,
  parseToolOutput,
  truncatePersonaName,
} from "./delegation-card"

describe("parseInput wrapper peeling", () => {
  it("reads top-level delegation args", () => {
    const parsed = parseInput(
      JSON.stringify({
        agent_type: "codex",
        task: "run the build",
        working_dir: "/tmp/proj",
      })
    )
    expect(parsed.agentType).toBe("codex")
    expect(parsed.task).toBe("run the build")
    expect(parsed.workingDir).toBe("/tmp/proj")
  })

  it("peels Cursor's MCP args wrapper", () => {
    // Cursor surfaces MCP calls as {providerIdentifier, toolName, args} — the
    // delegation fields live one level down under `args`. Mirrors the Rust
    // walker in acp/lifecycle.rs (ARGS_WRAPPER_KEYS).
    const parsed = parseInput(
      JSON.stringify({
        providerIdentifier: "codeg-mcp",
        toolName: "delegate_to_agent",
        args: { agent_type: "claude_code", task: "执行 pnpm build" },
      })
    )
    expect(parsed.agentType).toBe("claude_code")
    expect(parsed.task).toBe("执行 pnpm build")
    expect(parsed.workingDir).toBeNull()
  })

  it("returns empty for undelegation-like payloads", () => {
    const parsed = parseInput(JSON.stringify({ command: "ls -la" }))
    expect(parsed.agentType).toBeNull()
    expect(parsed.task).toBeNull()
  })

  // Guards the allowlist against drifting behind the canonical agent list — the
  // regression that left `grok` and `cursor` delegation cards iconless. Every
  // known agent must resolve so its sub-agent card shows the right icon/label.
  it.each(ALL_AGENT_TYPES)("recognizes the %s agent_type", (agentType) => {
    const parsed = parseInput(
      JSON.stringify({ agent_type: agentType, task: "do the thing" })
    )
    expect(parsed.agentType).toBe(agentType)
  })
})

describe("codex live-wire result envelope", () => {
  /**
   * codex-acp forwards every MCP call's outcome as
   * `rawOutput = { result: <CallToolResult>, error: <string|null> }`
   * (`createMcpRawOutput`) — one layer above the shapes the parsers read.
   */
  function codexLive(callToolResult: Record<string, unknown>): string {
    return JSON.stringify({
      error: null,
      result: { meta: null, ...callToolResult },
    })
  }

  const runningAck = {
    agent_type: "codex",
    child_conversation_id: 2781,
    status: "running",
    task_id: "8cb72a7c-1a96-44aa-9c26-d4356862c9c2",
    message:
      "Delegation successful. task_id=8cb72a7c-1a96-44aa-9c26-d4356862c9c2.",
  }

  it("reads a running ack through the wrapper (ack, not a terminal outcome)", () => {
    const parsed = parseToolOutput(
      codexLive({
        content: [{ type: "text", text: runningAck.message }],
        structuredContent: runningAck,
      })
    )
    expect(parsed).toEqual({
      kind: "ack",
      childConversationId: 2781,
      appliedPersona: null,
      requestedModel: null,
      agentType: "codex",
      // No refusal code — this is a real ack. See `isRefusedResume`.
      errorCode: null,
    })
  })

  // Note: this one already passed pre-fix via the `task_id=<id>` text scan —
  // it guards that the structured path doesn't regress that resolution.
  it("resolves the task id through the wrapper", () => {
    const output = codexLive({
      content: [{ type: "text", text: "Delegation successful." }],
      structuredContent: runningAck,
    })
    expect(parseDelegateTaskId(output, null)).toBe(runningAck.task_id)
  })

  it("surfaces a failed envelope's error string instead of the raw JSON", () => {
    const parsed = parseToolOutput(
      JSON.stringify({ error: "mcp server disconnected", result: null })
    )
    expect(parsed).toEqual({
      kind: "outcome",
      text: "mcp server disconnected",
      isError: true,
      childConversationId: null,
      appliedPersona: null,
      requestedModel: null,
    })
  })

  it("leaves a child's nested {status, task_id} payload alone", () => {
    // Peeling on the `result` KEY alone would turn opaque child output into a
    // failed delegation outcome and hand out `child-job` as the task id.
    const childOutput = JSON.stringify({
      result: { status: "failed", task_id: "child-job", message: "domain" },
    })
    expect(parseToolOutput(childOutput)).toEqual({
      kind: "outcome",
      text:
        "```json\n" +
        JSON.stringify(JSON.parse(childOutput), null, 2) +
        "\n```",
      isError: false,
      childConversationId: null,
      appliedPersona: null,
      requestedModel: null,
    })
    expect(parseDelegateTaskId(childOutput, null)).toBeNull()
  })

  it("does NOT treat a child's own `error` field as a host failure", () => {
    // No `result` key ⇒ not codex-acp's failure envelope. Must stay a
    // non-error outcome rendered as-is.
    const childOutput = JSON.stringify({ error: "domain validation", rows: [] })
    const parsed = parseToolOutput(childOutput)
    expect(parsed).toMatchObject({ kind: "outcome", isError: false })
    expect(parsed).not.toMatchObject({ text: "domain validation" })
  })
})

describe("parseDelegationMeta task fields", () => {
  it("surfaces the broker-stamped task_preview and task_id", () => {
    // The persisted Cursor shape: raw_input is "{}" forever, so the meta the
    // broker stamped is the card's ONLY label source after a refresh.
    const parsed = parseDelegationMeta({
      "codeg.delegation": {
        status: "running",
        child_conversation_id: 42,
        task_preview: "执行 pnpm build",
        task_id: "task-uuid-1",
      },
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.task).toBe("执行 pnpm build")
    expect(parsed?.taskId).toBe("task-uuid-1")
    expect(parsed?.childConversationId).toBe(42)
  })

  it("keeps task fields null when the meta lacks them (older backend)", () => {
    const parsed = parseDelegationMeta({
      "codeg.delegation": { status: "completed" },
    })
    expect(parsed?.task).toBeNull()
    expect(parsed?.taskId).toBeNull()
  })

  it("ignores empty and non-string task fields", () => {
    const parsed = parseDelegationMeta({
      "codeg.delegation": {
        status: "running",
        task_preview: "",
        task_id: 7,
      },
    })
    expect(parsed?.task).toBeNull()
    expect(parsed?.taskId).toBeNull()
  })

  it("surfaces the agent_type the historical injection supplies", () => {
    // Written only by `build_historical_delegation_meta` (from the child's DB
    // row). It is the agent-type source for a reloaded `resume_delegation`
    // card, whose arguments are just `{task_id, reason}`.
    const parsed = parseDelegationMeta({
      "codeg.delegation": { status: "completed", agent_type: "codex" },
    })
    expect(parsed?.agentType).toBe("codex")
  })

  it("rejects an unrecognized agent_type but keeps a custom one", () => {
    expect(
      parseDelegationMeta({
        "codeg.delegation": { status: "running", agent_type: "not_an_agent" },
      })?.agentType
    ).toBeNull()
    expect(
      parseDelegationMeta({
        "codeg.delegation": { status: "running", agent_type: "custom:my-cli" },
      })?.agentType
    ).toBe("custom:my-cli")
  })
})

describe("parseToolOutput agent type", () => {
  it("reads agent_type off the broker report", () => {
    // `delegate_to_agent` merely echoes its own argument here, but a
    // `resume_delegation` result is the ONLY place a reloaded card can learn
    // which agent came back.
    expect(
      parseToolOutput(
        JSON.stringify({
          task_id: "t-1",
          status: "running",
          agent_type: "codex",
          child_conversation_id: 9,
        })
      )
    ).toMatchObject({ kind: "ack", agentType: "codex", childConversationId: 9 })
  })

  it("carries agent_type onto a terminal outcome too", () => {
    expect(
      parseToolOutput(
        JSON.stringify({
          task_id: "t-1",
          status: "completed",
          agent_type: "claude_code",
          text: "all green",
        })
      )
    ).toMatchObject({
      kind: "outcome",
      agentType: "claude_code",
      isError: false,
    })
  })

  it("leaves agentType null when the report omits it", () => {
    expect(
      parseToolOutput(JSON.stringify({ task_id: "t-1", status: "running" }))
    ).toMatchObject({ kind: "ack", agentType: null })
  })
})

describe("isRefusedResume", () => {
  // `not_resumable_report` (broker.rs) reports the task's REAL status, so a
  // refusal and a genuine resume differ only by `error_code`. Reading status
  // alone paints "Not resumed: it already completed" as a finished sub-agent.
  it.each(["completed", "running", "canceled"])(
    "recognizes a refusal reported with status %s",
    (status) => {
      expect(
        isRefusedResume(
          JSON.stringify({
            task_id: "t-1",
            status,
            error_code: "not_resumable",
            agent_type: "codex",
            child_conversation_id: 9,
            message: "Not resumed: the task already completed.",
          })
        )
      ).toBe(true)
    }
  )

  it("leaves a genuine resume ack alone", () => {
    expect(
      isRefusedResume(
        JSON.stringify({
          task_id: "t-1",
          status: "running",
          agent_type: "codex",
          child_conversation_id: 9,
          message: "Delegation resumed.",
        })
      )
    ).toBe(false)
  })

  // An unknown task id is refused too, but by a report that names no agent and
  // no child — nothing for a card to draw, so `hasModel` already handles it.
  it("does not claim an unknown-task report", () => {
    expect(
      isRefusedResume(
        JSON.stringify({
          task_id: "t-1",
          status: "unknown",
          message: "Unknown task id",
        })
      )
    ).toBe(false)
    expect(isRefusedResume(null)).toBe(false)
  })

  it("reads a refusal delivered as an error", () => {
    expect(
      isRefusedResume(
        null,
        JSON.stringify({
          task_id: "t-1",
          status: "failed",
          error_code: "not_resumable",
        })
      )
    ).toBe(true)
  })
})

// `render_task_report` keeps the whole report in `structuredContent` and
// renders only `message` as content text. OpenCode drops `structuredContent`
// wholesale ("the human-readable lines ARE the whole record",
// `acp/connection.rs`), so on those hosts the prefix is the only signal left.
describe("resume verdicts on hosts that drop structuredContent", () => {
  const REFUSAL_TEXT =
    "Not resumed: the task already completed — resume only applies to a canceled task."
  const ACK_TEXT =
    "Delegation resumed. task_id=t-1 (unchanged). Call get_delegation_status with this id."
  const UNKNOWN_TEXT =
    "Unknown task id — it never existed, isn't owned by this session, or its result was evicted."

  // Bare text is what actually arrives: `opencode_live_tool_output` returns
  // None whenever `content` carries the result (letting the clean text render)
  // and otherwise unwraps `rawOutput.output` to the bare string, and the
  // history parser mirrors it. So the `{output: …}` envelope never reaches
  // these predicates — which is why the text check can stay anchored.
  it("still recognizes a refusal from the message text alone", () => {
    expect(isRefusedResume(REFUSAL_TEXT)).toBe(true)
  })

  it("affirms a resume from the ack text alone", () => {
    expect(isAffirmedResume(ACK_TEXT)).toBe(true)
  })

  // A foreign task id lands on `unknown_report`. It must NOT affirm, or the
  // card would adopt another conversation's binding by task id alone.
  it("does not affirm an unknown-task report or a refusal", () => {
    expect(isAffirmedResume(UNKNOWN_TEXT)).toBe(false)
    expect(isAffirmedResume(REFUSAL_TEXT)).toBe(false)
    expect(isAffirmedResume(null)).toBe(false)
  })

  it("keeps the structured verdict authoritative when it survived", () => {
    const structured = JSON.stringify({
      task_id: "t-1",
      status: "running",
      agent_type: "codex",
      child_conversation_id: 9,
      message: ACK_TEXT,
    })
    expect(isRefusedResume(structured)).toBe(false)
    expect(isAffirmedResume(structured)).toBe(true)
  })
})

// `render_task_report` renders `text` in preference to `message` for a
// `completed` report, and a resume whose child finished during setup
// (`broker.rs`'s `Disposition::ChildTerminal`) reports the child's OWN
// LLM-written output there. A sub-agent that merely talks about delegation
// must not be read as a verdict about its own card — which is why the text
// check is anchored rather than a substring scan.
describe("resume verdicts never read a child's prose as a verdict", () => {
  const CHILD_PROSE =
    "I reviewed the resume path. The broker answers `Not resumed: <why>` when it " +
    "refuses, and `Delegation resumed. task_id=…` when it succeeds."

  it("ignores both markers when they appear inside a completed child's text", () => {
    const structured = JSON.stringify({
      task_id: "t-1",
      status: "completed",
      agent_type: "codex",
      child_conversation_id: 9,
      text: CHILD_PROSE,
    })
    expect(isRefusedResume(structured)).toBe(false)
    // Structure survived, so the child id — not the prose — is the confirmation.
    expect(isAffirmedResume(structured)).toBe(true)
  })

  it("ignores them in bare child text on a structure-dropping host", () => {
    expect(isRefusedResume(CHILD_PROSE)).toBe(false)
    expect(isAffirmedResume(CHILD_PROSE)).toBe(false)
  })

  // A structured report that named no child is `unknown_report` — the foreign
  // task id case. It must not affirm even though nothing refused it either.
  it("does not affirm a structured report that named no child", () => {
    const unknown = JSON.stringify({
      task_id: "t-1",
      status: "unknown",
      message: "Unknown task id — it never existed.",
    })
    expect(isAffirmedResume(unknown)).toBe(false)
  })

  // The legacy synchronous `{kind: "ok"|"err"}` shape is a RECOGNIZED report
  // too, so it must never fall through to the text path — otherwise a
  // legitimate result whose text merely opens with a marker gets read as a
  // verdict about the call.
  it("treats the legacy kind-shaped outcome as structured", () => {
    const legacyOk = JSON.stringify({
      kind: "ok",
      child_conversation_id: 9,
      text: "Not resumed: is the phrase the broker uses when it declines.",
    })
    expect(isRefusedResume(legacyOk)).toBe(false)
    expect(isAffirmedResume(legacyOk)).toBe(true)

    const legacyErr = JSON.stringify({
      kind: "err",
      code: "spawn_failed",
      message: "Delegation resumed is the phrase used on success.",
    })
    expect(isRefusedResume(legacyErr)).toBe(false)
    // No child named ⇒ nothing corroborates a task-id binding.
    expect(isAffirmedResume(legacyErr)).toBe(false)
  })
})

describe("parseAppliedPersona", () => {
  // Mirrors Rust's `#[serde(tag = "kind", rename_all = "snake_case")]` on
  // `AppliedPersona` (acp/delegation/persona.rs). A drift in either direction
  // silently kills the label, so pin the three wire literals.
  it("reads the native variant", () => {
    expect(
      parseAppliedPersona({ kind: "native", name: "plan-reality-recon" })
    ).toEqual({ kind: "native", name: "plan-reality-recon" })
  })

  it("reads the hint variant", () => {
    expect(
      parseAppliedPersona({ kind: "hint", name: "code-reviewer" })
    ).toEqual({ kind: "hint", name: "code-reviewer" })
  })

  it("reads the ignored_unsupported_cli variant", () => {
    expect(
      parseAppliedPersona({ kind: "ignored_unsupported_cli", name: "whatever" })
    ).toEqual({ kind: "ignored_unsupported_cli", name: "whatever" })
  })

  it.each([
    ["null", null],
    ["undefined (legacy backend omits the field)", undefined],
    ["an array", [{ kind: "native", name: "x" }]],
    ["a string", "native"],
    ["a number", 7],
    ["an unknown kind", { kind: "failed", name: "x" }],
    ["a non-string kind", { kind: 1, name: "x" }],
    ["a missing name", { kind: "native" }],
    ["an empty name", { kind: "native", name: "" }],
    ["a non-string name", { kind: "native", name: { nested: true } }],
  ])("returns null for %s", (_label, raw) => {
    expect(parseAppliedPersona(raw)).toBeNull()
  })
})

describe("applied_persona on the parsed tool output", () => {
  /**
   * The load-bearing timing case (backend R3-A2): the broker commits
   * `Native` / `IgnoredUnsupportedCli` the moment `spawn` returns Ok, which is
   * still the RUNNING ack — the card is on screen from that point, so the
   * persona must ride the `ack` variant, not just `outcome`.
   */
  it("carries the persona on a running ack, not only on a terminal outcome", () => {
    const parsed = parseToolOutput(
      JSON.stringify({
        content: [{ type: "text", text: "Delegation successful." }],
        structuredContent: {
          status: "running",
          child_conversation_id: 51,
          task_id: "t-1",
          applied_persona: { kind: "native", name: "plan-reality-recon" },
        },
      })
    )
    expect(parsed).toEqual({
      kind: "ack",
      childConversationId: 51,
      appliedPersona: { kind: "native", name: "plan-reality-recon" },
      requestedModel: null,
      agentType: null,
      errorCode: null,
    })
  })

  it("carries a hint persona on the terminal completed report", () => {
    // `Hint` is only promoted after the first-turn send is accepted, so the
    // terminal report — not the ack — is where it surfaces.
    const parsed = parseToolOutput(
      JSON.stringify({
        status: "completed",
        child_conversation_id: 9,
        text: "done",
        applied_persona: { kind: "hint", name: "code-reviewer" },
      })
    )
    expect(parsed).toMatchObject({
      kind: "outcome",
      isError: false,
      appliedPersona: { kind: "hint", name: "code-reviewer" },
    })
  })

  it("keeps a persona committed before a later failure", () => {
    // A spawn that succeeded and then failed downstream has already committed
    // `Native`; the error card may legitimately show it.
    const parsed = parseToolOutput(
      JSON.stringify({
        status: "failed",
        error_code: "subagent_error",
        message: "child crashed",
        applied_persona: { kind: "native", name: "executor" },
      })
    )
    expect(parsed).toMatchObject({
      kind: "outcome",
      isError: true,
      appliedPersona: { kind: "native", name: "executor" },
    })
  })

  it("yields a null persona for a legacy report without the field", () => {
    // `skip_serializing_if = "Option::is_none"` means old backends omit it
    // entirely — must parse, not crash.
    const parsed = parseToolOutput(
      JSON.stringify({ status: "completed", text: "done" })
    )
    expect(parsed).toMatchObject({ kind: "outcome", appliedPersona: null })
  })

  it("yields a null persona for the legacy synchronous outcome shape", () => {
    const parsed = parseToolOutput(JSON.stringify({ kind: "ok", text: "done" }))
    expect(parsed).toMatchObject({ kind: "outcome", appliedPersona: null })
  })

  it("drops a malformed persona instead of rendering a partial one", () => {
    const parsed = parseToolOutput(
      JSON.stringify({
        status: "running",
        applied_persona: { kind: "definitely-not-a-variant", name: "x" },
      })
    )
    expect(parsed).toEqual({
      kind: "ack",
      childConversationId: null,
      appliedPersona: null,
      requestedModel: null,
      agentType: null,
      errorCode: null,
    })
  })
})

describe("parseInput subagent_type (request, never the effect)", () => {
  it("surfaces the nominated persona for the failure-card hint", () => {
    const parsed = parseInput(
      JSON.stringify({
        agent_type: "kiro",
        task: "review",
        subagent_type: "plan-reality-recon",
      })
    )
    expect(parsed.subagentType).toBe("plan-reality-recon")
  })

  it("keeps it null when absent or empty", () => {
    expect(
      parseInput(JSON.stringify({ agent_type: "kiro", task: "x" })).subagentType
    ).toBeNull()
    expect(
      parseInput(JSON.stringify({ agent_type: "kiro", subagent_type: "" }))
        .subagentType
    ).toBeNull()
    expect(
      parseInput(JSON.stringify({ agent_type: "kiro", subagent_type: 7 }))
        .subagentType
    ).toBeNull()
  })
})

describe("truncatePersonaName (32 grapheme clusters)", () => {
  it("leaves a name at or under the limit untouched", () => {
    expect(truncatePersonaName("plan-reality-recon")).toBe("plan-reality-recon")
    expect(truncatePersonaName("a".repeat(32))).toBe("a".repeat(32))
  })

  it("truncates an over-long ASCII name with an ellipsis", () => {
    expect(truncatePersonaName("a".repeat(33))).toBe("a".repeat(32) + "…")
  })

  // `IgnoredUnsupportedCli` short-circuits BEFORE the ASCII name-grammar check
  // (backend R3-F1), so a non-ASCII name really can reach the UI. Counting
  // UTF-16 code units here would cut a CJK name at half its visible length and
  // could split a surrogate pair into a replacement char.
  it("counts CJK characters as one unit each", () => {
    const name = "计".repeat(40)
    expect(truncatePersonaName(name)).toBe("计".repeat(32) + "…")
  })

  it("does not split a multi-code-unit emoji", () => {
    const name = "🤖".repeat(40)
    const out = truncatePersonaName(name)
    expect(out).toBe("🤖".repeat(32) + "…")
    expect(out).not.toContain("�")
  })

  it("keeps a ZWJ emoji family together when Intl.Segmenter is available", () => {
    // One grapheme cluster, 7 code points. Under the Segmenter path this stays
    // whole; the code-point fallback would count it as several.
    const family = "👨‍👩‍👧‍👦"
    expect(truncatePersonaName(family + "x", 2)).toBe(family + "x")
  })

  it("honors an explicit lower limit", () => {
    expect(truncatePersonaName("abcdef", 3)).toBe("abc…")
  })
})

describe("requested_model on the parsed tool output", () => {
  function outputWith(report: Record<string, unknown>): string {
    return JSON.stringify({
      content: [{ type: "text", text: "Delegation successful." }],
      structuredContent: report,
    })
  }

  it("reads the model off a running ack", () => {
    const parsed = parseToolOutput(
      outputWith({
        status: "running",
        child_conversation_id: 7,
        requested_model: "claude-sonnet-5",
      })
    )
    expect(parsed).toMatchObject({
      kind: "ack",
      requestedModel: "claude-sonnet-5",
    })
  })

  it("reads the model off a terminal report", () => {
    const parsed = parseToolOutput(
      outputWith({
        status: "completed",
        text: "done",
        requested_model: "gemini-3-pro",
      })
    )
    expect(parsed).toMatchObject({
      kind: "outcome",
      requestedModel: "gemini-3-pro",
    })
  })

  it("keeps the model on a failure report", () => {
    const parsed = parseToolOutput(
      outputWith({
        status: "failed",
        error_code: "child_refusal",
        message: "nope",
        requested_model: "claude-sonnet-5",
      })
    )
    expect(parsed).toMatchObject({
      kind: "outcome",
      isError: true,
      requestedModel: "claude-sonnet-5",
    })
  })

  it("degrades a legacy payload with no field to null", () => {
    const parsed = parseToolOutput(
      outputWith({ status: "completed", text: "x" })
    )
    expect(parsed).toMatchObject({ kind: "outcome", requestedModel: null })
  })

  it("drops a non-string or blank model rather than rendering it", () => {
    for (const bad of [42, {}, [], true, "", "   "]) {
      const parsed = parseToolOutput(
        outputWith({ status: "completed", text: "x", requested_model: bad })
      )
      expect(parsed).toMatchObject({ kind: "outcome", requestedModel: null })
    }
  })

  it("trims surrounding whitespace off an otherwise valid id", () => {
    const parsed = parseToolOutput(
      outputWith({
        status: "completed",
        text: "x",
        requested_model: "  claude-sonnet-5  ",
      })
    )
    expect(parsed).toMatchObject({ requestedModel: "claude-sonnet-5" })
  })
})
