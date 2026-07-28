"use client"

/**
 * Read-only, in-place transcript of a Claude BUILT-IN sub-agent, rendered as a
 * section inside the parent `AgentCapsule` body (NOT a dialog, drawer or tab).
 *
 * The shape is load-bearing, not incidental: a built-in sub-agent has no
 * conversation row, no resume credential and no address of its own — in the
 * data model it IS the parent turn's one `tool_call`. A dialog shell would
 * visually promise a capability surface it does not have, which is the same
 * deception the "no input box" invariant guards against, leaking through the
 * container instead of through a button. So: the process detail of this tool
 * call, shown where the tool call already is.
 *
 * Deliberately absent, and not "later": any textarea / reply / continue / stop
 * button (codeg cannot address a built-in sub-agent at all — even a disabled
 * control would read as "conditions unmet" when the truth is "never possible"),
 * "open in tab", a sidebar row, a nested Card, and the `agentId` (the on-disk
 * rows mark it "internal ID - do not mention to user").
 */

import { memo, useMemo, useState, type ReactNode } from "react"
import { EyeIcon, ScissorsIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { MessageResponse } from "@/components/ai-elements/message"
import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import type { ContentBlock } from "@/lib/types"
import {
  buildSubagentTranscriptView,
  type SubagentFrame,
} from "@/lib/subagent-transcript"

/**
 * Messages shown without paging. Older ones stay behind a "show earlier" anchor
 * (design card E-5), which is a DIFFERENT state from truncation (E-6): one says
 * "you can load more", the other "this part is gone for good". Conflating them
 * leaves the user clicking a button that can never help.
 */
const VISIBLE_BLOCK_WINDOW = 30

type ToolCallPartShape = Extract<AdaptedContentPart, { type: "tool-call" }>

interface Props {
  frames: readonly SubagentFrame[]
  /** Injected by the parent to avoid the circular import
   *  content-parts-renderer → agent-tool-call → renderer. Same injection point
   *  the capsule already uses for its historical tool list, so a sub-agent's
   *  tool call renders exactly like one in the parent conversation. */
  renderToolCall: (part: ToolCallPartShape, key: string) => ReactNode
  /** Parent tool-call id — namespaces synthesized inline tool-call ids. */
  parentToolUseId: string
}

/** Pair each `tool_use` with the `tool_result` that answers it, so a tool
 *  renders as one card under the message that called it (rather than a
 *  detached results column, which would lose "why was this called"). */
function buildResultMap(
  blocks: readonly ContentBlock[]
): Map<string, Extract<ContentBlock, { type: "tool_result" }>> {
  const map = new Map<string, Extract<ContentBlock, { type: "tool_result" }>>()
  for (const block of blocks) {
    if (block.type !== "tool_result") continue
    if (!block.tool_use_id) continue
    map.set(block.tool_use_id, block)
  }
  return map
}

export const SubagentTranscript = memo(function SubagentTranscript({
  frames,
  renderToolCall,
  parentToolUseId,
}: Props) {
  const t = useTranslations("Folder.chat.contentParts")
  const [showAll, setShowAll] = useState(false)
  const [thinkingOpen, setThinkingOpen] = useState(false)

  const view = useMemo(() => buildSubagentTranscriptView(frames), [frames])
  const resultMap = useMemo(() => buildResultMap(view.blocks), [view.blocks])

  // Rendered blocks exclude the tool_results already folded into their
  // tool_use card; an orphan result (interrupted run) still renders on its own
  // so nothing is silently dropped.
  const renderable = useMemo(
    () =>
      view.blocks.filter(
        (block) =>
          !(
            block.type === "tool_result" &&
            block.tool_use_id &&
            resultMap.has(block.tool_use_id)
          )
      ),
    [view.blocks, resultMap]
  )

  const hiddenCount = showAll
    ? 0
    : Math.max(0, renderable.length - VISIBLE_BLOCK_WINDOW)
  const visible = hiddenCount > 0 ? renderable.slice(hiddenCount) : renderable

  const thinking = useMemo(
    () =>
      visible
        .filter((block) => block.type === "thinking")
        .map((block) => (block.type === "thinking" ? block.text : ""))
        .filter((text) => text.trim().length > 0),
    [visible]
  )

  return (
    <div className="space-y-2" data-testid="subagent-transcript">
      {/* Capability-boundary declaration. A badge, not a persistent banner:
          with five sub-agents in flight, five banners would push the very
          transcript the user opened off the first screen. */}
      <div className="flex items-center gap-2">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="secondary"
                className="gap-1 rounded-full text-[10px] font-normal"
              >
                <EyeIcon aria-hidden="true" className="size-3" />
                {t("subagentReadOnlyBadge")}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{t("subagentReadOnlyTooltip")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <span className="text-[10px] text-muted-foreground/70">
          {t("subagentTranscriptLabel")}
        </span>
      </div>

      {/* The prompt the sub-agent was launched with. */}
      {view.taskPrompt && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            {t("subagentTaskLabel")}
          </div>
          <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
            <MessageResponse>{view.taskPrompt}</MessageResponse>
          </div>
        </div>
      )}

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full border-b border-border/60 pb-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("subagentLoadEarlier", { count: hiddenCount })}
        </button>
      )}

      {/* Thinking — high volume, low signal → folded by default (P2). */}
      {thinking.length > 0 && (
        <Collapsible open={thinkingOpen} onOpenChange={setThinkingOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 transition-transform",
                thinkingOpen && "rotate-90"
              )}
            />
            {t("subagentThinkingLabel")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 text-xs text-muted-foreground prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
              <MessageResponse>{thinking.join("\n\n")}</MessageResponse>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Prose + inline tool calls, oldest first — same reading direction as
          the parent conversation. No nested card: separators and spacing only. */}
      {visible.map((block, index) => {
        const key = `${parentToolUseId}-sa-${hiddenCount + index}`
        if (block.type === "text") {
          return (
            <div
              key={key}
              className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside"
            >
              <MessageResponse>{block.text}</MessageResponse>
            </div>
          )
        }
        if (block.type === "tool_use") {
          const result = block.tool_use_id
            ? resultMap.get(block.tool_use_id)
            : undefined
          const part: ToolCallPartShape = {
            type: "tool-call",
            toolCallId: block.tool_use_id ?? key,
            toolName: block.tool_name,
            input: block.input_preview,
            state: result
              ? result.is_error
                ? "output-error"
                : "output-available"
              : "input-available",
            output: result?.output_preview ?? null,
            errorText:
              result?.is_error && result.output_preview
                ? result.output_preview
                : undefined,
            // No agentStats: a sub-agent's tool call must never re-enter the
            // Agent capsule renderer (infinite nesting).
            agentStats: undefined,
          }
          return renderToolCall(part, key)
        }
        if (block.type === "tool_result") {
          // Orphan result (no matching tool_use in the retained window).
          return (
            <div
              key={key}
              className={cn(
                "rounded-md p-2 text-xs",
                block.is_error
                  ? "bg-destructive/10 text-destructive"
                  : "bg-muted/50 text-muted-foreground"
              )}
            >
              <pre className="whitespace-pre-wrap break-words">
                {block.output_preview ?? ""}
              </pre>
            </div>
          )
        }
        return null
      })}

      {/* Data-side loss (E-6), distinct from the pageable E-5 above. */}
      {view.blocks.length === 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ScissorsIcon aria-hidden="true" className="size-3 shrink-0" />
          {t("subagentContentTruncated")}
        </div>
      )}
    </div>
  )
})
