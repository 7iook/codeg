"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { workTaskMerge, workTaskSettingsGet } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { WorkTask } from "@/lib/types"

interface TaskMergeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: WorkTask | null
}

/**
 * Quick-merge a reviewed task: commit message (prefilled from the title),
 * strategy (folder default), and the delete-worktree checkbox (checked by
 * default per the folder settings). Submit fires the async two-stage merge;
 * the outcome rides `task://changed` (merging → done, or back to review with a
 * readable error on the card).
 */
export function TaskMergeDialog({
  open,
  onOpenChange,
  task,
}: TaskMergeDialogProps) {
  const t = useTranslations("Tasks")
  const [message, setMessage] = useState("")
  const [strategy, setStrategy] = useState<"squash" | "merge">("squash")
  const [deleteWorktree, setDeleteWorktree] = useState(true)
  const [autoResolve, setAutoResolve] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open || !task) return
    // Seed per open: message from the title, strategy + delete-worktree from
    // the folder's task settings.
    /* eslint-disable react-hooks/set-state-in-effect */
    setMessage(task.title)
    setAutoResolve(true)
    setSubmitting(false)
    let cancelled = false
    workTaskSettingsGet(task.folder_id)
      .then((s) => {
        if (cancelled) return
        setStrategy(s.merge_strategy === "merge" ? "merge" : "squash")
        setDeleteWorktree(s.delete_worktree_default)
      })
      .catch(() => {
        if (cancelled) return
        setStrategy("squash")
        setDeleteWorktree(true)
      })
    return () => {
      cancelled = true
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, task])

  const submit = async () => {
    if (!task || !message.trim()) return
    setSubmitting(true)
    try {
      await workTaskMerge(
        task.id,
        message.trim(),
        strategy,
        deleteWorktree,
        autoResolve
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
          <DialogTitle>{t("mergeTitle")}</DialogTitle>
          <DialogDescription>
            {task
              ? t("mergeDescription", {
                  branch: task.work_branch ?? "?",
                  base: task.base_branch ?? "?",
                })
              : null}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-merge-message">{t("mergeMessage")}</Label>
            <Textarea
              id="task-merge-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("mergeMessagePlaceholder")}
              rows={3}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <Label className="text-sm">{t("mergeStrategy")}</Label>
            <Select
              value={strategy}
              onValueChange={(v) =>
                setStrategy(v === "merge" ? "merge" : "squash")
              }
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="squash">{t("strategySquash")}</SelectItem>
                <SelectItem value="merge">{t("strategyMerge")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Label className="text-sm font-normal">
            <Checkbox
              checked={deleteWorktree}
              onCheckedChange={(v) => setDeleteWorktree(v === true)}
            />
            {t("mergeDeleteWorktree")}
          </Label>

          <Label className="text-sm font-normal">
            <Checkbox
              checked={autoResolve}
              onCheckedChange={(v) => setAutoResolve(v === true)}
            />
            {t("mergeAutoResolve")}
          </Label>
        </div>

        <DialogFooter>
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
            onClick={submit}
            disabled={submitting || !message.trim()}
          >
            {t("mergeSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
