"use client"

import { useTranslations } from "next-intl"
import {
  Archive,
  ArchiveRestore,
  Ban,
  CircleCheck,
  CircleX,
  GitBranch,
  GitMerge,
  Loader2,
  MessageSquareText,
  Play,
  RotateCw,
  Wrench,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { WorkTask } from "@/lib/types"

const STATUS_STYLES: Record<string, string> = {
  todo: "bg-muted text-muted-foreground",
  queued: "bg-primary/10 text-primary",
  running: "bg-primary/10 text-primary",
  awaiting_input: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  review: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  merging: "bg-primary/10 text-primary",
  done: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  canceled: "bg-muted text-muted-foreground",
}

type StatusLabelKey =
  | "statusTodo"
  | "statusQueued"
  | "statusRunning"
  | "statusAwaitingInput"
  | "statusReview"
  | "statusMerging"
  | "statusDone"
  | "statusFailed"
  | "statusCanceled"

export function statusLabelKey(status: WorkTask["status"]): StatusLabelKey {
  switch (status) {
    case "todo":
      return "statusTodo"
    case "queued":
      return "statusQueued"
    case "running":
      return "statusRunning"
    case "awaiting_input":
      return "statusAwaitingInput"
    case "review":
      return "statusReview"
    case "merging":
      return "statusMerging"
    case "done":
      return "statusDone"
    case "failed":
      return "statusFailed"
    case "canceled":
      return "statusCanceled"
  }
}

export function StatusChip({ task }: { task: WorkTask }) {
  const t = useTranslations("Tasks")
  const spinning = task.status === "running" || task.status === "merging"
  // An interrupted failure (restart) reads differently from an agent failure.
  const label =
    task.status === "failed" && task.failure_reason === "interrupted"
      ? t("statusInterrupted")
      : t(statusLabelKey(task.status))
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium leading-none",
        STATUS_STYLES[task.status]
      )}
    >
      {spinning ? (
        <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
      ) : null}
      {label}
    </span>
  )
}

interface TaskCardProps {
  task: WorkTask
  folderName: string | null
  onOpen: () => void
  onStart: () => void
  onCancel: () => void
  onRetry: () => void
  onRequeue: () => void
  onOpenConversation: () => void
  onMerge: () => void
  /** Toggles by `task.archived_at` (archive ⇄ unarchive). */
  onArchive: () => void
}

/** The acceptance red/green light for a reviewed card. */
export function PreflightChip({ task }: { task: WorkTask }) {
  const t = useTranslations("Tasks")
  const light = task.preflight
  if (!light || task.status !== "review") return null
  const tone =
    light.status === "passed"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : light.status === "failed"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground"
  return (
    <span
      className={cn(
        "inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium leading-none",
        tone
      )}
      title={
        light.status === "passed"
          ? t("preflightPassed", { name: light.command })
          : light.status === "failed"
            ? t("preflightFailed", { name: light.command })
            : t("preflightRunning", { name: light.command })
      }
    >
      {light.status === "running" ? (
        <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
      ) : light.status === "passed" ? (
        <CircleCheck className="size-2.5" aria-hidden="true" />
      ) : (
        <CircleX className="size-2.5" aria-hidden="true" />
      )}
      <span className="truncate">{light.command}</span>
    </span>
  )
}

/**
 * One board card. The whole card opens the detail sheet; the footer surfaces
 * only the status's single most-likely action (everything else lives in the
 * sheet). `merging` is deliberately action-less — it cannot be canceled.
 */
