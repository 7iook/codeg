import { createElement, useEffect } from "react"
import { describe, it, expect, vi } from "vitest"
import { act, fireEvent, render, renderHook } from "@testing-library/react"
import { useMessageQueue } from "./use-message-queue"
import type { PromptDraft } from "@/lib/types"

function draft(text: string): PromptDraft {
  return { blocks: [{ type: "text", text }], displayText: text }
}

function texts(q: { draft: PromptDraft }[]): string[] {
  return q.map((item) => item.draft.displayText)
}

function ClaimRaceHarness({
  deferWholeSendNowClaim,
  onOrdinarySend,
  onSteer,
}: {
  deferWholeSendNowClaim: boolean
  onOrdinarySend: () => void
  onSteer: () => void
}) {
  const { queue, enqueue, dequeue, markInFlight } = useMessageQueue()
  const queueLength = queue.length

  useEffect(() => {
    if (queueLength === 0) return
    const timer = setTimeout(() => {
      if (dequeue()) onOrdinarySend()
    }, 0)
    return () => clearTimeout(timer)
  }, [queueLength, dequeue, onOrdinarySend])

  return createElement(
    "div",
    null,
    createElement(
      "button",
      { onClick: () => enqueue(draft("only"), null) },
      "queue"
    ),
    createElement(
      "button",
      {
        onClick: () => {
          const item = queue[0]
          if (!item) return
          const claimAndSteer = () => {
            if (!markInFlight(item.id)) return
            onSteer()
          }
          if (deferWholeSendNowClaim) {
            setTimeout(claimAndSteer, 0)
          } else {
            claimAndSteer()
          }
        },
      },
      "send now"
    )
  )
}

describe("useMessageQueue bounce FIFO ordering", () => {
  it("requeueFront keeps a bounced head ahead of items behind it", () => {
    const { result } = renderHook(() => useMessageQueue())

    // Queue [A, B].
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    expect(texts(result.current.queue)).toEqual(["A", "B"])

    // The auto-flush dequeues the head (A) and sends it.
    let dequeued: ReturnType<typeof result.current.dequeue>
    act(() => {
      dequeued = result.current.dequeue()
    })
    expect(dequeued?.draft.displayText).toBe("A")
    expect(texts(result.current.queue)).toEqual(["B"])

    // A bounces (TurnBusyError) → re-queued at the FRONT, NOT the tail, so it
    // retries before B. (Re-enqueuing at the tail here would yield [B, A] and
    // send B before A — the FIFO regression this guards against.)
    act(() => result.current.requeueFront(draft("A"), null))
    expect(texts(result.current.queue)).toEqual(["A", "B"])

    // The next flush therefore dequeues A again, not B.
    act(() => {
      dequeued = result.current.dequeue()
    })
    expect(dequeued?.draft.displayText).toBe("A")
  })

  it("enqueue still appends to the tail (front vs tail are distinct)", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("tail"), null))
    act(() => result.current.requeueFront(draft("front"), null))
    expect(texts(result.current.queue)).toEqual(["front", "A", "tail"])
  })

  it("getQueueLength reflects mutations SYNCHRONOUSLY (same tick, before re-render)", () => {
    const { result } = renderHook(() => useMessageQueue())
    // Multiple mutations within a single act() — getQueueLength must observe
    // each one immediately, without waiting for a React commit. This is what
    // the fork-send guard relies on: a draft re-queued by a same-tick bounce
    // is visible before the next render hides the fork affordance.
    act(() => {
      expect(result.current.getQueueLength()).toBe(0)
      result.current.enqueue(draft("A"), null)
      expect(result.current.getQueueLength()).toBe(1)
      result.current.requeueFront(draft("B"), null)
      expect(result.current.getQueueLength()).toBe(2)
      result.current.dequeue()
      expect(result.current.getQueueLength()).toBe(1)
    })
    // After commit the rendered queue matches the authoritative ref.
    expect(texts(result.current.queue)).toEqual(["A"])
    expect(result.current.getQueueLength()).toBe(1)
  })

  it("applies a valid reorder (a permutation of the live queue)", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    const [a, b] = result.current.queue
    act(() => result.current.reorder([b, a]))
    expect(texts(result.current.queue)).toEqual(["B", "A"])
  })

  it("ignores a STALE reorder whose id set no longer matches (no resurrect/drop)", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    const stale = [...result.current.queue].reverse() // snapshot of [A, B] → [B, A]
    // The queue changes (A dequeued) AFTER the drag snapshot was taken.
    act(() => result.current.dequeue())
    expect(texts(result.current.queue)).toEqual(["B"])
    // Applying the stale [B, A] order would resurrect A — it must be ignored.
    act(() => result.current.reorder(stale))
    expect(texts(result.current.queue)).toEqual(["B"])
  })

  it("ignores a reorder containing a duplicate id (would drop another item)", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    const [a] = result.current.queue
    // [A, A] matches length + membership but is NOT a permutation — applying it
    // would duplicate A and drop B. Must be ignored.
    act(() => result.current.reorder([a, a]))
    expect(texts(result.current.queue)).toEqual(["A", "B"])
  })

  it("reorders the AUTHORITATIVE items, not the caller's stale objects", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    const [a, b] = result.current.queue
    // A is edited AFTER the drag snapshot [a, b] was captured.
    act(() => result.current.updateItem(a.id, draft("A-edited")))
    // The stale reorder carries the OLD `a` object (draft "A"); the commit must
    // use the authoritative edited A (by id), only applying the requested order.
    act(() => result.current.reorder([b, a]))
    expect(texts(result.current.queue)).toEqual(["B", "A-edited"])
  })
})

