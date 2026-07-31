import { describe, expect, it } from "vitest"

import { isCancelScopeRetryable, needsCancelConfirmation } from "./cancel-scope"

/**
 * Both backend refusals mean "NOTHING was cancelled, re-preview". Recognizing
 * them is the difference between re-confirming and silently falling through to
 * the unbounded cancel this whole feature exists to prevent.
 *
 * Recognition is by Display-string marker, NOT by error code: the web handler
 * maps both variants to `AppErrorCode::InvalidInput`
 * (`web/handlers/acp.rs:513`), so `AcpError::code()`'s stable
 * `cancel_scope_token_rejected` / `cancel_scope_changed` never reach the
 * client. Same constraint `turn-busy.ts` documents.
 */
describe("isCancelScopeRetryable", () => {
  it("recognizes a rejected token as a bare string (Tauri AcpError Display)", () => {
    expect(
      isCancelScopeRetryable(
        "cancel scope token rejected: expired; re-run the preview"
      )
    ).toBe(true)
  })

  it("recognizes a moved scope as a bare string (Tauri AcpError Display)", () => {
    expect(
      isCancelScopeRetryable(
        "delegation scope changed since the preview; re-confirm before cancelling"
      )
    ).toBe(true)
  })

  it("recognizes both inside a web AppCommandError message", () => {
    // The web handler preserves the Display as `message` while flattening the
    // code to invalid_input — so the message is the only usable signal.
    expect(
      isCancelScopeRetryable({
        code: "invalid_input",
        message: "cancel scope token rejected: unknown or already used",
      })
    ).toBe(true)
    expect(
      isCancelScopeRetryable({
        code: "invalid_input",
        message:
          "delegation scope changed since the preview; re-confirm before cancelling",
      })
    ).toBe(true)
  })

  it("recognizes an Error instance carrying the marker", () => {
    expect(
      isCancelScopeRetryable(
        new Error(
          "cancel scope token rejected: issued for a different connection"
        )
      )
    ).toBe(true)
  })

  it("does NOT match unrelated failures", () => {
    // A genuine fault must NOT be treated as "re-preview and carry on".
    expect(isCancelScopeRetryable("connection not found: abc")).toBe(false)
    expect(
      isCancelScopeRetryable({ code: "invalid_input", message: "HTTP 500" })
    ).toBe(false)
    expect(isCancelScopeRetryable(null)).toBe(false)
    expect(isCancelScopeRetryable(undefined)).toBe(false)
    expect(isCancelScopeRetryable({})).toBe(false)
    expect(isCancelScopeRetryable(42)).toBe(false)
  })
})

describe("needsCancelConfirmation", () => {
  it("does not confirm when nothing would be terminated", () => {
    // R4.4: `token` is None exactly when count == 0 — a dialog here is pure
    // friction, there are no sub-agents to warn about.
    expect(
      needsCancelConfirmation({ count: 0, taskIds: [], expiresInMs: 0 })
    ).toBe(false)
  })

  it("confirms whenever the cascade would terminate something", () => {
    expect(
      needsCancelConfirmation({
        token: "t-1",
        count: 2,
        taskIds: ["a"],
        expiresInMs: 60000,
      })
    ).toBe(true)
  })

  it("does not confirm when count > 0 but no token was issued", () => {
    // Defensive: a token-less preview cannot authorize a bounded cancel, so
    // there is nothing a confirmation could commit.
    expect(
      needsCancelConfirmation({ count: 3, taskIds: [], expiresInMs: 0 })
    ).toBe(false)
  })

  it("counts still-starting delegations, never taskIds.length", () => {
    // `count` covers running + still-starting; a starting delegation has no
    // task_id yet but WILL be killed. Deriving from taskIds would show 0.
    expect(
      needsCancelConfirmation({
        token: "t-1",
        count: 1,
        taskIds: [],
        expiresInMs: 60000,
      })
    ).toBe(true)
  })
})
