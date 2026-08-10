import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { WorkflowCard } from "./workflow-card"
import enMessages from "@/i18n/messages/en.json"
import type { WorkflowRunPayload } from "@/lib/types"

function renderCard(data: WorkflowRunPayload) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkflowCard data={data} />
    </NextIntlClientProvider>
  )
}

const baseCompleted: WorkflowRunPayload = {
  task_id: "wbk63ch2d",
  workflow_name: "demo-workflow",
  task_type: "local_workflow",
  status: "completed",
  workflow_progress: [
    { type: "workflow_phase", name: "Scan", agent_count: 2 },
    { type: "workflow_agent", index: 1, state: "success" },
    { type: "workflow_agent", index: 2, state: "success", tool_calls: 3 },
    { type: "workflow_phase", name: "Fix", agent_count: 1 },
    { type: "workflow_agent", index: 3, state: "running" },
  ],
  output_file: "/tmp/out.md",
  usage: { total_tokens: 9000, duration_ms: 5280 },
}

describe("WorkflowCard", () => {
  // decision-card §4.2 test 8: phase / agent folded list.
  it("renders the workflow name, task id and a folded phase/agent list", () => {
    renderCard(baseCompleted)

    expect(screen.getByTestId("workflow-card")).toBeInTheDocument()
    expect(screen.getByText("demo-workflow")).toBeInTheDocument()
    // Short task-id prefix (`#` + first 8 chars of "wbk63ch2d").
    expect(screen.getByText("#wbk63ch2")).toBeInTheDocument()

    // Two phases, each its own foldable section.
    const phases = screen.getAllByTestId("workflow-phase")
    expect(phases).toHaveLength(2)
    expect(screen.getByText("Scan")).toBeInTheDocument()
    expect(screen.getByText("Fix")).toBeInTheDocument()

    // All three agents render (phases default open).
    const agents = screen.getAllByTestId("workflow-agent-row")
    expect(agents).toHaveLength(3)
    expect(screen.getByText("#1")).toBeInTheDocument()
    expect(screen.getByText("#2")).toBeInTheDocument()
    expect(screen.getByText("#3")).toBeInTheDocument()
  })

  it("shows the completed status label", () => {
    renderCard(baseCompleted)
    const badge = screen.getByTestId("workflow-status")
    expect(badge).toHaveTextContent("Completed")
  })

  it("shows the running status label", () => {
    renderCard({
      ...baseCompleted,
      status: "running",
      usage: null,
    })
    expect(screen.getByTestId("workflow-status")).toHaveTextContent("Running")
  })

  it("shows the failed status label", () => {
    renderCard({ ...baseCompleted, status: "failed" })
    expect(screen.getByTestId("workflow-status")).toHaveTextContent("Failed")
  })

  // recon R7: workflow_progress is cumulative — a newer snapshot REPLACES the
  // list wholesale. Re-rendering with a fuller snapshot must show exactly the
  // new agents, never the union of old + new.
  it("replaces the progress list on re-render, never appends", () => {
    const { rerender } = renderCard({
      ...baseCompleted,
      status: "running",
      workflow_progress: [
        { type: "workflow_phase", name: "Scan", agent_count: 1 },
        { type: "workflow_agent", index: 1, state: "running" },
      ],
      usage: null,
    })
    expect(screen.getAllByTestId("workflow-agent-row")).toHaveLength(1)

    // A later cumulative snapshot carries the FULL current state (2 agents).
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <WorkflowCard
          data={{
            ...baseCompleted,
            status: "running",
            workflow_progress: [
              { type: "workflow_phase", name: "Scan", agent_count: 2 },
              { type: "workflow_agent", index: 1, state: "success" },
              { type: "workflow_agent", index: 2, state: "running" },
            ],
            usage: null,
          }}
        />
      </NextIntlClientProvider>
    )
    // Exactly 2 — the replacement, not 3 (1 old + 2 new appended).
    expect(screen.getAllByTestId("workflow-agent-row")).toHaveLength(2)
  })

  it("renders an empty-state when there is no progress", () => {
    renderCard({
      task_id: "empty1",
      task_type: "local_workflow",
      status: "started",
      workflow_progress: [],
    })
    expect(screen.getByTestId("workflow-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("workflow-phase")).not.toBeInTheDocument()
  })

  // Agents that appear before any phase node still render (leading null group).
  it("renders agents that precede the first phase node", () => {
    renderCard({
      task_id: "nophase",
      task_type: "local_workflow",
      status: "running",
      workflow_progress: [
        { type: "workflow_agent", index: 1, state: "running" },
      ],
    })
    expect(screen.getByTestId("workflow-phase")).toBeInTheDocument()
    expect(screen.getAllByTestId("workflow-agent-row")).toHaveLength(1)
  })
})
