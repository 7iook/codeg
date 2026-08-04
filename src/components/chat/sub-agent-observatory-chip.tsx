"use client"

/**
 * Resident sub-agent chip — the observatory's entry point.
 *
 * Sits in the conversation panel's `topBanner` stack alongside the
 * config-stale banner and the background-tasks chip. Unlike `SubAgentOverlay`
 * (bound to the last assistant reply, and cleared by the next non-delegation
 * one), this chip's visibility is tied to the WORKSPACE's observation set, so
 * it survives both a new reply and the sub-agents finishing.
 *
 * What the number means, precisely, because two nearby chips count different
 * things:
 *
 *   * While anything is running it is the RUNNING count, with a spinner.
 *   * Once nothing is running it is the TOTAL observable count, with no spinner
 *     — NOT a completed count. A built-in sub-agent's event stream carries no
 *     termination signal, so a quiet one is `silent`, never `completed`;
 *     reporting it as finished would assert something unobservable (R5.6).
 *   * `BackgroundTasksChip` counts a DISJOINT pool (Claude's own transcript:
 *     async agents + background shells). The two numbers are unrelated by
 *     construction and are not meant to agree.
 *
 * It renders nothing when the workspace has no observable sub-agents (R5.3).
 */

import { Bot, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { useObservedSubAgents } from "@/hooks/use-observed-sub-agents"

export function SubAgentObservatoryChip({
  conversationId,
  onActivate,
  panelOpen = false,
}: {
  /** DB conversation id of the viewed conversation, or `null` before one
   *  exists. Only labels rows current-vs-other; never narrows the set. */
  conversationId: number | null
  /** Opens the observatory panel (task 6.2 owns the panel itself). Absent until
   *  then: the chip stays a live, readable indicator rather than a button
   *  wired to nothing. */
  onActivate?: () => void
  /** Reflected as `aria-expanded` once a panel exists to expand. */
  panelOpen?: boolean
}) {
  const t = useTranslations("Folder.chat.subAgentObservatory")
  const { runningCount, totalCount } = useObservedSubAgents(conversationId)

  if (totalCount === 0) return null

  const running = runningCount > 0
  const count = running ? runningCount : totalCount
  const label = running ? t("running", { count }) : t("observable", { count })

  return (
    <button
      type="button"
      data-testid="sub-agent-observatory-chip"
      // A real button even with no handler yet: it is the accessible name that
      // carries the count to screen readers, and 6.2 only has to pass the
      // callback. Not `disabled` — a disabled control reads as "temporarily
      // unavailable" and invites repeated clicking.
      onClick={onActivate}
      aria-expanded={onActivate ? panelOpen : undefined}
      aria-label={label}
      className="flex w-full items-center border-b border-violet-500/20 bg-violet-500/10 px-3 py-1.5 text-xs text-violet-700 transition-colors hover:bg-violet-500/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-violet-500/50 dark:text-violet-300"
    >
      <span className="mx-auto flex w-full max-w-3xl items-center justify-center gap-2">
        {running ? (
          /* Plain animate-spin, matching BackgroundTasksChip: gating it behind
             motion-safe would remove the only "still working" signal for
             Reduce Motion users. */
          <Loader2
            data-testid="sub-agent-observatory-activity"
            className="h-3.5 w-3.5 shrink-0 animate-spin"
            aria-hidden="true"
          />
        ) : (
          <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate">{label}</span>
      </span>
    </button>
  )
}
