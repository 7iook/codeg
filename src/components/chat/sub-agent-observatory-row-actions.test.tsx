import { NextIntlClientProvider } from "next-intl"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SubAgentObservatoryList } from "./sub-agent-observatory-list"
import enMessages from "@/i18n/messages/en.json"
import type { ObservatoryActionsValue } from "@/contexts/observatory-actions-context"
import {
  type ObservedLifecycle,
  type ObservedScope,
  type ObservedSubAgentRow,
} from "@/lib/observed-sub-agents"

/**
 * Row actions (spec R7.1-R7.6) at the surface a user touches: the context menu,
 * what it does and does NOT offer, and the read-only disclosure that replaces a
 * dead control.
 *
 * The actions provider is substituted here — its own file drives the real one
 * through the real providers and covers the ordering properties. What this file
 * establishes is the part that file cannot see: that the menu's contents follow
 * the ROW'S CAPABILITY FLAGS, and that an unavailable action is ABSENT rather
 * than present-and-disabled. That distinction is the whole point of R7.4-R7.5 —
 * `disabled` reads as "try again later", so users keep clicking, which is the
 * complaint this feature came from.
 */

const actions: {
  cancelPending: Set<number>
  cancelFailed: Set<number>
  requestCancel: ReturnType<typeof vi.fn>
} = {
  cancelPending: new Set<number>(),
  cancelFailed: new Set<number>(),
  requestCancel: vi.fn(),
}

vi.mock("@/contexts/observatory-actions-context", () => ({
  useObservatoryActions: (): ObservatoryActionsValue => ({
    cancelPending: actions.cancelPending,
    cancelFailed: actions.cancelFailed,
    requestCancel: actions.requestCancel,
  }),
}))

const mockGetFolderConversation = vi.fn()
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api")
  return {
    ...actual,
    getFolderConversation: (...args: unknown[]) =>
      mockGetFolderConversation(...args),
  }
})

const mockOpenTab = vi.fn()
vi.mock("@/stores/tab-store", async () => {
  const actual =
    await vi.importActual<typeof import("@/stores/tab-store")>(
      "@/stores/tab-store"
    )
  return { ...actual, useTabActions: () => ({ openTab: mockOpenTab }) }
})

let conversationTitles = new Map<number, string>()
vi.mock("@/stores/app-workspace-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/stores/app-workspace-store")
  >("@/stores/app-workspace-store")
  const mocked = ((selector: (s: unknown) => unknown) =>
    selector({
      conversations: [...conversationTitles].map(([id, title]) => ({
        id,
        title,
      })),
    })) as unknown as typeof actual.useAppWorkspaceStore
  Object.assign(mocked, actual.useAppWorkspaceStore)
  return { ...actual, useAppWorkspaceStore: mocked }
})

function row(over: Partial<ObservedSubAgentRow> = {}): ObservedSubAgentRow {
  const scope: ObservedScope = over.scope ?? "current"
  const lifecycle: ObservedLifecycle = over.lifecycle ?? "running"
  const terminal =
    lifecycle === "completed" ||
    lifecycle === "canceled" ||
    lifecycle === "failed"
  return {
    id: "delegated:task-1",
    kind: "delegated",
    parentToolUseId: "pt-1",
    taskId: "task-1abcdef9",
    childConversationId: 900,
    conversationId: 1,
    sessionId: null,
    agentType: "codex",
    agentLabel: "codex",
    taskText: "investigate the failing import",
    errorCode: null,
    scope,
    lifecycle,
    partition: terminal ? "completed" : scope,
    canCancel: lifecycle === "running",
    canOpenInTab: true,
    lastActivityAt: null,
    frameCount: 0,
    ...over,
  }
}

function builtinRow(
  over: Partial<ObservedSubAgentRow> = {}
): ObservedSubAgentRow {
  return row({
    id: "builtin:pt-b1",
    kind: "builtin",
    parentToolUseId: "pt-b1",
    taskId: null,
    childConversationId: null,
    agentType: null,
    agentLabel: "sub-agent",
    taskText: null,
    canCancel: false,
    canOpenInTab: false,
    lastActivityAt: 1000,
    frameCount: 2,
    ...over,
  })
}

