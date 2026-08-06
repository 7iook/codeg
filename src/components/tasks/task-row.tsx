"use client"

import { useTranslations } from "next-intl"
import { CircleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import { cn } from "@/lib/utils"
import { StatusChip } from "./task-card"
import { buildTaskActions, type TaskActionHandlers } from "./task-actions"
import type { WorkTask } from "@/lib/types"

interface TaskRowProps extends TaskActionHandlers {
  task: WorkTask
  folderName: string | null
  /** Shared render-tick timestamp for relative times (refreshed by the page). */
  now: number
  onOpen: () => void
}

/**
 * One list-view row: the same task the board draws as a card, laid out on a
 * single line so many of them can be scanned at once — leading status column
 * (chips line up), title, meta, then the same action set the card carries
 * (`buildTaskActions`, so the two surfaces cannot drift).
 *
 * A second line appears only when the task has something to say: the error of
 * a failed one, the live progress of a running one, the summary of a reviewed
 * one. Everything else stays in the detail sheet, which the row opens.
 */
export function TaskRow({
  task,
  folderName,
  now,
  onOpen,
  ...handlers
}: TaskRowProps) {
  const t = useTranslations("Tasks")
  const archived = task.archived_at != null
  const live =
    task.status === "running" ||
    task.status === "awaiting_input" ||
    task.status === "merging"
  const { primary, secondaries } = buildTaskActions(task, t, handlers)

  const showError =
    task.last_error && (task.status === "failed" || task.status === "review")
  const note = showError
    ? task.last_error
    : live && task.latest_progress
      ? task.latest_progress
      : task.status === "review" && task.result_summary
        ? task.result_summary
        : null

  const when = formatRelative(
    task.finished_at ?? task.settled_at ?? task.started_at ?? task.created_at,
    now
  )

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // Only the row's own focus opens the sheet: Enter/Space on a nested
        // action button bubbles up here, and preventing the default would
        // swallow that button's activation and open the sheet instead.
        if (e.target !== e.currentTarget) return
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        "group/row flex cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors",
        "hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        archived && "opacity-60"
      )}
    >
      {/* Fixed status column: chips vary in width, and a ragged left edge is
          exactly what a list is supposed to fix. */}
      <div className="flex w-[5.5rem] shrink-0 justify-start">
        <StatusChip task={task} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[0.8125rem] font-medium leading-snug">
          {task.title}
        </span>
        {note ? (
          <span
            className={cn(
              "flex min-w-0 items-center gap-1 text-[0.6875rem] leading-snug",
              showError ? "text-destructive" : "text-muted-foreground",
              !showError && live && "italic"
            )}
          >
            {showError ? (
              <CircleAlert className="size-3 shrink-0" aria-hidden="true" />
            ) : null}
            <span className="truncate">{note}</span>
          </span>
        ) : null}
      </div>

      {/* Meta cluster — dropped first when the window gets narrow; the title
          and the actions are what a row cannot lose. */}
      <div className="hidden shrink-0 items-center gap-1.5 text-[0.6875rem] text-muted-foreground lg:flex">
        {folderName ? (
          <span className="max-w-32 truncate">{folderName}</span>
        ) : null}
        {folderName && task.work_branch ? (
          <span className="text-muted-foreground/40">/</span>
        ) : null}
        {task.work_branch ? (
          <span className="max-w-40 truncate font-mono text-[0.625rem]">
            {task.work_branch}
          </span>
        ) : null}
        {task.files_changed != null && task.files_changed > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.625rem]">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{task.additions ?? 0}
            </span>
            <span className="text-destructive">-{task.deletions ?? 0}</span>
          </span>
        ) : null}
      </div>
      {when ? (
        <span className="hidden w-16 shrink-0 text-right text-[0.6875rem] text-muted-foreground sm:block">
          {when}
        </span>
      ) : null}

      {/* Actions keep a fixed slot so the rows' right edge stays flush whether
          or not a status has a primary (merging has none). */}
      <div className="flex shrink-0 items-center justify-end gap-1.5">
        {primary ? (
          <Button
            type="button"
            size="xs"
            onClick={(e) => {
              // The row itself opens the detail sheet — keep actions local.
              e.stopPropagation()
              primary.onClick()
            }}
          >
            <primary.icon className="size-3" aria-hidden="true" />
            {primary.label}
          </Button>
        ) : null}
        {secondaries.map((item) => (
          <Button
            key={item.label}
            type="button"
            size="icon-xs"
            variant="outline"
            className="rounded-full opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100"
            title={item.label}
            aria-label={item.label}
            onClick={(e) => {
              e.stopPropagation()
              item.onClick()
            }}
          >
            <item.icon aria-hidden="true" />
          </Button>
        ))}
      </div>
    </div>
  )
}
