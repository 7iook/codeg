import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { BUILTIN_AGENT_ROSTER } from "./agent-roster"
import { AGENT_DISPLAY_ORDER } from "./types"

interface DelegationToolSchema {
  name: string
  inputSchema?: {
    properties?: {
      agent_type?: {
        enum?: string[]
      }
    }
  }
}

function expectSameMembers(
  actual: readonly string[],
  expected: readonly string[],
  actualName: string,
  expectedName: string
): void {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const missing = expected.filter((agent) => !actualSet.has(agent))
  const extra = actual.filter((agent) => !expectedSet.has(agent))

  expect(
    { missing, extra },
    `${actualName} differs from ${expectedName}: missing [${missing.join(
      ", "
    )}], extra [${extra.join(", ")}]`
  ).toEqual({ missing: [], extra: [] })
}

function rustDelegationAgentTypes(): string[] {
  const schemaPath = path.resolve(
    process.cwd(),
    "src-tauri/src/acp/delegation/tool_schema.json"
  )
  const schema = JSON.parse(
    readFileSync(schemaPath, "utf8")
  ) as DelegationToolSchema[]
  const delegateTool = schema.find((tool) => tool.name === "delegate_to_agent")
  const agentTypes = delegateTool?.inputSchema?.properties?.agent_type?.enum

  expect(agentTypes, "delegate_to_agent agent_type.enum is missing").toBeDefined()
  return agentTypes ?? []
}

describe("built-in agent roster", () => {
  it("matches the Rust delegation schema membership", () => {
    // This gate inherits authority from the Rust schema/registry equality gate.
    // If that Rust gate is removed, both layers can drift together undetected.
    expectSameMembers(
      BUILTIN_AGENT_ROSTER,
      rustDelegationAgentTypes(),
      "frontend roster",
      "Rust delegation schema"
    )
  })

  it("keeps the curated display order membership complete", () => {
    expectSameMembers(
      AGENT_DISPLAY_ORDER,
      BUILTIN_AGENT_ROSTER,
      "display order",
      "frontend roster"
    )
  })
})
