import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { WorkTask } from "@/lib/types"
import { TaskRow } from "./task-row"

function task(overrides?: Partial<WorkTask>): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Answer the question",
    config: null,
    status: "review",
    failure_reason: null,
    last_error: null,
    run_seq: 1,
    sort_order: 1,
    worktree_folder_id: 9,
    conversation_id: null,
    connection_id: null,
    base_branch: "main",
    base_sha: "abc",
    work_branch: "task/7",
    cleanup_state: null,
    verdict: null,
    result_summary: null,
    files_changed: 3,
    additions: 10,
    deletions: 2,
    merge_commit: null,
    preflight: null,
    archived_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    started_at: null,
    settled_at: null,
    finished_at: null,
    ...overrides,
  }
}

function renderRow(
  t: WorkTask,
  handlers?: Partial<Record<string, () => void>>
) {
  const noop = () => {}
  const props = {
    onOpen: noop,
    onStart: noop,
    onCancel: noop,
    onRetry: noop,
    onRequeue: noop,
    onViewSession: noop,
    onMerge: noop,
    onComplete: noop,
    onArchive: noop,
    onEdit: noop,
    ...handlers,
  }
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskRow
        task={t}
        folderName="repo"
        now={Date.parse("2026-08-01T01:00:00Z")}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

describe("TaskRow", () => {
  it("carries the same primary action the card derives for the status", async () => {
    const onMerge = vi.fn()
    renderRow(task(), { onMerge })
    await userEvent.click(screen.getByRole("button", { name: "Merge" }))
    expect(onMerge).toHaveBeenCalledTimes(1)
  })

  it("opens the detail sheet on the row, but not when an action is clicked", async () => {
    const onOpen = vi.fn()
    const onRetry = vi.fn()
    renderRow(task({ status: "failed" }), { onOpen, onRetry })

    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    // The action must not bubble into the row's own open handler.
    expect(onOpen).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText("Answer the question"))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("does not open the sheet when a row action is activated by keyboard", async () => {
    const onOpen = vi.fn()
    const onArchive = vi.fn()
    renderRow(task({ status: "done" }), { onOpen, onArchive })

    screen.getByRole("button", { name: "Archive" }).focus()
    await userEvent.keyboard("{Enter}")
    expect(onArchive).toHaveBeenCalledTimes(1)
    // The keydown bubbles to the row — which must neither open the sheet nor
    // cancel the button's own activation.
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("keeps the session viewer on an archived task", () => {
    renderRow(
      task({
        status: "done",
        archived_at: "2026-08-01T02:00:00Z",
        conversation_id: 42,
      })
    )
    expect(
      screen.getByRole("button", { name: "View session" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Unarchive" })
    ).toBeInTheDocument()
  })

  it("shows the error of a failed task and the live progress of a running one", () => {
    const { unmount } = renderRow(
      task({ status: "failed", last_error: "boom: exit 1" })
    )
    expect(screen.getByText("boom: exit 1")).toBeTruthy()
    unmount()

    renderRow(task({ status: "running", latest_progress: "installing deps" }))
    expect(screen.getByText("installing deps")).toBeTruthy()
  })
})
