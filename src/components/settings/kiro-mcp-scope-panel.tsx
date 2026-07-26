import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, Loader2, Lock, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { loadFolderHistory, mcpKiroScopedView } from "@/lib/api"
import type {
  FolderHistoryEntry,
  KiroMcpScope,
  KiroMcpScopedServer,
  KiroMcpView,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/** Sentinel for "no project picked", since a Select cannot hold an empty value. */
const NO_WORKSPACE = "__none__"

/**
 * Spec keys whose values are credentials. Rendering an entry's raw JSON would
 * put an API key or a bearer token on screen, so the panel lists which of these
 * keys are set and never their values.
 *
 * Reading the scopes at all is already gated (`ReadMcpConfig`, desktop-only by
 * default) — this is the second half: even a permitted read is not a reason to
 * paint secrets into the DOM.
 */
const SECRET_KEYS = ["env", "headers", "oauth"] as const

/** Names of the credential-bearing keys present on a spec, for display. */
function secretKeyNames(spec: unknown): string[] {
  if (typeof spec !== "object" || spec === null) return []
  const out: string[] = []
  for (const group of SECRET_KEYS) {
    const value = (spec as Record<string, unknown>)[group]
    if (typeof value !== "object" || value === null) continue
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out.push(key)
    }
  }
  return out
}

/** The non-secret shape of an entry: enough to recognize it, nothing sensitive.
 * `command`/`url` are what Kiro discriminates local vs remote on. */
function entrySummary(spec: unknown): string {
  if (typeof spec !== "object" || spec === null) return ""
  const obj = spec as Record<string, unknown>
  if (typeof obj.url === "string") return obj.url
  if (typeof obj.command === "string") {
    const args = Array.isArray(obj.args)
      ? obj.args.filter((a): a is string => typeof a === "string")
      : []
    return [obj.command, ...args].join(" ")
  }
  return ""
}

/**
 * Read-only view of Kiro's three MCP scopes.
 *
 * Kiro merges `Agent > Project > Global` (kiro.dev/docs/cli/mcp/configuration):
 * same-name entries override by precedence, different names all stay active.
 * codeg writes only the global file, so without this panel a user can edit the
 * entry codeg owns, save successfully, and have Kiro keep using a project or
 * agent copy — with nothing on screen explaining why the change had no effect.
 *
 * Project scope needs a workspace path to resolve. This page is global settings
 * and has no ambient workspace, so the scope is picked explicitly from folder
 * history — the same approach `skills-settings.tsx` takes for folder-scoped
 * skills, including its choice of `loadFolderHistory()` (a direct `folder`
 * query) over `listFolders()` (aggregates across every conversation).
 */
