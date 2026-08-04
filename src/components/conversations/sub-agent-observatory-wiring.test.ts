import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Wiring assertions for the resident sub-agent chip (task 6.6).
 *
 * These read the panel's SOURCE rather than rendering it, deliberately: the
 * component test one directory over proves the chip behaves correctly when
 * mounted, but it constructs its own provider tree, so it is structurally blind
 * to whether the production panel mounts it at all. That gap is how a fully
 * tested component ships as dead code. The judgement to apply here is "if the
 * mount line is deleted, does something turn red?" — and only a check against
 * the real call site can answer it.
 */

const panelSource = readFileSync(
  resolve(
    process.cwd(),
    "src/components/conversations/conversation-detail-panel.tsx"
  ),
  "utf8"
)

describe("sub-agent observatory chip wiring", () => {
  it("is imported and mounted by the conversation panel", () => {
    expect(panelSource).toContain(
      'import { SubAgentObservatoryChip } from "@/components/chat/sub-agent-observatory-chip"'
    )
    expect(panelSource).toContain("<SubAgentObservatoryChip")
  })

  it("receives the DB conversation id, never the tab id", () => {
    // The two id spaces are not interchangeable: `tabId` would make every row's
    // attribution wrong while still rendering a plausible-looking chip, which
    // is why this is asserted structurally rather than left to review.
    expect(panelSource).toContain(
      "<SubAgentObservatoryChip conversationId={dbConversationId} />"
    )
    expect(panelSource).not.toContain(
      "<SubAgentObservatoryChip conversationId={tabId}"
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
    const observatoryAt = banner.indexOf("<SubAgentObservatoryChip")

    expect(staleAt).toBeGreaterThan(-1)
    expect(backgroundAt).toBeGreaterThan(staleAt)
    // Order is asserted, not just co-presence: two adjacent count strips that
    // can swap places between renders would make the numbers hard to attribute
    // to the right pool.
    expect(observatoryAt).toBeGreaterThan(backgroundAt)
  })
})