function renderList(rows: readonly ObservedSubAgentRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SubAgentObservatoryList
        rows={rows}
        evictedCount={0}
        getFrames={() => undefined}
      />
    </NextIntlClientProvider>
  )
}

/** Open a row's action menu. Right-click, which is what the context menu is. */
async function openMenu(index = 0) {
  const rows = screen.getAllByTestId("observatory-row")
  const target = rows[index]!
  await userEvent.pointer({ target, keys: "[MouseRight]" })
  return screen.findByTestId("observatory-row-menu")
}

/** The menu for a row that has no available action: it opens and is EMPTY.
 *  Asserted separately because "opens with nothing in it" is the intended
 *  capability disclosure, not a missing menu. */
async function openEmptyMenu(index = 0) {
  const menu = await openMenu(index)
  return menu
}

beforeEach(() => {
  actions.cancelPending = new Set()
  actions.cancelFailed = new Set()
  actions.requestCancel = vi.fn()
  mockGetFolderConversation.mockReset()
  mockGetFolderConversation.mockResolvedValue({
    summary: { id: 900, folder_id: 7, agent_type: "codex" },
    turns: [],
  })
  mockOpenTab.mockReset()
  conversationTitles = new Map([
    [1, "current conversation"],
    [42, "the other conversation"],
  ])
})

describe("row actions — menu contents follow the row's capabilities (R7.5)", () => {
  it("offers cancel and Open in Tab for a running delegation", async () => {
    renderList([row()])
    const menu = await openMenu()

    expect(within(menu).getByTestId("observatory-action-cancel")).toBeTruthy()
    expect(within(menu).getByTestId("observatory-action-open")).toBeTruthy()
  })

  it("omits cancel for a TERMINAL delegation but keeps Open in Tab", async () => {
    // Reading what a finished sub-agent did is the main reason terminal rows
    // stay listed at all, so the link-out must survive; there is nothing left
    // to stop, so cancel must not be offered.
    renderList([row({ lifecycle: "completed", canCancel: false })])
    const menu = await openMenu()

    expect(within(menu).queryByTestId("observatory-action-cancel")).toBeNull()
    expect(within(menu).getByTestId("observatory-action-open")).toBeTruthy()
  })

  it("offers NEITHER action for a built-in SUB (R4.3)", async () => {
    // Not disabled — absent. A built-in SUB has no ACP address and no separate
    // conversation, so both actions are physically impossible, permanently. The
    // menu still opens: an empty menu plus the row's positive read-only badge is
    // the disclosure, whereas an inert "unavailable" entry would be the dead
    // control R7.4 removes.
    renderList([builtinRow()])
    const menu = await openEmptyMenu()

    expect(within(menu).queryByTestId("observatory-action-cancel")).toBeNull()
    expect(within(menu).queryByTestId("observatory-action-open")).toBeNull()
    expect(
      menu.querySelectorAll("[data-slot='context-menu-item']")
    ).toHaveLength(0)
  })

  it("never renders a disabled action item, on any row shape (R7.4)", async () => {
    // The rule is structural, so it is asserted structurally: whatever the row,
    // the menu contains no item carrying a disabled state.
    for (const candidate of [
      row(),
      row({ lifecycle: "completed", canCancel: false }),
      builtinRow(),
      builtinRow({ lifecycle: "silent" }),
    ]) {
      const { unmount } = renderList([candidate])
      const menu = await openMenu()
      expect(menu.querySelectorAll("[data-disabled]")).toHaveLength(0)
      expect(menu.querySelectorAll("[aria-disabled='true']")).toHaveLength(0)
      unmount()
    }
  })
})

describe("row actions — the read-only indicator (R7.4)", () => {
  it("marks a built-in row read-only in POSITIVE terms", async () => {
    renderList([builtinRow()])

    const indicator = screen.getByTestId("observatory-row-readonly")
    // Affirmative about what the row IS, not about what is unavailable: wording
    // like "cannot be stopped" reads as a defect rather than a boundary.
    expect(indicator.textContent ?? "").toMatch(/view only/i)
    expect(indicator.textContent ?? "").not.toMatch(
      /unavailable|not available|disabled|cannot/i
    )
  })

  it("does not mark a delegation row read-only", () => {
    renderList([row()])
    expect(screen.queryByTestId("observatory-row-readonly")).toBeNull()
  })

  it("keeps the indicator on a terminal delegation OFF — it is not read-only", () => {
    // A finished delegation can still be opened, so it is not a read-only row;
    // labelling it as one would blur the capability boundary the label exists
    // to communicate.
    renderList([row({ lifecycle: "completed", canCancel: false })])
    expect(screen.queryByTestId("observatory-row-readonly")).toBeNull()
  })
})

