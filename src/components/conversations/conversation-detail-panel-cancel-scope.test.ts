import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Wiring gates for the cancel-scope confirmation (spec R4).
 *
 * The behavioral tests (`use-connection-lifecycle.cancel-scope.test.ts`,
 * `cancel-scope.test.ts`) mock `useConnection`, so they stay green even if
 * nothing in production reaches the endpoints — which is exactly the state this
 * feature shipped in twice: a complete, 292-test backend with zero frontend.
 * These assertions read the SHIPPED source so a disconnected hop fails.
 */
const apiSource = readFileSync(resolve(process.cwd(), "src/lib/api.ts"), "utf8")
const contextSource = readFileSync(
  resolve(process.cwd(), "src/contexts/acp-connections-context.tsx"),
  "utf8"
)
const useConnectionSource = readFileSync(
  resolve(process.cwd(), "src/hooks/use-connection.ts"),
  "utf8"
)
const lifecycleSource = readFileSync(
  resolve(process.cwd(), "src/hooks/use-connection-lifecycle.ts"),
  "utf8"
)
const panelSource = readFileSync(
  resolve(
    process.cwd(),
    "src/components/conversations/conversation-detail-panel.tsx"
  ),
  "utf8"
)

describe("the endpoints are reachable from src/ at all", () => {
  it("api.ts calls acp_preview_cancel_scope through the transport", () => {
    // The transport hop — works in BOTH Tauri and web modes. This is the line
    // whose absence made the whole backend unreachable.
    expect(apiSource).toContain(
      'getTransport().call("acp_preview_cancel_scope"'
    )
  })

  it("api.ts calls acp_cancel_with_scope_token through the transport", () => {
    expect(apiSource).toContain(
      'getTransport().call("acp_cancel_with_scope_token"'
    )
  })

  it("passes scopeToken camelCase, matching the backend params", () => {
    // `AcpCancelWithScopeTokenParams` is `rename_all = "camelCase"`; a
    // snake_case key would 4xx at deserialization.
    const idx = apiSource.indexOf(
      'getTransport().call("acp_cancel_with_scope_token"'
    )
    expect(apiSource.slice(idx, idx + 200)).toContain("scopeToken,")
  })
})

describe("the chain from the stop button down to api.ts is connected", () => {
  it("the context action calls the api client (not a local stub)", () => {
    expect(contextSource).toContain("acpPreviewCancelScope(conn.connectionId)")
    expect(contextSource).toContain(
      "acpCancelWithScopeToken(conn.connectionId, scopeToken)"
    )
  })

  it("the context exposes both actions on the actions value", () => {
    // Present in the useMemo body AND its dep array (twice total); a value
    // defined but not exported from the memo never reaches a consumer.
    const previewRefs = contextSource.match(/^\s+previewCancelScope,$/gm) ?? []
    expect(previewRefs.length).toBeGreaterThanOrEqual(2)
    const commitRefs = contextSource.match(/^\s+cancelWithScopeToken,$/gm) ?? []
    expect(commitRefs.length).toBeGreaterThanOrEqual(2)
  })

  it("useConnection forwards both actions for its contextKey", () => {
    expect(useConnectionSource).toContain(
      "actions.previewCancelScope(contextKey)"
    )
    expect(useConnectionSource).toContain(
      "actions.cancelWithScopeToken(contextKey, scopeToken)"
    )
  })

  it("the lifecycle hook consumes them from the connection", () => {
    expect(lifecycleSource).toContain(
      "previewCancelScope: connPreviewCancelScope"
    )
    expect(lifecycleSource).toContain(
      "cancelWithScopeToken: connCancelWithScopeToken"
    )
  })

  it("handleCancel previews BEFORE cancelling", () => {
    // The ordering IS the feature: cancelling first and previewing after would
    // disclose a cascade that already happened.
    const handlerIdx = lifecycleSource.indexOf(
      "const handleCancel = useCallback"
    )
    expect(handlerIdx).toBeGreaterThan(-1)
    const handler = lifecycleSource.slice(handlerIdx, handlerIdx + 1800)
    expect(handler).toContain("await connPreviewCancelScope()")
    expect(handler.indexOf("connPreviewCancelScope()")).toBeLessThan(
      handler.indexOf("connCancel()")
    )
  })

  it("handleCancel gates the dialog on needsCancelConfirmation", () => {
    const handlerIdx = lifecycleSource.indexOf(
      "const handleCancel = useCallback"
    )
    const handler = lifecycleSource.slice(handlerIdx, handlerIdx + 1800)
    expect(handler).toContain("needsCancelConfirmation(preview)")
    expect(handler).toContain("setCancelScopeConfirm(")
  })

  it("the commit path never calls the unbounded cancel on a refusal", () => {
    // A `connCancel()` inside the retryable branch would be the disclosure
    // hole: we showed N, then killed an unknown number.
    const commitIdx = lifecycleSource.indexOf(
      "const commitCancel = useCallback"
    )
    expect(commitIdx).toBeGreaterThan(-1)
    const commit = lifecycleSource.slice(commitIdx, commitIdx + 2400)
    expect(commit).toContain("isCancelScopeRetryable(e)")
    const retryableIdx = commit.indexOf("if (!isCancelScopeRetryable(e))")
    const freshIdx = commit.indexOf("await connPreviewCancelScope()")
    // Between recognizing the refusal and getting a FRESH preview there must be
    // no cancel: the only connCancel() comes after the re-preview proved the
    // cascade empty. Comment prose is stripped so the gate tests code, not text.
    const refusalBranch = commit
      .slice(retryableIdx, freshIdx)
      .replace(/\/\/[^\n]*/g, "")
    expect(refusalBranch).not.toContain("connCancel(")
  })

  it("reports the result's count, never the preview's", () => {
    const reportIdx = lifecycleSource.indexOf("const reportTerminated")
    expect(reportIdx).toBeGreaterThan(-1)
    const report = lifecycleSource.slice(reportIdx, reportIdx + 400)
    expect(report).toContain("count: result.count")
    // `terminatedTaskIds.length` under-reports still-starting delegations.
    expect(report).not.toContain("terminatedTaskIds.length")
  })
})

describe("the panel actually renders the dialog", () => {
  it("takes cancelScopeConfirm off the lifecycle hook", () => {
    expect(panelSource).toContain("cancelScopeConfirm,")
  })

  it("mounts CancelScopeDialog with that confirmation", () => {
    // The last hop. Without it the hook resolves a confirmation nobody shows,
    // and the stop button hangs silently instead of cancelling.
    expect(panelSource).toContain(
      "<CancelScopeDialog confirmation={cancelScopeConfirm} />"
    )
    expect(panelSource).toContain(
      'from "@/components/chat/cancel-scope-dialog"'
    )
  })

  it("mounts it in BOTH composer surfaces (shell and welcome/draft)", () => {
    // Both branches pass the same handleCancel, so a dialog in only one leaves
    // the other's stop button waiting on a confirmation that never appears.
    const mounts =
      panelSource.match(
        /<CancelScopeDialog confirmation=\{cancelScopeConfirm\} \/>/g
      ) ?? []
    expect(mounts.length).toBeGreaterThanOrEqual(2)
  })
})
