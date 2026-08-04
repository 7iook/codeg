import { describe, expect, it } from "vitest"

import { buildDelegationSeedEnvelopes } from "@/lib/delegation-seed"
import type { ActiveDelegationState } from "@/lib/types"

function dele(
  overrides: Partial<ActiveDelegationState> & { parent_tool_use_id: string }
): ActiveDelegationState {
  return {
    child_connection_id: "c1",
    child_conversation_id: 99,
    agent_type: "codex",
    ...overrides,
  }
}

describe("buildDelegationSeedEnvelopes", () => {
  it("seeds a delegation_started per running delegation, carrying the parent connection id", () => {
    const env = buildDelegationSeedEnvelopes(
      "parent-conn",
      [dele({ parent_tool_use_id: "pt-1" })],
      42
    )
    expect(env).toHaveLength(1)
    expect(env[0]).toMatchObject({
      seq: 42,
      connection_id: "parent-conn",
      type: "delegation_started",
      parent_connection_id: "parent-conn",
      parent_tool_use_id: "pt-1",
      child_connection_id: "c1",
      child_conversation_id: 99,
      agent_type: "codex",
      // Absent on older-backend snapshots → normalized to null.
      task_preview: null,
      task_id: null,
    })
  })

  it("passes the snapshot's task label + task id through to the seeded envelope", () => {
    const env = buildDelegationSeedEnvelopes(
      "parent-conn",
      [
        dele({
          parent_tool_use_id: "pt-1",
          task_preview: "执行 pnpm build",
          task_id: "task-uuid-3",
        }),
      ],
      1
    )
    expect(env[0]).toMatchObject({
      task_preview: "执行 pnpm build",
      task_id: "task-uuid-3",
    })
  })

  it("preserves order and emits one started envelope per delegation", () => {
    const env = buildDelegationSeedEnvelopes(
      "p",
      [
        dele({ parent_tool_use_id: "pt-a", child_conversation_id: 1 }),
        dele({ parent_tool_use_id: "pt-b", child_conversation_id: 2 }),
        dele({ parent_tool_use_id: "pt-c", child_conversation_id: 3 }),
      ],
      5
    )
    expect(env.map((e) => e.type)).toEqual([
      "delegation_started",
      "delegation_started",
      "delegation_started",
    ])
    expect(
      env.map((e) =>
        "parent_tool_use_id" in e ? e.parent_tool_use_id : undefined
      )
    ).toEqual(["pt-a", "pt-b", "pt-c"])
  })

  it("returns an empty array for no delegations", () => {
    expect(buildDelegationSeedEnvelopes("p", [], 0)).toEqual([])
  })

  it("fills parent_conversation_id from the snapshot's own conversation id", () => {
    // R2.6 — the replay producer must yield the SAME attribution value the
    // live broker event does. `ActiveDelegationState` has no such field, but
    // the snapshot it travels in does; taking it from there is the same move
    // already used for `parent_connection_id`.
    const env = buildDelegationSeedEnvelopes(
      "parent-conn",
      [dele({ parent_tool_use_id: "pt-1" })],
      1,
      77
    )
    expect(env[0]).toMatchObject({
      parent_connection_id: "parent-conn",
      parent_conversation_id: 77,
    })
  })

  it("leaves parent_conversation_id absent when the snapshot has none", () => {
    // R2.8 — no conversation id on the snapshot → the entry is unattributed.
    // It must NOT fall back to `child_conversation_id` (a different
    // conversation) or to the connection id (a different id system).
    const env = buildDelegationSeedEnvelopes(
      "parent-conn",
      [dele({ parent_tool_use_id: "pt-1", child_conversation_id: 99 })],
      1,
      null
    )
    expect(env[0]).toMatchObject({ parent_conversation_id: null })
    const seeded = env[0] as Extract<
      (typeof env)[number],
      { type: "delegation_started" }
    >
    expect(seeded.parent_conversation_id).not.toBe(99)
  })
})