export function KiroMcpScopePanel() {
  const t = useTranslations("McpSettings")
  const [view, setView] = useState<KiroMcpView | null>(null)
  const [folders, setFolders] = useState<FolderHistoryEntry[]>([])
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // A denied read and an empty config both yield zero rows. Keeping the error
  // separate is what lets the panel say "refused" instead of "nothing here".
  const [error, setError] = useState<string | null>(null)

  const scopeLabel = useCallback(
    (scope: KiroMcpScope) => t(`kiroScopes.scope.${scope}`),
    [t]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setView(await mcpKiroScopedView({ workspacePath }))
    } catch (err) {
      setView(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workspacePath])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    loadFolderHistory()
      .then(setFolders)
      .catch((err) => {
        // Folder history only feeds the project-scope picker; failing to load it
        // must not take the global scope down with it.
        console.error("[KiroMcpScopePanel] loadFolderHistory failed:", err)
      })
  }, [])

  const rows = useMemo(() => view?.servers ?? [], [view])

  return (
    <section className="space-y-3 rounded-xl border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t("kiroScopes.title")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("kiroScopes.description")}
          </p>
        </div>
        <Button
          className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
          disabled={loading}
          onClick={() => void load()}
          size="sm"
          type="button"
          variant="outline"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          {t("kiroScopes.workspaceLabel")}
        </Button>
      </div>

      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">
          {t("kiroScopes.workspaceLabel")}
        </div>
        <Select
          onValueChange={(value) =>
            setWorkspacePath(value === NO_WORKSPACE ? null : value)
          }
          value={workspacePath ?? NO_WORKSPACE}
        >
          <SelectTrigger className="h-7 w-full text-xs" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_WORKSPACE}>
              {t("kiroScopes.workspaceNone")}
            </SelectItem>
            {folders.map((folder) => (
              <SelectItem key={folder.path} value={folder.path}>
                {folder.path}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* R4.1.5: the panel states which file it actually reads and writes. */}
      {view ? (
        <div className="rounded-md border border-dashed px-2 py-1.5 text-[11px]">
          <span className="text-muted-foreground">
            {t("kiroScopes.writeTarget")}:{" "}
          </span>
          <span className="break-all font-mono">{view.write_target}</span>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {t("kiroScopes.loadFailed", { message: error })}
        </div>
      ) : null}

      {/* R4.1.12: a scope whose file does not parse is called out. Kiro's own
       * troubleshooting names JSON syntax errors as the top reason a configured
       * server never shows up, so silence here is a real failure mode. */}
      {view?.scope_failures.map((failure) => (
        <div
          className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs"
          key={`${failure.scope}:${failure.path}`}
        >
          <div className="flex items-center gap-1.5 font-medium text-amber-500">
            <AlertTriangle className="h-3.5 w-3.5" />
            {scopeLabel(failure.scope)} · {t("kiroScopes.scopeFailed")}
          </div>
          <div className="break-all font-mono text-[11px]">{failure.path}</div>
          <div className="text-[11px] text-muted-foreground">
            {failure.reason}
          </div>
        </div>
      ))}

      {!loading && !error && rows.length === 0 ? (
        <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          {t("kiroScopes.empty")}
        </div>
      ) : null}

      <div className="space-y-1">
        {rows.map((row) => (
          <ScopeRow
            key={row.id}
            row={row}
            scopeLabel={scopeLabel}
            t={t as (key: string, values?: Record<string, string>) => string}
          />
        ))}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {t("kiroScopes.hotReload")}
      </p>
    </section>
  )
}

function ScopeRow({
  row,
  scopeLabel,
  t,
}: {
  row: KiroMcpScopedServer
  scopeLabel: (scope: KiroMcpScope) => string
  t: (key: string, values?: Record<string, string>) => string
}) {
  const secrets = secretKeyNames(row.spec)
  const summary = entrySummary(row.spec)
  return (
    <div className="space-y-1 rounded-md border p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 break-all font-medium">{row.id}</span>
        <span
          className={cn(
            "shrink-0 rounded border px-1.5 py-0.5 text-[10px]",
            row.editable
              ? "border-primary/40 text-primary"
              : "text-muted-foreground"
          )}
        >
          {scopeLabel(row.scope)}
        </span>
        {/* R4.1.4: agent and project entries are read-only here. The backend
         * already decided this (`editable`); the row does not recompute it. */}
        {row.editable ? null : (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
            <Lock className="h-3 w-3" />
            {t("kiroScopes.readOnly")}
          </span>
        )}
      </div>

      {summary ? (
        <div className="break-all font-mono text-[10px] text-muted-foreground">
          {summary}
        </div>
      ) : null}

      {/* R4.1.3: name the scopes this entry overrides. Without it, a user who
       * edits the shadowed copy gets no explanation for the missing effect. */}
      {row.shadowed_scopes.length > 0 ? (
        <div className="text-[10px] text-amber-500">
          {t("kiroScopes.shadowedBy", {
            scopes: row.shadowed_scopes.map(scopeLabel).join(", "),
          })}
        </div>
      ) : null}

      {row.agent_name ? (
        <div className="text-[10px] text-muted-foreground">
          {t("kiroScopes.agentSource", { name: row.agent_name })}
        </div>
      ) : null}

      {secrets.length > 0 ? (
        <div className="text-[10px] text-muted-foreground">
          {t("kiroScopes.keysSet", { keys: secrets.join(", ") })}
        </div>
      ) : null}
    </div>
  )
}
