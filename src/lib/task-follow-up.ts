/**
 * Follow-up scenarios for a reviewed work task.
 *
 * The board offers ONE neutral "follow up" action on a reviewed task; the
 * intent picks the wording the backend wraps around whatever the user typed.
 * That distinction is the point: the same sentence means "fix this", "also do
 * this" or "explain this" depending on which they meant, and an agent told its
 * work was *returned* starts editing files either way — including when the user
 * only wanted an answer.
 *
 * Mirrors `FollowUpIntent` in `src-tauri/src/models/work_task.rs`. The list
 * order is the chip order.
 */

import {
  CircleQuestionMark,
  ListChecks,
  PenLine,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react"

export type FollowUpIntent = "revise" | "continue" | "question" | "verify"

/**
 * `as const` and no widening annotation on purpose: next-intl types `t()` by
 * literal key, so `labelKey: string` would make every lookup a type error.
 */
export const FOLLOW_UP_SCENARIOS = [
  {
    // First, and the default: this is what the action did before it grew
    // scenarios, down to the prompt the agent receives.
    intent: "revise",
    icon: PenLine,
    labelKey: "followUpIntentRevise",
    placeholderKey: "followUpPlaceholderRevise",
    allowsEmpty: false,
  },
  {
    intent: "continue",
    icon: ListChecks,
    labelKey: "followUpIntentContinue",
    placeholderKey: "followUpPlaceholderContinue",
    allowsEmpty: false,
  },
  {
    intent: "question",
    icon: CircleQuestionMark,
    labelKey: "followUpIntentQuestion",
    placeholderKey: "followUpPlaceholderQuestion",
    allowsEmpty: false,
  },
  {
    intent: "verify",
    icon: ShieldCheck,
    labelKey: "followUpIntentVerify",
    placeholderKey: "followUpPlaceholderVerify",
    allowsEmpty: true,
  },
] as const satisfies readonly {
  intent: FollowUpIntent
  icon: LucideIcon
  /** `Tasks` message key for the chip label. */
  labelKey: string
  /** `Tasks` message key for the textarea placeholder. */
  placeholderKey: string
  /**
   * Whether the scenario is a complete instruction without user text. Only the
   * self-check is: "look it over before I accept it" needs no elaboration, and
   * making it one click is most of its value.
   */
  allowsEmpty: boolean
}[]

export type FollowUpScenario = (typeof FOLLOW_UP_SCENARIOS)[number]

export const DEFAULT_FOLLOW_UP_INTENT: FollowUpIntent = "revise"

export function followUpScenario(intent: FollowUpIntent): FollowUpScenario {
  return (
    FOLLOW_UP_SCENARIOS.find((s) => s.intent === intent) ??
    FOLLOW_UP_SCENARIOS[0]
  )
}

/** Whether this scenario can be sent with the text currently in the box. */
export function canSubmitFollowUp(
  intent: FollowUpIntent,
  text: string
): boolean {
  return text.trim().length > 0 || followUpScenario(intent).allowsEmpty
}
