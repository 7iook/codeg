"use client"

/**
 * Live user-feedback ("steering") settings panel — a single feature kill
 * switch persisted as `feedback.enabled` on the Rust side.
 *
 * When enabled, `codeg-mcp` exposes the `check_user_feedback` tool so an agent
 * can pull mid-turn notes/corrections the user types in the conversation view,
 * and the conversation UI shows the "send a note to the agent" bar while a turn
 * is in flight. Mounted under `/settings/general` next to the multi-agent
 * delegation section, because it's a global feature, not per-agent.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { MessageSquarePlus, Power } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSaveBar,
  SettingsSection,
} from "@/components/shared/settings-section"
import { Switch } from "@/components/ui/switch"
import {
  type FeedbackSettings,
  getFeedbackSettings,
  setFeedbackSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { primeFeedbackEnabled } from "@/hooks/use-feedback-enabled"

export function SessionFeedbackSettingsSection() {
  const t = useTranslations("SessionFeedbackSettings")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getFeedbackSettings()
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
    const payload: FeedbackSettings = { enabled }
    setSaving(true)
    try {
      const applied = await setFeedbackSettings(payload)
      setEnabled(applied.enabled)
      // Refresh the module-cached flag so open conversations show/hide the
      // feedback bar without a full reload.
      primeFeedbackEnabled(applied.enabled)
      toast.success(t("saved"))
    } catch (err: unknown) {
      toast.error(t("saveFailed"), { description: toErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }, [enabled, t])

  return (
    <SettingsSection
      icon={MessageSquarePlus}
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
          htmlFor="feedback-enabled"
          control={
            <Switch
              id="feedback-enabled"
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
