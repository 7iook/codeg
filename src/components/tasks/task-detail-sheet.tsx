"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Ban,
  Bot,
  CircleAlert,
  FileDiff,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Loader2,
  MessageSquareText,
  Pencil,
  Play,
  RotateCw,
  Trash2,
  Undo2,
} from "lucide-react"
import {
  workTaskCancel,
  workTaskChangedFiles,
  workTaskCleanup,
  workTaskDelete,
  workTaskDiff,
  workTaskEvents,
  workTaskRequeue,
  workTaskRetry,
  workTaskReturn,
  workTaskStart,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import { UnifiedDiffPreview } from "@/components/diff/unified-diff-preview"
import { StatusChip } from "./task-card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { WorkTask, WorkTaskChangedFile, WorkTaskEvent } from "@/lib/types"

const WORK_TASK_CHANGED_EVENT = "task://changed"

interface TaskDetailSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The live task row (already refreshed by the board's provider). */
  task: WorkTask | null
  folderName: string | null
  onOpenConversation: (task: WorkTask) => void
  onMerge: (task: WorkTask) => void
  onEdit: (task: WorkTask) => void
}

/**
 * Right-side detail drawer: metadata, the acceptance panel (diff + merge /
 * return / abandon), and the append-only progress timeline (`work_task_event`).
 */
export function TaskDetailSheet({
  open,
  onOpenChange,
  task,
  folderName,
  onOpenConversation,
  onMerge,
  onEdit,
}: TaskDetailSheetProps) {
  const t = useTranslations("Tasks")
  const [events, setEvents] = useState<WorkTaskEvent[]>([])
  const [files, setFiles] = useState<WorkTaskChangedFile[]>([])
  const [returnOpen, setReturnOpen] = useState(false)
  const [returnText, setReturnText] = useState("")
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteWorktree, setDeleteWorktree] = useState(false)
  const [diffFile, setDiffFile] = useState<string | null | false>(false)
  const [busy, setBusy] = useState(false)
  const reqRef = useRef(0)

  const taskId = task?.id ?? null
  const hasWorktree = task?.worktree_folder_id != null

  const reload = useCallback(async () => {
    if (taskId == null) return
    const id = ++reqRef.current
    try {
      const [evs, fls] = await Promise.all([
        workTaskEvents(taskId),
        hasWorktree ? workTaskChangedFiles(taskId) : Promise.resolve([]),
      ])
      if (id === reqRef.current) {
        setEvents(evs)
        setFiles(fls)
      }
    } catch {
      // keep previous data on transient error
    }
  }, [taskId, hasWorktree])

  useEffect(() => {
    if (!open || taskId == null) return

    setEvents([])
    setFiles([])
    setReturnOpen(false)
    setReturnText("")
    void reload()
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribe(WORK_TASK_CHANGED_EVENT, () => {
      void reload()
    }).then((u: () => void) => {
      if (cancelled) u()
      else unsub = u
    })
    const offReconnect = onTransportReconnect(() => {
      void reload()
    })
    return () => {
      cancelled = true
      unsub?.()
      offReconnect?.()
    }
  }, [open, taskId, reload])

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const agentLabel = useMemo(() => {
    const snap = task?.config?.label_snapshot
    if (snap?.agent_label) {
      const model = snap.config_labels?.model
      return model ? `${snap.agent_label} · ${model}` : snap.agent_label
    }
    return null
  }, [task])

  if (!task) return null

  const submitReturn = () =>
    run(async () => {
      const feedback = returnText.trim()
      if (!feedback) return
      await workTaskReturn(task.id, feedback)
      setReturnOpen(false)
      setReturnText("")
    })

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-[40rem]"
        >
          <SheetHeader className="shrink-0 gap-1.5 border-b border-border px-4 py-3">
            <div className="flex items-center gap-2 pr-8">
              <SheetTitle className="min-w-0 break-words text-base leading-snug">
                {task.title}
              </SheetTitle>
              <StatusChip task={task} />
            </div>
            <SheetDescription className="sr-only">
              {t("detailDescription")}
            </SheetDescription>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {folderName ? (
                <span className="inline-flex items-center gap-1">
                  <Folder className="size-3" aria-hidden="true" />
                  {folderName}
                </span>
              ) : null}
              {agentLabel ? (
                <span className="inline-flex items-center gap-1">
                  <Bot className="size-3" aria-hidden="true" />
                  {agentLabel}
                </span>
              ) : null}
              {task.work_branch ? (
                <span className="inline-flex items-center gap-1 font-mono text-[0.6875rem]">
                  <GitBranch className="size-3" aria-hidden="true" />
                  {task.work_branch}
                  {task.base_branch ? ` ← ${task.base_branch}` : null}
                </span>
              ) : null}
              {task.merge_commit ? (
                <span className="inline-flex items-center gap-1 font-mono text-[0.6875rem]">
                  <GitCommitHorizontal className="size-3" aria-hidden="true" />
                  {task.merge_commit.slice(0, 8)}
                </span>
              ) : null}
            </div>
          </SheetHeader>

          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 px-4 py-3">
              {task.last_error ? (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
                  <CircleAlert
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 whitespace-pre-wrap break-words">
                    {task.last_error}
                  </span>
                </div>
              ) : null}

              {task.result_summary ? (
                <section className="flex flex-col gap-1.5">
                  <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("detailSummary")}
                  </h3>
                  <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-card/40 p-2.5 text-xs leading-relaxed">
                    {task.result_summary}
                  </p>
                </section>
              ) : null}

              {/* Acceptance panel — review only. */}
              {task.status === "review" ? (
                <section className="flex flex-col gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 gap-1.5"
                      disabled={busy}
                      onClick={() => onMerge(task)}
                    >
                      <GitMerge className="size-3.5" aria-hidden="true" />
                      {t("actionMerge")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5"
                      disabled={busy}
                      onClick={() => setReturnOpen((v) => !v)}
                    >
                      <Undo2 className="size-3.5" aria-hidden="true" />
                      {t("actionReturn")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1.5 text-muted-foreground"
                      disabled={busy}
                      onClick={() => run(() => workTaskCancel(task.id))}
                    >
                      <Ban className="size-3.5" aria-hidden="true" />
                      {t("actionAbandon")}
                    </Button>
                  </div>
                  {returnOpen ? (
                    <div className="flex flex-col gap-1.5">
                      <Textarea
                        value={returnText}
                        onChange={(e) => setReturnText(e.target.value)}
                        placeholder={t("returnPlaceholder")}
                        rows={3}
                        autoFocus
                      />
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          size="sm"
                          className="h-7"
                          disabled={busy || !returnText.trim()}
                          onClick={submitReturn}
                        >
                          {t("returnSubmit")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {/* Changed files vs the recorded base. */}
              {hasWorktree ? (
                <section className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                      {t("detailFiles")}
                    </h3>
                    {files.length > 0 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 gap-1 px-2 text-[0.6875rem] text-muted-foreground"
                        onClick={() => setDiffFile(null)}
                      >
                        <FileDiff className="size-3" aria-hidden="true" />
                        {t("detailDiffAll")}
                      </Button>
                    ) : null}
                  </div>
                  {files.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t("detailNoChanges")}
                    </p>
                  ) : (
                    <ul className="flex flex-col overflow-hidden rounded-lg border border-border">
                      {files.map((f) => (
                        <li key={f.file}>
                          <button
                            type="button"
                            onClick={() => setDiffFile(f.file)}
                            className={cn(
                              "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs",
                              "transition-colors hover:bg-accent/50"
                            )}
                          >
                            <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem]">
                              {f.file}
                            </span>
                            <span className="shrink-0 font-mono text-[0.625rem] text-emerald-600 dark:text-emerald-400">
                              +{f.additions}
                            </span>
                            <span className="shrink-0 font-mono text-[0.625rem] text-destructive">
                              -{f.deletions}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}

              {/* Progress timeline (work_task_event, append-only). */}
              <section className="flex flex-col gap-1.5">
                <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("detailTimeline")}
                </h3>
                {events.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("detailTimelineEmpty")}
                  </p>
                ) : (
                  <ol className="flex flex-col gap-0 border-l border-border/70 pl-3">
                    {events.map((ev) => (
                      <TimelineRow key={ev.id} event={ev} />
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </ScrollArea>

          {/* Footer: status-specific secondary actions. */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border px-4 py-2.5">
            {task.status === "todo" ? (
              <FooterAction
                icon={Play}
                label={t("actionStart")}
                busy={busy}
                onClick={() => run(() => workTaskStart(task.id))}
              />
            ) : null}
            {task.status === "failed" ? (
              <FooterAction
                icon={RotateCw}
                label={t("actionRetry")}
                busy={busy}
                onClick={() => run(() => workTaskRetry(task.id))}
              />
            ) : null}
            {task.status === "todo" || task.status === "failed" ? (
              <FooterAction
                icon={Pencil}
                label={t("actionEdit")}
                busy={busy}
                onClick={() => onEdit(task)}
              />
            ) : null}
            {task.status === "canceled" ? (
              <FooterAction
                icon={RotateCw}
                label={t("actionRequeue")}
                busy={busy}
                onClick={() => run(() => workTaskRequeue(task.id))}
              />
            ) : null}
            {["queued", "running", "awaiting_input"].includes(task.status) ? (
              <FooterAction
                icon={Ban}
                label={t("actionCancel")}
                busy={busy}
                onClick={() => run(() => workTaskCancel(task.id))}
              />
            ) : null}
            {task.conversation_id != null ? (
              <FooterAction
                icon={MessageSquareText}
                label={t("actionOpenConversation")}
                busy={false}
                onClick={() => onOpenConversation(task)}
              />
            ) : null}
            {hasWorktree &&
            ["done", "canceled", "failed", "review"].includes(task.status) ? (
              <FooterAction
                icon={Trash2}
                label={
                  task.cleanup_state === "failed"
                    ? t("actionRetryCleanup")
                    : t("actionCleanup")
                }
                busy={busy}
                onClick={() => run(() => workTaskCleanup(task.id))}
              />
            ) : null}
            <div className="flex-1" />
            {task.status !== "merging" ? (
              <FooterAction
                icon={Trash2}
                label={t("actionDelete")}
                busy={busy}
                destructive
                onClick={() => setDeleteOpen(true)}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      {/* Per-file / full diff viewer. */}
      <Dialog
        open={diffFile !== false}
        onOpenChange={(o) => !o && setDiffFile(false)}
      >
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[56rem]">
          <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
            <DialogTitle className="truncate font-mono text-sm">
              {diffFile === false ? "" : (diffFile ?? t("detailDiffAllTitle"))}
            </DialogTitle>
          </DialogHeader>
          {diffFile !== false ? (
            <TaskDiffBody taskId={task.id} file={diffFile} />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Delete confirm (optionally with the worktree). */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirmBody", { title: task.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {hasWorktree ? (
            <Label className="text-sm font-normal">
              <Checkbox
                checked={deleteWorktree}
                onCheckedChange={(v) => setDeleteWorktree(v === true)}
              />
              {t("deleteWithWorktree")}
            </Label>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                run(async () => {
                  await workTaskDelete(task.id, hasWorktree && deleteWorktree)
                  setDeleteOpen(false)
                  onOpenChange(false)
                })
              }
            >
              {t("actionDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function TaskDiffBody({
  taskId,
  file,
}: {
  taskId: number
  file: string | null
}) {
  const t = useTranslations("Tasks")
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    /* eslint-disable react-hooks/set-state-in-effect */
    setDiff(null)
    setError(null)
    workTaskDiff(taskId, file)
      .then((d) => {
        if (!cancelled) setDiff(d)
      })
      .catch((e) => {
        if (!cancelled) setError(toErrorMessage(e))
      })
    return () => {
      cancelled = true
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [taskId, file])

  if (error) {
    return <p className="p-4 text-sm text-destructive">{error}</p>
  }
  if (diff == null) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t("diffLoading")}
      </div>
    )
  }
  if (!diff.trim()) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("detailNoChanges")}
      </p>
    )
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="p-3">
        <UnifiedDiffPreview diffText={diff} />
      </div>
    </ScrollArea>
  )
}

function FooterAction({
  icon: Icon,
  label,
  onClick,
  busy,
  destructive,
}: {
  icon: typeof Play
  label: string
  onClick: () => void
  busy: boolean
  destructive?: boolean
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={busy}
      className={cn(
        "h-7 gap-1.5 px-2 text-xs",
        destructive
          ? "text-destructive hover:text-destructive"
          : "text-muted-foreground hover:text-foreground"
      )}
      onClick={onClick}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </Button>
  )
}

const EVENT_KIND_KEYS = {
  created: "eventCreated",
  status_changed: "eventStatusChanged",
  config_effective: "eventConfigEffective",
  agent_progress: "eventAgentProgress",
  agent_verdict: "eventAgentVerdict",
  merge_attempt: "eventMergeAttempt",
  merge_conflict: "eventMergeConflict",
  cleanup_failed: "eventCleanupFailed",
  resume_fallback: "eventResumeFallback",
  user_action: "eventUserAction",
  diff_stat: "eventDiffStat",
} as const

function TimelineRow({ event }: { event: WorkTaskEvent }) {
  const t = useTranslations("Tasks")
  const key =
    event.kind in EVENT_KIND_KEYS
      ? EVENT_KIND_KEYS[event.kind as keyof typeof EVENT_KIND_KEYS]
      : null
  const label = key ? t(key) : event.kind
  const detail = timelineDetail(event)
  const time = new Date(event.created_at).toLocaleString()
  return (
    <li className="relative py-1 pl-2">
      <span
        aria-hidden="true"
        className="absolute -left-[0.3125rem] top-[0.5625rem] size-1.5 rounded-full bg-border"
      />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-xs font-medium">{label}</span>
        {detail ? (
          <span className="min-w-0 break-words text-[0.6875rem] text-muted-foreground">
            {detail}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-[0.625rem] text-muted-foreground/70">
          {time}
        </span>
      </div>
    </li>
  )
}

/** Human-readable one-liner for an event payload (best-effort, schema-loose). */
function timelineDetail(event: WorkTaskEvent): string | null {
  const p = event.payload
  if (!p) return null
  const str = (k: string) =>
    typeof p[k] === "string" ? (p[k] as string) : null
  switch (event.kind) {
    case "status_changed": {
      const from = str("from")
      const to = str("to")
      const err = str("error") ?? str("reason")
      const arrow = to ? (from ? `${from} → ${to}` : to) : null
      return [arrow, err].filter(Boolean).join(" · ") || null
    }
    case "config_effective": {
      const agent = str("agent")
      const model = str("model")
      return [agent, model].filter(Boolean).join(" · ") || null
    }
    case "agent_progress":
      return str("message")
    case "agent_verdict":
      return (
        [str("verdict"), str("summary")].filter(Boolean).join(" · ") || null
      )
    case "merge_attempt":
      return str("strategy")
    case "merge_conflict": {
      const files = Array.isArray(p.files) ? (p.files as string[]) : []
      return files.join(", ") || null
    }
    case "cleanup_failed":
      return str("error")
    case "user_action": {
      const action = str("action")
      const feedback = str("feedback")
      return [action, feedback].filter(Boolean).join(": ") || null
    }
    case "diff_stat": {
      const fc = p.files_changed
      const a = p.additions
      const d = p.deletions
      if (typeof fc === "number") return `${fc} files · +${a ?? 0} -${d ?? 0}`
      return null
    }
    default:
      return null
  }
}
