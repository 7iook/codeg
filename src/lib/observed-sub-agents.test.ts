import { describe, expect, it } from "vitest"

import type { DelegationBinding } from "@/contexts/delegation-context"
import {
  DEFAULT_SILENCE_THRESHOLD_MS,
  UNKNOWN_AGENT_LABEL,
  buildObservedSubAgentRows,
  type ObservedSubAgentsInput,
} from "@/lib/observed-sub-agents"
import type { SubagentTrackedEntry } from "@/lib/subagent-transcript"

/** Deterministic PRNG (mulberry32) — property tests must be reproducible on
 *  CI, so the generated-input sweeps below are seeded, never Math.random. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(r: () => number, values: readonly T[]): T {
  return values[Math.floor(r() * values.length)]!
}

function binding(
  overrides: Partial<DelegationBinding> & { parentToolUseId: string }
): DelegationBinding {
  return {
    parentConnectionId: "p1",
    childConnectionId: "c1",
    childConversationId: 99,
    agentType: "codex",
    status: "running",
    task: "do the thing",
    taskId: `task-${overrides.parentToolUseId}`,
    parentConversationId: 1,
    ...overrides,
  }
}

function tracked(
  overrides: Partial<SubagentTrackedEntry> & { parentToolUseId: string }
): SubagentTrackedEntry {
  return {
    sessionId: "sess-1",
    lastFrameAt: 1_000,
    frames: [],
    ...overrides,
  }
}

function input(
  overrides: Partial<ObservedSubAgentsInput> = {}
): ObservedSubAgentsInput {
  return {
    delegations: [],
    subagents: [],
    currentConversationId: 1,
    conversationIdByExternalId: new Map(),
    now: 1_000,
    silenceThresholdMs: DEFAULT_SILENCE_THRESHOLD_MS,
    ...overrides,
  }
}

/** Generate a random-but-seeded mixed population of both sources. */
function generatePopulation(seed: number) {
  const r = rng(seed)
  const delegations: DelegationBinding[] = []
  const subagents: SubagentTrackedEntry[] = []
  const externalIds = ["sess-a", "sess-b", "sess-c", "sess-missing"]
  const delegationCount = Math.floor(r() * 6)
  const subagentCount = Math.floor(r() * 6)

  for (let i = 0; i < delegationCount; i += 1) {
    delegations.push(
      binding({
        parentToolUseId: `pt-d-${seed}-${i}`,
        status: pick(r, ["running", "ok", "err"] as const),
        errorCode: pick(r, [undefined, "canceled", "timeout"]),
        agentType: pick(r, ["codex", "claude-code"] as const),
        task: pick(r, ["a task", null]),
        parentConversationId: pick(r, [1, 2, null]),
        taskId: pick(r, [`task-${i}`, null]),
      })
    )
  }
  for (let i = 0; i < subagentCount; i += 1) {
    subagents.push(
      tracked({
        parentToolUseId: `pt-s-${seed}-${i}`,
        sessionId: pick(r, [...externalIds, null]),
        lastFrameAt: pick(r, [0, 500, 1_000, 100_000]),
      })
    )
  }
  const map = new Map<string, number>([
    ["sess-a", 1],
    ["sess-b", 2],
    ["sess-c", 1],
  ])
  return { delegations, subagents, map, now: 20_000 }
}

const TERMINAL_LIFECYCLES = ["completed", "canceled", "failed"] as const

