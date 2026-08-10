/**
 * Runtime zod schemas mirroring the Rust `ContentBlock::HookLifecycle` /
 * `ContentBlock::WorkflowRun` payloads (parsers/claude/hook.rs +
 * parsers/claude/workflow.rs), serialized with serde `tag = "type"`,
 * `rename_all = "snake_case"`.
 *
 * Why this exists (decision-card §3.3 hop 7): the hand-written TS types in
 * `@/lib/types` and these schemas are two views of ONE contract. The paired
 * test (`claude-events.schema.test.ts`) asserts, at COMPILE time, that
 * `z.infer` of each schema is structurally identical to its TS type — so if
 * the backend renames a field and only one side is updated, the build breaks.
 * The same test also asserts, at RUN time, that a real backend-shaped payload
 * parses. A6 is enforced here too: the schemas are `.strict()`, so a payload
 * carrying `command_raw` / `stdout_raw` / `stderr_raw` (the debug-only fields
 * the backend must never emit to the frontend) fails validation loudly.
 */
import { z } from "zod"

export const hookOutcomeSchema = z.enum([
  "pass",
  "soft_context",
  "hard_block",
  "error",
])

export const hookLifecyclePayloadSchema = z
  .object({
    hook_name: z.string(),
    hook_event: z.string(),
    tool_use_id: z.string().nullish(),
    outcome: hookOutcomeSchema,
    outcome_reason: z.string().nullish(),
    exit_code: z.number(),
    duration_ms: z.number(),
    command_display: z.string().nullish(),
    additional_context: z.array(z.string()).optional(),
    hook_specific_output: z.unknown().optional(),
    timestamp: z.string(),
  })
  .strict()

export const workflowStatusSchema = z.enum([
  "started",
  "running",
  "completed",
  "failed",
  "killed",
  "stopped",
  "unknown",
])

export const workflowUsageSchema = z
  .object({
    total_tokens: z.number(),
    duration_ms: z.number(),
  })
  .strict()

export const workflowProgressNodeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("workflow_phase"),
      name: z.string().nullish(),
      elapsed_ms: z.number().nullish(),
      agent_count: z.number().nullish(),
    })
    .strict(),
  z
    .object({
      type: z.literal("workflow_agent"),
      index: z.number(),
      state: z.string().nullish(),
      prompt: z.string().nullish(),
      tool_calls: z.number().nullish(),
    })
    .strict(),
])

export const workflowRunPayloadSchema = z
  .object({
    task_id: z.string(),
    workflow_name: z.string().nullish(),
    task_type: z.string(),
    status: workflowStatusSchema,
    workflow_progress: z.array(workflowProgressNodeSchema).optional(),
    prompt: z.string().nullish(),
    tool_use_id: z.string().nullish(),
    session_id: z.string().nullish(),
    output_file: z.string().nullish(),
    usage: workflowUsageSchema.nullish(),
  })
  .strict()
