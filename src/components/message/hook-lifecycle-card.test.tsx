import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { HookLifecycleCard } from "./hook-lifecycle-card"
import enMessages from "@/i18n/messages/en.json"
import type { HookLifecyclePayload } from "@/lib/types"

function renderCard(data: HookLifecyclePayload) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HookLifecycleCard data={data} />
    </NextIntlClientProvider>
  )
}

function base(overrides: Partial<HookLifecyclePayload>): HookLifecyclePayload {
  return {
    hook_name: "Stop",
    hook_event: "Stop",
    outcome: "pass",
    exit_code: 0,
    duration_ms: 120,
    timestamp: "2026-08-07T10:11:03.440Z",
    ...overrides,
  }
}

describe("HookLifecycleCard — four outcome states", () => {
  // pass: de-emphasized single line, no full card chrome.
  it("renders pass as a minimal line", () => {
    renderCard(base({ outcome: "pass" }))
    const card = screen.getByTestId("hook-lifecycle-card")
    expect(card).toHaveAttribute("data-outcome", "pass")
    // The minimal line carries no outcome badge / exit-code row.
    expect(screen.queryByTestId("hook-outcome-badge")).not.toBeInTheDocument()
    expect(screen.queryByTestId("hook-exit-code")).not.toBeInTheDocument()
  })

  // soft_context: the sampled real wire (w1-report §二) — a normal card that
  // surfaces the additionalContext fed to Claude.
  it("renders soft_context with its additional context", () => {
    renderCard(
      base({
        outcome: "soft_context",
        additional_context: ["[P1 stop-gate] cleanup still pending"],
      })
    )
    expect(screen.getByTestId("hook-lifecycle-card")).toHaveAttribute(
      "data-outcome",
      "soft_context"
    )
    expect(screen.getByTestId("hook-outcome-badge")).toHaveTextContent(
      "Context added"
    )
    expect(screen.getByTestId("hook-additional-context")).toHaveTextContent(
      "[P1 stop-gate] cleanup still pending"
    )
  })

  // hard_block: destructive framing + "Blocked" badge + reason highlighted.
  it("renders hard_block with a blocked badge and highlighted reason", () => {
    renderCard(
      base({
        outcome: "hard_block",
        exit_code: 2,
        outcome_reason: "Push to main is not allowed",
      })
    )
    const card = screen.getByTestId("hook-lifecycle-card")
    expect(card).toHaveAttribute("data-outcome", "hard_block")
    expect(screen.getByTestId("hook-outcome-badge")).toHaveTextContent(
      "Blocked"
    )
    expect(screen.getByTestId("hook-outcome-reason")).toHaveTextContent(
      "Push to main is not allowed"
    )
  })

  // error: an error badge, distinct from a block, so "the hook script failed"
  // reads differently from "the hook blocked me".
  it("renders error distinctly from a block", () => {
    renderCard(
      base({
        outcome: "error",
        exit_code: 1,
        outcome_reason: "script crashed: missing module",
      })
    )
    const card = screen.getByTestId("hook-lifecycle-card")
    expect(card).toHaveAttribute("data-outcome", "error")
    expect(screen.getByTestId("hook-outcome-badge")).toHaveTextContent("Error")
    // NOT the block label — the two must be visually distinguishable.
    expect(screen.getByTestId("hook-outcome-badge")).not.toHaveTextContent(
      "Blocked"
    )
  })
})

describe("HookLifecycleCard — content handling", () => {
  // §3.1: the backend truncates each additional_context entry to 4KB and
  // appends "…truncated". The frontend just renders whatever it gets — verify
  // a truncated marker survives intact (no double-processing / clipping).
  it("renders a backend-truncated additional_context entry verbatim", () => {
    const truncated = "x".repeat(80) + "…truncated"
    renderCard(
      base({
        outcome: "soft_context",
        additional_context: [truncated],
      })
    )
    expect(screen.getByTestId("hook-additional-context")).toHaveTextContent(
      "…truncated"
    )
  })

  it("renders multiple additional_context entries", () => {
    renderCard(
      base({
        outcome: "soft_context",
        additional_context: ["first note", "second note"],
      })
    )
    const ctx = screen.getByTestId("hook-additional-context")
    expect(ctx).toHaveTextContent("first note")
    expect(ctx).toHaveTextContent("second note")
  })

  // Every optional field absent (command_display / outcome_reason /
  // additional_context / hook_specific_output all missing) must not crash and
  // must not render their sections.
  it("does not crash when all optional fields are absent", () => {
    renderCard(base({ outcome: "hard_block", exit_code: 2 }))
    expect(screen.getByTestId("hook-lifecycle-card")).toBeInTheDocument()
    expect(screen.queryByTestId("hook-outcome-reason")).not.toBeInTheDocument()
    expect(
      screen.queryByTestId("hook-additional-context")
    ).not.toBeInTheDocument()
    // No details section without command_display or hook_specific_output.
    expect(screen.queryByTestId("hook-command-display")).not.toBeInTheDocument()
  })

  // The details section appears only when there is something to fold into it.
  // radix Collapsible keeps its content UNMOUNTED while closed, so the trigger
  // is present but the command is revealed only after expanding.
  it("reveals command_display after expanding the details section", () => {
    renderCard(
      base({
        outcome: "soft_context",
        command_display: "claude-stop-orchestrator.ps1",
      })
    )
    const toggle = screen.getByText("Details")
    expect(screen.queryByTestId("hook-command-display")).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.getByTestId("hook-command-display")).toHaveTextContent(
      "claude-stop-orchestrator.ps1"
    )
  })
})
