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
const actionsSource = read("src/contexts/observatory-actions-context.tsx")
const providersSource = read("src/contexts/live-observability-providers.tsx")
const apiSource = read("src/lib/api.ts")

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

  it("mounts the actions provider in the workspace-level composition", () => {
    // Placement is load-bearing, not stylistic: R7.12 requires ONE
    // authoritative read per still-running row after a reconnect, and a
    // provider nested per conversation pane would fire one set of reads per open
    // pane. Mounting it here is what makes the read count a property of the
    // workspace.
    expect(providersSource).toContain(
      'import { ObservatoryActionsProvider } from "@/contexts/observatory-actions-context"'
    )
    expect(providersSource).toContain("<ObservatoryActionsProvider>")
    expect(listSource).toContain("useObservatoryActions()")
  })

  it("has real production callers for both delegation action APIs", () => {
    // The E-052 shape: `cancelDelegation` / `getDelegationTaskStatus` shipped
    // ahead of their consumer and carried `gate:allow-unwired` escape hatches
    // saying so. Those markers must be GONE, and gone because the calls exist —
    // not because someone deleted the comment.
    expect(apiSource).not.toContain("gate:allow-unwired")
    expect(actionsSource).toContain("cancelDelegation(")
    expect(actionsSource).toContain("getDelegationTaskStatus(")
  })

  it("routes reconciliation through the binding map, not a parallel store", () => {
    // Property 9 is structural: lifecycle keeps exactly one writer. If the
    // authoritative read ever grew its own lifecycle store for a consumer to
    // overlay, the dual-source-of-truth the design spent a review round
    // removing would be back, and the ordering tests would start passing for
    // the wrong reason.
    expect(actionsSource).toContain("applyAuthoritativeStatus")
    expect(actionsSource).toContain("onTransportReconnect(")
  })
})
