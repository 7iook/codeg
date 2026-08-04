"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { useConnection } from "@/hooks/use-connection"
import { resolveBackgroundTaskKinds } from "@/lib/background-task-kinds"

/**
 * How long the "syncing results" state stays visible after a settlement with
 * no follow-up turns observed. The agent's reaction normally lands within
 * 3–15s (model time-to-first-block); past this window the CLI was likely
 * killed and the indicator must not strand.
 */
const SETTLE_SYNC_DISPLAY_MS = 30_000

/**
 * Slim per-conversation strip shown while this connection has
 * launched-but-unresolved background work (async sub-agents / background
 * shell tasks, accounted from the agent's own transcript by the backend
 * watcher). Makes the otherwise-silent gap perceivable: the turn already
 * ended, but results will still stream in as overlay turns and the
 * connection is being kept alive for them.
 *
 * The count NAMES its two kinds — "2 background sub-agents", "1 background
 * shell", or both with separate numbers — because the bare aggregate was
 * unreadable next to the sub-agent chip directly above it: that one counts
 * codeg's DELEGATED sub-agents (delegation broker), a disjoint pool this number
 * never included. Dispatch two delegations and this chip correctly reads
 * nothing; run one build and it reads 1 while the sub-agent panel is empty. The
 * two numbers are unrelated by construction and are not meant to agree — only
 * to each be readable on its own (R5A).
 *
 * A zero kind is omitted rather than printed as "0 shells" (R5A.4), and a
 * backend that predates the split keeps the original aggregate sentence (see
 * `resolveBackgroundTaskKinds`).
 *
 * After the last task settles the strip doesn't vanish into a void: it
 * transitions to a "syncing results" state until the agent's reaction turn
 * starts surfacing (or the display window above expires).
 *
 * Returns null (no layout impact) when nothing is pending.
 */
export function BackgroundTasksChip({ contextKey }: { contextKey: string }) {
  const t = useTranslations("Folder.chat.backgroundTasks")
  const {
    backgroundOutstanding,
    backgroundOutstandingAgents,
    backgroundOutstandingShells,
    backgroundSettleSyncingSince,
  } = useConnection(contextKey)

  // Which arm timestamp has display-expired. Tied to the specific value so a
  // re-arm (another settlement → fresh timestamp) un-expires automatically,
  // and render stays pure (Date.now() only runs inside the effect).
  const [expiredFor, setExpiredFor] = useState<number | null>(null)
  useEffect(() => {
    if (backgroundSettleSyncingSince == null) return
    const remaining =
      SETTLE_SYNC_DISPLAY_MS - (Date.now() - backgroundSettleSyncingSince)
    // An already-expired arm (e.g. hydrated stale) fires on the next tick —
    // never synchronously in the effect body.
    const timer = setTimeout(
      () => setExpiredFor(backgroundSettleSyncingSince),
      Math.max(0, remaining) + 50
    )
    return () => clearTimeout(timer)
  }, [backgroundSettleSyncingSince])

  const showSyncing =
    backgroundOutstanding <= 0 &&
    backgroundSettleSyncingSince != null &&
    expiredFor !== backgroundSettleSyncingSince

  if (backgroundOutstanding <= 0 && !showSyncing) return null

  return (
    <div className="border-b border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-700 dark:text-sky-300">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-center gap-2">
        {/* Plain animate-spin on purpose: a motion-safe gate would freeze the
            only "still working" signal for Reduce Motion users. */}
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span className="min-w-0 truncate">
          {backgroundOutstanding > 0
            ? runningLabel(t, {
                outstanding: backgroundOutstanding,
                agents: backgroundOutstandingAgents,
                shells: backgroundOutstandingShells,
              })
            : t("settling")}
        </span>
      </div>
    </div>
  )
}

/**
 * The running sentence for a non-zero count, naming whichever kinds are
 * actually present. Split out so the four-way wording choice reads as one
 * decision rather than nested ternaries inside JSX.
 */
function runningLabel(
  t: ReturnType<typeof useTranslations<"Folder.chat.backgroundTasks">>,
  counts: { outstanding: number; agents: number; shells: number }
): string {
  const resolved = resolveBackgroundTaskKinds(counts)
  if (resolved.kind === "aggregate") {
    return t("running", { count: resolved.total })
  }
  const { agents, shells } = resolved
  if (agents > 0 && shells > 0) {
    return t("runningBoth", { agents, shells })
  }
  // Exactly one kind is non-zero here: the caller only renders on a non-zero
  // aggregate, and a consistent split cannot have both kinds at zero then.
  return agents > 0
    ? t("runningAgents", { count: agents })
    : t("runningShells", { count: shells })
}