describe("row actions — cancel (R7.1, R7.2, R7.6)", () => {
  it("confirms first, then requests cancel by child conversation id (R7.1)", async () => {
    renderList([row()])
    const menu = await openMenu()
    await userEvent.click(within(menu).getByTestId("observatory-action-cancel"))

    // The confirmation gates the request: nothing is sent on menu click alone.
    const dialog = await screen.findByTestId("observatory-cancel-confirm")
    expect(actions.requestCancel).not.toHaveBeenCalled()

    await userEvent.click(
      within(dialog).getByTestId("observatory-cancel-confirm-accept")
    )
    await waitFor(() => expect(actions.requestCancel).toHaveBeenCalledWith(900))
  })

  it("sends nothing when the confirmation is declined", async () => {
    renderList([row()])
    const menu = await openMenu()
    await userEvent.click(within(menu).getByTestId("observatory-action-cancel"))

    const dialog = await screen.findByTestId("observatory-cancel-confirm")
    await userEvent.click(
      within(dialog).getByTestId("observatory-cancel-confirm-dismiss")
    )

    await waitFor(() =>
      expect(screen.queryByTestId("observatory-cancel-confirm")).toBeNull()
    )
    expect(actions.requestCancel).not.toHaveBeenCalled()
  })

  it("shows the in-flight state on the row while a cancel is pending (R7.2)", () => {
    actions.cancelPending = new Set([900])
    renderList([row()])

    expect(screen.getByTestId("observatory-row-cancel-pending")).toBeTruthy()
  })

  it("does not offer cancel again while one is in flight (R7.6)", async () => {
    // The provider also guards this, but the menu must not invite the click:
    // a second cancel that is silently dropped looks like an unresponsive UI.
    actions.cancelPending = new Set([900])
    renderList([row()])

    const menu = await openMenu()
    expect(within(menu).queryByTestId("observatory-action-cancel")).toBeNull()
  })

  it("surfaces a failed cancel REQUEST without touching the lifecycle (R7.10)", () => {
    actions.cancelFailed = new Set([900])
    renderList([row()])

    expect(screen.getByTestId("observatory-row-cancel-failed")).toBeTruthy()
    // The row is still shown as running, because a request that failed to send
    // says nothing about whether the sub-agent stopped.
    expect(
      screen.getByTestId("observatory-row-lifecycle").textContent ?? ""
    ).toMatch(/running/i)
  })
})

describe("row actions — Open in Tab (R7.3)", () => {
  it("opens the child session from the menu, without expanding the row", async () => {
    renderList([row()])
    const menu = await openMenu()
    await userEvent.click(within(menu).getByTestId("observatory-action-open"))

    await waitFor(() =>
      expect(mockOpenTab).toHaveBeenCalledWith(7, 900, "codex")
    )
  })

  it("acts on the row it was opened from, not the first row", async () => {
    // A menu that always operated on row 0 would look right in a one-row list
    // and silently cancel the wrong sub-agent in a real one.
    mockGetFolderConversation.mockResolvedValue({
      summary: { id: 902, folder_id: 7, agent_type: "codex" },
      turns: [],
    })
    renderList([
      row({ id: "delegated:a", taskId: "task-aaa", childConversationId: 901 }),
      row({ id: "delegated:b", taskId: "task-bbb", childConversationId: 902 }),
    ])

    const menu = await openMenu(1)
    await userEvent.click(within(menu).getByTestId("observatory-action-cancel"))
    const dialog = await screen.findByTestId("observatory-cancel-confirm")
    await userEvent.click(
      within(dialog).getByTestId("observatory-cancel-confirm-accept")
    )

    await waitFor(() => expect(actions.requestCancel).toHaveBeenCalledWith(902))
    expect(actions.requestCancel).not.toHaveBeenCalledWith(901)
  })
})