export function TaskCard({
  task,
  folderName,
  onOpen,
  onStart,
  onCancel,
  onRetry,
  onRequeue,
  onOpenConversation,
  onMerge,
  onArchive,
}: TaskCardProps) {
  const t = useTranslations("Tasks")
  const archived = task.archived_at != null
  const terminal =
    task.status === "done" ||
    task.status === "failed" ||
    task.status === "canceled"

  const stat =
    task.files_changed != null && task.files_changed > 0 ? (
      <span className="inline-flex items-center gap-1 font-mono text-[0.625rem] text-muted-foreground">
        <span>{t("filesChanged", { count: task.files_changed })}</span>
        <span className="text-emerald-600 dark:text-emerald-400">
          +{task.additions ?? 0}
        </span>
        <span className="text-destructive">-{task.deletions ?? 0}</span>
      </span>
    ) : null

  const quickAction = (() => {
    // An archived card offers exactly one way back.
    if (archived) {
      return (
        <CardAction
          icon={ArchiveRestore}
          label={t("actionUnarchive")}
          onClick={onArchive}
        />
      )
    }
    switch (task.status) {
      case "todo":
        return (
          <CardAction
            icon={Play}
            label={t("actionStart")}
            onClick={onStart}
            emphasized
          />
        )
      case "queued":
        return (
          <CardAction icon={Ban} label={t("actionCancel")} onClick={onCancel} />
        )
      case "running":
      case "awaiting_input":
        return (
          <>
            <CardAction
              icon={MessageSquareText}
              label={t("actionOpenConversation")}
              onClick={onOpenConversation}
              emphasized={task.status === "awaiting_input"}
            />
            <CardAction
              icon={Ban}
              label={t("actionCancel")}
              onClick={onCancel}
            />
          </>
        )
      case "review":
        return (
          <CardAction
            icon={GitMerge}
            label={t("actionMerge")}
            onClick={onMerge}
            emphasized
          />
        )
      case "merging":
        return null
      case "failed":
        return (
          <CardAction
            icon={RotateCw}
            label={t("actionRetry")}
            onClick={onRetry}
            emphasized
          />
        )
      case "done":
        return task.conversation_id != null ? (
          <CardAction
            icon={MessageSquareText}
            label={t("actionOpenConversation")}
            onClick={onOpenConversation}
          />
        ) : null
      case "canceled":
        return (
          <CardAction
            icon={RotateCw}
            label={t("actionRequeue")}
            onClick={onRequeue}
          />
        )
    }
  })()

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        "group/card flex cursor-pointer flex-col gap-1.5 rounded-lg border border-border bg-card/60 p-2.5 text-left",
        "transition-colors hover:border-ring/40 hover:bg-card",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        archived && "opacity-60"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words text-[0.8125rem] font-medium leading-snug">
          {task.title}
        </span>
        <StatusChip task={task} />
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem] text-muted-foreground">
        {folderName ? (
          <span className="min-w-0 truncate">{folderName}</span>
        ) : null}
        {task.work_branch ? (
          <span className="inline-flex min-w-0 items-center gap-0.5">
            <GitBranch className="size-2.5 shrink-0" aria-hidden="true" />
            <span className="truncate font-mono text-[0.625rem]">
              {task.work_branch}
            </span>
          </span>
        ) : null}
        {stat}
        {task.repairing ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[0.625rem] text-amber-600 dark:text-amber-400">
            <Wrench className="size-2.5" aria-hidden="true" />
            {t("badgeRepairing")}
          </span>
        ) : null}
        <PreflightChip task={task} />
        {task.cleanup_state === "failed" ? (
          <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[0.625rem] text-amber-600 dark:text-amber-400">
            {t("badgeCleanupFailed")}
          </span>
        ) : null}
        {task.status === "canceled" && task.worktree_folder_id != null ? (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.625rem]">
            {t("badgeWorktreeKept")}
          </span>
        ) : null}
      </div>

      {task.last_error &&
      (task.status === "failed" || task.status === "review") ? (
        <p className="line-clamp-2 text-[0.6875rem] leading-snug text-destructive/90">
          {task.last_error}
        </p>
      ) : null}
      {task.status === "review" && task.result_summary ? (
        <p className="line-clamp-2 text-[0.6875rem] leading-snug text-muted-foreground">
          {task.result_summary}
        </p>
      ) : null}
      {(task.status === "running" || task.status === "awaiting_input") &&
      task.latest_progress ? (
        <p className="line-clamp-2 text-[0.6875rem] leading-snug text-muted-foreground italic">
          {task.latest_progress}
        </p>
      ) : null}

      {quickAction || (terminal && !archived) ? (
        <div className="flex items-center gap-1 pt-0.5">
          {quickAction}
          {terminal && !archived ? (
            <CardAction
              icon={Archive}
              label={t("actionArchive")}
              onClick={onArchive}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function CardAction({
  icon: Icon,
  label,
  onClick,
  emphasized,
}: {
  icon: typeof Play
  label: string
  onClick: () => void
  emphasized?: boolean
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={emphasized ? "secondary" : "ghost"}
      className="h-6 gap-1 px-2 text-[0.6875rem]"
      onClick={(e) => {
        // The card itself opens the detail sheet — keep actions local.
        e.stopPropagation()
        onClick()
      }}
    >
      <Icon className="size-3" aria-hidden="true" />
      {label}
    </Button>
  )
}
