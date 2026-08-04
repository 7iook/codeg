import { NextIntlClientProvider } from "next-intl"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SubAgentObservatoryList } from "./sub-agent-observatory-list"
import enMessages from "@/i18n/messages/en.json"
import {
  type ObservedSubAgentRow,
  type ObservedLifecycle,
  type ObservedScope,
} from "@/lib/observed-sub-agents"

/**
 * The list body is exercised directly with rows, because it is deliberately
 * container-agnostic: everything the sections, the conversation labels and the
 * in-place detail depend on arrives as props. The popover that hosts it is
 * covered by the chip-integration file, which drives the real providers.
 */

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

/** Conversation titles the panel resolves ids against (R6.4). */
let conversationTitles = new Map<number, string>()
vi.mock("@/stores/app-workspace-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/stores/app-workspace-store")
  >("@/stores/app-workspace-store")
  // `tab-store` calls `useAppWorkspaceStore.getState()` at module scope, so the
  // mock has to remain a callable store object, not just a selector function.
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

function renderList(
  rows: readonly ObservedSubAgentRow[],
  props: { evictedCount?: number; getFrames?: (id: string) => unknown } = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SubAgentObservatoryList
        rows={rows}
        evictedCount={props.evictedCount ?? 0}
        getFrames={(props.getFrames as never) ?? ((() => undefined) as never)}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockGetFolderConversation.mockReset()
  mockOpenTab.mockReset()
  conversationTitles = new Map([
    [1, "current conversation"],
    [42, "the other conversation"],
  ])
})

describe("SubAgentObservatoryList — sections", () => {
  it("lists current-conversation rows expanded at the top (R6.1)", () => {
    renderList([
      row({ id: "delegated:cur", conversationId: 1, scope: "current" }),
      row({
        id: "delegated:oth",
        conversationId: 42,
        scope: "other",
        taskId: "task-other1",
      }),
    ])

    // Present without any interaction, unlike the other-conversations section.
    const current = screen.getByTestId("observatory-section-current")
    expect(within(current).getAllByTestId("observatory-row")).toHaveLength(1)

    // And it is FIRST in the document, not merely present.
    const sections = screen.getAllByTestId(/^observatory-section-/)
    expect(sections[0]).toBe(current)
  })

  it("collapses other-conversation rows behind a count (R6.2)", async () => {
    renderList([
      row({ id: "delegated:cur", scope: "current" }),
      row({ id: "delegated:o1", scope: "other", conversationId: 42 }),
      row({ id: "delegated:o2", scope: "other", conversationId: 42 }),
    ])

    const trigger = screen.getByTestId("observatory-other-toggle")
    expect(trigger).toHaveTextContent("2")
    // Collapsed: the rows are not rendered until asked for.
    const section = screen.getByTestId("observatory-section-other")
    expect(within(section).queryAllByTestId("observatory-row")).toHaveLength(0)

    await userEvent.click(trigger)
    expect(within(section).getAllByTestId("observatory-row")).toHaveLength(2)
  })

  it("puts terminal rows in their own section (R6.3)", () => {
    renderList([
      row({ id: "delegated:run", lifecycle: "running" }),
      row({ id: "delegated:done", lifecycle: "completed" }),
      row({ id: "delegated:cx", lifecycle: "canceled", errorCode: "canceled" }),
      row({ id: "delegated:bad", lifecycle: "failed", errorCode: "timeout" }),
    ])

    const completed = screen.getByTestId("observatory-section-completed")
    expect(within(completed).getAllByTestId("observatory-row")).toHaveLength(3)
  })

  it("labels the owning conversation in the other and completed sections only (R6.4)", async () => {
    renderList([
      row({ id: "delegated:cur", scope: "current", conversationId: 1 }),
      row({ id: "delegated:oth", scope: "other", conversationId: 42 }),
      row({
        id: "delegated:done",
        lifecycle: "completed",
        scope: "other",
        conversationId: 42,
      }),
    ])

    await userEvent.click(screen.getByTestId("observatory-other-toggle"))

    const other = screen.getByTestId("observatory-section-other")
    const completed = screen.getByTestId("observatory-section-completed")
    expect(
      within(other).getByTestId("observatory-row-conversation")
    ).toHaveTextContent("the other conversation")
    expect(
      within(completed).getByTestId("observatory-row-conversation")
    ).toHaveTextContent("the other conversation")

    // The current section would only repeat what the panel's own context
    // already says, so it carries no label.
    const current = screen.getByTestId("observatory-section-current")
    expect(
      within(current).queryByTestId("observatory-row-conversation")
    ).toBeNull()
  })

  it("caps the completed section per conversation, dropping the oldest", () => {
    // 22 terminal rows on one conversation; the cap is 20 per conversation.
    const rows = Array.from({ length: 22 }, (_, i) =>
      row({
        id: `delegated:done-${String(i).padStart(2, "0")}`,
        taskId: `task-${i}`,
        lifecycle: "completed",
        conversationId: 1,
      })
    )
    renderList(rows)

    const completed = screen.getByTestId("observatory-section-completed")
    expect(within(completed).getAllByTestId("observatory-row")).toHaveLength(20)
  })

  it("applies the completed cap per conversation, not across all of them", () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) =>
        row({
          id: `delegated:a-${i}`,
          taskId: `task-a-${i}`,
          lifecycle: "completed",
          conversationId: 1,
        })
      ),
      row({
        id: "delegated:b-1",
        taskId: "task-b-1",
        lifecycle: "completed",
        conversationId: 42,
        scope: "other",
      }),
    ]
    renderList(rows)

    const completed = screen.getByTestId("observatory-section-completed")
    // The 42-conversation row survives a full quota on conversation 1.
    expect(within(completed).getAllByTestId("observatory-row")).toHaveLength(21)
  })

  it("shows an unattributed section without folding rows into the current one (R3.4)", () => {
    renderList([
      row({
        id: "builtin:orphan",
        kind: "builtin",
        scope: "unattributed",
        conversationId: null,
        canCancel: false,
        canOpenInTab: false,
      }),
    ])

    expect(screen.getByTestId("observatory-section-unattributed")).toBeTruthy()
    expect(screen.queryByTestId("observatory-section-current")).toBeNull()
  })
})

