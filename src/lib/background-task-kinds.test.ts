import { describe, expect, it } from "vitest"

import { resolveBackgroundTaskKinds } from "./background-task-kinds"

describe("resolveBackgroundTaskKinds", () => {
  it("reports the split when the two kinds account for the aggregate", () => {
    expect(
      resolveBackgroundTaskKinds({ outstanding: 3, agents: 1, shells: 2 })
    ).toEqual({ kind: "split", agents: 1, shells: 2 })
  })

  it("keeps a zero kind as zero so the caller can omit its clause", () => {
    expect(
      resolveBackgroundTaskKinds({ outstanding: 2, agents: 2, shells: 0 })
    ).toEqual({ kind: "split", agents: 2, shells: 0 })
    expect(
      resolveBackgroundTaskKinds({ outstanding: 2, agents: 0, shells: 2 })
    ).toEqual({ kind: "split", agents: 0, shells: 2 })
  })

  it("falls back to the aggregate when a pre-split backend omitted both", () => {
    // Indistinguishable field-by-field from "no tasks of either kind"; only the
    // sum reveals that the split never arrived.
    expect(
      resolveBackgroundTaskKinds({ outstanding: 2, agents: 0, shells: 0 })
    ).toEqual({ kind: "aggregate", total: 2 })
  })

  it("falls back to the aggregate when the split under-accounts", () => {
    expect(
      resolveBackgroundTaskKinds({ outstanding: 5, agents: 1, shells: 1 })
    ).toEqual({ kind: "aggregate", total: 5 })
  })

  it("treats an idle connection as a (trivially consistent) split", () => {
    // All zero: the sums agree, and the caller renders nothing anyway.
    expect(
      resolveBackgroundTaskKinds({ outstanding: 0, agents: 0, shells: 0 })
    ).toEqual({ kind: "split", agents: 0, shells: 0 })
  })
})