describe("useMessageQueue steering status field (T4)", () => {
  it("enqueues items as `queued` with a distinct client-generated messageId", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    const [a, b] = result.current.queue
    expect(a.status).toBe("queued")
    expect(b.status).toBe("queued")
    // Delivery identity is distinct from the React list key: `id` is reassigned
    // by a requeue, while `messageId` is the value local dedup keys on.
    expect(a.messageId).toBeTruthy()
    expect(b.messageId).toBeTruthy()
    expect(a.messageId).not.toBe(b.messageId)
  })

  it("setStatus moves one item without disturbing its position or siblings", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    act(() => result.current.enqueue(draft("C"), null))
    const targetId = result.current.queue[1].id
    act(() => result.current.setStatus(targetId, "in_flight"))
    expect(texts(result.current.queue)).toEqual(["A", "B", "C"])
    expect(result.current.queue.map((i) => i.status)).toEqual([
      "queued",
      "in_flight",
      "queued",
    ])
  })

  it("markInFlight claims a queued item exactly ONCE", () => {
    // This covers repeated send-now claims. The cross-claim race with dequeue is
    // covered below; both rely on synchronous read-check-write against queueRef.
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("only"), null))
    const id = result.current.queue[0].id
    let first = false
    let second = true
    act(() => {
      first = result.current.markInFlight(id)
      second = result.current.markInFlight(id)
    })
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(result.current.queue[0].status).toBe("in_flight")
  })

  it.each([
    ["send-now claim runs synchronously", false],
    ["whole send-now claim is deferred atomically", true],
  ] as const)(
    "delivers once when timer auto-flush races the send-now click: %s",
    async (_scenario, deferWholeSendNowClaim) => {
      vi.useFakeTimers()
      try {
        const ordinarySend = vi.fn()
        const steer = vi.fn()
        const view = render(
          createElement(ClaimRaceHarness, {
            deferWholeSendNowClaim,
            onOrdinarySend: ordinarySend,
            onSteer: steer,
          })
        )
        fireEvent.click(view.getByRole("button", { name: "queue" }))
        fireEvent.click(view.getByRole("button", { name: "send now" }))

        act(() => {
          // Keep promise callbacks pending until every same-tick timer has made
          // its claim. The async timer helper would serialize a split read/write
          // mutation and turn this regression guard back into a fake gate.
          vi.runAllTimers()
        })
        await act(async () => {
          await Promise.resolve()
        })
        view.unmount()

        // The invariant is sink-level: ordinary prompt + steer totals exactly one.
        expect(ordinarySend.mock.calls.length + steer.mock.calls.length).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it("markInFlight refuses an unknown id without mutating the queue", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    let claimed = true
    act(() => {
      claimed = result.current.markInFlight("no-such-id")
    })
    expect(claimed).toBe(false)
    expect(result.current.queue).toHaveLength(1)
    expect(result.current.queue[0].status).toBe("queued")
  })

  it("markInFlight refuses an item that is already delivered", () => {
    // Same `messageId` twice → the second attempt is skipped. `delivered` is
    // terminal; re-delivering it would run the user's instruction again.
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    const id = result.current.queue[0].id
    act(() => result.current.setStatus(id, "delivered"))
    let claimed = true
    act(() => {
      claimed = result.current.markInFlight(id)
    })
    expect(claimed).toBe(false)
  })

  it("dequeue SKIPS a non-queued head so the auto-flush can't re-take it", () => {
    // The head is mid-injection: the flush must look past it rather than
    // shifting it out and sending the same message a second time.
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("head"), null))
    act(() => result.current.enqueue(draft("next"), null))
    const headId = result.current.queue[0].id
    act(() => result.current.markInFlight(headId))
    let taken: string | undefined
    act(() => {
      taken = result.current.dequeue()?.draft.displayText
    })
    expect(taken).toBe("next")
    // The in-flight head STAYS in the queue: its own outcome decides its fate.
    expect(texts(result.current.queue)).toEqual(["head"])
  })

  it("dequeue returns undefined when no item is claimable", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.markInFlight(result.current.queue[0].id))
    let taken: unknown = "unset"
    act(() => {
      taken = result.current.dequeue()
    })
    expect(taken).toBeUndefined()
  })

  it("carries each item's status through a drag-reorder", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    act(() => result.current.setStatus(result.current.queue[1].id, "unknown"))
    const [a, b] = result.current.queue
    act(() => result.current.reorder([b, a]))
    expect(texts(result.current.queue)).toEqual(["B", "A"])
    expect(result.current.queue.map((i) => i.status)).toEqual([
      "unknown",
      "queued",
    ])
  })

  it("keeps status and messageId when the item's draft is edited", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("before"), null))
    const { id, messageId } = result.current.queue[0]
    act(() => result.current.setStatus(id, "unknown"))
    act(() => result.current.updateItem(id, draft("after")))
    expect(result.current.queue[0].draft.displayText).toBe("after")
    expect(result.current.queue[0].status).toBe("unknown")
    expect(result.current.queue[0].messageId).toBe(messageId)
  })

  it("keeps delete working on an item carrying a non-queued status", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    const id = result.current.queue[0].id
    act(() => result.current.setStatus(id, "in_flight"))
    act(() => result.current.remove(id))
    expect(texts(result.current.queue)).toEqual(["B"])
  })

  it("requeueFront still puts a bounced draft at the head as `queued`", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("existing"), null))
    act(() => result.current.requeueFront(draft("bounced"), null))
    expect(texts(result.current.queue)).toEqual(["bounced", "existing"])
    expect(result.current.queue[0].status).toBe("queued")
  })
})
