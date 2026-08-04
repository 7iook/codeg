"use client"

/**
 * The observatory's list body — container-agnostic on purpose.
 *
 * It receives rows, an eviction count and a frame reader, and knows nothing
 * about the popover that currently hosts it (D5's upgrade path: pinning this to
 * a sidebar or promoting it to an AuxPanel tab should be wiring, not a rewrite).
 * The only thing it owns beyond layout is the SELECTION and the one summary
 * fetch that selection triggers.
 *
 * Row visual language deliberately matches `SubAgentOverlay`'s rows (agent icon
 * in a circle, bold label, `#taskId` prefix in monospace, status badge, second
 * line of grey truncated task text): the panel and the inline cards describe the
 * same objects, and two different visual treatments would read as two features.
 *
 * Detail depth differs by source, and the asymmetry is the design (D2):
 *
 *   * A BUILT-IN SUB's frames are already in memory, so its transcript renders
 *     directly with no request at all.
 *   * A DELEGATION has no frames here — its transcript lives in the child's DB
 *     rows — so one recent-assistant-message summary is fetched through the
 *     EXISTING conversation-detail read, on selection only. The full history
 *     stays behind the link-out; this panel is not a second session viewer.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react"
import {
  Bot,
  ChevronRight,
  ExternalLink,
  Info,
  Loader2,
  RotateCw,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { AgentIcon } from "@/components/agent-icon"
import { StatusBadge } from "@/components/message/delegation-status-badge"
import { SubagentTranscript } from "@/components/message/subagent-transcript"
import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import { getFolderConversation } from "@/lib/api"
import { getAgentLabel } from "@/lib/custom-agents"
import type { SubagentFrame } from "@/lib/subagent-transcript"
import type {
  ObservedPartition,
  ObservedSubAgentRow,
} from "@/lib/observed-sub-agents"
import type { AgentType, DbConversationDetail } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions } from "@/stores/tab-store"
import { cn } from "@/lib/utils"

/**
 * Terminal rows kept per conversation (R2.14). Bounds the section a busy
 * workspace would otherwise let grow to the provider caps (256 delegations),
 * while staying large enough to cover a normal look-back. Applied PER
 * CONVERSATION so one noisy conversation cannot squeeze another's history out
 * of view — the panel is workspace-wide, so a global cap would do exactly that.
 */
export const COMPLETED_ROWS_PER_CONVERSATION = 20

/** Sections in display order. `partition` already encodes the lifecycle-first
 *  precedence, so this list only fixes the visual order. */
const SECTION_ORDER: readonly ObservedPartition[] = [
  "current",
  "other",
  "unattributed",
  "completed",
]

export interface SubAgentObservatoryListProps {
  rows: readonly ObservedSubAgentRow[]
  /** Built-in SUB entries dropped for capacity since the workspace loaded.
   *  Workspace-scoped, never per-conversation (R3.9). */
  evictedCount: number
  /** Frames for a built-in row, by `parentToolUseId`. Injected rather than read
   *  from the provider here so this component stays testable without one, and
   *  so the caller keeps the single subscription. */
  getFrames: (parentToolUseId: string) => readonly SubagentFrame[] | undefined
}

/** Newest-last ordering is the selector's; the cap keeps the newest, so it
 *  drops from the FRONT of each conversation's terminal group. */
function capCompletedPerConversation(
  rows: readonly ObservedSubAgentRow[]
): ObservedSubAgentRow[] {
  const counts = new Map<number | null, number>()
  const kept: ObservedSubAgentRow[] = []
  // Walk backwards so "keep the newest N" needs no sort: the first N seen from
  // the end are the ones retained.
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const candidate = rows[i]!
    const seen = counts.get(candidate.conversationId) ?? 0
    if (seen >= COMPLETED_ROWS_PER_CONVERSATION) continue
    counts.set(candidate.conversationId, seen + 1)
    kept.push(candidate)
  }
  kept.reverse()
  return kept
}

/** Status shape the shared `StatusBadge` speaks, derived from the row's
 *  lifecycle. `silent` maps to `checked` — a neutral, NON-SPINNING badge — never
 *  to `ok`: a quiet built-in SUB has not been shown to have succeeded, and its
 *  event stream cannot support that claim (R3.14). */
function badgeStatus(
  row: ObservedSubAgentRow
): "running" | "checked" | "ok" | "err" {
  switch (row.lifecycle) {
    case "running":
      return "running"
    case "silent":
      return "checked"
    case "completed":
      return "ok"
    default:
      return "err"
  }
}

