"use client"

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CirclePlay,
  Eye,
  EyeOff,
  Plus,
  Settings2,
  SquareKanban,
} from "lucide-react"
import { useTasksView } from "@/contexts/tasks-view-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useTabActions } from "@/contexts/tab-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  workTaskCancel,
  workTaskCreate,
  workTaskRequeue,
  workTaskRetry,
  workTaskStart,
  workTaskStartAll,
  workTaskUpdate,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { Button } from "@/components/ui/button"
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

const ALL_FOLDERS = "__all__"

/**
 * The Tasks route page: toolbar (folder filter, show-canceled toggle, start
 * all, per-folder settings, new task) + the four-column board. Data comes from
 * the always-mounted TasksViewProvider; every mutation is fire-and-refetch —
 * the engine's `task://changed` nudges keep all clients converged.
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
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorTask, setEditorTask] = useState<WorkTask | null>(null)
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
    () => groupTasksByColumn(visibleTasks, showCanceled),
    [visibleTasks, showCanceled]
  )
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
      void refetch()
    },
    [editorTask, refetch]
  )

  const openMerge = useCallback((task: WorkTask) => {
    setMergeTask(task)
    setMergeOpen(true)
  }, [])

  const startAll = useCallback(() => {
    if (folderFilter == null) return
    void act(async () => {
      const claimed = await workTaskStartAll(folderFilter)
      if (claimed > 0) toast.success(t("toastStartedAll", { count: claimed }))
      else toast.info(t("toastNothingToStart"))
    })
  }, [act, folderFilter, t])

  const hasAnyTask = tasks.length > 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-4 py-2.5">
        <h1 className="mr-1 inline-flex items-center gap-1.5 text-sm font-semibold">
          <SquareKanban
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          {t("title")}
        </h1>

        <Select
          value={folderFilter == null ? ALL_FOLDERS : String(folderFilter)}
          onValueChange={(v) =>
            setFolderFilter(v === ALL_FOLDERS ? null : Number(v))
          }
        >
          <SelectTrigger
            size="sm"
            className="h-7 w-auto min-w-32 gap-1.5 text-xs"
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

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          onClick={() => setShowCanceled((v) => !v)}
          aria-pressed={showCanceled}
        >
          {showCanceled ? (
            <EyeOff className="size-3.5" aria-hidden="true" />
          ) : (
            <Eye className="size-3.5" aria-hidden="true" />
          )}
          {t("showCanceled")}
        </Button>

        <div className="flex-1" />

        {folderFilter != null ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-xs"
              onClick={startAll}
            >
              <CirclePlay className="size-3.5" aria-hidden="true" />
              {t("startAll")}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground"
              onClick={() => setSettingsOpen(true)}
              title={t("folderSettings")}
              aria-label={t("folderSettings")}
            >
              <Settings2 className="size-3.5" aria-hidden="true" />
            </Button>
          </>
        ) : null}

        <Button
          type="button"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => {
            setEditorTask(null)
            setEditorOpen(true)
          }}
        >
          <Plus className="size-3.5" aria-hidden="true" />
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
            onClick={() => {
              setEditorTask(null)
              setEditorOpen(true)
            }}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t("new")}
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto">
          <div className="grid h-full min-w-[56rem] grid-cols-4 gap-3 p-4">
            {BOARD_COLUMN_IDS.map((col) => (
              <div key={col} className="flex min-h-0 flex-col gap-2">
                <div className="flex shrink-0 items-center gap-1.5 px-1">
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
                  <h2 className="text-xs font-medium text-muted-foreground">
                    {t(COLUMN_LABEL_KEYS[col])}
                  </h2>
                  <span className="text-[0.6875rem] text-muted-foreground/60">
                    {columns[col].length}
                  </span>
                </div>
                <ScrollArea className="min-h-0 flex-1 rounded-xl bg-muted/30 p-1.5">
                  <div className="flex flex-col gap-1.5">
                    {columns[col].map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        folderName={folderNames.get(task.folder_id) ?? null}
                        onOpen={() => setDetailTaskId(task.id)}
                        onStart={() => void act(() => workTaskStart(task.id))}
                        onCancel={() => void act(() => workTaskCancel(task.id))}
                        onRetry={() => void act(() => workTaskRetry(task.id))}
                        onRequeue={() =>
                          void act(() => workTaskRequeue(task.id))
                        }
                        onOpenConversation={() => openConversation(task)}
                        onMerge={() => openMerge(task)}
                      />
                    ))}
                  </div>
                </ScrollArea>
              </div>
            ))}
          </div>
        </div>
      )}

      <TaskEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        task={editorTask}
        defaultFolderId={folderFilter}
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
