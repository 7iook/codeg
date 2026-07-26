import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  buildKiroEnv,
  inferKiroEffort,
  inferKiroTrustMode,
  KiroConfigPanel,
} from "./kiro-config-panel"
import { acpListKiroCustomAgents } from "@/lib/api"
import type { AcpAgentInfo } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

vi.mock("@/lib/api", () => ({
  acpListKiroCustomAgents: vi.fn(),
}))

describe("buildKiroEnv", () => {
  it("writes every knob it is given and leaves unrelated keys alone", () => {
    const env = buildKiroEnv(
      { OTHER: "x" },
      {
        apiKey: "  kiro-key  ",
        model: " claude-opus-5 ",
        effort: "xhigh",
        trustMode: "tools",
        trustTools: " fs_read , execute_bash ,",
        agentId: "reviewer",
      }
    )
    expect(env).toEqual({
      OTHER: "x",
      KIRO_API_KEY: "kiro-key",
      KIRO_MODEL: "claude-opus-5",
      KIRO_EFFORT: "xhigh",
      KIRO_TRUST_MODE: "tools",
      // Normalized here so the launch path never sees a blank tool name.
      KIRO_TRUST_TOOLS: "fs_read,execute_bash",
      KIRO_AGENT: "reviewer",
    })
  })

  it("removes a cleared key instead of writing a blank one (R7.3.1)", () => {
    // An empty string in env_json would still be injected; the key has to go.
    const env = buildKiroEnv(
      {
        KIRO_API_KEY: "old",
        KIRO_MODEL: "auto",
        KIRO_EFFORT: "max",
        KIRO_AGENT: "old-agent",
        KEEP: "y",
      },
      {
        apiKey: "   ",
        model: "",
        effort: "",
        trustMode: "",
        trustTools: "",
        agentId: "",
      }
    )
    expect(env).toEqual({ KEEP: "y" })
  })

  it("drops a stale tool list when trust mode is not per-tool", () => {
    const env = buildKiroEnv(
      { KIRO_TRUST_TOOLS: "execute_bash" },
      {
        apiKey: "",
        model: "",
        effort: "",
        trustMode: "all",
        trustTools: "execute_bash",
        agentId: "",
      }
    )
    expect(env).toEqual({ KIRO_TRUST_MODE: "all" })
  })

  it("keeps per-tool mode but omits --trust-tools when the list is blank", () => {
    const env = buildKiroEnv(
      {},
      {
        apiKey: "",
        model: "",
        effort: "",
        trustMode: "tools",
        trustTools: " , ,",
        agentId: "",
      }
    )
    expect(env).toEqual({ KIRO_TRUST_MODE: "tools" })
  })
})

describe("inferKiroEffort", () => {
  it("accepts the five CLI levels in any case and rejects the rest", () => {
    expect(inferKiroEffort({ KIRO_EFFORT: "low" })).toBe("low")
    expect(inferKiroEffort({ KIRO_EFFORT: " XHIGH " })).toBe("xhigh")
    // A hand-edited value the CLI would reject shows as unset, not as-is.
    expect(inferKiroEffort({ KIRO_EFFORT: "turbo" })).toBe("")
    expect(inferKiroEffort({})).toBe("")
  })
})

describe("inferKiroTrustMode", () => {
  it("falls back to unset rather than granting an unpicked authorization", () => {
    expect(inferKiroTrustMode({ KIRO_TRUST_MODE: "all" })).toBe("all")
    expect(inferKiroTrustMode({ KIRO_TRUST_MODE: "TOOLS" })).toBe("tools")
    expect(inferKiroTrustMode({ KIRO_TRUST_MODE: "bypassPermissions" })).toBe(
      ""
    )
    expect(inferKiroTrustMode({})).toBe("")
  })
})

