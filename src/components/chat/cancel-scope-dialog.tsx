"use client"

import { useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { CancelScopeConfirmation } from "@/hooks/use-connection-lifecycle"

/**
 * "Stopping will also stop N sub-agents" (spec R4.1).
 *
 * Rendered only when a cascade would actually kill something: the stop handler
 * resolves `confirmation` to null when `count === 0`, so this never interposes
 * on the common path.
 *
 * The count comes from the backend preview and includes still-starting
 * delegations that have no task_id yet — it is displayed verbatim, never
 * recomputed from a list length.
 */
export function CancelScopeDialog({
  confirmation,
}: {
  confirmation: CancelScopeConfirmation | null
}) {
  const t = useTranslations("Folder.chat.connectionLifecycle.cancelScope")
  return (
    <AlertDialog
      open={confirmation !== null}
      // Covers Escape and the overlay click as well as the Cancel button: every
      // dismissal path must terminate nothing.
      onOpenChange={(open) => {
        if (!open) confirmation?.dismiss()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("description", { count: confirmation?.count ?? 0 })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => confirmation?.dismiss()}>
            {t("keepRunning")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => confirmation?.confirm()}
          >
            {t("stopAll")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
