"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { AgentSelector } from "@/components/chat/agent-selector"
import {
  AgentConfigSection,
  effectiveSelections,
  snapshotLabels,
} from "@/components/automations/agent-config-section"
import { useAgentOptions } from "@/components/automations/use-agent-options"
import { getAgentLabel } from "@/lib/custom-agents"
import { workTaskSettingsGet, workTaskSettingsSet } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AgentType, WorkTaskFolderSettings } from "@/lib/types"

interface TaskSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  folderId: number | null
}

/**
 * Per-folder task defaults: the default processing agent + its ACP-probed
 * mode/model options (same surface as the sub-agent settings), max concurrency,
 * and merge defaults. The auto-process toggle is P1 and not surfaced yet.
 */
export function TaskSettingsDialog({
  open,
  onOpenChange,
  folderId,
}: TaskSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[30rem]">
        {open && folderId != null ? (
          <TaskSettingsBody
            folderId={folderId}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TaskSettingsBody({
  folderId,
  onClose,
}: {
  folderId: number
  onClose: () => void
}) {
  const t = useTranslations("Tasks")
  const folders = useAppWorkspaceStore((s) => s.folders)
  const folder = useMemo(
    () => folders.find((f) => f.id === folderId) ?? null,
    [folders, folderId]
  )

  const [loaded, setLoaded] = useState<WorkTaskFolderSettings | null>(null)
  const [agentType, setAgentType] = useState<AgentType>("claude_code")
  const [modeId, setModeId] = useState<string | null>(null)
  const [configValues, setConfigValues] = useState<Record<string, string>>({})
  const [maxConcurrent, setMaxConcurrent] = useState("2")
  const [mergeStrategy, setMergeStrategy] = useState<"squash" | "merge">(
    "squash"
  )
  const [deleteWorktreeDefault, setDeleteWorktreeDefault] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false

    workTaskSettingsGet(folderId)
      .then((s) => {
        if (cancelled) return
        setLoaded(s)
        setAgentType(
          s.default_agent_type ?? folder?.default_agent_type ?? "claude_code"
        )
        setModeId(s.mode_id ?? null)
        setConfigValues(s.config_values ?? {})
        setMaxConcurrent(String(s.max_concurrent))
        setMergeStrategy(s.merge_strategy === "merge" ? "merge" : "squash")
        setDeleteWorktreeDefault(s.delete_worktree_default)
      })
      .catch((e) => {
        if (!cancelled) toast.error(toErrorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [folderId, folder?.default_agent_type])

  const agentOptions = useAgentOptions(
    agentType,
    folder?.path ?? null,
    loaded != null
  )

  const save = async () => {
    setSaving(true)
    try {
      const snapshot = await agentOptions.ensure()
      const { mode_id, config_values } = effectiveSelections(
        snapshot,
        modeId,
        configValues
      )
      const parsed = Number.parseInt(maxConcurrent, 10)
      const settings: WorkTaskFolderSettings = {
        default_agent_type: agentType,
        mode_id,
        config_values,
        label_snapshot: {
          agent_label: getAgentLabel(agentType) ?? agentType,
          ...snapshotLabels(snapshot, mode_id, config_values),
        },
        auto_process: loaded?.auto_process ?? false,
        max_concurrent: Number.isFinite(parsed) && parsed >= 0 ? parsed : 2,
        merge_strategy: mergeStrategy,
        delete_worktree_default: deleteWorktreeDefault,
      }
      await workTaskSettingsSet(folderId, settings)
      onClose()
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("settingsTitle")}</DialogTitle>
        <DialogDescription>
          {folder ? t("settingsDescription", { folder: folder.name }) : null}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-2">
          <Label className="text-sm">{t("settingsAgent")}</Label>
          <div className="flex">
            <AgentSelector
              defaultAgentType={agentType}
              onSelect={(a) => {
                setAgentType(a)
                setModeId(null)
                setConfigValues({})
              }}
              onFallback={setAgentType}
            />
          </div>
          <AgentConfigSection
            snapshot={agentOptions.snapshot}
            loading={agentOptions.loading}
            error={agentOptions.error}
            onReload={agentOptions.reload}
            modeId={modeId}
            configValues={configValues}
            layout="inline"
            onModeChange={setModeId}
            onConfigChange={(optionId, valueId) =>
              setConfigValues((prev) => {
                const next = { ...prev }
                if (valueId === null) delete next[optionId]
                else next[optionId] = valueId
                return next
              })
            }
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <Label htmlFor="task-max-concurrent" className="text-sm">
              {t("settingsMaxConcurrent")}
            </Label>
            <span className="text-xs text-muted-foreground">
              {t("settingsMaxConcurrentHint")}
            </span>
          </div>
          <Input
            id="task-max-concurrent"
            inputMode="numeric"
            value={maxConcurrent}
            onChange={(e) =>
              setMaxConcurrent(e.target.value.replace(/[^0-9]/g, ""))
            }
            className="w-20 text-right"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <Label className="text-sm">{t("settingsMergeStrategy")}</Label>
          <Select
            value={mergeStrategy}
            onValueChange={(v) =>
              setMergeStrategy(v === "merge" ? "merge" : "squash")
            }
          >
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="squash">{t("strategySquash")}</SelectItem>
              <SelectItem value="merge">{t("strategyMerge")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Label className="text-sm font-normal">
          <Checkbox
            checked={deleteWorktreeDefault}
            onCheckedChange={(v) => setDeleteWorktreeDefault(v === true)}
          />
          {t("settingsDeleteWorktree")}
        </Label>
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          disabled={saving}
        >
          {t("cancel")}
        </Button>
        <Button
          type="button"
          onClick={save}
          disabled={saving || loaded == null}
        >
          {t("save")}
        </Button>
      </DialogFooter>
    </>
  )
}
