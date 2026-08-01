"use client"

/**
 * Live transcript viewer for a work task's agent session — the same read-only
 * streaming surface as the delegation sub-agent dialog (`LiveTranscriptView`),
 * without opening the conversation in the workbench.
 *
 * Unlike delegation children (attached by the delegation provider), a
 * headless work-task connection is invisible to the frontend until attached:
 * on desktop the global acp://event router drops envelopes with no reverse-map
 * entry, and on web there is no per-connection stream at all. So while the
 * task is in a live status this dialog owns an
 * `attachDelegationChild`/`detachDelegationChild` pair for the task's
 * connection (identity parent mapping — there is no real parent tool call).
 * For settled tasks the DB row's connection_id is stale and the connection is
 * gone; we skip the attach and the viewer renders the persisted transcript.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { AgentIcon } from "@/components/agent-icon"
import { LiveTranscriptView } from "@/components/message/live-transcript-view"
import { type ResolvedMessageGroup } from "@/components/message/message-list-view"
import { StatusChip } from "./task-card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { useAcpActions } from "@/contexts/acp-connections-context"
import { workTaskEvents } from "@/lib/api"
import {
  extractRounds,
  firstTextOfParts,
  matchRoundKind,
  type TaskRound,
} from "@/lib/task-rounds"
import { type AgentType, type WorkTask } from "@/lib/types"

interface TaskTranscriptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: WorkTask | null
  /** Resolved by the host (conversation summary → config override → null). */
  agentType: AgentType | null
}

/** Statuses in which the engine holds a live connection worth attaching
 *  (`merging` included — the merge is an agent turn too). */
function isLive(task: WorkTask): boolean {
  return (
    task.status === "running" ||
    task.status === "awaiting_input" ||
    task.status === "merging"
  )
}

export function TaskTranscriptDialog({
  open,
  onOpenChange,
  task,
  agentType,
}: TaskTranscriptDialogProps) {
  const t = useTranslations("Tasks")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeButtonClassName="top-2 right-2"
        className="flex h-[85vh] w-full max-w-3xl flex-col gap-0 overflow-hidden rounded-2xl p-0 lg:max-w-4xl"
      >
        <DialogTitle className="sr-only">{t("transcriptTitle")}</DialogTitle>
        <DialogDescription className="sr-only">
          {t("transcriptDescription")}
        </DialogDescription>
        {open && task != null && task.conversation_id != null ? (
          <TaskTranscriptBody task={task} agentType={agentType} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TaskTranscriptBody({
  task,
  agentType,
}: {
  task: WorkTask
  agentType: AgentType | null
}) {
  const t = useTranslations("Tasks")
  const { attachDelegationChild, detachDelegationChild } = useAcpActions()

  // Round markers → phase dividers above the matching user turns. Refetched
  // when a new generation dispatches (run_seq moves) so a merge started while
  // watching gets its divider too.
  const [rounds, setRounds] = useState<TaskRound[]>([])
  const runSeq = task.run_seq
  useEffect(() => {
    let cancelled = false
    workTaskEvents(task.id, 500)
      .then((events) => {
        if (!cancelled) setRounds(extractRounds(events))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [task.id, runSeq])
  const userTurnHeader = useCallback(
    (group: ResolvedMessageGroup) => {
      switch (matchRoundKind(rounds, firstTextOfParts(group.parts))) {
        case "work":
          return t("phaseWork")
        case "retry":
          return t("phaseRetry")
        case "return":
          return t("phaseReturn")
        case "merge":
          return t("phaseMerge")
        default:
          return null
      }
    },
    [rounds, t]
  )

  // Latched at mount: attach only when the task is live *now*, and keep the
  // attach until the dialog closes. Re-deriving per render would detach the
  // instant the provider refetch flips the task to review — racing the final
  // turn-complete event the bridge needs to promote the live reply — and a
  // task that settled long ago must not attach at all (on web that would open
  // a per-connection stream for a connection the backend no longer has).
  const [attach] = useState(() => ({
    id: isLive(task) ? task.connection_id : null,
    // Agent as known at open; a late refinement (conversation summary landing
    // after mount) must not re-attach — it would drop buffered events.
    agentType: agentType ?? ("claude_code" as AgentType),
  }))
  const attachId = attach.id
  const taskId = task.id
  useEffect(() => {
    const id = attachId
    if (id == null) return
    attachDelegationChild({
      connectionId: id,
      parentConnectionId: id,
      parentToolUseId: `work-task-${taskId}`,
      agentType: attach.agentType,
    })
    return () => detachDelegationChild(id)
  }, [attachId, attach, taskId, attachDelegationChild, detachDelegationChild])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-2.5 pr-12">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground">
          {agentType ? (
            <AgentIcon agentType={agentType} className="h-4 w-4" />
          ) : (
            <span className="h-2 w-2 rounded-sm bg-muted-foreground/60" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {task.title}
        </span>
        <StatusChip task={task} />
      </div>
      <LiveTranscriptView
        conversationId={task.conversation_id as number}
        connectionId={attachId}
        agentType={agentType}
        kickoffText={task.config?.display_text ?? null}
        userTurnHeader={userTurnHeader}
      />
    </div>
  )
}
