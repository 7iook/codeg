/**
 * Planning a start crosses a timezone boundary: the picker speaks the user's
 * wall clock and the backend stores an instant. These pin the conversion (a
 * silent UTC slip would run tasks hours off) and the clear path.
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { toDateTimeLocalValue } from "@/lib/task-schedule"
import type { WorkTask } from "@/lib/types"

const scheduleMock = vi.fn().mockResolvedValue(undefined)

vi.mock("@/lib/api", () => ({
  workTaskSchedule: (...args: unknown[]) => scheduleMock(...args),
}))

import { TaskScheduleDialog } from "./task-schedule-dialog"

function task(overrides?: Partial<WorkTask>): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Fix login",
    config: null,
    status: "todo",
    scheduled_at: null,
    ...overrides,
  } as WorkTask
}

function renderDialog(row: WorkTask = task()) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskScheduleDialog open onOpenChange={() => {}} task={row} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  scheduleMock.mockClear()
})

describe("TaskScheduleDialog", () => {
  it("sends the picked wall-clock time as its own instant", async () => {
    renderDialog()
    const input = screen.getByLabelText("Start at")
    // fireEvent-style set: `userEvent.type` on datetime-local fills segment by
    // segment, which is exactly what this test does not want to assert about.
    await userEvent.clear(input)
    await userEvent.type(input, "2026-08-08T09:30")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(scheduleMock).toHaveBeenCalled())
    const [id, iso] = scheduleMock.mock.calls[0]
    expect(id).toBe(7)
    // Whatever the machine's zone, the instant must denote 09:30 locally.
    expect(toDateTimeLocalValue(new Date(iso as string))).toBe(
      "2026-08-08T09:30"
    )
  })

  it("seeds the input from an existing plan and can clear it", async () => {
    const planned = new Date(2026, 7, 8, 9, 30)
    renderDialog(task({ scheduled_at: planned.toISOString() }))
    expect(screen.getByLabelText("Start at")).toHaveValue("2026-08-08T09:30")

    await userEvent.click(
      screen.getByRole("button", { name: "Clear schedule" })
    )
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledWith(7, null))
  })

  it("offers no clear button when the task has no plan", () => {
    renderDialog()
    expect(screen.queryByRole("button", { name: "Clear schedule" })).toBeNull()
  })

  it("warns instead of refusing when the time has already passed", async () => {
    renderDialog()
    const input = screen.getByLabelText("Start at")
    await userEvent.clear(input)
    await userEvent.type(input, "2020-01-01T09:00")
    expect(screen.getByText(/That time has passed/)).toBeInTheDocument()
    // Still savable: the engine simply starts it at its next sweep.
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })

  it("applies a preset to the input", async () => {
    renderDialog()
    await userEvent.click(screen.getByRole("button", { name: "Tomorrow 9:00" }))
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(9, 0, 0, 0)
    expect(screen.getByLabelText("Start at")).toHaveValue(
      toDateTimeLocalValue(tomorrow)
    )
  })
})
