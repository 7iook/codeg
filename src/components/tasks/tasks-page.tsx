"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Reorder, type PanInfo } from "motion/react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Funnel, Play, Plus, Settings2, SquareKanban } from "lucide-react"
import { useTasksView } from "@/contexts/tasks-view-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useTabActions } from "@/contexts/tab-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  workTaskArchive,
  workTaskCancel,
  workTaskCreate,
  workTaskReorder,
  workTaskRequeue,
  workTaskRetry,
  workTaskStart,
  workTaskStartAll,
  workTaskUpdate,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  consumePendingTaskDraft,
  CREATE_TASK_FROM_TEXT_EVENT,
  type CreateTaskFromTextDetail,
} from "@/lib/task-compose-events"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  BOARD_COLUMN_IDS,
  groupTasksByColumn,
  type BoardColumnId,
} from "./board-columns"
import { TaskCard } from "./task-card"
import { TaskDetailSheet } from "./task-detail-sheet"
import { TaskEditorDialog } from "./task-editor-dialog"
import { TaskMergeDialog } from "./task-merge-dialog"
import { TaskSettingsDialog } from "./task-settings-dialog"
import type { WorkTask, WorkTaskDraft } from "@/lib/types"

const COLUMN_LABEL_KEYS = {
  todo: "colTodo",
  inProgress: "colInProgress",
  attention: "colAttention",
  done: "colDone",
} as const satisfies Record<BoardColumnId, string>

const EMPTY_LABEL_KEYS = {
  todo: "emptyColTodo",
  inProgress: "emptyColInProgress",
  attention: "emptyColAttention",
  done: "emptyColDone",
} as const satisfies Record<BoardColumnId, string>

const ALL_FOLDERS = "__all__"

/** Page title rendered into the window-chrome strip above the page (the h-10
 *  band shared with the fixed corner overlays) — see WorkbenchRouteStrip. */
export function TasksPageTitle() {
  const t = useTranslations("Tasks")
  return (
    <h1 className="flex h-10 shrink-0 items-center gap-2 px-4 text-lg font-semibold leading-none tracking-tight">
      <SquareKanban
        className="size-4.5 text-muted-foreground"
        aria-hidden="true"
      />
      {t("title")}
    </h1>
  )
}

/**
 * The Tasks route page: toolbar (folder filter, filter popover, settings,
 * start all, new task — the page title lives in the chrome strip above) and
 * the four-column board. Data comes from the always-mounted TasksViewProvider;
 * every mutation is fire-and-refetch — the engine's `task://changed` nudges
 * keep all clients converged.
 */
