"use client"

/**
 * Get-session-info settings panel — a single feature kill switch persisted as
 * `session_info.enabled` on the Rust side.
 *
 * When enabled (the default), `codeg-mcp` exposes the read-only `get_session_info`
 * tool so an agent can resolve a session the user referenced in the composer
 * (`codeg://session/<id>`) into its title, agent, status, workspace, token usage,
 * and recent messages. Mounted under `/settings/general` next to the other
 * MCP-tool feature toggles, because it's a global feature, not per-agent.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { MessageSquare, Power } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSaveBar,
  SettingsSection,
} from "@/components/shared/settings-section"
import { Switch } from "@/components/ui/switch"
import {
  type SessionInfoSettings,
  getSessionInfoSettings,
  setSessionInfoSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"

export function SessionInfoSettingsSection() {
  const t = useTranslations("SessionInfoSettings")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getSessionInfoSettings()
      .then((s) => {
        if (cancelled) return
        setEnabled(s.enabled)
        setLoadError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(toErrorMessage(err))
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(async () => {
    const payload: SessionInfoSettings = { enabled }
    setSaving(true)
    try {
      const applied = await setSessionInfoSettings(payload)
      setEnabled(applied.enabled)
      toast.success(t("saved"))
    } catch (err: unknown) {
      toast.error(t("saveFailed"), { description: toErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }, [enabled, t])

  return (
    <SettingsSection
      icon={MessageSquare}
      title={t("title")}
      description={t("description")}
    >
      {loadError && (
        <SettingsError>{t("loadFailed", { detail: loadError })}</SettingsError>
      )}

      <SettingCard>
        <SettingRow
          icon={Power}
          title={t("enable")}
          description={t("enableHint")}
          htmlFor="session-info-enabled"
          control={
            <Switch
              id="session-info-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={loading}
            />
          }
        />
      </SettingCard>

      <SettingsSaveBar
        onSave={() => void save()}
        saving={saving}
        disabled={loading}
        label={t("save")}
        savingLabel={t("saving")}
      />
    </SettingsSection>
  )
}
