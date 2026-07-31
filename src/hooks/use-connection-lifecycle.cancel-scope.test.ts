/**
 * Behavior of the stop button's cancel-scope flow (spec R4), driven through the
 * REAL `useConnectionLifecycle` hook — the same handler the panel passes to
 * `onCancel`.
 *
 * The mock boundary is `useConnection`, i.e. the per-connection action surface.
 * Everything under test (preview → confirm → tokened commit, and the refusal
 * handling) is production code.
 */

import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const toastError = vi.fn()
const toastSuccess = vi.fn()

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: vi.fn(),
    message: vi.fn(),
  },
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const cancel = vi.fn().mockResolvedValue(undefined)
const previewCancelScope = vi.fn()
const cancelWithScopeToken = vi.fn()

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({ setActiveKey: vi.fn(), touchActivity: vi.fn() }),
}))

vi.mock("@/contexts/task-context", () => ({
  useTaskContext: () => ({
    addTask: vi.fn(),
    updateTask: vi.fn(),
    removeTask: vi.fn(),
  }),
}))

vi.mock("@/hooks/use-connection", () => ({
  useConnection: () => ({
    status: "prompting",
    selectorsReady: true,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn(),
    setMode: vi.fn().mockResolvedValue(undefined),
    setConfigOption: vi.fn().mockResolvedValue(undefined),
    cancel,
    previewCancelScope,
    cancelWithScopeToken,
    respondPermission: vi.fn().mockResolvedValue(undefined),
    modes: null,
    configOptions: null,
    hasCachedSelectors: true,
    isViewer: false,
    backgroundOutstanding: 0,
  }),
}))

import { useConnectionLifecycle } from "@/hooks/use-connection-lifecycle"

function mount() {
  return renderHook(() =>
    useConnectionLifecycle({
      contextKey: "tab-1",
      agentType: "claude_code",
      isActive: false,
    })
  )
}

beforeEach(() => {
  cancel.mockClear()
  previewCancelScope.mockReset()
  cancelWithScopeToken.mockReset()
  toastError.mockClear()
  toastSuccess.mockClear()
})

describe("count === 0 takes the no-dialog path (R4.4)", () => {
  it("cancels directly and never opens a confirmation", async () => {
    // The backend issues no token when nothing would be cascade-killed.
    previewCancelScope.mockResolvedValue({
      count: 0,
      taskIds: [],
      expiresInMs: 0,
    })
    const { result } = mount()

    await act(async () => {
      result.current.handleCancel()
    })

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(result.current.cancelScopeConfirm).toBeNull()
    expect(cancelWithScopeToken).not.toHaveBeenCalled()
  })
})

