import { parseTimestamp } from "@/components/conversations/sidebar-conversation-grouping"
import type { WorkTask, WorkTaskStatus } from "@/lib/types"

/** The four board columns (DB statuses are exact; the UI aggregates them). */
export type BoardColumnId = "todo" | "inProgress" | "attention" | "done"

export const BOARD_COLUMN_IDS: BoardColumnId[] = [
  "todo",
  "inProgress",
  "attention",
  "done",
]

/**
 * The exact statuses behind each column, in the order the list view's status
 * filter offers them. `columnForStatus` stays the single source of truth for
 * the mapping — board-columns.test.ts asserts the two agree and that every
 * `WorkTaskStatus` appears here exactly once.
 */
export const STATUSES_BY_COLUMN: Record<BoardColumnId, WorkTaskStatus[]> = {
  todo: ["todo", "queued"],
  inProgress: ["preparing", "running"],
  attention: ["awaiting_input", "review", "merging", "failed"],
  done: ["done", "canceled"],
}

/** Every status, column order — the list view's filter menu reads this. */
export const ALL_WORK_TASK_STATUSES: WorkTaskStatus[] =
  BOARD_COLUMN_IDS.flatMap((col) => STATUSES_BY_COLUMN[col])

/**
 * DB status → board column. `canceled` lives in the Done column but is hidden
 * unless the "show canceled" toggle is on (filtered by `groupTasksByColumn`).
 */
export function columnForStatus(status: WorkTaskStatus): BoardColumnId {
  switch (status) {
    case "todo":
    // Still waiting for a concurrency slot — nothing is happening yet.
    case "queued":
      return "todo"
    // Already out of the queue and working (worktree, init command, agent
    // spawn), just without a session to show yet.
    case "preparing":
    case "running":
      return "inProgress"
    case "awaiting_input":
    case "review":
    // A merge is an agent turn, but the card must not bounce across the
    // board when the user clicks merge — it stays in the review column and
    // moves straight to Done when the merge lands.
    case "merging":
    case "failed":
      return "attention"
    case "done":
    case "canceled":
      return "done"
  }
}

/**
 * Bucket tasks into the four columns. Canceled tasks are dropped unless
 * `showCanceled`, archived ones unless `showArchived` (archived is always
 * terminal).
 *
 * Every column reads freshest-first: `updated_at` descending, so whatever just
 * moved sits at the top of its column. The sort is stable and the backend hands
 * rows over in board order (sort_order, id), so equal timestamps keep that
 * order — which is exactly what preserves a pending-column drag: `reorder`
 * stamps the whole column with one `updated_at`, the rows tie, and the fallback
 * is their freshly written sort_order. sort_order still drives the launch queue
 * (`next_queued` / "start all"); it just no longer drives the display.
 */
export function groupTasksByColumn(
  tasks: WorkTask[],
  showCanceled: boolean,
  showArchived = false
): Record<BoardColumnId, WorkTask[]> {
  const grouped: Record<BoardColumnId, WorkTask[]> = {
    todo: [],
    inProgress: [],
    attention: [],
    done: [],
  }
  for (const task of tasks) {
    if (task.status === "canceled" && !showCanceled) continue
    if (task.archived_at != null && !showArchived) continue
    grouped[columnForStatus(task.status)].push(task)
  }
  for (const column of BOARD_COLUMN_IDS) {
    grouped[column].sort(byFreshest)
  }
  return grouped
}

/** Freshest-first, the order every board column and the list view read in. */
function byFreshest(a: WorkTask, b: WorkTask): number {
  return parseTimestamp(b.updated_at) - parseTimestamp(a.updated_at)
}

/**
 * The list view's rows: one flat, freshest-first sequence instead of four
 * columns. `statuses` is the list-only status filter (`null` = every status,
 * which is the default), and archived tasks stay hidden unless `showArchived`.
 *
 * The board's "show canceled" toggle deliberately has no say here — in list
 * mode `canceled` is just one more status checkbox, so there is exactly one
 * control per status rather than two that can contradict each other.
 */
export function filterTasksForList(
  tasks: WorkTask[],
  statuses: WorkTaskStatus[] | null,
  showArchived: boolean
): WorkTask[] {
  const allowed = statuses == null ? null : new Set(statuses)
  return tasks
    .filter(
      (task) =>
        (task.archived_at == null || showArchived) &&
        (allowed == null || allowed.has(task.status))
    )
    .sort(byFreshest)
}