describe("buildObservedSubAgentRows", () => {
  // ── Property 1: 两维度归类完备 + 投影确定 ──────────────────────────────
  describe("Property 1: dimension completeness and deterministic projection", () => {
    it("property_every_input_yields_exactly_one_row_with_both_dimensions", () => {
      for (let seed = 1; seed <= 200; seed += 1) {
        const { delegations, subagents, map, now } = generatePopulation(seed)
        const rows = buildObservedSubAgentRows(
          input({
            delegations,
            subagents,
            conversationIdByExternalId: map,
            now,
          })
        )
        expect(rows).toHaveLength(delegations.length + subagents.length)
        expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
        for (const row of rows) {
          expect(["current", "other", "unattributed"]).toContain(row.scope)
          expect([
            "running",
            "silent",
            "completed",
            "canceled",
            "failed",
          ]).toContain(row.lifecycle)
          expect(["current", "other", "unattributed", "completed"]).toContain(
            row.partition
          )
        }
      }
    })

    it("property_partition_is_a_function_of_lifecycle_then_scope", () => {
      for (let seed = 1; seed <= 200; seed += 1) {
        const { delegations, subagents, map, now } = generatePopulation(seed)
        const rows = buildObservedSubAgentRows(
          input({
            delegations,
            subagents,
            conversationIdByExternalId: map,
            now,
          })
        )
        for (const row of rows) {
          const terminal = (TERMINAL_LIFECYCLES as readonly string[]).includes(
            row.lifecycle
          )
          // R4.9 — lifecycle wins: any terminal row lands in "completed"
          // regardless of which conversation it belongs to.
          expect(row.partition).toBe(terminal ? "completed" : row.scope)
        }
      }
    })

    it("property_output_order_is_deterministic_across_repeated_calls", () => {
      for (let seed = 1; seed <= 60; seed += 1) {
        const { delegations, subagents, map, now } = generatePopulation(seed)
        const args = input({
          delegations,
          subagents,
          conversationIdByExternalId: map,
          now,
        })
        const a = buildObservedSubAgentRows(args).map((r) => r.id)
        const b = buildObservedSubAgentRows(args).map((r) => r.id)
        // Input ORDER must not decide output order either — the panel diffs
        // on this list, so a reshuffled provider map must not reorder rows.
        const reversed = buildObservedSubAgentRows(
          input({
            delegations: [...delegations].reverse(),
            subagents: [...subagents].reverse(),
            conversationIdByExternalId: map,
            now,
          })
        ).map((r) => r.id)
        expect(b).toEqual(a)
        expect(reversed).toEqual(a)
      }
    })
  })

  // ── Property 2: 内部 SUB 操作能力恒受限 ───────────────────────────────
  describe("Property 2: built-in SUB capabilities are always restricted", () => {
    it("property_builtin_rows_never_offer_cancel_or_open_in_tab", () => {
      for (let seed = 1; seed <= 200; seed += 1) {
        const { delegations, subagents, map, now } = generatePopulation(seed)
        const rows = buildObservedSubAgentRows(
          input({
            delegations,
            subagents,
            conversationIdByExternalId: map,
            now,
          })
        )
        for (const row of rows.filter((r) => r.kind === "builtin")) {
          expect(row.canCancel).toBe(false)
          expect(row.canOpenInTab).toBe(false)
        }
      }
    })

    it("running_delegation_row_offers_cancel_and_open_in_tab", () => {
      const rows = buildObservedSubAgentRows(
        input({ delegations: [binding({ parentToolUseId: "pt-1" })] })
      )
      expect(rows[0]!.canCancel).toBe(true)
      expect(rows[0]!.canOpenInTab).toBe(true)
    })

    it("terminal_delegation_row_is_no_longer_cancelable_but_stays_openable", () => {
      const rows = buildObservedSubAgentRows(
        input({
          delegations: [binding({ parentToolUseId: "pt-1", status: "ok" })],
        })
      )
      expect(rows[0]!.canCancel).toBe(false)
      expect(rows[0]!.canOpenInTab).toBe(true)
    })
  })

  // ── Property 3: 字段缺失全域封闭 ──────────────────────────────────────
  describe("Property 3: field-absence is closed over the whole domain", () => {
    it("property_missing_fields_never_throw_and_never_drop_a_row", () => {
      const r = rng(7)
      for (let i = 0; i < 200; i += 1) {
        // Deliberately hostile: fields the row model reads are randomly
        // absent, and the whole input object is partially absent too.
        const partialDelegation = {
          parentToolUseId: `pt-${i}`,
          status: pick(r, ["running", "ok", "err", undefined]),
          agentType: pick(r, ["codex", undefined, null]),
          task: pick(r, ["t", null, undefined]),
          taskId: pick(r, ["task-1", null, undefined]),
          parentConversationId: pick(r, [1, null, undefined]),
          childConversationId: pick(r, [5, null, undefined]),
        } as unknown as DelegationBinding
        const partialSubagent = {
          parentToolUseId: `pt-s-${i}`,
          sessionId: pick(r, ["sess-a", null, undefined]),
          lastFrameAt: pick(r, [1_000, null, undefined]),
          frames: pick(r, [[], undefined]),
        } as unknown as SubagentTrackedEntry

        let rows: ReturnType<typeof buildObservedSubAgentRows> = []
        expect(() => {
          rows = buildObservedSubAgentRows({
            delegations: [partialDelegation],
            subagents: [partialSubagent],
            currentConversationId: pick(r, [1, null]),
            conversationIdByExternalId: new Map([["sess-a", 1]]),
            now: 20_000,
          } as ObservedSubAgentsInput)
        }).not.toThrow()
        expect(rows).toHaveLength(2)
        for (const row of rows) {
          expect(typeof row.id).toBe("string")
          expect(row.id.length).toBeGreaterThan(0)
          expect(typeof row.agentLabel).toBe("string")
          expect(row.agentLabel.length).toBeGreaterThan(0)
        }
      }
    })

    it("missing_agent_type_degrades_to_a_neutral_placeholder_not_blank", () => {
      const rows = buildObservedSubAgentRows(
        input({ subagents: [tracked({ parentToolUseId: "pt-s" })] })
      )
      expect(rows[0]!.agentType).toBeNull()
      expect(rows[0]!.agentLabel).toBe(UNKNOWN_AGENT_LABEL)
      expect(rows[0]!.agentLabel.trim().length).toBeGreaterThan(0)
    })

    it("tolerates_a_wholly_absent_input_and_returns_an_array_not_null", () => {
      const rows = buildObservedSubAgentRows(
        {} as unknown as ObservedSubAgentsInput
      )
      expect(rows).toEqual([])
    })
  })

  // ── Requirement 2.9 / 2.11: 委托行的会话归属 ─────────────────────────
  describe("delegation conversation scope", () => {
    it("delegation_scope_is_current_when_parent_conversation_id_matches", () => {
      const rows = buildObservedSubAgentRows(
        input({
          currentConversationId: 7,
          delegations: [
            binding({ parentToolUseId: "pt-1", parentConversationId: 7 }),
          ],
        })
      )
      expect(rows[0]!.scope).toBe("current")
      expect(rows[0]!.partition).toBe("current")
    })

    it("delegation_scope_is_other_when_parent_conversation_id_differs", () => {
      const rows = buildObservedSubAgentRows(
        input({
          currentConversationId: 7,
          delegations: [
            binding({ parentToolUseId: "pt-1", parentConversationId: 8 }),
          ],
        })
      )
      expect(rows[0]!.scope).toBe("other")
      expect(rows[0]!.partition).toBe("other")
    })

    it("delegation_scope_is_unattributed_when_parent_conversation_id_absent", () => {
      // R2.11 — absent must NOT be assumed to be the current conversation,
      // even when the current conversation is itself unknown (cold start).
      for (const current of [7, null]) {
        const rows = buildObservedSubAgentRows(
          input({
            currentConversationId: current,
            delegations: [
              binding({ parentToolUseId: "pt-1", parentConversationId: null }),
            ],
          })
        )
        expect(rows[0]!.scope).toBe("unattributed")
        expect(rows[0]!.partition).toBe("unattributed")
      }
    })
  })

  // ── Property 7: 归属对映射到达时序无关 ────────────────────────────────
  describe("Property 7: attribution is independent of mapping arrival order", () => {
    it("property_builtin_scope_depends_only_on_the_snapshot_passed_this_call", () => {
      for (let seed = 1; seed <= 120; seed += 1) {
        const r = rng(seed)
        const sessionId = pick(r, ["sess-a", "sess-b"])
        const entry = tracked({
          parentToolUseId: `pt-s-${seed}`,
          sessionId,
          lastFrameAt: 19_000,
        })
        const empty = new Map<string, number>()
        const resolved = new Map<string, number>([
          ["sess-a", 1],
          ["sess-b", 2],
        ])
        const base = input({
          subagents: [entry],
          currentConversationId: 1,
          now: 20_000,
        })

        // Mapping not yet built → unattributed, and NOT dropped.
        const before = buildObservedSubAgentRows({
          ...base,
          conversationIdByExternalId: empty,
        })
        expect(before).toHaveLength(1)
        expect(before[0]!.scope).toBe("unattributed")
        expect(before[0]!.conversationId).toBeNull()

        // Same entry, mapping now available → corrected on the NEXT
        // evaluation with no re-delivery of any frame event (R3.5).
        const after = buildObservedSubAgentRows({
          ...base,
          conversationIdByExternalId: resolved,
        })
        expect(after).toHaveLength(1)
        expect(after[0]!.scope).toBe(
          sessionId === "sess-a" ? "current" : "other"
        )
        expect(after[0]!.conversationId).toBe(sessionId === "sess-a" ? 1 : 2)

        // And re-evaluating with the mapping REMOVED again degrades back —
        // proving nothing was cached inside the selector.
        const removedAgain = buildObservedSubAgentRows({
          ...base,
          conversationIdByExternalId: empty,
        })
        expect(removedAgain[0]!.scope).toBe("unattributed")
      }
    })

    it("accepts_a_plain_record_mapping_snapshot_as_well_as_a_map", () => {
      const rows = buildObservedSubAgentRows(
        input({
          subagents: [
            tracked({
              parentToolUseId: "pt-s",
              sessionId: "sess-a",
              lastFrameAt: 19_500,
            }),
          ],
          conversationIdByExternalId: { "sess-a": 1 },
          now: 20_000,
        })
      )
      expect(rows[0]!.scope).toBe("current")
    })

    it("unresolvable_session_id_is_never_treated_as_the_current_conversation", () => {
      const rows = buildObservedSubAgentRows(
        input({
          subagents: [
            tracked({ parentToolUseId: "pt-s", sessionId: "sess-nope" }),
          ],
          conversationIdByExternalId: new Map([["sess-a", 1]]),
        })
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.scope).toBe("unattributed")
    })
  })

  // ── Property 8: 内部 SUB 永不获得终态 ─────────────────────────────────
  describe("Property 8: built-in SUBs never receive a terminal lifecycle", () => {
    it("property_builtin_lifecycle_is_only_running_or_silent", () => {
      const r = rng(11)
      for (let i = 0; i < 300; i += 1) {
        const now = Math.floor(r() * 1_000_000)
        const lastFrameAt = pick(r, [
          0,
          now,
          now - 1,
          now - DEFAULT_SILENCE_THRESHOLD_MS,
          now - DEFAULT_SILENCE_THRESHOLD_MS - 1,
          now + 5_000, // clock skew: frame stamped in the future
          null,
        ]) as number | null
        const rows = buildObservedSubAgentRows(
          input({
            subagents: [
              tracked({
                parentToolUseId: `pt-s-${i}`,
                lastFrameAt: lastFrameAt as number,
                sessionId: pick(r, ["sess-a", null]),
              }),
            ],
            conversationIdByExternalId: new Map([["sess-a", 1]]),
            now,
            silenceThresholdMs: pick(r, [
              DEFAULT_SILENCE_THRESHOLD_MS,
              1,
              60_000,
            ]),
          })
        )
        expect(rows).toHaveLength(1)
        expect(["running", "silent"]).toContain(rows[0]!.lifecycle)
        expect(rows[0]!.partition).not.toBe("completed")
      }
    })

    it("builtin_is_running_within_the_threshold_and_silent_past_it", () => {
      const now = 100_000
      const fresh = buildObservedSubAgentRows(
        input({
          subagents: [
            tracked({ parentToolUseId: "pt-fresh", lastFrameAt: now - 14_999 }),
          ],
          now,
        })
      )
      const stale = buildObservedSubAgentRows(
        input({
          subagents: [
            tracked({ parentToolUseId: "pt-stale", lastFrameAt: now - 15_001 }),
          ],
          now,
        })
      )
      expect(fresh[0]!.lifecycle).toBe("running")
      expect(stale[0]!.lifecycle).toBe("silent")
      expect(DEFAULT_SILENCE_THRESHOLD_MS).toBe(15_000)
    })
  })

  // ── Requirement 4.6: 委托行的生命周期映射 ────────────────────────────
  describe("delegation lifecycle mapping", () => {
    it("maps_binding_status_to_lifecycle_and_partitions_terminals_together", () => {
      const rows = buildObservedSubAgentRows(
        input({
          currentConversationId: 1,
          delegations: [
            binding({ parentToolUseId: "pt-run", status: "running" }),
            binding({ parentToolUseId: "pt-ok", status: "ok" }),
            binding({
              parentToolUseId: "pt-cancel",
              status: "err",
              errorCode: "canceled",
            }),
            binding({
              parentToolUseId: "pt-fail",
              status: "err",
              errorCode: "timeout",
            }),
          ],
        })
      )
      const byId = new Map(rows.map((r) => [r.parentToolUseId, r]))
      expect(byId.get("pt-run")!.lifecycle).toBe("running")
      expect(byId.get("pt-ok")!.lifecycle).toBe("completed")
      expect(byId.get("pt-cancel")!.lifecycle).toBe("canceled")
      expect(byId.get("pt-fail")!.lifecycle).toBe("failed")
      for (const id of ["pt-ok", "pt-cancel", "pt-fail"]) {
        expect(byId.get(id)!.partition).toBe("completed")
      }
      expect(byId.get("pt-run")!.partition).toBe("current")
    })

    it("terminal_delegation_from_another_conversation_still_lands_in_completed", () => {
      const rows = buildObservedSubAgentRows(
        input({
          currentConversationId: 1,
          delegations: [
            binding({
              parentToolUseId: "pt-1",
              status: "ok",
              parentConversationId: 2,
            }),
          ],
        })
      )
      expect(rows[0]!.scope).toBe("other")
      expect(rows[0]!.partition).toBe("completed")
    })
  })
})
