/**
 * §3.3 hop 7 drift guard. Two views of one contract must not drift:
 *   • the hand-written TS types in `@/lib/types` (compile-time), and
 *   • the zod schemas in `./claude-events` (runtime).
 *
 * This file asserts they agree, in three ways:
 *   1. COMPILE time — `z.infer` of each schema is assignable both ways against
 *      its TS type. Rename/retype a field on one side only → tsc fails here.
 *   2. RUN time — a payload shaped exactly as the Rust parser serializes it
 *      (serde tag="type", snake_case) parses cleanly.
 *   3. A6 — a payload carrying the debug-only `*_raw` fields is REJECTED by
 *      the `.strict()` schema, proving those bytes can't slip to the frontend.
 */
import { describe, expect, it } from "vitest"

import type {
  HookLifecyclePayload,
  WorkflowRunPayload,
  WorkflowProgressNode,
} from "@/lib/types"
import {
  hookLifecyclePayloadSchema,
  workflowProgressNodeSchema,
  workflowRunPayloadSchema,
} from "./claude-events"
import type { z } from "zod"

// ── 1. Compile-time structural equality (bidirectional assignability) ───────
//
// `Equal` is exact: it fails if either side has a field the other lacks or a
// differently-typed field. A one-sided backend rename breaks the build right
// here, which is the whole point of the guard.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

type HookInfer = z.infer<typeof hookLifecyclePayloadSchema>
type WorkflowInfer = z.infer<typeof workflowRunPayloadSchema>
type ProgressInfer = z.infer<typeof workflowProgressNodeSchema>

// Each constant only type-checks when the schema's inferred type is EXACTLY
// its hand-written TS counterpart. A one-sided backend rename makes the
// corresponding line a compile error — the guard is the assignment itself.
const _hookTypesMatch: Equal<HookInfer, HookLifecyclePayload> = true
const _workflowTypesMatch: Equal<WorkflowInfer, WorkflowRunPayload> = true
const _progressTypesMatch: Equal<ProgressInfer, WorkflowProgressNode> = true
void _hookTypesMatch
void _workflowTypesMatch
void _progressTypesMatch

describe("claude-events zod schemas mirror the backend payloads", () => {
  // §4.1: the merged Stop-hook shape the Rust parser emits (frontend-visible
  // fields only — the `*_raw` trio is serde(skip) without claude-hook-debug).
  it("accepts a real HookLifecycle payload", () => {
    const payload = {
      hook_name: "Stop",
      hook_event: "Stop",
      tool_use_id: "e36bffa1-3acc-4549-84a5-fec0e2501ce6",
      outcome: "soft_context",
      outcome_reason: "[P1 stop-gate] cleanup still pending",
      exit_code: 0,
      duration_ms: 14714,
      command_display: "claude-stop-orchestrator.ps1",
      additional_context: ["[P1 stop-gate] cleanup still pending"],
      hook_specific_output: { hookEventName: "Stop" },
      timestamp: "2026-08-07T10:11:03.440Z",
    }
    const parsed = hookLifecyclePayloadSchema.parse(payload)
    expect(parsed.hook_name).toBe("Stop")
    expect(parsed.outcome).toBe("soft_context")
  })

  // A6: raw command / stdout / stderr must never reach the frontend. The
  // schema is `.strict()`, so their presence is a hard parse failure — this
  // is the test that would catch a backend accidentally shipping them.
  it("rejects a HookLifecycle payload carrying the debug-only *_raw fields", () => {
    const leaky = {
      hook_name: "Stop",
      hook_event: "Stop",
      outcome: "pass",
      exit_code: 0,
      duration_ms: 10,
      timestamp: "2026-08-07T10:11:03.440Z",
      command_raw: "pwsh -File C:/secret/path/hook.ps1",
      stdout_raw: "...",
      stderr_raw: "...",
    }
    const result = hookLifecyclePayloadSchema.safeParse(leaky)
    expect(result.success).toBe(false)
  })

  it("rejects an unknown HookOutcome value", () => {
    const bad = {
      hook_name: "Stop",
      hook_event: "Stop",
      outcome: "blocked", // not one of pass/soft_context/hard_block/error
      exit_code: 0,
      duration_ms: 10,
      timestamp: "2026-08-07T10:11:03.440Z",
    }
    expect(hookLifecyclePayloadSchema.safeParse(bad).success).toBe(false)
  })

  // A cumulative workflow snapshot with a phase + agent node (recon R7 shape).
  it("accepts a real WorkflowRun payload", () => {
    const payload = {
      task_id: "wbk63ch2d",
      workflow_name: "demo-workflow",
      task_type: "local_workflow",
      status: "completed",
      workflow_progress: [
        { type: "workflow_phase", name: "Scan", agent_count: 1 },
        { type: "workflow_agent", index: 1, state: "success" },
      ],
      output_file: "/tmp/out.md",
      usage: { total_tokens: 9000, duration_ms: 5280 },
    }
    const parsed = workflowRunPayloadSchema.parse(payload)
    expect(parsed.task_id).toBe("wbk63ch2d")
    expect(parsed.status).toBe("completed")
    expect(parsed.workflow_progress).toHaveLength(2)
  })

  it("rejects an unknown workflow_progress node type", () => {
    const bad = { type: "workflow_mystery", index: 1 }
    expect(workflowProgressNodeSchema.safeParse(bad).success).toBe(false)
  })

  it("rejects an unknown WorkflowStatus value", () => {
    const bad = {
      task_id: "x",
      task_type: "local_workflow",
      status: "paused", // not a legal WorkflowStatus
    }
    expect(workflowRunPayloadSchema.safeParse(bad).success).toBe(false)
  })
})
