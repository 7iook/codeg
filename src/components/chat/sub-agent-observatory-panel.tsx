"use client"

/**
 * The observatory panel: the chip as popover trigger, the list body as content.
 *
 * Carrier choice (design D5): a popover anchored ON the chip, not an AuxPanel
 * tab. Three reasons, and they are about this panel specifically rather than a
 * general preference — the trigger and the result are vertically adjacent so
 * there is no eye-travel across the window; a fifth AuxPanel tab would push the
 * existing four past their `SEGMENTED_TABS_WIDTH` collapse threshold, which is a
 * net loss to an interaction that works today; and the AuxPanel is closed by
 * default and folded away in chat mode, where this panel must be usable.
 *
 * This file owns the OPEN/CLOSED cadence question (R6.5-R6.7). The chip and the
 * panel each call `useObservedSubAgents`, and the panel's instance passes
 * `panelOpen` to select the faster clock. There is no second timer: the hook is
 * the only scheduler, and the panel's instance — with its interval — unmounts
 * with the popover content, which is the stop-clock (R6.6). The chip's instance
 * keeps ticking at the closed cadence throughout, so its count never freezes
 * while the panel is shut (R6.7).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { SubAgentObservatoryChip } from "@/components/chat/sub-agent-observatory-chip"
import { SubAgentObservatoryList } from "@/components/chat/sub-agent-observatory-list"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { useSubagentTranscriptStore } from "@/contexts/subagent-transcript-context"
import { useObservedSubAgents } from "@/hooks/use-observed-sub-agents"

/** Content of the open panel. A separate component so its `useObservedSubAgents`
 *  instance — and therefore the faster tick — exists only while the popover is
 *  open, making the stop-clock structural rather than a flag someone has to
 *  remember to clear. */
function ObservatoryPanelBody({
  conversationId,
}: {
  conversationId: number | null
}) {
  const t = useTranslations("Folder.chat.subAgentObservatory")
  const store = useSubagentTranscriptStore()
  const { rows, evictedCount } = useObservedSubAgents(conversationId, {
    panelOpen: true,
  })

  return (
    <>
      <div className="px-2 text-xs font-medium text-foreground">
        {t("panelTitle")}
      </div>
      <div className="max-h-96 overflow-y-auto">
        <SubAgentObservatoryList
          rows={rows}
          evictedCount={evictedCount}
          getFrames={store.getFrames}
        />
      </div>
    </>
  )
}

export function SubAgentObservatoryPanel({
  conversationId,
}: {
  /** DB conversation id of the viewed conversation (NOT a tab id). Labels rows
   *  current-vs-other; never narrows the workspace-wide observation set. */
  conversationId: number | null
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* `PopoverAnchor`, not `PopoverTrigger asChild`: the chip is a plain
          function component that neither forwards a ref nor spreads unknown
          props, so `asChild` would hand Radix's onClick / aria-expanded / ref to
          a component that drops them — a trigger that silently does nothing.
          Anchoring instead keeps the chip's own `onActivate` as the one open
          path and its `panelOpen` as the one source of `aria-expanded`. */}
      <PopoverAnchor>
        <SubAgentObservatoryChip
          conversationId={conversationId}
          onActivate={() => setOpen((prev) => !prev)}
          panelOpen={open}
        />
      </PopoverAnchor>
      <PopoverContent
        align="center"
        data-testid="sub-agent-observatory-panel"
        className="w-96 gap-2 p-2"
      >
        <ObservatoryPanelBody conversationId={conversationId} />
      </PopoverContent>
    </Popover>
  )
}
