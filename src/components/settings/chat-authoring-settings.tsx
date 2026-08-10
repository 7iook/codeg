"use client"

/**
 * Create-from-chat settings panel — two independent kill switches persisted as
 * `chat_authoring.automations_enabled` / `chat_authoring.work_tasks_enabled` on
 * the Rust side.
 *
 * When on, `codeg-mcp` exposes `create_automation` (save a scheduled or manual
 * automation) and/or `create_work_task` (queue a card on the task board) so an
 * agent can park recurring or deferred work without the user leaving the
 * conversation. Both ship OFF: unlike the read-only lookups next to them these
 * tools write app state, and a scheduled automation goes on to spawn agents on
 * its own. Mounted under `/settings/general` with the other MCP-tool toggles.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CalendarClock, ListTodo, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSaveBar,
  SettingsSection,
} from "@/components/shared/settings-section"
import { Switch } from "@/components/ui/switch"
import {
  type ChatAuthoringSettings,
  getChatAuthoringSettings,
  setChatAuthoringSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"

export function ChatAuthoringSettingsSection() {
  const t = useTranslations("ChatAuthoringSettings")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [automations, setAutomations] = useState(false)
  const [workTasks, setWorkTasks] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getChatAuthoringSettings()
      .then((s) => {
        if (cancelled) return
        setAutomations(s.automations_enabled)
        setWorkTasks(s.work_tasks_enabled)
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
    const payload: ChatAuthoringSettings = {
      automations_enabled: automations,
      work_tasks_enabled: workTasks,
    }
    setSaving(true)
    try {
      const applied = await setChatAuthoringSettings(payload)
      setAutomations(applied.automations_enabled)
      setWorkTasks(applied.work_tasks_enabled)
      toast.success(t("saved"))
    } catch (err: unknown) {
      toast.error(t("saveFailed"), { description: toErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }, [automations, workTasks, t])

  return (
    <SettingsSection
      icon={Sparkles}
      title={t("title")}
      description={t("description")}
    >
      {loadError && (
        <SettingsError>{t("loadFailed", { detail: loadError })}</SettingsError>
      )}

      {/* Both switches share one card: they are the same decision — how much
          of the app an agent may write to from a conversation — split by which
          surface the work lands on. */}
      <SettingCard>
        <SettingRow
          icon={CalendarClock}
          title={t("enableAutomations")}
          description={t("enableAutomationsHint")}
          htmlFor="chat-authoring-automations"
          control={
            <Switch
              id="chat-authoring-automations"
              checked={automations}
              onCheckedChange={setAutomations}
              disabled={loading}
            />
          }
        />
        <SettingRow
          icon={ListTodo}
          title={t("enableWorkTasks")}
          description={t("enableWorkTasksHint")}
          htmlFor="chat-authoring-work-tasks"
          control={
            <Switch
              id="chat-authoring-work-tasks"
              checked={workTasks}
              onCheckedChange={setWorkTasks}
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
