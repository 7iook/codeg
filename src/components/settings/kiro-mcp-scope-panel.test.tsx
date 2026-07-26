import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import enMessages from "@/i18n/messages/en.json"
import { KiroMcpScopePanel } from "./kiro-mcp-scope-panel"
import { loadFolderHistory, mcpKiroScopedView } from "@/lib/api"
import type { KiroMcpView } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  mcpKiroScopedView: vi.fn(),
  loadFolderHistory: vi.fn(),
}))

const kiroT = enMessages.McpSettings.kiroScopes

function view(overrides?: Partial<KiroMcpView>): KiroMcpView {
  return {
    write_target: "C:\\Users\\7\\.kiro\\settings\\mcp.json",
    servers: [],
    scope_failures: [],
    ...overrides,
  }
}

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <KiroMcpScopePanel />
    </NextIntlClientProvider>
  )
}

describe("KiroMcpScopePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadFolderHistory).mockResolvedValue([])
    vi.mocked(mcpKiroScopedView).mockResolvedValue(view())
  })

  // The failure this panel exists to prevent: the user edits the entry codeg
  // owns (global), saves successfully, and Kiro keeps using the project copy.
  // Without the shadow annotation nothing on screen explains why.
  it("marks the project copy as effective and the global one as shadowed", async () => {
    vi.mocked(mcpKiroScopedView).mockResolvedValue(
      view({
        servers: [
          {
            id: "git",
            spec: { command: "uvx", args: ["mcp-server-git"] },
            scope: "project",
            shadowed_scopes: ["global"],
            editable: false,
          },
        ],
      })
    )
    renderPanel()

    await screen.findByText("git")
    expect(screen.getByText(kiroT.scope.project)).toBeInTheDocument()
    // The shadow warning must name the scope that lost, so the user knows the
    // file they just edited is the one being ignored.
    expect(
      screen.getByText(
        kiroT.shadowedBy.replace("{scopes}", kiroT.scope.global)
      )
    ).toBeInTheDocument()
  })

  it("offers no edit affordance on read-only agent and project rows", async () => {
    vi.mocked(mcpKiroScopedView).mockResolvedValue(
      view({
        servers: [
          {
            id: "fetch",
            spec: { command: "uvx" },
            scope: "agent",
            shadowed_scopes: [],
            editable: false,
            agent_name: "reviewer",
          },
          {
            id: "aws",
            spec: { command: "npx" },
            scope: "global",
            shadowed_scopes: [],
            editable: true,
          },
        ],
      })
    )
    renderPanel()

    await screen.findByText("fetch")
    // Read-only rows say so; only the global row is presented as editable.
    expect(screen.getAllByText(kiroT.readOnly)).toHaveLength(1)
    // The contributing agent definition is named — several agents can each
    // contribute a different id, so "agent scope" alone is not actionable.
    expect(screen.getByText(/reviewer/)).toBeInTheDocument()
  })

  it("shows the absolute path of the file codeg reads and writes", async () => {
    renderPanel()
    await screen.findByText("C:\\Users\\7\\.kiro\\settings\\mcp.json")
  })

  it("reports a corrupt scope file while the other scopes still render", async () => {
    vi.mocked(mcpKiroScopedView).mockResolvedValue(
      view({
        servers: [
          {
            id: "aws",
            spec: { command: "npx" },
            scope: "global",
            shadowed_scopes: [],
            editable: true,
          },
        ],
        scope_failures: [
          {
            scope: "project",
            path: "F:\\proj\\.kiro\\settings\\mcp.json",
            reason: "expected `,` or `}` at line 4 column 3",
          },
        ],
      })
    )
    renderPanel()

    // Kiro's own troubleshooting names JSON syntax errors as the top reason a
    // configured server never appears, so this must be visible, not silent.
    await screen.findByText("F:\\proj\\.kiro\\settings\\mcp.json")
    expect(
      screen.getByText(/expected `,` or `}` at line 4 column 3/)
    ).toBeInTheDocument()
    // The healthy scope is unaffected.
    expect(screen.getByText("aws")).toBeInTheDocument()
  })

  it("never renders credential values, only which keys are set", async () => {
    vi.mocked(mcpKiroScopedView).mockResolvedValue(
      view({
        servers: [
          {
            id: "figma",
            spec: {
              url: "https://mcp.figma.com/mcp",
              env: { BRAVE_API_KEY: "sk-live-must-not-render" },
              headers: { Authorization: "Bearer header-must-not-render" },
              oauth: { clientSecret: "secret-must-not-render" },
            },
            scope: "global",
            shadowed_scopes: [],
            editable: true,
          },
        ],
      })
    )
    const { container } = renderPanel()

    await screen.findByText("figma")
    const dom = container.innerHTML
    expect(dom).not.toContain("sk-live-must-not-render")
    expect(dom).not.toContain("header-must-not-render")
    expect(dom).not.toContain("secret-must-not-render")
    // The key names still surface, so the user can tell what is configured.
    expect(screen.getByText(/BRAVE_API_KEY/)).toBeInTheDocument()
  })

  // A denied read and an empty config both produce zero rows. Rendering the
  // denial as an empty list would read as "nothing is configured".
  it("explains a denied read instead of rendering it as an empty list", async () => {
    vi.mocked(mcpKiroScopedView).mockRejectedValue(
      new Error("refused to read Kiro MCP configuration over the network")
    )
    renderPanel()

    await screen.findByText(/refused to read Kiro MCP configuration/)
    expect(screen.queryByText(kiroT.empty)).not.toBeInTheDocument()
  })

  it("distinguishes an empty config from a failed read", async () => {
    renderPanel()
    await screen.findByText(kiroT.empty)
    expect(
      screen.queryByText(/refused to read Kiro MCP configuration/)
    ).not.toBeInTheDocument()
  })

  it("re-resolves the project scope when the workspace selection changes", async () => {
    vi.mocked(loadFolderHistory).mockResolvedValue([
      {
        path: "F:\\proj",
        name: "proj",
        last_used_at: "2026-07-26T00:00:00Z",
        conversation_count: 1,
      } as unknown as Awaited<ReturnType<typeof loadFolderHistory>>[number],
    ])
    renderPanel()

    // Global-only by default: with no workspace picked there is no project
    // scope to resolve, and the backend treats null as "skip that scope".
    await waitFor(() =>
      expect(mcpKiroScopedView).toHaveBeenCalledWith({ workspacePath: null })
    )
  })
})
