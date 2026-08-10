"use client"

/**
 * Ask-user-question settings panel — a single feature kill switch persisted as
 * `question.enabled` on the Rust side.
 *
 * When enabled (the default), `codeg-mcp` exposes the `ask_user_question` tool so
 * an agent can block on a multiple-choice question rendered as an interactive
 * card above the conversation input box. Mounted under `/settings/general` next
 * to the live-feedback section, because it's a global feature, not per-agent.
 *
 * Unlike live-feedback, no module-cached frontend flag is needed: the card is
 * driven entirely by the backend `question_request` event, which only fires when
 * the tool was injected (i.e. the setting was on at launch).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { HelpCircle, Power } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSaveBar,
  SettingsSection,
} from "@/components/shared/settings-section"
import { Switch } from "@/components/ui/switch"
import {
  type QuestionSettings,
  getQuestionSettings,
  setQuestionSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"

export function AskQuestionSettingsSection() {
  const t = useTranslations("AskQuestionSettings")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getQuestionSettings()
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
    const payload: QuestionSettings = { enabled }
    setSaving(true)
    try {
      const applied = await setQuestionSettings(payload)
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
      icon={HelpCircle}
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
          htmlFor="question-enabled"
          control={
            <Switch
              id="question-enabled"
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
