"use client"

/**
 * The one renderer for "which persona actually took effect" on a delegation
 * card. Both the inline `DelegatedSubThread` and the top-right
 * `SubAgentOverlay` mount it, for the same reason they share
 * `useDelegationCardModel`: the two surfaces must never disagree about a
 * sub-agent. Styling per Requirement 5.3 — native is primary, hint is dimmed
 * (`best-effort`), ignored is greyed with an explicit "CLI unsupported".
 *
 * It renders the EFFECT only. The nominated request (`requestedPersona`) is a
 * separate component below, deliberately: conflating them is what would let a
 * rejected persona look applied.
 */

import { useTranslations } from "next-intl"

import {
  truncateModelId,
  truncatePersonaName,
  type AppliedPersona,
} from "@/lib/delegation-card"
import { cn } from "@/lib/utils"

/**
 * The effective-persona label, or null when nothing took effect.
 *
 * Renders nothing for a null persona — no fallback to the request, since
 * "asked for X" and "running as X" are different facts (Requirement 5.5).
 */
export function PersonaLabel({
  persona,
  className,
}: {
  persona: AppliedPersona | null
  className?: string
}) {
  const t = useTranslations("Folder.chat.delegation")
  if (!persona) return null

  // The full name stays reachable via the native tooltip and is selectable for
  // copy even when the visible text is truncated (Requirement 5.6).
  const display = truncatePersonaName(persona.name)
  const suffix =
    persona.kind === "hint"
      ? ` (${t("personaBestEffort")})`
      : persona.kind === "ignored_unsupported_cli"
        ? ` (${t("personaIgnoredUnsupported")})`
        : ""

  return (
    <span
      data-testid="delegation-persona-label"
      data-persona-kind={persona.kind}
      title={`@${persona.name}${suffix}`}
      className={cn(
        "min-w-0 truncate font-mono",
        persona.kind === "native"
          ? "text-foreground"
          : persona.kind === "hint"
            ? "text-muted-foreground"
            : "text-muted-foreground/60",
        className
      )}
    >
      {`· @${display}${suffix}`}
    </span>
  )
}

/**
 * The "what was asked for" line on a FAILURE card (Requirement 5.4). Reuses the
 * existing error card and the existing `Err` wire shape — no new outcome field
 * was added for failures (R3-F2), so this is the only place `raw_input`'s
 * nominated name is allowed to surface.
 *
 * Callers must gate on the card actually being in an error state; this
 * component only guards the empty-name case.
 */
export function RequestedPersonaNote({
  requestedPersona,
  className,
}: {
  requestedPersona: string | null
  className?: string
}) {
  const t = useTranslations("Folder.chat.delegation")
  if (!requestedPersona) return null
  return (
    <div
      data-testid="delegation-requested-persona"
      title={`@${requestedPersona}`}
      className={cn("truncate font-mono text-muted-foreground", className)}
    >
      {t("personaRequested", {
        name: `@${truncatePersonaName(requestedPersona)}`,
      })}
    </div>
  )
}

/**
 * The per-call model a delegated sub-agent was LAUNCHED WITH, or null when none
 * was nominated.
 *
 * # Why this says "requested" and not "running on"
 *
 * codeg's committed responsibility boundary is DELIVERY: it guarantees the model
 * id reached the child's launch (env var, or `--model` argv for Kiro / Cursor),
 * and it never verifies the endpoint honoured it. A relay can silently answer
 * with its own default model instead of erroring. Labelling this as the model in
 * USE would therefore assert something the build never checked — the specific
 * failure this component exists to avoid. Hence the `t("modelRequested")`
 * framing and the tooltip spelling the caveat out in full.
 *
 * This is the same requested-vs-applied split `RequestedPersonaNote` draws, for
 * the same reason — but note the difference in WHEN each shows: the persona note
 * is failure-only (a nominated persona that did not take effect), whereas this
 * renders on every card that carried a model, because the value being present at
 * all already means the spawn succeeded. What it never claims is adoption.
 *
 * Renders nothing for a null model — a sub-agent on the user's configured
 * default gets no chip, not an "unknown" or "default" placeholder.
 */
export function RequestedModelLabel({
  model,
  className,
}: {
  model: string | null
  className?: string
}) {
  const t = useTranslations("Folder.chat.delegation")
  if (!model) return null

  // Full id stays reachable via the native tooltip and selectable for copy even
  // when the visible text is truncated (mirrors PersonaLabel's affordance).
  return (
    <span
      data-testid="delegation-requested-model"
      title={t("modelRequestedTooltip", { model })}
      className={cn(
        "min-w-0 truncate font-mono text-muted-foreground",
        className
      )}
    >
      {t("modelRequested", { model: truncateModelId(model) })}
    </span>
  )
}