describe("KiroConfigPanel", () => {
  const baseAgent = {
    agent_type: "kiro",
    enabled: true,
    env: {} as Record<string, string>,
  }

  function renderPanel(overrides?: {
    env?: Record<string, string>
    onSaveEnv?: ReturnType<typeof vi.fn>
    onSaved?: ReturnType<typeof vi.fn>
  }) {
    const onSaveEnv = overrides?.onSaveEnv ?? vi.fn().mockResolvedValue(0)
    const onSaved = overrides?.onSaved ?? vi.fn()
    const agent = {
      ...baseAgent,
      env: overrides?.env ?? baseAgent.env,
    } as unknown as AcpAgentInfo
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <KiroConfigPanel
          agent={agent}
          saving={false}
          onSaveEnv={onSaveEnv}
          onSaved={onSaved}
        />
      </NextIntlClientProvider>
    )
    return { onSaveEnv, onSaved }
  }

  const saveButton = () =>
    screen.getByRole("button", {
      name: enMessages.AcpAgentSettings.kiro.saveConfig,
    })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(acpListKiroCustomAgents).mockResolvedValue([])
  })

  it("shows a stored API key in plaintext and states the login precedence", async () => {
    renderPanel({ env: { KIRO_API_KEY: "stored-secret" } })
    await waitFor(() => expect(acpListKiroCustomAgents).toHaveBeenCalled())

    const input = screen.getByPlaceholderText(
      enMessages.AcpAgentSettings.kiro.apiKeyPlaceholder
    )
    // No masking, and the real value on screen (not a placeholder stand-in).
    expect(input).toHaveAttribute("type", "text")
    expect(input).toHaveValue("stored-secret")
    screen.getByText(enMessages.AcpAgentSettings.kiro.loginPrecedenceHint)
  })

  it("passes an arbitrary model ID through verbatim (R6.1.2)", async () => {
    const { onSaveEnv, onSaved } = renderPanel({ env: {} })
    await waitFor(() => expect(acpListKiroCustomAgents).toHaveBeenCalled())

    fireEvent.change(
      screen.getByPlaceholderText(
        enMessages.AcpAgentSettings.kiro.modelPlaceholder
      ),
      { target: { value: "some-unreleased-model-2027" } }
    )
    fireEvent.click(saveButton())

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(onSaveEnv.mock.calls[0][0]).toEqual({
      KIRO_MODEL: "some-unreleased-model-2027",
    })
    expect(onSaveEnv.mock.calls[0][1]).toBe(true)
  })

  it("clearing the API key removes it from the saved env", async () => {
    const { onSaveEnv, onSaved } = renderPanel({
      env: { KIRO_API_KEY: "old-key", KIRO_MODEL: "auto" },
    })
    await waitFor(() => expect(acpListKiroCustomAgents).toHaveBeenCalled())

    fireEvent.change(
      screen.getByPlaceholderText(
        enMessages.AcpAgentSettings.kiro.apiKeyPlaceholder
      ),
      { target: { value: "" } }
    )
    fireEvent.click(saveButton())

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(onSaveEnv.mock.calls[0][0]).toEqual({ KIRO_MODEL: "auto" })
  })

  it("only offers the tool list in per-tool trust mode, and warns while it is empty", async () => {
    renderPanel({ env: { KIRO_TRUST_MODE: "tools" } })
    await waitFor(() => expect(acpListKiroCustomAgents).toHaveBeenCalled())

    screen.getByText(enMessages.AcpAgentSettings.kiro.trustToolsEmptyWarning)
    fireEvent.change(screen.getByPlaceholderText("fs_read,execute_bash"), {
      target: { value: "fs_read" },
    })
    screen.getByText(enMessages.AcpAgentSettings.kiro.trustToolsHint)
  })

  it("hides the tool list when trust mode is unset", async () => {
    renderPanel({ env: {} })
    await waitFor(() => expect(acpListKiroCustomAgents).toHaveBeenCalled())
    expect(screen.queryByPlaceholderText("fs_read,execute_bash")).toBeNull()
  })

  it("an empty custom-agent list is normal and does not break the panel (R6.9)", async () => {
    const { onSaveEnv, onSaved } = renderPanel({ env: {} })
    await screen.findByText(enMessages.AcpAgentSettings.kiro.customAgentEmpty)
    // Still fully usable: the save path works with no agents on disk.
    fireEvent.click(saveButton())
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(onSaveEnv.mock.calls[0][0]).toEqual({})
  })

  it("a transport failure while listing agents leaves the rest of the panel usable", async () => {
    vi.mocked(acpListKiroCustomAgents).mockRejectedValue(new Error("offline"))
    renderPanel({ env: { KIRO_API_KEY: "k" } })
    await screen.findByText(enMessages.AcpAgentSettings.kiro.customAgentEmpty)
    expect(
      screen.getByPlaceholderText(
        enMessages.AcpAgentSettings.kiro.apiKeyPlaceholder
      )
    ).toHaveValue("k")
  })

  it("flags a saved agent that no longer exists on disk (R6.5.4)", async () => {
    vi.mocked(acpListKiroCustomAgents).mockResolvedValue([
      { id: "reviewer", description: "Reads diffs" },
    ])
    const { onSaveEnv, onSaved } = renderPanel({
      env: { KIRO_AGENT: "deleted-agent" },
    })
    await screen.findByText(
      /deleted-agent.*no longer under `KIRO_HOME`\/agents/
    )

    // The selection is not silently dropped by saving an unrelated knob.
    fireEvent.click(saveButton())
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(onSaveEnv.mock.calls[0][0]).toEqual({ KIRO_AGENT: "deleted-agent" })
  })

  it("does not flag a saved agent that is present in the scan", async () => {
    vi.mocked(acpListKiroCustomAgents).mockResolvedValue([
      { id: "reviewer", description: null },
    ])
    renderPanel({ env: { KIRO_AGENT: "reviewer" } })
    await waitFor(() => expect(acpListKiroCustomAgents).toHaveBeenCalled())
    await waitFor(() =>
      expect(
        screen.queryByText(enMessages.AcpAgentSettings.kiro.customAgentEmpty)
      ).toBeNull()
    )
    expect(screen.queryByText(/no longer under `KIRO_HOME`\/agents/)).toBeNull()
  })

  it("surfaces a save failure without reporting success", async () => {
    const onSaveEnv = vi.fn().mockRejectedValue(new Error("db locked"))
    const onSaved = vi.fn()
    renderPanel({ env: {}, onSaveEnv, onSaved })
    await waitFor(() => expect(acpListKiroCustomAgents).toHaveBeenCalled())

    fireEvent.click(saveButton())
    await waitFor(() => expect(onSaveEnv).toHaveBeenCalledTimes(1))
    expect(onSaved).not.toHaveBeenCalled()
  })
})
