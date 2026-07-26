"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2, RefreshCw, Save, ShieldCheck } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { acpListKiroCustomAgents } from "@/lib/api"
import type { AcpAgentInfo, KiroCustomAgent } from "@/lib/types"

/** The API key Kiro's CLI reads. Injected verbatim into the child process. */
const KIRO_API_KEY_ENV = "KIRO_API_KEY"
/** codeg-side launch knobs. These are NOT env vars kiro-cli reads: the launch
 * path (`kiro_launch_args` in src-tauri/src/acp/connection.rs) turns them into
 * `kiro-cli acp` flags and strips them from the child's environment. */
const KIRO_MODEL_ENV = "KIRO_MODEL"
const KIRO_EFFORT_ENV = "KIRO_EFFORT"
const KIRO_TRUST_MODE_ENV = "KIRO_TRUST_MODE"
const KIRO_TRUST_TOOLS_ENV = "KIRO_TRUST_TOOLS"
const KIRO_AGENT_ENV = "KIRO_AGENT"

const UNSET = "__unset__"

/** `--effort` levels the CLI accepts. The launch path drops anything outside
 * this set rather than failing the whole spawn (R6.2). */
export const KIRO_EFFORT_VALUES = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const
export type KiroEffort = (typeof KIRO_EFFORT_VALUES)[number]

/** Trust mode: `all` → `--trust-all-tools`, `tools` → `--trust-tools <names>`.
 * Mutually exclusive, which is why the mode is stored instead of inferred. */
export type KiroTrustMode = "all" | "tools"

/**
 * Convenience presets for the model picker — deliberately NOT authoritative
 * (R6.1.1): Kiro's catalog changes monthly and what a given account can see
 * depends on its plan and region, so the control accepts any typed ID and
 * passes it through verbatim (R6.1.2). The list is a `datalist`, not a
 * dropdown, for exactly that reason.
 *
 * The list is static on purpose: `kiro-cli chat --list-models` hangs on an auth
 * portal when the CLI is not logged in, so fetching it would block the panel.
 */
export const KIRO_MODEL_PRESETS = [
  "auto",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-opus-4.5",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "deepseek-3.2",
  "minimax-m2.5",
  "minimax-m2.1",
  "glm-5",
  "qwen3-coder-next",
]

/** The saved effort, or "" when unset / hand-edited to something the CLI would
 * reject (in which case the control shows unset rather than a bogus value). */
export function inferKiroEffort(env: Record<string, string>): KiroEffort | "" {
  const raw = (env[KIRO_EFFORT_ENV] ?? "").trim().toLowerCase()
  return (KIRO_EFFORT_VALUES as readonly string[]).includes(raw)
    ? (raw as KiroEffort)
    : ""
}

/** The saved trust mode, or "" when unset / unrecognized. An unknown value
 * falls back to unset — never to `all`, which would silently grant an
 * authorization the user never picked. */
export function inferKiroTrustMode(
  env: Record<string, string>
): KiroTrustMode | "" {
  const raw = (env[KIRO_TRUST_MODE_ENV] ?? "").trim().toLowerCase()
  return raw === "all" || raw === "tools" ? raw : ""
}

/**
 * Build the env map to persist for Kiro. Every knob is set-or-delete, so an
 * emptied control removes its key instead of writing a blank one:
 *  - a cleared API key is REMOVED, so the next launch injects nothing at all
 *    and Kiro falls back to its own `kiro-cli login` state (R7.3.1/7.3.2);
 *  - a cleared model / effort / agent lets Kiro apply its own default
 *    (R6.1.3 / R6.7);
 *  - `KIRO_TRUST_TOOLS` only survives in `tools` mode, so switching to
 *    "trust everything" cannot leave a stale tool list behind.
 * Unrelated keys in `prevEnv` are preserved untouched.
 */
export function buildKiroEnv(
  prevEnv: Record<string, string>,
  values: {
    apiKey: string
    model: string
    effort: string
    trustMode: KiroTrustMode | ""
    trustTools: string
    agentId: string
  }
): Record<string, string> {
  const env: Record<string, string> = { ...prevEnv }
  const setOrDelete = (key: string, value: string) => {
    const trimmed = value.trim()
    if (trimmed) {
      env[key] = trimmed
    } else {
      delete env[key]
    }
  }
  setOrDelete(KIRO_API_KEY_ENV, values.apiKey)
  setOrDelete(KIRO_MODEL_ENV, values.model)
  setOrDelete(KIRO_EFFORT_ENV, values.effort)
  setOrDelete(KIRO_TRUST_MODE_ENV, values.trustMode)
  // Normalize the tool list here so a trailing comma or padded name can't reach
  // the launch path as an empty `--trust-tools` entry.
  const tools =
    values.trustMode === "tools"
      ? values.trustTools
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .join(",")
      : ""
  setOrDelete(KIRO_TRUST_TOOLS_ENV, tools)
  setOrDelete(KIRO_AGENT_ENV, values.agentId)
  return env
}

