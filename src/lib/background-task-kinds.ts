/**
 * How `BackgroundTasksChip` decides what to SAY about a background-task count.
 *
 * The chip's number was never wrong, it was unreadable: it counts Claude CLI's
 * OWN transcript-derived work (async sub-agents + background shells) and does
 * not include codeg's delegated sub-agents at all — those are accounted by the
 * delegation broker, a disjoint pool with its own chip. Naming the two kinds is
 * what makes the number interpretable (R5A.2).
 *
 * Kept separate from the component so the wording decision — in particular the
 * old-backend fallback, which is invisible in normal rendering — is directly
 * testable.
 */

/** What the chip should say, given a connection's background counts. */
export type BackgroundTaskKinds =
  | {
      /** The split is known: render the per-kind clauses. */
      kind: "split"
      /** Async sub-agents pending. `0` means: omit that clause (R5A.4). */
      agents: number
      /** Background shell tasks pending. `0` means: omit that clause. */
      shells: number
    }
  | {
      /** The split is unavailable — use the pre-existing aggregate wording. */
      kind: "aggregate"
      total: number
    }

/**
 * Resolve the chip's wording mode from the three counts mirrored onto the
 * connection.
 *
 * Backward compatibility is the whole point of the `aggregate` arm. The backend
 * omits a per-kind count when it is zero, so an absent field denormalizes to
 * `0` — indistinguishable, field-by-field, from a backend that never sent the
 * split at all. The pair's SUM disambiguates: the producer guarantees
 * `agents + shells === total` (asserted backend-side), so a non-zero `total`
 * with a zero sum can only mean the split never arrived, and the chip keeps its
 * original aggregate sentence rather than claiming zero of both kinds.
 *
 * A partial sum (one kind present, and the two not summing to the total) is
 * treated the same conservative way: reporting clauses that don't account for
 * every counted task would be worse than the honest aggregate.
 */
export function resolveBackgroundTaskKinds(counts: {
  outstanding: number
  agents: number
  shells: number
}): BackgroundTaskKinds {
  const { outstanding, agents, shells } = counts
  if (agents + shells !== outstanding) {
    return { kind: "aggregate", total: outstanding }
  }
  return { kind: "split", agents, shells }
}
