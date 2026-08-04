import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

import { BackgroundTasksChip } from "./background-tasks-chip"

/**
 * The chip reads its counts from `useConnection`. Mocking that hook (rather
 * than standing up the whole ACP context) keeps these tests about the ONE thing
 * this component decides: what the number is called.
 */
const mockUseConnection = vi.fn()
vi.mock("@/hooks/use-connection", () => ({
  useConnection: (contextKey: string) => mockUseConnection(contextKey),
}))

type Counts = {
  backgroundOutstanding: number
  backgroundOutstandingAgents?: number
  backgroundOutstandingShells?: number
  backgroundSettleSyncingSince?: number | null
}

function renderChip(counts: Counts) {
  mockUseConnection.mockReturnValue({
    backgroundOutstandingAgents: 0,
    backgroundOutstandingShells: 0,
    backgroundSettleSyncingSince: null,
    ...counts,
  })
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BackgroundTasksChip contextKey="tab-1" />
    </NextIntlClientProvider>
  )
}

describe("BackgroundTasksChip wording", () => {
  it("names async sub-agents when only they are running", () => {
    renderChip({
      backgroundOutstanding: 2,
      backgroundOutstandingAgents: 2,
      backgroundOutstandingShells: 0,
    })
    // The shell clause is omitted entirely rather than printed as "0 shells"
    // (R5A.4).
    expect(
      screen.getByText("2 background sub-agents running")
    ).toBeInTheDocument()
  })

  it("uses the singular form for one sub-agent", () => {
    renderChip({
      backgroundOutstanding: 1,
      backgroundOutstandingAgents: 1,
      backgroundOutstandingShells: 0,
    })
    expect(
      screen.getByText("1 background sub-agent running")
    ).toBeInTheDocument()
  })

  it("names background shells when only they are running", () => {
    renderChip({
      backgroundOutstanding: 1,
      backgroundOutstandingAgents: 0,
      backgroundOutstandingShells: 1,
    })
    expect(screen.getByText("1 background shell running")).toBeInTheDocument()
  })

  it("names both kinds, each with its own count, when both are running", () => {
    renderChip({
      backgroundOutstanding: 3,
      backgroundOutstandingAgents: 1,
      backgroundOutstandingShells: 2,
    })
    // Each kind carries its own number — the reason a single aggregate was
    // unreadable in the first place.
    expect(
      screen.getByText("1 background sub-agent and 2 shells running")
    ).toBeInTheDocument()
  })

  it("pluralizes each clause independently", () => {
    renderChip({
      backgroundOutstanding: 3,
      backgroundOutstandingAgents: 2,
      backgroundOutstandingShells: 1,
    })
    expect(
      screen.getByText("2 background sub-agents and 1 shell running")
    ).toBeInTheDocument()
  })

  it("falls back to the aggregate wording when the split is absent", () => {
    // A backend predating the split sends only the aggregate, which
    // denormalizes both per-kind fields to 0. Claiming "0 sub-agents and 0
    // shells" would be a lie about 2 real tasks, so the pre-existing sentence
    // is kept.
    renderChip({
      backgroundOutstanding: 2,
      backgroundOutstandingAgents: 0,
      backgroundOutstandingShells: 0,
    })
    expect(screen.getByText("2 background tasks running")).toBeInTheDocument()
  })

  it("falls back to the aggregate when the split does not account for every task", () => {
    // A partial split (sum < aggregate) must not silently under-report: naming
    // 1 shell while 3 tasks are pending would strand 2 uncounted.
    renderChip({
      backgroundOutstanding: 3,
      backgroundOutstandingAgents: 0,
      backgroundOutstandingShells: 1,
    })
    expect(screen.getByText("3 background tasks running")).toBeInTheDocument()
  })

  it("still renders the settling state and nothing at all when idle", () => {
    // The two pre-existing behaviors this change must not disturb.
    const settling = renderChip({
      backgroundOutstanding: 0,
      backgroundSettleSyncingSince: Date.now(),
    })
    expect(screen.getByText("Syncing background results…")).toBeInTheDocument()
    settling.unmount()

    const idle = renderChip({ backgroundOutstanding: 0 })
    expect(idle.container).toBeEmptyDOMElement()
  })
})
