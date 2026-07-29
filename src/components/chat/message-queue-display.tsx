"use client"

import { useCallback, type PointerEvent } from "react"
import { Reorder, useDragControls } from "motion/react"
import { GripVertical, Pencil, RotateCcw, X, Zap } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { canSendNow } from "@/lib/steering-queue"
import type { QueuedMessage } from "@/hooks/use-message-queue"

interface MessageQueueDisplayProps {
  queue: QueuedMessage[]
  onReorder: (items: QueuedMessage[]) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  editingItemId: string | null
  /**
   * Whether the agent supports mid-turn steering. `undefined` (probe hasn't
   * answered) is treated the same as `false`: no "send now" is offered, and the
   * item shows only its "will send after this turn" timing (R2.2).
   */
  supportsSteering?: boolean | undefined
  /**
   * Inject this item into the RUNNING turn. Absent → the action is never
   * rendered (e.g. the welcome composer, which has no live turn to steer).
   */
  onSendNow?: (id: string) => void
}

interface QueueItemProps {
  item: QueuedMessage
  index: number
  isEditing: boolean
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  supportsSteering?: boolean | undefined
  onSendNow?: (id: string) => void
}

function QueueItem({
  item,
  index,
  isEditing,
  onEdit,
  onDelete,
  supportsSteering,
  onSendNow,
}: QueueItemProps) {
  const t = useTranslations("Folder.chat.messageQueue")
  const dragControls = useDragControls()
  // Gated on `queued` + a confirmed capability, so an item already mid-delivery
  // cannot be sent a second time (design §2.3.1).
  const showSendNow =
    Boolean(onSendNow) && canSendNow(item.status, supportsSteering)

  const startDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      dragControls.start(event)
    },
    [dragControls]
  )

  return (
    <Reorder.Item
      as="div"
      value={item}
      dragListener={false}
      dragControls={dragControls}
      className={cn(
        "flex items-center gap-1 rounded-md border px-1.5 py-1 text-[10px] leading-none select-none [text-box-trim:both] [text-box-edge:cap_alphabetic]",
        "bg-muted/40 border-border/70",
        isEditing && "border-primary/50 bg-primary/5"
      )}
    >
      <button
        type="button"
        className="shrink-0 cursor-grab touch-none active:cursor-grabbing p-0"
        onPointerDown={startDrag}
      >
        <GripVertical className="h-3 w-3 text-muted-foreground/60" />
      </button>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
        #{index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate text-[10px] text-foreground/80">
        {item.draft.displayText}
      </span>
      {/* Delivery timing / state. Always present so the user can never conclude
          the message was silently dropped (Zed #48175). The `unknown` wording
          claims NEITHER "sent" NOR "failed" — no response came back, so both
          would assert a fact we don't have. */}
      <span
        className={cn(
          "shrink-0 whitespace-nowrap text-[10px]",
          item.status === "unknown"
            ? "text-amber-600 dark:text-amber-500"
            : "text-muted-foreground/70"
        )}
        title={
          item.status === "unknown" ? t("statusUnknownTooltip") : undefined
        }
      >
        {item.status === "in_flight"
          ? t("statusSending")
          : item.status === "unknown"
            ? t("statusUnknown")
            : t("willSendAfterTurn")}
      </span>
      {showSendNow && (
        <button
          type="button"
          onClick={() => onSendNow?.(item.id)}
          className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground"
          // Names the consequence rather than hiding it: `_session/steering` only
          // offers `priority=now`, which pre-empts the current generation. There
          // is no gentler variant to offer (design C6).
          title={t("sendNowTooltip")}
          aria-label={t("sendNow")}
        >
          <Zap className="h-2.5 w-2.5" />
        </button>
      )}
      {item.status === "unknown" && onSendNow && (
        // Separate, explicitly-labelled affordance rather than reusing "send
        // now": an `unknown` item may already have been accepted, so re-sending
        // it is a deliberate user decision and must never be automatic.
        <button
          type="button"
          onClick={() => onSendNow(item.id)}
          className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground"
          title={t("resend")}
          aria-label={t("resend")}
        >
          <RotateCcw className="h-2.5 w-2.5" />
        </button>
      )}
      <button
        type="button"
        onClick={() => onEdit(item.id)}
        className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground"
        title={t("editItem")}
      >
        <Pencil className="h-2.5 w-2.5" />
      </button>
      <button
        type="button"
        onClick={() => onDelete(item.id)}
        className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground"
        title={t("deleteItem")}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </Reorder.Item>
  )
}

export function MessageQueueDisplay({
  queue,
  onReorder,
  onEdit,
  onDelete,
  editingItemId,
  supportsSteering,
  onSendNow,
}: MessageQueueDisplayProps) {
  if (queue.length === 0) return null

  return (
    <div className="max-h-28 overflow-y-auto pb-1">
      <Reorder.Group
        as="div"
        axis="y"
        values={queue}
        onReorder={onReorder}
        className="flex flex-col gap-0.5"
      >
        {queue.map((item, index) => (
          <QueueItem
            key={item.id}
            item={item}
            index={index}
            isEditing={editingItemId === item.id}
            onEdit={onEdit}
            onDelete={onDelete}
            supportsSteering={supportsSteering}
            onSendNow={onSendNow}
          />
        ))}
      </Reorder.Group>
    </div>
  )
}
