/**
 * Mid-turn steering: the queue item's delivery state machine and the capability
 * gate, as pure functions (design §2.5 / §2.5.1).
 *
 * Dependency-free on purpose: the transitions below are the whole correctness
 * argument for "never lost, never silently duplicated", so they are unit-testable
 * without loading React, the API client, or the connection store.
 */

/**
 * Mirror of the Rust `SteerOutcome` (`src-tauri/src/acp/types.rs`), which
 * serializes `#[serde(rename_all = "camelCase")]`.
 *
 * FOUR variants, not three. The fourth (`unknown`) is the point of the type: it
 * is neither success nor failure, and collapsing it into either one asserts a
 * fact we do not have.
 */
export type SteerOutcome = "injected" | "startedNewTurn" | "failed" | "unknown"

/**
 * Delivery state of a queued message.
 *
 * - `queued` — waiting. The only state in which a delivery may be started.
 * - `in_flight` — a delivery is out (auto-flush OR "send now"). Shared by both
 *   paths so one item can never be dequeued twice (design §2.3.1).
 * - `delivered` — terminal. The agent took ownership; never re-sent.
 * - `unknown` — no response came back. Whether the agent got it is unknowable,
 *   so this is NEVER auto-retried; only the user leaves this state.
 */
export type QueueItemStatus = "queued" | "in_flight" | "delivered" | "unknown"

/**
 * The capability gate for the per-item "send now" affordance (R2.2).
 *
 * `undefined` means the `initialize` probe hasn't landed (or an older server
 * omitted the field) and is deliberately treated the SAME as a confirmed
 * `false`: offering the action would promise an interruption the agent may not
 * be able to perform. The backend refuses independently
 * (`AcpError::SteeringUnsupported`), so this gate is UX, not safety.
 */
export function isSteeringSupported(
  supportsSteering: boolean | undefined
): boolean {
  return supportsSteering === true
}

/**
 * Whether a queue item may offer "send now" right now.
 *
 * Gated on `queued` — NOT merely "not delivered". An `in_flight` item already
 * has a delivery out; offering the action again is the double-dequeue this flag
 * exists to prevent. An `unknown` item is also excluded: re-sending it is a real
 * duplicate-execution risk, so it is surfaced through its own explicit resend
 * affordance rather than the ordinary one.
 */
export function canSendNow(
  status: QueueItemStatus,
  supportsSteering: boolean | undefined
): boolean {
  return status === "queued" && isSteeringSupported(supportsSteering)
}

/**
 * The status an `in_flight` item moves to when its outcome arrives.
 *
 * - `injected` / `startedNewTurn` → `delivered`. Both mean the agent accepted the
 *   message. `startedNewTurn` is the trap: it looks like a fallback, but the
 *   message is ALREADY executing in a turn we cannot observe, so re-sending it
 *   would run the user's instruction twice (design §2.4).
 * - `failed` → `queued`. A response came back and explicitly refused, so the
 *   message was definitively NOT accepted: re-queueing cannot duplicate
 *   execution, and the item stays clickable.
 * - `unknown` → `unknown`. Terminal for automation, not for the user.
 */
export function nextStatusForOutcome(outcome: SteerOutcome): QueueItemStatus {
  switch (outcome) {
    case "injected":
    case "startedNewTurn":
      return "delivered"
    case "failed":
      return "queued"
    case "unknown":
      return "unknown"
  }
}