export function TasksPage() {
  const t = useTranslations("Tasks")
  const { tasks, refetch } = useTasksView()
  const { openConversations } = useWorkbenchRoute()
  const { openTab } = useTabActions()
  const folders = useAppWorkspaceStore((s) => s.folders)
  const projectFolders = useMemo(
    () => folders.filter((f) => f.parent_id == null && f.kind === "regular"),
    [folders]
  )
  const folderNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const f of folders) map.set(f.id, f.alias ?? f.name)
    return map
  }, [folders])

  const [folderFilter, setFolderFilter] = useState<number | null>(null)
  const [showCanceled, setShowCanceled] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  // Drag state for the pending column (enabled only with a folder selected —
  // sort_order is per folder, so a mixed-folder列 has no persistable order).
  const [dragOrder, setDragOrder] = useState<number[] | null>(null)
  const dragOrderRef = useRef<number[] | null>(null)
  dragOrderRef.current = dragOrder
  const [draggingTodo, setDraggingTodo] = useState(false)
  const inProgressColRef = useRef<HTMLDivElement | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorTask, setEditorTask] = useState<WorkTask | null>(null)
  const [editorPrefill, setEditorPrefill] =
    useState<CreateTaskFromTextDetail | null>(null)

  // One shared timestamp per render tick keeps every card's relative-time
  // label consistent; a minute interval bounds staleness.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // "Task from message" hand-off: consume the parked draft on mount (this page
  // is unmounted while other routes are active) and on the live event.
  useEffect(() => {
    const consume = () => {
      const draft = consumePendingTaskDraft()
      if (!draft) return
      setEditorTask(null)
      setEditorPrefill(draft)
      setEditorOpen(true)
    }
    consume()
    window.addEventListener(CREATE_TASK_FROM_TEXT_EVENT, consume)
    return () =>
      window.removeEventListener(CREATE_TASK_FROM_TEXT_EVENT, consume)
  }, [])
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null)
  const [mergeTask, setMergeTask] = useState<WorkTask | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const visibleTasks = useMemo(
    () =>
      folderFilter == null
        ? tasks
        : tasks.filter((task) => task.folder_id === folderFilter),
    [tasks, folderFilter]
  )
  const columns = useMemo(
    () => groupTasksByColumn(visibleTasks, showCanceled, showArchived),
    [visibleTasks, showCanceled, showArchived]
  )
  const dragEnabled = folderFilter != null
  // Optimistic order while a drag is live; server order otherwise.
  const todoTasks = useMemo(() => {
    const base = columns.todo
    if (!dragEnabled || dragOrder == null) return base
    const byId = new Map(base.map((task) => [task.id, task]))
    const ordered = dragOrder.flatMap((id) => byId.get(id) ?? [])
    for (const task of base) {
      if (!dragOrder.includes(task.id)) ordered.push(task)
    }
    return ordered
  }, [columns.todo, dragEnabled, dragOrder])
  // The sheet renders the LIVE row from the provider so status flips (e.g.
  // merging → done) update in place while it is open.
  const detailTask = useMemo(
    () => tasks.find((task) => task.id === detailTaskId) ?? null,
    [tasks, detailTaskId]
  )

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch (e) {
        toast.error(toErrorMessage(e))
      } finally {
        void refetch()
      }
    },
    [refetch]
  )

  const openConversation = useCallback(
    (task: WorkTask) => {
      if (task.conversation_id == null) return
      // After cleanup the conversation lives re-parented under the project
      // folder; before that, under its worktree folder.
      const folderId = task.worktree_folder_id ?? task.folder_id
      // Best-effort agent for the tab chrome (the conversation view reloads the
      // authoritative agent from the DB): task override → folder default.
      const agent =
        task.config?.agent_type ??
        folders.find((f) => f.id === task.folder_id)?.default_agent_type ??
        "claude_code"
      openConversations()
      openTab(folderId, task.conversation_id, agent)
    },
    [openConversations, openTab, folders]
  )

  const submitEditor = useCallback(
    async (draft: WorkTaskDraft) => {
      if (editorTask) await workTaskUpdate(editorTask.id, draft)
      else await workTaskCreate(draft)
      setEditorOpen(false)
      setEditorPrefill(null)
      void refetch()
    },
    [editorTask, refetch]
  )

  const openMerge = useCallback((task: WorkTask) => {
    setMergeTask(task)
    setMergeOpen(true)
  }, [])

  const openNewTask = useCallback(() => {
    setEditorTask(null)
    setEditorOpen(true)
  }, [])

  // Drop on the In-progress column = start (the pending column drags on the y
  // axis, but the POINTER is free — droppedness is judged by its position).
  // Anywhere else = persist the reorder.
  const handleTodoDragEnd = useCallback(
    (task: WorkTask, info: PanInfo) => {
      setDraggingTodo(false)
      const rect = inProgressColRef.current?.getBoundingClientRect()
      const droppedOnInProgress =
        rect != null &&
        info.point.x >= rect.left &&
        info.point.x <= rect.right &&
        info.point.y >= rect.top &&
        info.point.y <= rect.bottom
      if (droppedOnInProgress && task.status === "todo") {
        setDragOrder(null)
        void act(() => workTaskStart(task.id))
        return
      }
      const order = dragOrderRef.current
      if (folderFilter != null && order != null) {
        void (async () => {
          try {
            await workTaskReorder(folderFilter, order)
          } catch (e) {
            toast.error(toErrorMessage(e))
          }
          await refetch()
          setDragOrder(null)
        })()
      }
    },
    [act, folderFilter, refetch]
  )

  // With "all folders" selected this is the global sweep — every folder that
  // holds todos gets its own claim + pump.
  const startAll = useCallback(() => {
    void act(async () => {
      const claimed = await workTaskStartAll(folderFilter)
      if (claimed > 0) toast.success(t("toastStartedAll", { count: claimed }))
      else toast.info(t("toastNothingToStart"))
    })
  }, [act, folderFilter, t])

  // Archives whatever the Done column currently shows unarchived — respects
  // the visibility toggles by construction (it reads the grouped column).
  const archiveAllDone = useCallback(() => {
    const targets = columns.done.filter((task) => task.archived_at == null)
    if (targets.length === 0) return
    void act(() =>
      Promise.all(targets.map((task) => workTaskArchive(task.id, true)))
    )
  }, [act, columns.done])

  const activeFilters = (showCanceled ? 1 : 0) + (showArchived ? 1 : 0)
  const hasAnyTask = tasks.length > 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar (the page title renders in the chrome strip above the page,
          which owns the divider — the toolbar itself is borderless). */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2">
        <Select
          value={folderFilter == null ? ALL_FOLDERS : String(folderFilter)}
          onValueChange={(v) =>
            setFolderFilter(v === ALL_FOLDERS ? null : Number(v))
          }
        >
          <SelectTrigger
            size="sm"
            className="h-8 w-auto min-w-0 gap-1.5 rounded-full border-transparent bg-muted/70 px-3 text-[0.8125rem] font-medium shadow-none ws-msg-chip hover:bg-muted"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_FOLDERS}>{t("allFolders")}</SelectItem>
            {projectFolders.map((f) => (
              <SelectItem key={f.id} value={String(f.id)}>
                {f.alias ?? f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="gap-1.5 px-2.5 text-[0.8125rem] font-normal text-muted-foreground hover:text-foreground"
            >
              <Funnel className="size-3.5" aria-hidden="true" />
              {t("filter")}
              {activeFilters > 0 ? (
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-primary tabular-nums">
                  {activeFilters}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-52 gap-0.5 rounded-xl p-1.5"
          >
            <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-accent/50">
              <Checkbox
                checked={showCanceled}
                onCheckedChange={(v) => setShowCanceled(v === true)}
              />
              {t("showCanceled")}
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-accent/50">
              <Checkbox
                checked={showArchived}
                onCheckedChange={(v) => setShowArchived(v === true)}
              />
              {t("showArchived")}
            </label>
          </PopoverContent>
        </Popover>

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="gap-1.5 px-2.5 text-[0.8125rem] font-normal text-muted-foreground hover:text-foreground"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 className="size-3.5" aria-hidden="true" />
          {t("settingsTitle")}
        </Button>

        <div className="flex-1" />

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="gap-1.5 px-2.5 text-[0.8125rem]"
          onClick={startAll}
        >
          <Play className="size-3.5" aria-hidden="true" />
          {t("startAll")}
        </Button>
        <Button
          type="button"
          size="sm"
          className="gap-1 px-3.5 text-[0.8125rem]"
          onClick={openNewTask}
        >
          <Plus className="size-4" aria-hidden="true" />
          {t("new")}
        </Button>
      </div>

      {/* Board */}
      {!hasAnyTask ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <SquareKanban
            className="size-10 text-muted-foreground/40"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{t("empty")}</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {t("emptyHint")}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            onClick={openNewTask}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t("new")}
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto">
          <div className="grid h-full min-w-[56rem] grid-cols-4 gap-4 p-4">
            {BOARD_COLUMN_IDS.map((col) => {
              const colTasks = col === "todo" ? todoTasks : columns[col]
              const cardFor = (task: WorkTask) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  folderName={folderNames.get(task.folder_id) ?? null}
                  now={now}
                  onOpen={() => setDetailTaskId(task.id)}
                  onStart={() => void act(() => workTaskStart(task.id))}
                  onCancel={() => void act(() => workTaskCancel(task.id))}
                  onRetry={() => void act(() => workTaskRetry(task.id))}
                  onRequeue={() => void act(() => workTaskRequeue(task.id))}
                  onOpenConversation={() => openConversation(task)}
                  onMerge={() => openMerge(task)}
                  onArchive={() =>
                    void act(() =>
                      workTaskArchive(task.id, task.archived_at == null)
                    )
                  }
                  onEdit={() => {
                    setEditorTask(task)
                    setEditorOpen(true)
                  }}
                />
              )
              return (
                <div
                  key={col}
                  ref={col === "inProgress" ? inProgressColRef : undefined}
                  className="flex min-h-0 flex-col gap-2"
                >
                  <div className="flex h-6 shrink-0 items-center gap-1.5 px-0.5">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        col === "todo" && "bg-muted-foreground/50",
                        col === "inProgress" && "bg-primary",
                        col === "attention" && "bg-amber-500",
                        col === "done" && "bg-emerald-500"
                      )}
                      aria-hidden="true"
                    />
                    <h2 className="text-xs font-semibold">
                      {t(COLUMN_LABEL_KEYS[col])}
                    </h2>
                    {col === "attention" && colTasks.length > 0 ? (
                      <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[0.625rem] font-semibold leading-none text-amber-600 tabular-nums dark:text-amber-400">
                        {colTasks.length}
                      </span>
                    ) : (
                      <span className="text-[0.6875rem] text-muted-foreground/60 tabular-nums">
                        {colTasks.length}
                      </span>
                    )}
                    <div className="flex-1" />
                    {col === "done" &&
                    columns.done.some((task) => task.archived_at == null) ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="px-1.5 font-normal text-muted-foreground hover:text-foreground"
                        onClick={archiveAllDone}
                      >
                        {t("archiveAllDone")}
                      </Button>
                    ) : null}
                  </div>
                  {colTasks.length === 0 ? (
                    <div
                      className={cn(
                        // border-border is near-invisible on the plain canvas —
                        // dash with a foreground-derived tone instead.
                        "flex flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-muted-foreground/30 p-4 text-center",
                        // Drop target hint while a pending card is dragged;
                        // otherwise tint like the cards when a workspace
                        // background image is on (ws-msg-card is inert without
                        // one) so the cell stays legible over a photo.
                        col === "inProgress" && draggingTodo
                          ? "border-primary/50 bg-primary/5"
                          : "ws-msg-card"
                      )}
                    >
                      <p className="text-xs text-muted-foreground">
                        {t(EMPTY_LABEL_KEYS[col])}
                      </p>
                    </div>
                  ) : (
                    <ScrollArea
                      className={cn(
                        "min-h-0 flex-1 rounded-xl",
                        col === "inProgress" &&
                          draggingTodo &&
                          "ring-2 ring-primary/40"
                      )}
                    >
                      {col === "todo" && dragEnabled ? (
                        <Reorder.Group
                          as="div"
                          axis="y"
                          values={todoTasks.map((task) => task.id)}
                          onReorder={(ids: number[]) => setDragOrder(ids)}
                          className="flex flex-col gap-2 pb-1"
                        >
                          {todoTasks.map((task) => (
                            <Reorder.Item
                              key={task.id}
                              value={task.id}
                              as="div"
                              onDragStart={() => setDraggingTodo(true)}
                              onDragEnd={(_e: unknown, info: PanInfo) =>
                                handleTodoDragEnd(task, info)
                              }
                              className="cursor-grab active:cursor-grabbing"
                            >
                              {cardFor(task)}
                            </Reorder.Item>
                          ))}
                        </Reorder.Group>
                      ) : (
                        <div className="flex flex-col gap-2 pb-1">
                          {colTasks.map(cardFor)}
                        </div>
                      )}
                    </ScrollArea>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <TaskEditorDialog
        open={editorOpen}
        onOpenChange={(o) => {
          setEditorOpen(o)
          if (!o) setEditorPrefill(null)
        }}
        task={editorTask}
        defaultFolderId={editorPrefill?.folderId ?? folderFilter}
        prefillText={editorPrefill?.text ?? null}
        onSubmit={submitEditor}
      />
      <TaskDetailSheet
        open={detailTaskId != null}
        onOpenChange={(o) => {
          if (!o) setDetailTaskId(null)
        }}
        task={detailTask}
        folderName={
          detailTask ? (folderNames.get(detailTask.folder_id) ?? null) : null
        }
        onOpenConversation={openConversation}
        onMerge={openMerge}
        onEdit={(task) => {
          setEditorTask(task)
          setEditorOpen(true)
        }}
      />
      <TaskMergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        task={mergeTask}
      />
      <TaskSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        folderId={folderFilter}
      />
    </div>
  )
}