describe("count > 0 discloses before destroying (R4.1)", () => {
  it("shows the count and cancels NOTHING until the user confirms", async () => {
    previewCancelScope.mockResolvedValue({
      token: "tok-1",
      count: 3,
      taskIds: ["t1"],
      expiresInMs: 60000,
    })
    const { result } = mount()

    await act(async () => {
      result.current.handleCancel()
    })

    // The whole point: the user is told, and nothing has died yet.
    expect(result.current.cancelScopeConfirm?.count).toBe(3)
    expect(cancel).not.toHaveBeenCalled()
    expect(cancelWithScopeToken).not.toHaveBeenCalled()
  })

  it("displays `count`, not taskIds.length (still-starting delegations)", async () => {
    // A delegation still starting up has no task_id but WILL be killed.
    previewCancelScope.mockResolvedValue({
      token: "tok-1",
      count: 2,
      taskIds: [],
      expiresInMs: 60000,
    })
    const { result } = mount()

    await act(async () => {
      result.current.handleCancel()
    })

    expect(result.current.cancelScopeConfirm?.count).toBe(2)
  })

  it("commits with the preview's token on confirm", async () => {
    previewCancelScope.mockResolvedValue({
      token: "tok-1",
      count: 2,
      taskIds: ["t1", "t2"],
      expiresInMs: 60000,
    })
    cancelWithScopeToken.mockResolvedValue({
      count: 2,
      terminatedTaskIds: ["t1", "t2"],
      terminatedStarting: 0,
    })
    const { result } = mount()

    await act(async () => {
      result.current.handleCancel()
    })
    await act(async () => {
      result.current.cancelScopeConfirm?.confirm()
    })

    expect(cancelWithScopeToken).toHaveBeenCalledWith("tok-1")
    // Bounded commit only — never the unbounded plain cancel as well.
    expect(cancel).not.toHaveBeenCalled()
    expect(result.current.cancelScopeConfirm).toBeNull()
  })

  it("reports what was ACTUALLY terminated, not the preview's number", async () => {
    // A sub-agent that finished on its own while the dialog was open is not a
    // kill: preview said 3, the result says 1, so the user must be told 1.
    previewCancelScope.mockResolvedValue({
      token: "tok-1",
      count: 3,
      taskIds: ["t1", "t2", "t3"],
      expiresInMs: 60000,
    })
    cancelWithScopeToken.mockResolvedValue({
      count: 1,
      terminatedTaskIds: ["t1"],
      terminatedStarting: 0,
    })
    const { result } = mount()

    await act(async () => {
      result.current.handleCancel()
    })
    await act(async () => {
      result.current.cancelScopeConfirm?.confirm()
    })

    expect(toastSuccess).toHaveBeenCalledWith(
      'cancelScope.terminated:{"count":1}'
    )
  })

  it("reports a terminated still-starting delegation (count > ids.length)", async () => {
    // `terminatedTaskIds` is empty but one starting delegation WAS killed;
    // reporting ids.length would say "nothing happened" when something did.
    previewCancelScope.mockResolvedValue({
      token: "tok-1",
      count: 1,
      taskIds: [],
      expiresInMs: 60000,
    })
    cancelWithScopeToken.mockResolvedValue({
      count: 1,
      terminatedTaskIds: [],
      terminatedStarting: 1,
    })
    const { result } = mount()

    await act(async () => {
      result.current.handleCancel()
    })
    await act(async () => {
      result.current.cancelScopeConfirm?.confirm()
    })

    expect(toastSuccess).toHaveBeenCalledWith(
      'cancelScope.terminated:{"count":1}'
    )
  })
})