/** Most recent assistant text in the child's persisted transcript, which is the
 *  whole of the summary (R6.9). Returns `null` when the child has no assistant
 *  turn yet — a real state, distinct from "still loading", and rendered as such
 *  rather than as blank space (R6.16). */
function summarizeDetail(detail: DbConversationDetail | null): string | null {
  if (!detail) return null
  for (let i = detail.turns.length - 1; i >= 0; i -= 1) {
    const turn = detail.turns[i]!
    if (turn.role !== "assistant") continue
    const texts: string[] = []
    for (const block of turn.blocks) {
      if (block.type === "text" && block.text.trim().length > 0) {
        texts.push(block.text.trim())
      }
    }
    if (texts.length > 0) return texts.join("\n\n")
  }
  return null
}

interface SummaryState {
  detail: DbConversationDetail | null
  loading: boolean
  error: boolean
}

const IDLE_SUMMARY: SummaryState = {
  detail: null,
  loading: false,
  error: false,
}

type SummaryAction =
  | { kind: "idle" }
  | { kind: "start" }
  | { kind: "ok"; detail: DbConversationDetail }
  | { kind: "err" }

// `useReducer` rather than `useState`, matching `use-delegated-sub-session.ts`:
// the in-effect transition is then a single dispatch, which is what
// `react-hooks/set-state-in-effect` is asking for (it flags raw setState in an
// effect body, not dispatch). Same three states, one transition function.
function summaryReducer(
  _state: SummaryState,
  action: SummaryAction
): SummaryState {
  switch (action.kind) {
    case "idle":
      return IDLE_SUMMARY
    case "start":
      return { detail: null, loading: true, error: false }
    case "ok":
      return { detail: action.detail, loading: false, error: false }
    case "err":
      return { detail: null, loading: false, error: true }
  }
}

/**
 * One summary fetch for the CURRENTLY SELECTED delegation row.
 *
 * Two independent guards, because they fail differently:
 *
 *   * `cancelled`, per effect run, stops a resolved promise from writing after
 *     the effect that started it was torn down (React 18 double-invoke, unmount).
 *   * `seqRef`, monotonic across runs, stops an EARLIER row's slower response
 *     from landing under a LATER row (R6.14). The cleanup flag alone does not
 *     cover this: both callbacks belong to live-at-the-time effects, and without
 *     a sequence the first response would overwrite the second whenever it
 *     arrives last — showing one sub-agent's work attributed to another, which
 *     is worse than showing nothing.
 *
 * `retryNonce` re-runs the effect without changing the selection, so retry
 * reuses this one path rather than a second fetch site (R6.13).
 */
function useSelectedSummary(
  childConversationId: number | null
): SummaryState & { retry: () => void } {
  const [state, dispatch] = useReducer(summaryReducer, IDLE_SUMMARY)
  const [retryNonce, setRetryNonce] = useState(0)
  const seqRef = useRef(0)
  const retry = useCallback(() => setRetryNonce((n) => n + 1), [])

  useEffect(() => {
    if (childConversationId == null) {
      dispatch({ kind: "idle" })
      return
    }
    const seq = ++seqRef.current
    let cancelled = false
    dispatch({ kind: "start" })
    void getFolderConversation(childConversationId)
      .then((detail) => {
        if (cancelled || seqRef.current !== seq) return
        dispatch({ kind: "ok", detail })
      })
      .catch(() => {
        if (cancelled || seqRef.current !== seq) return
        dispatch({ kind: "err" })
      })
    return () => {
      cancelled = true
    }
  }, [childConversationId, retryNonce])

  return { ...state, retry }
}

/** Delegation detail: one summary line + the link out. Never the full history —
 *  that is `SubAgentSessionDialog` / the child's own tab (R6.15). */
