import { beforeEach, describe, expect, it } from "vitest"
import {
  loadTasksStatusFilter,
  loadTasksViewMode,
  saveTasksStatusFilter,
  saveTasksViewMode,
} from "./tasks-board-filter-storage"

const VIEW_MODE_KEY = "workspace:tasks-view-mode"
const STATUS_FILTER_KEY = "workspace:tasks-status-filter"

beforeEach(() => {
  localStorage.clear()
})

describe("tasks view mode storage", () => {
  it("round-trips a stored mode and defaults to the board", () => {
    expect(loadTasksViewMode()).toBe("board")
    saveTasksViewMode("list")
    expect(loadTasksViewMode()).toBe("list")
    saveTasksViewMode("board")
    expect(loadTasksViewMode()).toBe("board")
  })

  it("falls back to the board on a junk entry", () => {
    localStorage.setItem(VIEW_MODE_KEY, "gallery")
    expect(loadTasksViewMode()).toBe("board")
  })
})

describe("tasks status filter storage", () => {
  it("round-trips a selection and keeps null meaning every status", () => {
    expect(loadTasksStatusFilter()).toBeNull()
    saveTasksStatusFilter(["review", "failed"])
    expect(loadTasksStatusFilter()).toEqual(["review", "failed"])
    // Clearing removes the entry rather than storing an empty selection that
    // would read back as "hide everything".
    saveTasksStatusFilter(null)
    expect(localStorage.getItem(STATUS_FILTER_KEY)).toBeNull()
    expect(loadTasksStatusFilter()).toBeNull()
  })

  it("normalizes a stored selection to column order", () => {
    saveTasksStatusFilter(["failed", "todo"])
    expect(loadTasksStatusFilter()).toEqual(["todo", "failed"])
  })

  it("drops unknown statuses and degrades an empty or full set to null", () => {
    localStorage.setItem(
      STATUS_FILTER_KEY,
      JSON.stringify(["review", "obsolete_status"])
    )
    expect(loadTasksStatusFilter()).toEqual(["review"])

    localStorage.setItem(STATUS_FILTER_KEY, JSON.stringify(["nope"]))
    expect(loadTasksStatusFilter()).toBeNull()

    localStorage.setItem(
      STATUS_FILTER_KEY,
      JSON.stringify([
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
      ])
    )
    expect(loadTasksStatusFilter()).toBeNull()

    localStorage.setItem(STATUS_FILTER_KEY, "{not json")
    expect(loadTasksStatusFilter()).toBeNull()
  })
})
