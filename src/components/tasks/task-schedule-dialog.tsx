"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CalendarClock, TriangleAlert } from "lucide-react"
import { workTaskSchedule } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  formatScheduleFull,
  isoToDateTimeLocalValue,
  isScheduleInPast,
  parseDateTimeLocalValue,
  schedulePresets,
  toDateTimeLocalValue,
} from "@/lib/task-schedule"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import type { WorkTask } from "@/lib/types"

interface TaskScheduleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: WorkTask | null
}

/** Default seed for an unplanned task: the next full hour. */
function nextHour(now: Date): string {
  const date = new Date(now)
  date.setMinutes(0, 0, 0)
  date.setHours(date.getHours() + 1)
  return toDateTimeLocalValue(date)
}

/**
 * Plan when a to-do task starts.
 *
 * `type="datetime-local"` rather than a bespoke calendar: it is keyboard
 * accessible and locale-formatted for free, and it speaks the user's own wall
 * clock — which is what "run it at nine" means. The conversion to the UTC
 * instant the backend stores happens on save (see `lib/task-schedule`).
 *
 * A time already in the past is accepted rather than refused: the engine simply
 * claims it on its next sweep. The dialog says so, so it can't read as a plan
 * that silently did nothing.
 */
export function TaskScheduleDialog({
  open,
  onOpenChange,
  task,
}: TaskScheduleDialogProps) {
  const t = useTranslations("Tasks")
  const [value, setValue] = useState("")
  const [submitting, setSubmitting] = useState(false)
  // Frozen at open: the presets and the "already passed" hint are a snapshot of
  // the moment the dialog appeared, and a ticking `now` would move them under
  // the pointer.
  const [openedAt, setOpenedAt] = useState(() => Date.now())

  // Keyed on the task's IDENTITY, not the row object: the board refetches on
  // every `task://changed` nudge and hands down a fresh object each time, so
  // depending on `task` would wipe a half-typed time whenever anything else on
  // the board moved.
  const taskId = task?.id ?? null
  const plannedAt = task?.scheduled_at ?? null
  useEffect(() => {
    if (!open) return
    const now = new Date()
    setOpenedAt(now.getTime())
    setValue(
      (plannedAt ? isoToDateTimeLocalValue(plannedAt) : null) ?? nextHour(now)
    )
    setSubmitting(false)
    // `plannedAt` seeds the field but deliberately does not re-run this: while
    // the dialog is open the input belongs to the user, not to the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskId])

  const picked = parseDateTimeLocalValue(value)
  const isPast = picked != null && isScheduleInPast(picked, openedAt)
  const scheduled = plannedAt != null

  const save = async (next: string | null) => {
    if (!task) return
    setSubmitting(true)
    try {
      await workTaskSchedule(task.id, next)
      toast.success(
        next
          ? t("toastScheduled", { time: formatScheduleFull(next) })
          : t("toastScheduleCleared")
      )
      onOpenChange(false)
    } catch (e) {
      toast.error(toErrorMessage(e))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[28rem]">
        <DialogHeader>
          <DialogTitle>{t("scheduleTitle")}</DialogTitle>
          <DialogDescription>{t("scheduleDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-schedule-at">{t("scheduleTimeLabel")}</Label>
            <Input
              id="task-schedule-at"
              type="datetime-local"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
          </div>

          {/* One-tap options for the times people actually pick. */}
          <div className="flex flex-wrap gap-1.5">
            {schedulePresets(new Date(openedAt)).map((preset) => (
              <Button
                key={preset.labelKey}
                type="button"
                size="sm"
                variant="ghost"
                aria-pressed={value === preset.value}
                className={cn(
                  "h-7 rounded-full bg-muted/70 px-3 text-xs font-medium hover:bg-muted",
                  value === preset.value && "bg-primary/10 text-primary"
                )}
                onClick={() => setValue(preset.value)}
              >
                {t(preset.labelKey)}
              </Button>
            ))}
          </div>

          <p
            className={cn(
              "flex items-center gap-1.5 text-xs",
              isPast
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground"
            )}
          >
            {isPast ? (
              <>
                <TriangleAlert
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {t("schedulePastHint")}
              </>
            ) : picked ? (
              <>
                <CalendarClock
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {t("schedulePreview", {
                  time: formatScheduleFull(picked.toISOString()),
                })}
              </>
            ) : null}
          </p>
        </div>

        <DialogFooter>
          {/* Unplanning is not a cancel — it leaves the task on the board under
              manual control, so it belongs beside the save, not behind it. */}
          {scheduled ? (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto text-muted-foreground hover:text-foreground"
              onClick={() => void save(null)}
              disabled={submitting}
            >
              {t("scheduleClear")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => picked && void save(picked.toISOString())}
            disabled={submitting || picked == null}
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