/**
 * Dedicated settings panel for Kiro (`kiro-cli acp`). Everything here lives in
 * `agent_setting.env_json` — the panel writes no file of its own, which is why
 * it needs no affected-sessions reporting like the Cursor panel does.
 *
 * Two groups:
 *  1. **Authentication** — a `KIRO_API_KEY`, shown in plaintext (a deliberate
 *     product decision for a local single-user tool). A browser login made with
 *     `kiro-cli login` outranks the key, so the panel says so instead of trying
 *     to detect the live auth state: `kiro-cli`'s subcommand output interleaves
 *     with its stderr logging, and parsing that is a brittle dependency.
 *  2. **Launch parameters** — model / effort / trust mode / custom agent, each
 *     stored as a knob the launch path turns into a flag. They apply to new
 *     sessions; a running session keeps the configuration it started with.
 */
export function KiroConfigPanel({
  agent,
  saving,
  onSaveEnv,
  onSaved,
}: {
  agent: AcpAgentInfo
  saving: boolean
  onSaveEnv: (env: Record<string, string>, enabled: boolean) => Promise<unknown>
  onSaved: () => void
}) {
  const t = useTranslations("AcpAgentSettings")

  const [apiKey, setApiKey] = useState(() => agent.env[KIRO_API_KEY_ENV] ?? "")
  const [model, setModel] = useState(() => agent.env[KIRO_MODEL_ENV] ?? "")
  const [effort, setEffort] = useState<KiroEffort | "">(() =>
    inferKiroEffort(agent.env)
  )
  const [trustMode, setTrustMode] = useState<KiroTrustMode | "">(() =>
    inferKiroTrustMode(agent.env)
  )
  const [trustTools, setTrustTools] = useState(
    () => agent.env[KIRO_TRUST_TOOLS_ENV] ?? ""
  )
  const [agentId, setAgentId] = useState(() => agent.env[KIRO_AGENT_ENV] ?? "")

  const [customAgents, setCustomAgents] = useState<KiroCustomAgent[]>([])
  const [agentsLoading, setAgentsLoading] = useState(false)
  const [savingAll, setSavingAll] = useState(false)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadCustomAgents = useCallback(async () => {
    setAgentsLoading(true)
    try {
      const list = await acpListKiroCustomAgents()
      if (mountedRef.current) setCustomAgents(list)
    } catch {
      // The scan never fails server-side (a missing directory yields []), so a
      // rejection here is transport-level: leave the list empty rather than
      // blocking the rest of the panel.
    } finally {
      if (mountedRef.current) setAgentsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadCustomAgents()
  }, [loadCustomAgents])

  // A saved agent that is no longer on disk stays selectable so saving an
  // unrelated knob can't silently drop it — the launch path is what reports it
  // as unavailable (R6.5.4), and the option is flagged as missing below.
  const agentOptions = useMemo<KiroCustomAgent[]>(() => {
    if (agentId && !customAgents.some((a) => a.id === agentId)) {
      return [{ id: agentId, description: null }, ...customAgents]
    }
    return customAgents
  }, [agentId, customAgents])

  const selectedAgentMissing = Boolean(
    agentId && !customAgents.some((a) => a.id === agentId)
  )

  const save = useCallback(async () => {
    setSavingAll(true)
    try {
      await onSaveEnv(
        buildKiroEnv(agent.env, {
          apiKey,
          model,
          effort,
          trustMode,
          trustTools,
          agentId,
        }),
        agent.enabled
      )
      toast.success(t("toasts.kiroSaved"))
      onSaved()
    } catch (e) {
      toast.error(
        `${t("toasts.saveKiroConfigFailed")}: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    } finally {
      if (mountedRef.current) setSavingAll(false)
    }
  }, [
    agent.enabled,
    agent.env,
    agentId,
    apiKey,
    effort,
    model,
    onSaveEnv,
    onSaved,
    t,
    trustMode,
    trustTools,
  ])

  const busy = saving || savingAll

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div>
        <label className="text-xs font-medium">{t("configManagement")}</label>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t("kiro.configDescription")}
        </p>
      </div>

      {/* ---- Authentication ---- */}
      <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
        <span className="text-[11px] font-medium">{t("kiro.authTitle")}</span>
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">
            {t("kiro.apiKeyLabel")}
          </label>
          {/* Plaintext by design: local single-user tool, no masking and no
              placeholder write-back, so what is on screen is what is stored. */}
          <Input
            className="h-7 text-xs"
            disabled={busy}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("kiro.apiKeyPlaceholder")}
            type="text"
            value={apiKey}
          />
          <p className="text-[10px] text-muted-foreground">
            {t("kiro.apiKeyHint")}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {t("kiro.loginPrecedenceHint")}
          </p>
        </div>
      </div>

      {/* ---- Launch parameters (model / effort / trust / agent) ---- */}
      <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[11px] font-medium">
            {t("kiro.launchTitle")}
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground">
          {t("kiro.launchDescription")}
        </p>

        <div className="grid gap-2 md:grid-cols-2">
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">
              {t("kiro.modelLabel")}
            </label>
            <Input
              className="h-7 font-mono text-xs"
              disabled={busy}
              list="kiro-model-options"
              onChange={(e) => setModel(e.target.value)}
              placeholder={t("kiro.modelPlaceholder")}
              value={model}
            />
            <datalist id="kiro-model-options">
              {KIRO_MODEL_PRESETS.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <p className="text-[10px] text-muted-foreground">
              {t("kiro.modelHint")}
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">
              {t("kiro.effortLabel")}
            </label>
            <Select
              onValueChange={(value) =>
                setEffort(value === UNSET ? "" : (value as KiroEffort))
              }
              value={effort || UNSET}
            >
              <SelectTrigger className="h-7 w-full text-xs" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem className="text-xs" value={UNSET}>
                  {t("kiro.optionDefault")}
                </SelectItem>
                {KIRO_EFFORT_VALUES.map((level) => (
                  <SelectItem className="text-xs" key={level} value={level}>
                    {t(`kiro.effort_${level}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              {t("kiro.effortHint")}
            </p>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">
            {t("kiro.trustModeLabel")}
          </label>
          <Select
            onValueChange={(value) =>
              setTrustMode(value === UNSET ? "" : (value as KiroTrustMode))
            }
            value={trustMode || UNSET}
          >
            <SelectTrigger className="h-7 w-full text-xs" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem className="text-xs" value={UNSET}>
                {t("kiro.trustModeAsk")}
              </SelectItem>
              <SelectItem className="text-xs" value="all">
                {t("kiro.trustModeAll")}
              </SelectItem>
              <SelectItem className="text-xs" value="tools">
                {t("kiro.trustModeTools")}
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">
            {t("kiro.trustModeHint")}
          </p>
        </div>

        {trustMode === "tools" ? (
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">
              {t("kiro.trustToolsLabel")}
            </label>
            <Input
              className="h-7 font-mono text-xs"
              disabled={busy}
              onChange={(e) => setTrustTools(e.target.value)}
              placeholder="fs_read,execute_bash"
              value={trustTools}
            />
            <p className="text-[10px] text-muted-foreground">
              {trustTools.trim()
                ? t("kiro.trustToolsHint")
                : t("kiro.trustToolsEmptyWarning")}
            </p>
          </div>
        ) : null}

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label className="text-[11px] text-muted-foreground">
              {t("kiro.customAgentLabel")}
            </label>
            <Button
              className="h-6 gap-1 px-2 text-[11px]"
              disabled={agentsLoading}
              onClick={() => void loadCustomAgents()}
              size="sm"
              type="button"
              variant="ghost"
            >
              {agentsLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {t("kiro.reloadCustomAgents")}
            </Button>
          </div>
          <Select
            onValueChange={(value) => setAgentId(value === UNSET ? "" : value)}
            value={agentId || UNSET}
          >
            <SelectTrigger className="h-7 w-full text-xs" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem className="text-xs" value={UNSET}>
                {t("kiro.customAgentNone")}
              </SelectItem>
              {agentOptions.map((a) => (
                <SelectItem className="text-xs" key={a.id} value={a.id}>
                  <span className="truncate">{a.id}</span>
                  {a.description ? (
                    <span className="ml-2 truncate text-[10px] text-muted-foreground">
                      {a.description}
                    </span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* An empty directory is the normal case on a fresh install. */}
          {!agentsLoading && customAgents.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">
              {t("kiro.customAgentEmpty")}
            </p>
          ) : null}
          {selectedAgentMissing ? (
            <p className="text-[10px] text-destructive">
              {t("kiro.customAgentMissing", { id: agentId })}
            </p>
          ) : null}
          <p className="text-[10px] text-muted-foreground">
            {t("kiro.customAgentHint")}
          </p>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          className="h-7 gap-1.5 px-2.5 text-xs"
          disabled={busy}
          onClick={() => void save()}
          size="sm"
          type="button"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {t("kiro.saveConfig")}
        </Button>
      </div>
    </div>
  )
}