describe("SubAgentObservatoryList — capacity notice and empty states", () => {
  it("shows the capacity notice only once entries have been evicted (R3.8)", () => {
    const { unmount } = renderList([row()], { evictedCount: 0 })
    expect(screen.queryByTestId("observatory-capacity-notice")).toBeNull()
    unmount()

    renderList([row()], { evictedCount: 3 })
    expect(screen.getByTestId("observatory-capacity-notice")).toBeTruthy()
  })

  it("does not word the capacity notice as current-conversation-only (R3.9)", () => {
    renderList([row()], { evictedCount: 3 })
    const notice = screen.getByTestId("observatory-capacity-notice")
    // The count is workspace-scoped; describing it as belonging to this
    // conversation would misattribute other conversations' losses.
    expect(notice.textContent ?? "").not.toMatch(
      /this conversation|current conversation/i
    )
  })

  it("shows an empty state when there are no rows at all (R6.17)", () => {
    renderList([])
    expect(screen.getByTestId("observatory-empty")).toBeTruthy()
    expect(screen.queryAllByTestId("observatory-row")).toHaveLength(0)
  })

  it("keeps the capacity notice reachable when the list itself is empty", () => {
    // Every tracked entry evicted: the list is empty BECAUSE of capacity, which
    // is exactly when the explanation matters most.
    renderList([], { evictedCount: 5 })
    expect(screen.getByTestId("observatory-empty")).toBeTruthy()
    expect(screen.getByTestId("observatory-capacity-notice")).toBeTruthy()
  })
})

