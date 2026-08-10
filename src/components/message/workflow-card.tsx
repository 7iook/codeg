"use client"

/**
 * Renders one Claude Code Dynamic Workflow snapshot (`workflow-progress`
 * content part) as a phase / agent folded card — decision-card §5.1 depth B.
 *
 * The backend (`parsers/claude/workflow.rs`) already reduced the cumulative
 * `workflow_progress[]` to its latest full state (recon R7), so this component
 * only DISPLAYS: it groups the flat node array into phases (each
 * `workflow_phase` opens a group; the `workflow_agent` nodes after it belong to
 * it), and folds each phase's agents behind a `Collapsible`. It accumulates
 * nothing across renders — a newer snapshot replaces the whole part.
 *
 * Visual language deliberately echoes `sub-agent-observatory-list.tsx`: agent
 * icon in a circle, bold label, `#id` in monospace, a status badge — the panel
 * and this inline card describe the same kind of object (a fan-out of agents),
 * and two visual treatments would read as two features.
 */

import { useMemo, useState } from "react"
import { Bot, ChevronRight, Layers, Workflow } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type {
  WorkflowProgressNode,
  WorkflowRunPayload,
  WorkflowStatus,
} from "@/lib/types"

/** A phase and the agents that fall under it in the flat progress array. */
interface PhaseGroup {
  /** `null` for agents that appear before any `workflow_phase` node. */
  phase: Extract<WorkflowProgressNode, { type: "workflow_phase" }> | null
  agents: Extract<WorkflowProgressNode, { type: "workflow_agent" }>[]
}

/**
 * Fold the flat `workflow_progress[]` into ordered phase groups. A
 * `workflow_phase` node opens a new group; every `workflow_agent` after it
 * (until the next phase) belongs to it. Agents before the first phase land in
 * a leading `phase: null` group so nothing is dropped.
 */
function groupProgress(nodes: readonly WorkflowProgressNode[]): PhaseGroup[] {
  const groups: PhaseGroup[] = []
  let current: PhaseGroup | null = null
  for (const node of nodes) {
    if (node.type === "workflow_phase") {
      current = { phase: node, agents: [] }
      groups.push(current)
    } else {
      if (!current) {
        current = { phase: null, agents: [] }
        groups.push(current)
      }
      current.agents.push(node)
    }
  }
  return groups
}

/** Map the workflow status to the badge tone. Completed is the only "success"
 *  tone; failed / killed are destructive; the rest are neutral/among-progress. */
function statusVariant(
  status: WorkflowStatus
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "completed":
      return "default"
    case "failed":
    case "killed":
      return "destructive"
    case "running":
    case "started":
      return "secondary"
    default:
      return "outline"
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m${s.toString().padStart(2, "0")}s`
}

function AgentRow({
  agent,
}: {
  agent: Extract<WorkflowProgressNode, { type: "workflow_agent" }>
}) {
  const t = useTranslations("Folder.chat.workflowCard")
  return (
    <div
      data-testid="workflow-agent-row"
      className="flex items-start gap-2 rounded-md border border-border/50 px-2 py-1.5"
    >
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-background">
        <Bot className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            #{agent.index}
          </span>
          {agent.state && (
            <Badge
              variant="outline"
              className="shrink-0 rounded-full text-[11px]"
              data-testid="workflow-agent-state"
            >
              {agent.state}
            </Badge>
          )}
          {typeof agent.tool_calls === "number" && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {t("toolCalls", { count: agent.tool_calls })}
            </span>
          )}
        </div>
        {agent.prompt && (
          <div className="truncate text-[11px] text-muted-foreground">
            {agent.prompt}
          </div>
        )}
      </div>
    </div>
  )
}

function PhaseSection({ group, index }: { group: PhaseGroup; index: number }) {
  const t = useTranslations("Folder.chat.workflowCard")
  const [open, setOpen] = useState(true)
  const phaseName = group.phase?.name ?? t("defaultPhase", { index: index + 1 })
  const agentCount = group.phase?.agent_count ?? group.agents.length

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid="workflow-phase"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60">
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        <Layers
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          {phaseName}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {t("agentCount", { count: agentCount })}
        </span>
        {typeof group.phase?.elapsed_ms === "number" && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {formatDuration(group.phase.elapsed_ms)}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 space-y-1 pl-6">
        {group.agents.length > 0 ? (
          group.agents.map((agent, i) => (
            <AgentRow key={`agent-${agent.index}-${i}`} agent={agent} />
          ))
        ) : (
          <p className="px-2 py-1 text-[11px] text-muted-foreground/80">
            {t("noAgents")}
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function WorkflowCard({ data }: { data: WorkflowRunPayload }) {
  const t = useTranslations("Folder.chat.workflowCard")
  const groups = useMemo(
    () => groupProgress(data.workflow_progress ?? []),
    [data.workflow_progress]
  )
  const totalTokens = data.usage?.total_tokens ?? 0
  const durationMs = data.usage?.duration_ms ?? 0

  return (
    <div
      data-testid="workflow-card"
      className="w-full space-y-2 rounded-lg border border-border/60 bg-background/40 p-3"
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background">
          <Workflow
            className="h-3.5 w-3.5 text-muted-foreground"
            aria-hidden="true"
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {data.workflow_name ?? t("untitledWorkflow")}
        </span>
        <span
          className="shrink-0 font-mono text-[11px] text-muted-foreground"
          title={data.task_id}
        >
          #{data.task_id.slice(0, 8)}
        </span>
        <Badge
          variant={statusVariant(data.status)}
          className="shrink-0 rounded-full text-[11px]"
          data-testid="workflow-status"
        >
          {t(`status.${data.status}`)}
        </Badge>
      </div>

      {(totalTokens > 0 || durationMs > 0) && (
        <div
          data-testid="workflow-usage"
          className="flex items-center gap-3 px-1 text-[11px] text-muted-foreground"
        >
          {totalTokens > 0 && (
            <span>{t("totalTokens", { count: totalTokens })}</span>
          )}
          {durationMs > 0 && <span>{formatDuration(durationMs)}</span>}
        </div>
      )}

      {groups.length > 0 ? (
        <div className="space-y-1">
          {groups.map((group, i) => (
            <PhaseSection key={`phase-${i}`} group={group} index={i} />
          ))}
        </div>
      ) : (
        <p
          data-testid="workflow-empty"
          className="px-2 py-1 text-[11px] text-muted-foreground/80"
        >
          {t("noProgress")}
        </p>
      )}
    </div>
  )
}
