import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { PersonaLabel, RequestedPersonaNote } from "./persona-label"
import type { AppliedPersona } from "@/lib/delegation-card"
import enMessages from "@/i18n/messages/en.json"

function renderLabel(persona: AppliedPersona | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PersonaLabel persona={persona} />
    </NextIntlClientProvider>
  )
}

function renderRequested(requestedPersona: string | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RequestedPersonaNote requestedPersona={requestedPersona} />
    </NextIntlClientProvider>
  )
}

describe("PersonaLabel", () => {
  it("renders a native persona as the primary label", () => {
    renderLabel({ kind: "native", name: "plan-reality-recon" })
    const el = screen.getByTestId("delegation-persona-label")
    expect(el).toHaveTextContent("· @plan-reality-recon")
    expect(el).not.toHaveTextContent("best-effort")
    expect(el.dataset.personaKind).toBe("native")
  })

  it("marks a hint persona best-effort", () => {
    renderLabel({ kind: "hint", name: "code-reviewer" })
    const el = screen.getByTestId("delegation-persona-label")
    expect(el).toHaveTextContent("· @code-reviewer (best-effort)")
    expect(el.dataset.personaKind).toBe("hint")
  })

  it("marks an ignored persona as unsupported by the CLI", () => {
    renderLabel({ kind: "ignored_unsupported_cli", name: "executor" })
    const el = screen.getByTestId("delegation-persona-label")
    expect(el).toHaveTextContent("· @executor (ignored — CLI unsupported)")
    expect(el.dataset.personaKind).toBe("ignored_unsupported_cli")
  })

  /**
   * Requirement 5.5 / R2-A4: with no effective persona the card shows NO
   * secondary label. It must not reach for `raw_input.subagent_type` — that is
   * the request, and a request may have been rejected or silently dropped.
   * `PersonaLabel` is structurally incapable of it (it receives no request), and
   * this pins the "renders nothing" half.
   */
  it("renders nothing when no persona took effect", () => {
    renderLabel(null)
    expect(screen.queryByTestId("delegation-persona-label")).toBeNull()
    expect(screen.queryByText(/@/)).toBeNull()
  })

  it("keeps the untruncated name reachable via the title attribute", () => {
    const long = "a".repeat(40)
    renderLabel({ kind: "native", name: long })
    const el = screen.getByTestId("delegation-persona-label")
    expect(el).toHaveTextContent(`· @${"a".repeat(32)}…`)
    // Full value for hover tooltip / copy (Requirement 5.6).
    expect(el).toHaveAttribute("title", `@${long}`)
  })

  it("truncates a CJK name at 32 graphemes, not 32 UTF-16 units", () => {
    const long = "计".repeat(40)
    renderLabel({ kind: "ignored_unsupported_cli", name: long })
    const el = screen.getByTestId("delegation-persona-label")
    expect(el.textContent).toContain("计".repeat(32) + "…")
    expect(el.textContent).not.toContain("计".repeat(33))
  })
})

describe("RequestedPersonaNote", () => {
  it("names the nominated persona on a failure card", () => {
    renderRequested("plan-reality-recon")
    expect(
      screen.getByTestId("delegation-requested-persona")
    ).toHaveTextContent("requested: @plan-reality-recon")
  })

  it("renders nothing without a nominated persona", () => {
    renderRequested(null)
    expect(screen.queryByTestId("delegation-requested-persona")).toBeNull()
  })

  it("truncates a long nominated name but keeps the full value in the title", () => {
    const long = "🤖".repeat(40)
    renderRequested(long)
    const el = screen.getByTestId("delegation-requested-persona")
    expect(el.textContent).toContain("🤖".repeat(32) + "…")
    expect(el).toHaveAttribute("title", `@${long}`)
  })
})
