/**
 * Recognition + policy for the cancel-scope confirmation (spec R4).
 *
 * A stop click cascades into `cancel_by_parent_turn`, which terminates EVERY
 * delegation in the parent-turn scope. The preview exists so the user is told
 * how many before it happens; the token exists so the commit destroys exactly
 * what was shown and nothing more.
 *
 * Dependency-free on purpose (no api / transport / react imports) so the
 * policy is unit-testable without loading the API client — same shape as
 * `turn-busy.ts`.
 */

/**
 * Mirror of the Rust `CancelScopePreview`
 * (`src-tauri/src/acp/delegation/cancel_scope.rs`, camelCase on the wire).
 */
export interface CancelScopePreview {
  /**
   * Authorization for the confirmed cancel. Absent EXACTLY when
   * `count === 0` — nothing to authorize.
   */
  token?: string
  /**
   * Delegations this cancel would terminate: running PLUS still-starting.
   * Authoritative, and can exceed `taskIds.length` — a delegation still
   * starting up has no task_id yet but will still be killed. This is the
   * number to display.
   */
  count: number
  /** task_ids of the running subset only. Partial by construction. */
  taskIds: string[]
  /** Remaining token validity; `0` when no token was issued. */
  expiresInMs: number
}

/**
 * Mirror of the Rust `CancelScopeResult`
 * (`src-tauri/src/acp/delegation/broker.rs`).
 *
 * These are ACTUALS, never the token's original count: a delegation that
 * finished on its own while the dialog was open is not a kill. Report `count`.
 */
export interface CancelScopeResult {
  /** Total terminated = `terminatedTaskIds.length` + `terminatedStarting`. */
  count: number
  /** Terminated delegations that were already running. Partial — see below. */
  terminatedTaskIds: string[]
  /** Terminated delegations still starting up, which had no task_id to list. */
  terminatedStarting: number
}

// Substrings of the two backend `AcpError` Display strings
// (`src-tauri/src/acp/error.rs:53,60`). Matched as substrings so a later
// elaboration of the message keeps recognition working.
//
// Deliberately NOT matched on `AcpError::code()`'s stable
// `cancel_scope_token_rejected` / `cancel_scope_changed`: that code channel is
// not surfaced on this path. Tauri serializes `AcpError` to its bare Display
// string, and the web handler flattens BOTH variants into
// `AppErrorCode::InvalidInput` (`web/handlers/acp.rs:513`) — which is also what
// `ConnectionNotFound` maps to, so the code cannot discriminate them.
const TOKEN_REJECTED_MARKER = "cancel scope token rejected"
const SCOPE_CHANGED_MARKER = "delegation scope changed since the preview"

function carriesMarker(text: string): boolean {
  return (
    text.includes(TOKEN_REJECTED_MARKER) || text.includes(SCOPE_CHANGED_MARKER)
  )
}

/**
 * True when the backend refused the confirmed cancel because the
 * authorization was stale (token used / expired / wrong connection) or the
 * scope moved since the preview.
 *
 * **Both mean NOTHING was cancelled.** The only correct response is to
 * re-preview and re-confirm. Falling back to the plain unbounded
 * `acpCancel` here would kill an unknown number of sub-agents with no
 * disclosure — precisely the hole this feature closes.
 */
export function isCancelScopeRetryable(error: unknown): boolean {
  if (typeof error === "string") return carriesMarker(error)
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return carriesMarker(message)
  }
  return false
}

/**
 * Whether the stop click must show the confirmation dialog first.
 *
 * `false` → cancel directly through the plain path (R4.4): there are no
 * sub-agents to warn about, so a confirmation would be pure friction.
 *
 * Requires a token as well as a non-zero count: without one there is no
 * authorization a confirmation could commit, so confirming would either
 * dead-end or tempt an unbounded fallback. The backend keeps the two in
 * lockstep (`token: None` ⇔ `count == 0`); this is defense in depth.
 */
export function needsCancelConfirmation(preview: CancelScopePreview): boolean {
  return preview.count > 0 && typeof preview.token === "string"
}
