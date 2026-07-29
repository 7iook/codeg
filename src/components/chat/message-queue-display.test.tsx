import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import { MessageQueueDisplay } from "./message-queue-display"
import enMessages from "@/i18n/messages/en.json"
import type { QueuedMessage } from "@/hooks/use-message-queue"
import type { QueueItemStatus } from "@/lib/steering-queue"

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function item(
  id: string,
  text: string,
  status: QueueItemStatus = "queued"
): QueuedMessage {
  return {
    id,
    draft: { blocks: [{ type: "text", text }], displayText: text },
    modeId: null,
    messageId: `mid-${id}`,
    status,
  }
}

function renderQueue(
  queue: QueuedMessage[],
  opts: {
    supportsSteering?: boolean | undefined
    onSendNow?: (id: string) => void
    onDelete?: (id: string) => void
    onEdit?: (id: string) => void
  } = {}
) {
  return renderWithIntl(
    <MessageQueueDisplay
      queue={queue}
      onReorder={() => {}}
      onEdit={opts.onEdit ?? (() => {})}
      onDelete={opts.onDelete ?? (() => {})}
      editingItemId={null}
      supportsSteering={opts.supportsSteering}
      onSendNow={opts.onSendNow}
    />
  )
}

describe("MessageQueueDisplay — capability three-state gates 'send now' (R2.2)", () => {
  it("renders the action when steering is confirmed supported", () => {
    renderQueue([item("a", "look at auth first")], {
      supportsSteering: true,
      onSendNow: () => {},
    })
    expect(screen.getByLabelText("Send now")).toBeInTheDocument()
  })

  it("does NOT render the action when steering is confirmed unsupported", () => {
    renderQueue([item("a", "look at auth first")], {
      supportsSteering: false,
      onSendNow: () => {},
    })
    expect(screen.queryByLabelText("Send now")).not.toBeInTheDocument()
  })

  it("does NOT render the action when the capability is unknown", () => {
    // The conservative default: `undefined` means the probe hasn't answered, and
    // offering the action would promise an interruption we can't guarantee.
    renderQueue([item("a", "look at auth first")], {
      supportsSteering: undefined,
      onSendNow: () => {},
    })
    expect(screen.queryByLabelText("Send now")).not.toBeInTheDocument()
  })

  it("shows the timing so a queued message never looks dropped (R3.2)", () => {
    // Zed #48175: an invisible queue makes users conclude the message was lost.
    renderQueue([item("a", "later")], { supportsSteering: false })
    expect(screen.getByText("will send after this turn")).toBeInTheDocument()
  })

  it("still shows the timing under unsupported/unknown, with no error text", () => {
    renderQueue([item("a", "later")], { supportsSteering: undefined })
    expect(screen.getByText("will send after this turn")).toBeInTheDocument()
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument()
  })

  it("names the interruption consequence in the action's tooltip (R1.3)", () => {
    renderQueue([item("a", "now please")], {
      supportsSteering: true,
      onSendNow: () => {},
    })
    expect(screen.getByLabelText("Send now")).toHaveAttribute(
      "title",
      "Send now — interrupts the current output"
    )
  })
})

describe("MessageQueueDisplay — per-item status rendering", () => {
  it("offers NO 'send now' on an in_flight item (no double dequeue)", () => {
    renderQueue([item("a", "already going", "in_flight")], {
      supportsSteering: true,
      onSendNow: () => {},
    })
    expect(screen.queryByLabelText("Send now")).not.toBeInTheDocument()
    expect(screen.getByText("sending...")).toBeInTheDocument()
  })

  it("describes an unknown outcome as neither sent nor failed", () => {
    // Both would assert a fact we don't have: no response came back, so the
    // message may or may not have been accepted.
    renderQueue([item("a", "unclear", "unknown")], {
      supportsSteering: true,
      onSendNow: () => {},
    })
    const label = screen.getByText("delivery result unknown")
    expect(label).toBeInTheDocument()
    expect(screen.queryByText(/^sent$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument()
  })

  it("offers an explicit resend (not the ordinary action) on an unknown item", () => {
    renderQueue([item("a", "unclear", "unknown")], {
      supportsSteering: true,
      onSendNow: () => {},
    })
    expect(screen.getByLabelText("Send again")).toBeInTheDocument()
    expect(screen.queryByLabelText("Send now")).not.toBeInTheDocument()
  })

  it("renders a mixed queue with each item's own state", () => {
    renderQueue(
      [
        item("a", "first", "in_flight"),
        item("b", "second"),
        item("c", "third", "unknown"),
      ],
      { supportsSteering: true, onSendNow: () => {} }
    )
    expect(screen.getByText("sending...")).toBeInTheDocument()
    expect(screen.getByText("will send after this turn")).toBeInTheDocument()
    expect(screen.getByText("delivery result unknown")).toBeInTheDocument()
    // Exactly one item is claimable, so exactly one ordinary action shows.
    expect(screen.getAllByLabelText("Send now")).toHaveLength(1)
  })
})

describe("MessageQueueDisplay — preserved item actions with the status field", () => {
  it("keeps edit and delete working on an item carrying a non-queued status", () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    renderQueue([item("a", "x", "unknown")], {
      supportsSteering: true,
      onSendNow: () => {},
      onEdit,
      onDelete,
    })
    expect(screen.getByTitle("Edit")).toBeInTheDocument()
    expect(screen.getByTitle("Remove")).toBeInTheDocument()
  })

  it("passes the clicked item's id to onSendNow", async () => {
    const onSendNow = vi.fn()
    renderQueue([item("a", "first"), item("b", "second")], {
      supportsSteering: true,
      onSendNow,
    })
    await userEvent.click(screen.getAllByLabelText("Send now")[1])
    expect(onSendNow).toHaveBeenCalledWith("b")
  })

  it("renders nothing at all for an empty queue", () => {
    const { container } = renderQueue([])
    expect(container.firstChild).toBeNull()
  })
})