describe("SubAgentObservatoryList — in-place detail", () => {
  it("renders a built-in SUB's cached frames in place (R6.8)", async () => {
    const frames = [
      {
        key: "f1",
        role: "assistant" as const,
        blocks: [{ type: "text" as const, text: "inspecting the parser" }],
      },
    ]
    renderList([builtinRow()], { getFrames: () => frames })

    await userEvent.click(screen.getByTestId("observatory-row"))

    expect(await screen.findByTestId("subagent-transcript")).toBeTruthy()
    expect(screen.getByText(/inspecting the parser/)).toBeTruthy()
    // No summary fetch for a built-in row: its frames are already in memory.
    expect(mockGetFolderConversation).not.toHaveBeenCalled()
  })

  it("fetches a delegation summary only on selection (R6.11)", async () => {
    mockGetFolderConversation.mockResolvedValue({
      summary: { id: 900, folder_id: 7, agent_type: "codex" },
      turns: [
        {
          id: "t1",
          role: "assistant",
          blocks: [{ type: "text", text: "found the root cause" }],
          timestamp: "2026-08-03T00:00:00Z",
        },
      ],
    })

    renderList([row()])
    // Rendering the list must not prefetch: N rows would be N requests.
    expect(mockGetFolderConversation).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId("observatory-row"))

    await waitFor(() =>
      expect(mockGetFolderConversation).toHaveBeenCalledWith(900)
    )
    expect(await screen.findByText(/found the root cause/)).toBeTruthy()
  })

  it("shows a loading state while a delegation summary is in flight (R6.12)", async () => {
    let resolve: ((v: unknown) => void) | null = null
    mockGetFolderConversation.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )

    renderList([row()])
    await userEvent.click(screen.getByTestId("observatory-row"))

    expect(await screen.findByTestId("observatory-detail-loading")).toBeTruthy()

    await act(async () => {
      resolve?.({ summary: { id: 900, folder_id: 7 }, turns: [] })
    })
    await waitFor(() =>
      expect(screen.queryByTestId("observatory-detail-loading")).toBeNull()
    )
  })

  it("offers a retry after a failed summary fetch (R6.13)", async () => {
    mockGetFolderConversation.mockRejectedValueOnce(new Error("offline"))
    renderList([row()])

    await userEvent.click(screen.getByTestId("observatory-row"))
    const retry = await screen.findByTestId("observatory-detail-retry")

    mockGetFolderConversation.mockResolvedValueOnce({
      summary: { id: 900, folder_id: 7 },
      turns: [
        {
          id: "t1",
          role: "assistant",
          blocks: [{ type: "text", text: "second attempt worked" }],
          timestamp: "2026-08-03T00:00:00Z",
        },
      ],
    })
    await userEvent.click(retry)

    expect(await screen.findByText(/second attempt worked/)).toBeTruthy()
    expect(mockGetFolderConversation).toHaveBeenCalledTimes(2)
  })

  it("discards an in-flight summary when the selection moves on (R6.14)", async () => {
    const resolvers: Array<(v: unknown) => void> = []
    mockGetFolderConversation.mockImplementation(
      () =>
        new Promise((r) => {
          resolvers.push(r as (v: unknown) => void)
        })
    )

    renderList([
      row({ id: "delegated:a", taskId: "task-aaa", childConversationId: 901 }),
      row({ id: "delegated:b", taskId: "task-bbb", childConversationId: 902 }),
    ])

    const rows = screen.getAllByTestId("observatory-row")
    await userEvent.click(rows[0]!)
    await waitFor(() => expect(resolvers).toHaveLength(1))
    await userEvent.click(rows[1]!)
    await waitFor(() => expect(resolvers).toHaveLength(2))

    // The FIRST row's response lands last — the classic cross-row contamination
    // ordering. Its text must never appear under the second row.
    await act(async () => {
      resolvers[0]!({
        summary: { id: 901, folder_id: 7 },
        turns: [
          {
            id: "t1",
            role: "assistant",
            blocks: [{ type: "text", text: "STALE row A answer" }],
            timestamp: "2026-08-03T00:00:00Z",
          },
        ],
      })
      resolvers[1]!({
        summary: { id: 902, folder_id: 7 },
        turns: [
          {
            id: "t2",
            role: "assistant",
            blocks: [{ type: "text", text: "fresh row B answer" }],
            timestamp: "2026-08-03T00:00:00Z",
          },
        ],
      })
    })

    expect(await screen.findByText(/fresh row B answer/)).toBeTruthy()
    expect(screen.queryByText(/STALE row A answer/)).toBeNull()
  })

  it("links out to the full child conversation instead of loading it (R6.15)", async () => {
    mockGetFolderConversation.mockResolvedValue({
      summary: { id: 900, folder_id: 7, agent_type: "codex" },
      turns: [],
    })
    renderList([row()])

    await userEvent.click(screen.getByTestId("observatory-row"))
    const link = await screen.findByTestId("observatory-detail-open")
    await userEvent.click(link)

    expect(mockOpenTab).toHaveBeenCalledWith(7, 900, "codex")
  })

  it("explains a row with nothing to show rather than rendering blank (R6.16)", async () => {
    mockGetFolderConversation.mockResolvedValue({
      summary: { id: 900, folder_id: 7 },
      // A child whose transcript has not landed yet: no assistant turn to
      // summarize. The distinction from "still loading" is the point.
      turns: [],
    })
    renderList([row()])

    await userEvent.click(screen.getByTestId("observatory-row"))
    expect(await screen.findByTestId("observatory-detail-nothing")).toBeTruthy()
  })

  it("explains an empty built-in row without attempting a fetch (R6.16)", async () => {
    renderList([builtinRow({ frameCount: 0 })], { getFrames: () => undefined })

    await userEvent.click(screen.getByTestId("observatory-row"))

    expect(await screen.findByTestId("observatory-detail-nothing")).toBeTruthy()
    expect(mockGetFolderConversation).not.toHaveBeenCalled()
  })

  it("states that a silent built-in SUB is quiet, not finished (R3.14)", () => {
    renderList([builtinRow({ lifecycle: "silent" })])
    const label = screen.getByTestId("observatory-row-lifecycle")
    expect(label.textContent ?? "").not.toMatch(/completed|finished|succeeded/i)
  })
})
