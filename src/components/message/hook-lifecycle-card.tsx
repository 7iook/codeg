"use client"

/**
 * Renders one Claude Code Stop-hook trigger (`hook-lifecycle` content part) as
 * a single compact card — decision-card §5.2. Display only: there is NO
 * allow / cancel control (the hook already ran; this is a record of what
 * happened, not an intervention point).
 *
 * The backend classified the outcome once (`HookOutcome`, single source of
 * truth), so the card only picks visuals per `data.outcome` — it never rebuilds
 * the decision from `exit_code` + stdout. The four outcomes read differently on
 * purpose (§3.1):
 *   • pass         — de-emphasized single line (the hook allowed the stop).
 *   • soft_context — a normal card showing the additionalContext fed to Claude.
 *   • hard_block   — destructive framing + a "blocked" badge, reason highlighted.
 *   • error        — an error badge, distinct from a block, so the user can tell
 *                    "the hook script itself failed" from "the hook blocked me".
 *
 * A6: the frontend payload carries `command_display` (basename) +
 * `hook_specific_output`, never the raw command / stdout / stderr — those are
 * serde(skip) on the backend, so there is nothing raw to render here.
 */

import { useState } from "react"
import {
  Ban,
  ChevronRight,
  CircleCheck,
  MessageSquareText,
  TriangleAlert,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { HookLifecyclePayload, HookOutcome } from "@/lib/types"

/** Badge tone + icon per outcome. Kept in one place so the card body and the
 *  badge never disagree about what an outcome looks like. */
function outcomeVisual(outcome: HookOutcome): {
  variant: "secondary" | "destructive" | "outline"
  Icon: typeof Ban
} {
  switch (outcome) {
    case "hard_block":
      return { variant: "destructive", Icon: Ban }
    case "error":
      return { variant: "destructive", Icon: TriangleAlert }
    case "soft_context":
      return { variant: "secondary", Icon: MessageSquareText }
    case "pass":
      return { variant: "outline", Icon: CircleCheck }
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m${s.toString().padStart(2, "0")}s`
}

export function HookLifecycleCard({ data }: { data: HookLifecyclePayload }) {
  const t = useTranslations("Folder.chat.hookLifecycle")
  const [detailsOpen, setDetailsOpen] = useState(false)

  const { variant, Icon } = outcomeVisual(data.outcome)
  const isBlock = data.outcome === "hard_block"
  const isError = data.outcome === "error"
  const context = data.additional_context ?? []
  const hasDetails =
    Boolean(data.command_display) || data.hook_specific_output != null

  // A passed hook is deliberately minimal — one de-emphasized line. It is the
  // "nothing to see" outcome, and a full card for it would be noise on every
  // ordinary turn end.
  if (data.outcome === "pass") {
    return (
      <div
        data-testid="hook-lifecycle-card"
        data-outcome="pass"
        className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-muted-foreground"
      >
        <CircleCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">
          {t("passedLine", { hook: data.hook_name })}
        </span>
      </div>
    )
  }

  return (
    <div
      data-testid="hook-lifecycle-card"
      data-outcome={data.outcome}
      className={cn(
        "w-full space-y-2 rounded-lg border p-3",
        isBlock || isError
          ? "border-destructive/40 bg-destructive/5"
          : "border-border/60 bg-background/40"
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-background",
            isBlock || isError ? "border-destructive/40" : "border-border"
          )}
        >
          <Icon
            className={cn(
              "h-3.5 w-3.5",
              isBlock || isError ? "text-destructive" : "text-muted-foreground"
            )}
            aria-hidden="true"
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {t("hookTitle", { hook: data.hook_name })}
        </span>
        <Badge
          variant={variant}
          className="shrink-0 rounded-full text-[11px]"
          data-testid="hook-outcome-badge"
        >
          {t(`outcome.${data.outcome}`)}
        </Badge>
      </div>

      {/* The reason a hook blocked (or errored) is the whole point of the card
          for those two states — highlight it rather than fold it away. */}
      {data.outcome_reason && (
        <p
          data-testid="hook-outcome-reason"
          className={cn(
            "text-xs whitespace-pre-wrap",
            isBlock || isError
              ? "font-medium text-destructive"
              : "text-muted-foreground"
          )}
        >
          {data.outcome_reason}
        </p>
      )}

      {/* additionalContext — the text the hook fed back to Claude. The soft
          case exists precisely to surface this (w1-report §二 sample). */}
      {context.length > 0 && (
        <div data-testid="hook-additional-context" className="space-y-1">
          {context.map((entry, i) => (
            <p
              key={`ctx-${i}`}
              className="rounded-md bg-muted/50 px-2 py-1.5 text-xs whitespace-pre-wrap text-muted-foreground"
            >
              {entry}
            </p>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 px-1 text-[11px] text-muted-foreground">
        <span data-testid="hook-exit-code">
          {t("exitCode", { code: data.exit_code })}
        </span>
        {data.duration_ms > 0 && (
          <span>{formatDuration(data.duration_ms)}</span>
        )}
      </div>

      {hasDetails && (
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "h-3 w-3 transition-transform",
                detailsOpen && "rotate-90"
              )}
            />
            {t("detailsToggle")}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1.5 space-y-1.5">
            {data.command_display && (
              <div
                data-testid="hook-command-display"
                className="font-mono text-[11px] text-muted-foreground"
              >
                {t("commandLabel")}{" "}
                <span className="text-foreground/80">
                  {data.command_display}
                </span>
              </div>
            )}
            {data.hook_specific_output != null && (
              <pre
                data-testid="hook-specific-output"
                className="overflow-x-auto rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground"
              >
                {JSON.stringify(data.hook_specific_output, null, 2)}
              </pre>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
