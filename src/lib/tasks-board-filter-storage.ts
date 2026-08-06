"use client"

import type { WorkTaskStatus } from "@/lib/types"

const BOARD_FILTER_KEY = "workspace:tasks-board-filter"
const VIEW_MODE_KEY = "workspace:tasks-view-mode"
const STATUS_FILTER_KEY = "workspace:tasks-status-filter"

/** Visibility toggles of the tasks board's filter popover. */
export interface TasksBoardFilter {
  showCanceled: boolean
  showArchived: boolean
}

/** Default view: canceled tasks visible, archived ones hidden. */
export const DEFAULT_TASKS_BOARD_FILTER: TasksBoardFilter = {
  showCanceled: true,
  showArchived: false,
}

/** How the tasks page lays its rows out: four-column board, or flat list. */
export type TasksViewMode = "board" | "list"

export const DEFAULT_TASKS_VIEW_MODE: TasksViewMode = "board"

/** Every status the list view can filter on. Kept in sync with
 *  `WorkTaskStatus` by `STATUSES_BY_COLUMN` (board-columns.ts), whose test
 *  asserts the two agree — this copy exists so the storage layer stays free of
 *  component imports. */
const KNOWN_STATUSES: readonly WorkTaskStatus[] = [
  "todo",
  "queued",
  "preparing",
  "running",
  "awaiting_input",
  "review",
  "merging",
  "done",
  "failed",
  "canceled",
]

export function loadTasksBoardFilter(): TasksBoardFilter {
  if (typeof window === "undefined") return DEFAULT_TASKS_BOARD_FILTER
  try {
    const raw = localStorage.getItem(BOARD_FILTER_KEY)
    if (!raw) return DEFAULT_TASKS_BOARD_FILTER
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return DEFAULT_TASKS_BOARD_FILTER
    const obj = parsed as Record<string, unknown>
    return {
      showCanceled:
        typeof obj.showCanceled === "boolean"
          ? obj.showCanceled
          : DEFAULT_TASKS_BOARD_FILTER.showCanceled,
      showArchived:
        typeof obj.showArchived === "boolean"
          ? obj.showArchived
          : DEFAULT_TASKS_BOARD_FILTER.showArchived,
    }
  } catch {
    return DEFAULT_TASKS_BOARD_FILTER
  }
}

export function saveTasksBoardFilter(filter: TasksBoardFilter): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(BOARD_FILTER_KEY, JSON.stringify(filter))
  } catch {
    /* ignore */
  }
}

export function loadTasksViewMode(): TasksViewMode {
  if (typeof window === "undefined") return DEFAULT_TASKS_VIEW_MODE
  try {
    const raw = localStorage.getItem(VIEW_MODE_KEY)
    return raw === "list" || raw === "board" ? raw : DEFAULT_TASKS_VIEW_MODE
  } catch {
    return DEFAULT_TASKS_VIEW_MODE
  }
}

export function saveTasksViewMode(mode: TasksViewMode): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode)
  } catch {
    /* ignore */
  }
}

/**
 * The list view's status selection. `null` means "every status" — the default,
 * and what an empty or unreadable entry falls back to. Unknown strings are
 * dropped so a stored selection survives a status being renamed or removed;
 * one that ends up empty (or complete) that way degrades to `null` rather than
 * hiding every task.
 */
export function loadTasksStatusFilter(): WorkTaskStatus[] | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(STATUS_FILTER_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const known = KNOWN_STATUSES.filter((status) => parsed.includes(status))
    if (known.length === 0 || known.length === KNOWN_STATUSES.length)
      return null
    return [...known]
  } catch {
    return null
  }
}

export function saveTasksStatusFilter(statuses: WorkTaskStatus[] | null): void {
  if (typeof window === "undefined") return
  try {
    if (statuses == null) localStorage.removeItem(STATUS_FILTER_KEY)
    else localStorage.setItem(STATUS_FILTER_KEY, JSON.stringify(statuses))
  } catch {
    /* ignore */
  }
}