describe("dismissing the dialog cancels nothing", () => {
  it("terminates neither the turn nor any sub-agent", async () => {
    previewCancelScope.mockResolvedValue({
      token: "tok-1",
      count: 2,
      taskIds: ["t1"],
      expiresInMs: 60000,
    })
    const { result } = mount()

    await act(async () => {
      result.current.handleCancel()
    })
    await act(async () => {
      result.current.cancelScopeConfirm?.dismiss()
    })

    expect(result.current.cancelScopeConfirm).toBeNull()
    expect(cancelWithScopeToken).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe("a refused commit never falls through to an unbounded cancel", () => {
  it("re-previews and re-confirms on cancel_scope_changed", async () => {
    // THE regression this feature exists to prevent: falling back to the plain
    // cancel here would kill an unknown number of sub-agents after having shown
    // the user a different number.
    previewCancelScope
      .mockResolvedValueOnce({
        token: "tok-1",
        count: 2,
        taskIds: ["t1"],
        expiresInMs: 60000,
      })
      .mockResolvedValueOnce({
        token: "tok-2",
        count: 3,
        taskIds: ["t1", "t2"],
        expiresInMs: 60000,
      })
    cancelWithScopeToken.mockRejectedValueOnce({
      code: "invalid_input",
      message:
        "delegation scope changed since the preview; re-confirm before cancelling",
    })
    const { result } = mount()

    await act(async () => {
      result.current.handleCancel()
    })
    await act(async () => {
      result.current.cancelScopeConfirm?.confirm()
    })

    expect(cancel).not.toHaveBeenCalled()
    // Re-confirmation on the NEW, larger scope.
    expect(result.current.cancelScopeConfirm?.count).toBe(3)
  })

  it("re-previews and re-confirms on a rejected token", async () => {
    previewCancelScope
      .mockResolvedValueOnce({
        token: "tok-1",
        count: 2,
        taskIds: ["t1"],
        expiresInMs: 60000,
      })
      .mockResolvedValueOnce({
        token: "tok-2",
        count: 2,
        taskIds: ["t1"],
        expiresInMs: 60000,
      })
    cancelWithScopeToken.mockRejectedValueOnce({
      code: "invalid_input",
      message: "cancel scope token rejected: expired; re-run the preview",
    })
    const { result } = mount()

    await act(async () => {
      result.current.handleCancel()
    })
    await act(async () => {
      result.current.cancelScopeConfirm?.confirm()
    })

    expect(cancel).not.toHaveBeenCalled()
    expect(result.current.cancelScopeConfirm?.count).toBe(2)
  })

  it("commits the fresh token on the second confirm, and stops re-looping", async () => {
    previewCancelScope
      .mockResolvedValueOnce({
        token: "tok-1",
        count: 2,
        taskIds: ["t1"],
        expiresInMs: 60000,
      })
      .mockResolvedValueOnce({
        token: "tok-2",
        count: 3,
        taskIds: ["t1", "t2"],
        expiresInMs: 60000,
      })
    cancelWithScopeToken
      .mockRejectedValueOnce({
        code: "invalid_input",
        message:
          "delegation scope changed since the preview; re-confirm before cancelling",
      })
      .mockRejectedValueOnce({
        code: "invalid_input",
        message:
          "delegation scope changed since the preview; re-confirm before cancelling",
      })
    const { result } = mount()

    await act(async () => {
      result.current.handleCancel()
    })
    await act(async () => {
      result.current.cancelScopeConfirm?.confirm()
    })
    await act(async () => {
      result.current.cancelScopeConfirm?.confirm()
    })

    expect(cancelWithScopeToken).toHaveBeenNthCalledWith(2, "tok-2")
    // A scope churning under us must not loop forever, and must STILL not
    // degrade into the unbounded cancel.
    expect(previewCancelScope).toHaveBeenCalledTimes(2)
    expect(cancel).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith("cancelScope.scopeMoved")
  })

  it("falls back to the plain cancel only once the cascade is provably empty", async () => {
    // Refused, and the re-preview shows the sub-agents finished on their own —
    // so a plain cancel now destroys nothing the user wasn't warned about.
    previewCancelScope
      .mockResolvedValueOnce({
        token: "tok-1",
        count: 2,
        taskIds: ["t1"],
        expiresInMs: 60000,
      })
      .mockResolvedValueOnce({ count: 0, taskIds: [], expiresInMs: 0 })
    cancelWithScopeToken.mockRejectedValueOnce({
      code: "invalid_input",
      message: "cancel scope token rejected: unknown or already used",
    })
    const { result } = mount()

    await act(async () => {
      result.current.handleCancel()
    })
    await act(async () => {
      result.current.cancelScopeConfirm?.confirm()
    })

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(result.current.cancelScopeConfirm).toBeNull()
  })

  it("does NOT re-preview on a genuine fault, and cancels nothing", async () => {
    previewCancelScope.mockResolvedValue({
      token: "tok-1",
      count: 2,
      taskIds: ["t1"],
      expiresInMs: 60000,
    })
    cancelWithScopeToken.mockRejectedValue(new Error("HTTP 500"))
    const { result } = mount()

    await act(async () => {
      result.current.handleCancel()
    })
    await act(async () => {
      result.current.cancelScopeConfirm?.confirm()
    })

    expect(cancel).not.toHaveBeenCalled()
    expect(previewCancelScope).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith("cancelScope.failed")
  })
})

describe("a failed PREVIEW still lets the user stop", () => {
  it("falls back to the plain cancel", async () => {
    // The preview is read-only, so its failure means we could not learn the
    // scope. Leaving the user unable to stop a runaway turn is worse than
    // stopping without a count.
    previewCancelScope.mockRejectedValue(new Error("network down"))
    const { result } = mount()

    await act(async () => {
      result.current.handleCancel()
    })

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(result.current.cancelScopeConfirm).toBeNull()
  })
})
