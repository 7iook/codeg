"use client"

import { useCallback, useRef, useState } from "react"
import type { PromptDraft } from "@/lib/types"
import type { QueueItemStatus } from "@/lib/steering-queue"
import { randomUUID } from "@/lib/utils"

export interface QueuedMessage {
  id: string
  draft: PromptDraft
  modeId: string | null
  /**
   * Stable delivery identity, distinct from `id`.
   *
   * `id` is the React list key and is REASSIGNED whenever a bounced draft is
   * re-queued (`requeueFront` mints a fresh item), so it cannot answer "have I
   * already delivered this message?". `messageId` is minted once per user
   * message and threaded to the backend as the steer request's `messageId`.
   *
   * Local bookkeeping only: `_session/steering` accepts no idempotency key, so
   * this prevents THIS client from double-sending but does not make delivery
   * exactly-once end to end (design §2.5.1).
   */
  messageId: string
  /** Delivery state. See `QueueItemStatus`. */
  status: QueueItemStatus
}

export interface UseMessageQueueReturn {
  queue: QueuedMessage[]
  enqueue: (draft: PromptDraft, modeId: string | null) => void
  /**
   * Put a draft back at the FRONT of the queue. Used when an auto-flushed item
   * was dequeued, sent, and bounced (TurnBusyError): it must return to the head
   * so it retries before items that were already behind it (FIFO preserved).
   */
  requeueFront: (draft: PromptDraft, modeId: string | null) => void
  /**
   * Take the first CLAIMABLE (`queued`) item and remove it from the queue, for
   * the auto-flush's ordinary-prompt path.
   *
   * Skips past a head that is `in_flight` / `delivered` / `unknown` rather than
   * shifting it out: a "send now" injection leaves its item in place while the
   * request is out, and shifting it would hand the same message to the flush for
   * a second delivery (design §2.3.1).
   */
  dequeue: () => QueuedMessage | undefined
  /**
   * Atomically claim `id` for delivery: flips `queued` → `in_flight` and returns
   * true. Returns false if the item is gone or is not `queued` — i.e. the caller
   * LOST the race and must not send.
   *
   * This is the single gate both dequeue paths ("send now" and auto-flush) pass
   * through, so one queue item can never produce two deliveries.
   */
  markInFlight: (id: string) => boolean
  /** Move an item to `status`, leaving its queue position untouched. */
  setStatus: (id: string, status: QueueItemStatus) => void
  remove: (id: string) => void
  reorder: (items: QueuedMessage[]) => void
  updateItem: (id: string, draft: PromptDraft) => void
  /**
   * The queue length, read SYNCHRONOUSLY from the authoritative ref — it
   * reflects the same-tick result of an enqueue/requeue/dequeue, before React
   * commits the next render. Callers gating on "is the queue non-empty right
   * now" (the fork-send guard, the direct-send routing) must use this rather
   * than `queue.length` (which lags a render).
   */
  getQueueLength: () => number
  editingItemId: string | null
  startEditing: (id: string) => void
  cancelEditing: () => void
}

/**
 * A fresh queue item. Every entry starts `queued` — the only claimable state —
 * and gets its own `messageId`, including a `requeueFront` retry of a bounced
 * draft (a bounce means the send was rejected, so that draft has no prior
 * delivery to be confused with).
 */
function newItem(draft: PromptDraft, modeId: string | null): QueuedMessage {
  return {
    id: randomUUID(),
    draft,
    modeId,
    messageId: randomUUID(),
    status: "queued",
  }
}

