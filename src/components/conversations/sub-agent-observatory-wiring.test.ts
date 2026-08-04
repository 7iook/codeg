import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Wiring assertions for the resident sub-agent chip and its panel (task 6.6).
 *
 * These read SOURCE rather than rendering, deliberately: the component tests one
 * directory over prove each piece behaves correctly when mounted, but they build
 * their own trees, so they are structurally blind to whether production mounts
 * them at all. That gap is how a fully tested component ships as dead code. The
 * judgement to apply is "if the mount line is deleted, does something turn red?"
 * — and only a check against the real call site can answer it.
 *
 * The chain has two hops now (panel → chip), and BOTH are asserted: task 6.2
 * moved the panel between the conversation panel and the chip, so a check that
 * only looked at the top of the chain would go green while the chip below it was
 * orphaned.
 */

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8")
}

const panelSource = read(
  "src/components/conversations/conversation-detail-panel.tsx"
)
const observatorySource = read(
  "src/components/chat/sub-agent-observatory-panel.tsx"
)
const listSource = read("src/components/chat/sub-agent-observatory-list.tsx")

describe("sub-agent observatory wiring", () => {
  it("is imported and mounted by the conversation panel", () => {
    expect(panelSource).toContain(
      'import { SubAgentObservatoryPanel } from "@/components/chat/sub-agent-observatory-panel"'
    )
    expect(panelSource).toContain("<SubAgentObservatoryPanel")
  })

  it("receives the DB conversation id, never the tab id", () => {
    // The two id spaces are not interchangeable: `tabId` would make every row's
    // attribution wrong while still rendering a plausible-looking chip, which
    // is why this is asserted structurally rather than left to review.
    expect(panelSource).toContain(
      "<SubAgentObservatoryPanel conversationId={dbConversationId} />"
    )
    expect(panelSource).not.toContain(
      "<SubAgentObservatoryPanel conversationId={tabId}"
    )
  })

  it("sits inside the topBanner stack in a fixed order (R5.9)", () => {
    const bannerStart = panelSource.indexOf("topBanner={")
    expect(bannerStart).toBeGreaterThan(-1)
    const bannerEnd = panelSource.indexOf("status={connStatus}", bannerStart)
    expect(bannerEnd).toBeGreaterThan(bannerStart)
    const banner = panelSource.slice(bannerStart, bannerEnd)

    const staleAt = banner.indexOf("<SessionConfigStaleBanner")
    const backgroundAt = banner.indexOf("<BackgroundTasksChip")
    const observatoryAt = banner.indexOf("<SubAgentObservatoryPanel")

    expect(staleAt).toBeGreaterThan(-1)
    expect(backgroundAt).toBeGreaterThan(staleAt)
    // Order is asserted, not just co-presence: two adjacent count strips that
    // can swap places between renders would make the numbers hard to attribute
    // to the right pool.
    expect(observatoryAt).toBeGreaterThan(backgroundAt)
  })

  it("mounts the chip as the panel's anchor, passing both new props", () => {
    // The chip shipped in 6.1 with `onActivate` / `panelOpen` unpassed. If this
    // hop regressed, the chip would still render its count and still pass its
    // own tests while being unable to open anything.
    expect(observatorySource).toContain("<SubAgentObservatoryChip")
    expect(observatorySource).toContain("onActivate={")
    expect(observatorySource).toContain("panelOpen={open}")
  })

  it("mounts the list body inside the panel and feeds it the hook's rows", () => {
    expect(observatorySource).toContain("<SubAgentObservatoryList")
    // `rows` and `evictedCount` exist on the hook for this consumer alone; if
    // the panel stopped reading them they would be dead projections again.
    expect(observatorySource).toContain("rows={rows}")
    expect(observatorySource).toContain("evictedCount={evictedCount}")
    expect(observatorySource).toContain("useObservedSubAgents(")
  })

  it("keeps the list body unaware of its container (D5 upgrade path)", () => {
    // Not an AC — an implementation stance worth pinning while it is cheap: the
    // body must stay re-hostable (sidebar, AuxPanel tab) as wiring rather than a
    // rewrite, which it cannot be if it reaches for the popover itself.
    expect(listSource).not.toContain("ui/popover")
  })
})