function DelegationDetail({ row }: { row: ObservedSubAgentRow }) {
  const t = useTranslations("Folder.chat.subAgentObservatory")
  const { openTab } = useTabActions()
  const { detail, loading, error, retry } = useSelectedSummary(
    row.childConversationId
  )
  const summary = useMemo(() => summarizeDetail(detail), [detail])

  const folderId = detail?.summary.folder_id ?? null
  const agentType: AgentType | null =
    detail?.summary.agent_type ?? row.agentType
  const canOpen =
    row.childConversationId != null && folderId != null && agentType != null

  if (loading) {
    return (
      <div
        data-testid="observatory-detail-loading"
        className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        {t("detailLoading")}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
        <span role="alert" className="min-w-0 flex-1 text-destructive">
          {t("detailError")}
        </span>
        <button
          type="button"
          data-testid="observatory-detail-retry"
          onClick={retry}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 font-medium transition-colors hover:bg-muted/60"
        >
          <RotateCw className="h-3 w-3" aria-hidden="true" />
          {t("detailRetry")}
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-2 px-2 py-2">
      {summary ? (
        <p className="line-clamp-4 text-xs whitespace-pre-wrap text-muted-foreground">
          {summary}
        </p>
      ) : (
        <p
          data-testid="observatory-detail-nothing"
          className="text-xs text-muted-foreground/80"
        >
          {t("detailNothing")}
        </p>
      )}
      {canOpen && (
        <button
          type="button"
          data-testid="observatory-detail-open"
          onClick={() => openTab(folderId, row.childConversationId!, agentType)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
          {t("detailOpenInTab")}
        </button>
      )}
    </div>
  )
}

/** Built-in SUB detail: the frames already held in memory, rendered by the same
 *  component the inline capsule uses, so the two never diverge (R6.8). */
function BuiltinDetail({
  row,
  getFrames,
}: {
  row: ObservedSubAgentRow
  getFrames: SubAgentObservatoryListProps["getFrames"]
}) {
  const t = useTranslations("Folder.chat.subAgentObservatory")
  const frames = getFrames(row.parentToolUseId)

  if (!frames || frames.length === 0) {
    return (
      <p
        data-testid="observatory-detail-nothing"
        className="px-2 py-2 text-xs text-muted-foreground/80"
      >
        {t("detailNothing")}
      </p>
    )
  }

  return (
    <div className="px-2 py-2">
      <SubagentTranscript
        frames={frames}
        parentToolUseId={row.parentToolUseId}
        // Tool calls render as a compact one-line marker here rather than the
        // full inline card: the panel is a narrow overview surface, and the
        // renderer that draws those cards lives downstream of this component
        // (wiring it in would invert the dependency direction for a detail the
        // link-out already covers in full).
        renderToolCall={(part, key) => (
          <div
            key={key}
            className="truncate rounded-md bg-muted/50 px-2 py-1 font-mono text-[11px] text-muted-foreground"
          >
            {part.toolName}
          </div>
        )}
      />
    </div>
  )
}

function ObservatoryRow({
  row,
  selected,
  onSelect,
  conversationLabel,
  getFrames,
}: {
  row: ObservedSubAgentRow
  selected: boolean
  onSelect: () => void
  /** Owning-conversation label, shown only in the sections where the row's
   *  conversation is not implied by context (R6.4). `null` elsewhere. */
  conversationLabel: string | null
  getFrames: SubAgentObservatoryListProps["getFrames"]
}) {
  const t = useTranslations("Folder.chat.subAgentObservatory")

  return (
    <div className="rounded-lg border border-border/60">
      <button
        type="button"
        data-testid="observatory-row"
        onClick={onSelect}
        aria-expanded={selected}
        className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-foreground">
              {row.agentType ? (
                <AgentIcon agentType={row.agentType} className="h-3.5 w-3.5" />
              ) : (
                <Bot className="h-3 w-3 text-muted-foreground" aria-hidden />
              )}
            </span>
            <span className="min-w-0 truncate text-xs font-semibold text-foreground">
              {row.agentType ? getAgentLabel(row.agentType) : t("unknownAgent")}
            </span>
            {row.taskId && (
              <span
                className="shrink-0 font-mono text-[11px] text-muted-foreground"
                title={row.taskId}
              >
                #{row.taskId.slice(0, 8)}
              </span>
            )}
            <span data-testid="observatory-row-lifecycle" className="shrink-0">
              {/* `silent` deliberately reads as "no recent activity", never as a
                  successful finish (R3.14) — the badge is neutral and the
                  tooltip says so in words. */}
              {row.lifecycle === "silent" ? (
                <Badge
                  variant="secondary"
                  className="gap-1 rounded-full text-xs"
                  title={t("silentTooltip")}
                >
                  <Info className="h-3 w-3 text-muted-foreground" aria-hidden />
                  {t("silent")}
                </Badge>
              ) : (
                <StatusBadge
                  status={badgeStatus(row)}
                  errorCode={row.errorCode ?? undefined}
                />
              )}
            </span>
          </div>
          {row.taskText && (
            <div className="truncate text-[11px] text-muted-foreground">
              {row.taskText}
            </div>
          )}
          {conversationLabel && (
            <div
              data-testid="observatory-row-conversation"
              className="truncate text-[11px] text-muted-foreground/70"
            >
              {t("inConversation", { name: conversationLabel })}
            </div>
          )}
        </div>
      </button>
      {selected && (
        <div className="border-t border-border/60">
          {row.kind === "builtin" ? (
            <BuiltinDetail row={row} getFrames={getFrames} />
          ) : (
            <DelegationDetail row={row} />
          )}
        </div>
      )}
    </div>
  )
}

export function SubAgentObservatoryList({
  rows,
  evictedCount,
  getFrames,
}: SubAgentObservatoryListProps) {
  const t = useTranslations("Folder.chat.subAgentObservatory")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [otherOpen, setOtherOpen] = useState(false)

  // Conversation titles for the labels in the other/completed sections. Read as
  // a whole list and resolved in a memo (rather than a per-row store read) so
  // one subscription covers every row.
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  const titleById = useMemo(() => {
    const map = new Map<number, string>()
    for (const conversation of conversations) {
      map.set(conversation.id, conversation.title ?? "")
    }
    return map
  }, [conversations])

  const sections = useMemo(() => {
    const grouped = new Map<ObservedPartition, ObservedSubAgentRow[]>()
    for (const row of rows) {
      const bucket = grouped.get(row.partition)
      if (bucket) bucket.push(row)
      else grouped.set(row.partition, [row])
    }
    const completed = grouped.get("completed")
    if (completed) {
      grouped.set("completed", capCompletedPerConversation(completed))
    }
    return SECTION_ORDER.flatMap((partition) => {
      const partitionRows = grouped.get(partition)
      if (!partitionRows || partitionRows.length === 0) return []
      return [{ partition, rows: partitionRows }]
    })
  }, [rows])

  const labelFor = useCallback(
    (row: ObservedSubAgentRow, partition: ObservedPartition): string | null => {
      // The current section's rows belong to the conversation the user is
      // already in, so a label there would be noise. Unattributed rows have no
      // conversation to name — that IS their state, disclosed by the section.
      if (partition !== "other" && partition !== "completed") return null
      if (row.conversationId == null) return null
      const title = titleById.get(row.conversationId)
      return title && title.length > 0
        ? title
        : t("untitledConversation", { id: row.conversationId })
    },
    [titleById, t]
  )

  // The notice renders even with an empty list: an empty list CAUSED by eviction
  // is exactly when the explanation matters most.
  const capacityNotice =
    evictedCount > 0 ? (
      <p
        data-testid="observatory-capacity-notice"
        className="flex items-start gap-1.5 border-b border-border/60 px-2 pb-2 text-[11px] text-muted-foreground"
      >
        <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
        {/* Workspace-scoped wording (R3.9): the count covers every conversation
            in this workspace, and saying "this conversation" would attribute
            other conversations' losses to the one being viewed. */}
        <span>{t("capacityNotice", { count: evictedCount })}</span>
      </p>
    ) : null

  if (sections.length === 0) {
    return (
      <div data-testid="observatory-list" className="space-y-2">
        {capacityNotice}
        <p
          data-testid="observatory-empty"
          className="px-2 py-3 text-center text-xs text-muted-foreground"
        >
          {t("empty")}
        </p>
      </div>
    )
  }

  return (
    <div data-testid="observatory-list" className="space-y-3">
      {capacityNotice}
      {sections.map(({ partition, rows: sectionRows }) => {
        const body = (
          <div className="space-y-1.5">
            {sectionRows.map((row) => (
              <ObservatoryRow
                key={row.id}
                row={row}
                selected={selectedId === row.id}
                onSelect={() =>
                  setSelectedId((prev) => (prev === row.id ? null : row.id))
                }
                conversationLabel={labelFor(row, partition)}
                getFrames={getFrames}
              />
            ))}
          </div>
        )

        // Only the other-conversations group collapses (R6.2). The current
        // conversation is expanded because it is why the user opened the panel;
        // the terminal group is expanded because looking back at finished work
        // is the other half of the same need.
        if (partition === "other") {
          return (
            <Collapsible
              key={partition}
              data-testid="observatory-section-other"
              open={otherOpen}
              onOpenChange={setOtherOpen}
            >
              <CollapsibleTrigger
                data-testid="observatory-other-toggle"
                className="flex w-full items-center gap-1 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "h-3 w-3 transition-transform",
                    otherOpen && "rotate-90"
                  )}
                />
                {t("sectionOther", { count: sectionRows.length })}
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1.5">{body}</CollapsibleContent>
            </Collapsible>
          )
        }

        return (
          <div key={partition} data-testid={`observatory-section-${partition}`}>
            <div className="px-2 pb-1.5 text-[11px] font-medium text-muted-foreground">
              {partition === "current"
                ? t("sectionCurrent")
                : partition === "unattributed"
                  ? t("sectionUnattributed")
                  : t("sectionCompleted")}
            </div>
            {body}
          </div>
        )
      })}
    </div>
  )
}
