"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Ban,
  Bot,
  CircleAlert,
  CircleCheck,
  CircleX,
  Coins,
  FileDiff,
  Folder,
  FolderX,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Loader2,
  MessageSquareText,
  Pencil,
  Play,
  RotateCw,
  ScrollText,
  Trash2,
  Undo2,
} from "lucide-react"
import {
  workTaskCancel,
  getFolderConversation,
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
import { formatTokenCount } from "@/lib/token-format"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import { UnifiedDiffPreview } from "@/components/diff/unified-diff-preview"
import { StatusChip, statusLabelKey } from "./task-card"
import { TaskTranscriptDialog } from "./task-transcript-dialog"
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
import type {
  AgentType,
  WorkTask,
  WorkTaskChangedFile,
  WorkTaskEvent,
} from "@/lib/types"

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
  const conversationId = task?.conversation_id ?? null
  const taskStatus = task?.status ?? null
  // Total token usage of the task's conversation — parsed from the agent's own
  // transcript on open and re-read when the task settles (status flip), not on
  // every progress nudge (the parse is the expensive part).
  const [tokenTotal, setTokenTotal] = useState<number | null>(null)
  // The conversation's actual agent — feeds the transcript viewer's renderer
  // (a task without a per-task override has no agent on its own row).
  const [convAgentType, setConvAgentType] = useState<AgentType | null>(null)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  useEffect(() => {
    if (!open || conversationId == null) {
      setTokenTotal(null)
      setConvAgentType(null)
      return
    }
    let cancelled = false
    getFolderConversation(conversationId)
      .then((detail) => {
        if (cancelled) return
        setConvAgentType(detail.summary.agent_type ?? null)
        const stats = detail.session_stats
        const usage = stats?.total_usage ?? null
        const total =
          stats?.total_tokens ??
          (usage
            ? usage.input_tokens +
              usage.output_tokens +
              usage.cache_creation_input_tokens +
              usage.cache_read_input_tokens
            : null)
        setTokenTotal(total ?? null)
      })
      .catch(() => {
        // Transcript may be unreadable (agent gone, file pruned) — no chip.
      })
    return () => {
      cancelled = true
    }
  }, [open, conversationId, taskStatus])

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

  // The user-authored brief, as typed (the agent receives the block form).
  const promptText = task.config?.display_text?.trim() || null

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
          <SheetHeader className="shrink-0 gap-2 border-b border-border px-5 py-4">
            <div className="flex items-start gap-2 pr-8">
              <SheetTitle className="min-w-0 break-words text-base font-semibold leading-snug">
                {task.title}
              </SheetTitle>
              {/* Top-align with the first title line when it wraps. */}
              <span className="mt-0.5 shrink-0">
                <StatusChip task={task} />
              </span>
            </div>
            <SheetDescription className="sr-only">
              {t("detailDescription")}
            </SheetDescription>
            {/* Identity only — git facts live in the Details grid below. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {folderName ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <Folder className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{folderName}</span>
                </span>
              ) : null}
              {agentLabel ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <Bot className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{agentLabel}</span>
                </span>
              ) : null}
              {tokenTotal != null && tokenTotal > 0 ? (
                <span
                  className="inline-flex items-center gap-1 tabular-nums"
                  title={t("detailTokens")}
                >
                  <Coins className="size-3" aria-hidden="true" />
                  {formatTokenCount(tokenTotal)}
                </span>
              ) : null}
            </div>
          </SheetHeader>

          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-5 px-5 py-4">
              {task.last_error ? (
                <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-xs text-destructive">
                  <CircleAlert
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 whitespace-pre-wrap break-words">
                    {task.last_error}
                  </span>
                </div>
              ) : null}

              {/* The original task brief — always above the agent's result. */}
              {promptText ? (
                <section className="flex flex-col gap-1.5">
                  <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("promptLabel")}
                  </h3>
                  <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                    {promptText}
                  </div>
                </section>
              ) : null}

              {task.result_summary ? (
                <section className="flex flex-col gap-1.5">
                  <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("detailSummary")}
                  </h3>
                  <p className="whitespace-pre-wrap break-words rounded-xl border border-border bg-card/40 p-3 text-xs leading-relaxed">
                    {task.result_summary}
                  </p>
                </section>
              ) : null}

              {/* Acceptance panel — review only. Amber = the board's
                  needs-you tone; this is the decision zone. */}
              {task.status === "review" ? (
                <section className="flex flex-col gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 dark:border-amber-400/25">
                  <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
                    {t("detailAcceptance")}
                  </h3>
                  {task.preflight ? (
                    <div className="flex flex-col gap-1.5">
                      <div
                        className={cn(
                          "flex items-center gap-1.5 text-xs",
                          task.preflight.status === "passed" &&
                            "text-emerald-600 dark:text-emerald-400",
                          task.preflight.status === "failed" &&
                            "text-destructive",
                          task.preflight.status === "running" &&
                            "text-muted-foreground"
                        )}
                      >
                        {task.preflight.status === "running" ? (
                          <Loader2
                            className="size-3.5 animate-spin"
                            aria-hidden="true"
                          />
                        ) : task.preflight.status === "passed" ? (
                          <CircleCheck
                            className="size-3.5"
                            aria-hidden="true"
                          />
                        ) : (
                          <CircleX className="size-3.5" aria-hidden="true" />
                        )}
                        <span>
                          {task.preflight.status === "passed"
                            ? t("preflightPassed", {
                                name: task.preflight.command,
                              })
                            : task.preflight.status === "failed"
                              ? t("preflightFailed", {
                                  name: task.preflight.command,
                                })
                              : t("preflightRunning", {
                                  name: task.preflight.command,
                                })}
                        </span>
                      </div>
                      {task.preflight.status === "failed" &&
                      task.preflight.output_tail ? (
                        <pre className="max-h-40 overflow-auto rounded-md border border-border bg-card/60 p-2 font-mono text-[0.625rem] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
                          {task.preflight.output_tail}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      className="gap-1.5"
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
                      className="gap-1.5"
                      disabled={busy}
                      onClick={() => setReturnOpen((v) => !v)}
                    >
                      <Undo2 className="size-3.5" aria-hidden="true" />
                      {t("actionReturn")}
                    </Button>
                    <div className="flex-1" />
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 text-muted-foreground"
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

              {/* Key-value facts: git coordinates, change size, lifecycle. */}
              <section className="flex flex-col gap-1.5">
                <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("detailInfo")}
                </h3>
                <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5 rounded-xl border border-border p-3 text-xs">
                  {task.work_branch ? (
                    <InfoRow label={t("detailBranch")}>
                      <span className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-[0.6875rem]">
                        <GitBranch
                          className="size-3 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="truncate">
                          {task.work_branch}
                          {task.base_branch ? ` ← ${task.base_branch}` : null}
                        </span>
                      </span>
                    </InfoRow>
                  ) : null}
                  {task.merge_commit ? (
                    <InfoRow label={t("detailMergeCommit")}>
                      <span className="inline-flex items-center gap-1 font-mono text-[0.6875rem]">
                        <GitCommitHorizontal
                          className="size-3 text-muted-foreground"
                          aria-hidden="true"
                        />
                        {task.merge_commit.slice(0, 8)}
                      </span>
                    </InfoRow>
                  ) : null}
                  {task.files_changed != null && task.files_changed > 0 ? (
                    <InfoRow label={t("detailChanges")}>
                      <span className="inline-flex flex-wrap items-center gap-x-1.5">
                        {t("filesChanged", { count: task.files_changed })}
                        <span className="font-mono text-[0.6875rem]">
                          <span className="text-emerald-600 dark:text-emerald-400">
                            +{task.additions ?? 0}
                          </span>{" "}
                          <span className="text-destructive">
                            -{task.deletions ?? 0}
                          </span>
                        </span>
                      </span>
                    </InfoRow>
                  ) : null}
                  <InfoRow label={t("detailCreated")}>
                    {formatDateTime(task.created_at)}
                  </InfoRow>
                  {task.started_at ? (
                    <InfoRow label={t("detailStarted")}>
                      {formatDateTime(task.started_at)}
                    </InfoRow>
                  ) : null}
                  {task.finished_at ? (
                    <InfoRow label={t("detailFinished")}>
                      {formatDateTime(task.finished_at)}
                    </InfoRow>
                  ) : null}
                </dl>
              </section>

              {/* Changed files vs the recorded base. */}
              {hasWorktree ? (
                <section className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                      {t("detailFiles")}
                      {files.length > 0 ? (
                        <span className="ml-1.5 font-normal text-muted-foreground/70 tabular-nums">
                          {files.length}
                        </span>
                      ) : null}
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
                    <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border">
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
                    {events
                      // `round` markers feed the transcript viewer's phase
                      // dividers; here the status headers already segment.
                      .filter((ev) => ev.kind !== "round")
                      .map((ev) => (
                        <TimelineRow key={ev.id} event={ev} />
                      ))}
                  </ol>
                )}
              </section>
            </div>
          </ScrollArea>

          {/* Footer: status-specific secondary actions. */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border px-5 py-3">
            {task.status === "todo" ? (
              <FooterAction
                icon={Play}
                label={t("actionStart")}
                busy={busy}
                emphasized
                onClick={() => run(() => workTaskStart(task.id))}
              />
            ) : null}
            {task.status === "failed" ? (
              <FooterAction
                icon={RotateCw}
                label={t("actionRetry")}
                busy={busy}
                emphasized
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
                emphasized
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
                icon={ScrollText}
                label={t("actionTranscript")}
                busy={false}
                onClick={() => setTranscriptOpen(true)}
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
                icon={FolderX}
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

      {/* Read-only live transcript of the task's agent session. */}
      <TaskTranscriptDialog
        open={transcriptOpen}
        onOpenChange={setTranscriptOpen}
        task={task}
        agentType={convAgentType ?? task?.config?.agent_type ?? null}
      />

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

/** One label/value pair inside the Details grid (grid supplies the columns). */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

/** Full date-time, minute precision — the Details grid. */
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** Compact date-time for timeline rows (year dropped; events are recent). */
function formatEventTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function FooterAction({
  icon: Icon,
  label,
  onClick,
  busy,
  destructive,
  emphasized,
}: {
  icon: typeof Play
  label: string
  onClick: () => void
  busy: boolean
  destructive?: boolean
  /** The status's leading action — outlined so it stands out of the ghosts. */
  emphasized?: boolean
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={emphasized ? "outline" : "ghost"}
      disabled={busy}
      className={cn(
        "h-7 gap-1.5 px-2.5 text-xs",
        destructive
          ? "text-destructive hover:text-destructive"
          : !emphasized && "text-muted-foreground hover:text-foreground"
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
  init_command: "eventInitCommand",
  agent_progress: "eventAgentProgress",
  agent_verdict: "eventAgentVerdict",
  merge_attempt: "eventMergeAttempt",
  merge_conflict: "eventMergeConflict",
  preflight_result: "eventPreflight",
  cleanup_failed: "eventCleanupFailed",
  resume_fallback: "eventResumeFallback",
  user_action: "eventUserAction",
  diff_stat: "eventDiffStat",
} as const

const STATUS_KEYS = new Set([
  "todo",
  "queued",
  "running",
  "awaiting_input",
  "review",
  "merging",
  "done",
  "failed",
  "canceled",
])

/**
 * A `status_changed` event renders as a group header — the status title
 * separates the timeline into phases; every other event is a plain row
 * grouped under the header above it.
 */
function TimelineRow({ event }: { event: WorkTaskEvent }) {
  const t = useTranslations("Tasks")
  if (event.kind === "status_changed") {
    return <TimelineStatusHeader event={event} />
  }
  const key =
    event.kind in EVENT_KIND_KEYS
      ? EVENT_KIND_KEYS[event.kind as keyof typeof EVENT_KIND_KEYS]
      : null
  const label = key ? t(key) : event.kind
  const detail = timelineDetail(event)
  const time = formatEventTime(event.created_at)
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

function TimelineStatusHeader({ event }: { event: WorkTaskEvent }) {
  const t = useTranslations("Tasks")
  const p = event.payload
  const str = (k: string) =>
    p && typeof p[k] === "string" ? (p[k] as string) : null
  const to = str("to")
  const label =
    to && STATUS_KEYS.has(to)
      ? t(statusLabelKey(to as WorkTask["status"]))
      : (to ?? t("eventStatusChanged"))
  const note = str("error") ?? str("reason")
  const time = formatEventTime(event.created_at)
  return (
    <li className="relative pb-0.5 pl-2 pt-2.5">
      <span
        aria-hidden="true"
        className="absolute -left-[0.4375rem] top-[0.9375rem] size-2 rounded-full border-2 border-background bg-muted-foreground/70"
      />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-xs font-semibold text-foreground">{label}</span>
        {note ? (
          <span className="min-w-0 break-words text-[0.6875rem] text-muted-foreground">
            {note}
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
    case "init_command": {
      const command = str("command")
      const exit =
        typeof p.exit_code === "number" ? `exit ${p.exit_code}` : null
      return [command, exit].filter(Boolean).join(" · ") || null
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
    case "preflight_result": {
      const status = str("status")
      const command = str("command")
      return [command, status].filter(Boolean).join(" · ") || null
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
