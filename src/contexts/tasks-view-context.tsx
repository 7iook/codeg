"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { workTaskList } from "@/lib/api"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import type { WorkTask } from "@/lib/types"

const WORK_TASK_CHANGED_EVENT = "task://changed"

/** Statuses that need the user ("等你处理") — drives the sidebar badge. */
const ATTENTION_STATUSES = new Set(["awaiting_input", "review", "failed"])

interface TasksViewContextValue {
  tasks: WorkTask[]
  /** Count of tasks waiting on the user — the sidebar badge. */
  attentionCount: number
  refetch: () => Promise<void>
}

const TasksViewContext = createContext<TasksViewContextValue | null>(null)

/**
 * Data layer for the Tasks feature: the full task list + a realtime
 * subscription, kept always-mounted so the sidebar's attention badge stays
 * live. Single source for both the badge and the Tasks route page (the board
 * filters per folder client-side). Mirrors AutomationsViewProvider: the engine
 * runs headless, so `task://changed` nudges + refetch are the only way an open
 * board learns a task advanced.
 */
export function useTasksView() {
  const ctx = useContext(TasksViewContext)
  if (!ctx) {
    throw new Error("useTasksView must be used within TasksViewProvider")
  }
  return ctx
}

export function TasksViewProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const reqRef = useRef(0)

  const refetch = useCallback(async () => {
    const id = ++reqRef.current
    try {
      const list = await workTaskList(null)
      // Drop stale responses; keep the previous list on transient error rather
      // than blanking the board (same idiom as automations-view-context).
      if (id === reqRef.current) setTasks(list)
    } catch {
      // ignore — a later event/refetch recovers
    }
  }, [])

  useEffect(() => {
    // Initial fetch + subscribe for backend-pushed nudges. Same
    // subscribe-then-setState idiom as automations-view-context.
    /* eslint-disable react-hooks/set-state-in-effect */
    void refetch()
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribe(WORK_TASK_CHANGED_EVENT, () => {
      void refetch()
    }).then((u: () => void) => {
      if (cancelled) u()
      else unsub = u
    })
    // Events fired while the WS was disconnected are dropped by the
    // broadcaster; refetch on reconnect so a task that settled during the gap
    // doesn't leave the board stale. No-op on desktop IPC.
    const offReconnect = onTransportReconnect(() => {
      void refetch()
    })
    return () => {
      cancelled = true
      unsub?.()
      offReconnect?.()
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [refetch])

  const attentionCount = useMemo(
    () => tasks.filter((t) => ATTENTION_STATUSES.has(t.status)).length,
    [tasks]
  )

  const value = useMemo<TasksViewContextValue>(
    () => ({ tasks, attentionCount, refetch }),
    [tasks, attentionCount, refetch]
  )

  return (
    <TasksViewContext.Provider value={value}>
      {children}
    </TasksViewContext.Provider>
  )
}