export function useMessageQueue(): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  // Authoritative copy of the queue, updated SYNCHRONOUSLY by every mutation
  // (before the React state commit). Reads that must observe the same-tick
  // result of a mutation — the fork-send guard and the direct-send queue
  // routing — go through this ref / `getQueueLength`, NOT the `queue` state
  // (which lags until React commits) and NOT a passive-effect-synced mirror
  // (which lags a full render). Without this, a bounce that re-queues a draft
  // leaves a window where the guard still sees an empty queue.
  const queueRef = useRef<QueuedMessage[]>(queue)

  // Update the authoritative ref first, then schedule the render. A plain value
  // (not a functional updater) is correct because `queueRef.current` is always
  // the latest committed value.
  const commit = useCallback((next: QueuedMessage[]) => {
    queueRef.current = next
    setQueue(next)
  }, [])

  const enqueue = useCallback(
    (draft: PromptDraft, modeId: string | null) => {
      commit([...queueRef.current, newItem(draft, modeId)])
    },
    [commit]
  )

  const requeueFront = useCallback(
    (draft: PromptDraft, modeId: string | null) => {
      commit([newItem(draft, modeId), ...queueRef.current])
    },
    [commit]
  )

  const dequeue = useCallback((): QueuedMessage | undefined => {
    const current = queueRef.current
    // First CLAIMABLE item, not blindly the head: an item mid-injection stays in
    // the queue while its request is out, and shifting it out here would hand the
    // same message to the flush for a second delivery.
    const index = current.findIndex((item) => item.status === "queued")
    if (index === -1) return undefined
    commit(current.filter((_, i) => i !== index))
    return current[index]
  }, [commit])

  const markInFlight = useCallback(
    (id: string): boolean => {
      const current = queueRef.current
      const item = current.find((entry) => entry.id === id)
      // Lost the race (already claimed / delivered / gone): the caller must NOT
      // send. Returning a boolean rather than throwing keeps the loser silent —
      // this is an expected outcome of two paths sharing one queue.
      if (!item || item.status !== "queued") return false
      commit(
        current.map((entry) =>
          entry.id === id ? { ...entry, status: "in_flight" } : entry
        )
      )
      return true
    },
    [commit]
  )

  const setStatus = useCallback(
    (id: string, status: QueueItemStatus) => {
      const current = queueRef.current
      if (!current.some((item) => item.id === id)) return
      commit(
        current.map((item) => (item.id === id ? { ...item, status } : item))
      )
    },
    [commit]
  )

  const remove = useCallback(
    (id: string) => {
      if (editingItemId === id) {
        setEditingItemId(null)
      }
      commit(queueRef.current.filter((item) => item.id !== id))
    },
    [commit, editingItemId]
  )

  const reorder = useCallback(
    (items: QueuedMessage[]) => {
      // Apply a reorder ONLY if it is a true permutation of the live queue, and
      // rebuild it from the AUTHORITATIVE items rather than the caller's
      // (possibly stale) objects. A drag emission carries the queue order from
      // the render it began in; if the live queue changed since (dequeue /
      // requeue / remove / updateItem), the dragged array is stale. Reject any
      // length mismatch, unknown id, or repeated id (e.g. `[A, A]` would
      // otherwise drop `B` and duplicate `A`); commit the current item objects
      // in the requested order so a concurrent `updateItem` isn't clobbered.
      const current = queueRef.current
      if (items.length !== current.length) return
      const byId = new Map(current.map((item) => [item.id, item]))
      const seen = new Set<string>()
      const next: QueuedMessage[] = []
      for (const item of items) {
        const authoritative = byId.get(item.id)
        if (!authoritative || seen.has(item.id)) return
        seen.add(item.id)
        next.push(authoritative)
      }
      commit(next)
    },
    [commit]
  )

  const updateItem = useCallback(
    (id: string, draft: PromptDraft) => {
      commit(
        queueRef.current.map((item) =>
          item.id === id ? { ...item, draft } : item
        )
      )
      setEditingItemId(null)
    },
    [commit]
  )

  const getQueueLength = useCallback(() => queueRef.current.length, [])

  const startEditing = useCallback((id: string) => {
    setEditingItemId(id)
  }, [])

  const cancelEditing = useCallback(() => {
    setEditingItemId(null)
  }, [])

  return {
    queue,
    enqueue,
    requeueFront,
    dequeue,
    markInFlight,
    setStatus,
    remove,
    reorder,
    updateItem,
    getQueueLength,
    editingItemId,
    startEditing,
    cancelEditing,
  }
}
