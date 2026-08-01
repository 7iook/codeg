"use client"

import { useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRight, Folder } from "lucide-react"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { AgentSelector } from "@/components/chat/agent-selector"
import {
  RichComposer,
  type RichComposerHandle,
} from "@/components/chat/composer/rich-composer"
import {
  useReferenceSearch,
  type ReferenceGroupLabels,
} from "@/components/chat/composer/use-reference-search"
import { docToPromptBlocks } from "@/components/chat/composer/to-prompt-blocks"
import type { MentionUiLabels } from "@/components/chat/composer/suggestion/types"
import {
  AgentConfigSection,
  effectiveSelections,
  snapshotLabels,
} from "@/components/automations/agent-config-section"
import { useAgentOptions } from "@/components/automations/use-agent-options"
import { getAgentLabel } from "@/lib/custom-agents"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type {
  AgentType,
  PromptInputBlock,
  WorkTask,
  WorkTaskDraft,
} from "@/lib/types"

interface TaskEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Existing task to edit, or null for a blank create. */
  task: WorkTask | null
  /** Preselected folder for a create (the board's folder filter). */
  defaultFolderId: number | null
  /** Seed text for a create (the "task from message" hand-off). */
  prefillText?: string | null
  onSubmit: (draft: WorkTaskDraft) => Promise<void>
}

/**
 * Create/edit a task: title + the real conversation composer (rich text +
 * @-mentions) + folder select, with an "advanced" collapse carrying the
 * per-task agent override (AgentSelector + ACP-probed mode/model options —
 * same surface as the sub-agent settings). No override = inherit the folder's
 * task defaults at launch.
 */
export function TaskEditorDialog({
  open,
  onOpenChange,
  task,
  defaultFolderId,
  prefillText,
  onSubmit,
}: TaskEditorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[40rem]">
        {/* Remount per open so a reopened editor never leaks previous state. */}
        {open ? (
          <TaskEditorBody
            task={task}
            defaultFolderId={defaultFolderId}
            prefillText={prefillText ?? null}
            onSubmit={onSubmit}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TaskEditorBody({
  task,
  defaultFolderId,
  prefillText,
  onSubmit,
  onCancel,
}: {
  task: WorkTask | null
  defaultFolderId: number | null
  prefillText: string | null
  onSubmit: (draft: WorkTaskDraft) => Promise<void>
  onCancel: () => void
}) {
  const t = useTranslations("Tasks")
  const tComposer = useTranslations("Folder.chat.messageInput")
  const folders = useAppWorkspaceStore((s) => s.folders)
  // Tasks bind to project roots only (never worktrees / chat scratch dirs).
  const projectFolders = useMemo(
    () => folders.filter((f) => f.parent_id == null && f.kind === "regular"),
    [folders]
  )

  // A create seeded from a chat message: the text becomes the description and
  // its first line (trimmed) the suggested title.
  const seededText = task == null ? (prefillText ?? "") : ""
  const [title, setTitle] = useState(
    task?.title ?? seededText.split("\n")[0]?.trim().slice(0, 80) ?? ""
  )
  const [prompt, setPrompt] = useState(task?.config?.display_text ?? seededText)
  const [folderId, setFolderId] = useState<number | null>(
    task?.folder_id ?? defaultFolderId ?? projectFolders[0]?.id ?? null
  )
  const [overrideAgent, setOverrideAgent] = useState(
    task?.config?.agent_type != null
  )
  const [agentType, setAgentType] = useState<AgentType>(
    task?.config?.agent_type ?? "claude_code"
  )
  const [modeId, setModeId] = useState<string | null>(
    task?.config?.mode_id ?? null
  )
  const [configValues, setConfigValues] = useState<Record<string, string>>(
    task?.config?.config_values ?? {}
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const editorRef = useRef<RichComposerHandle>(null)

  const folderPath = useMemo(
    () => folders.find((f) => f.id === folderId)?.path ?? null,
    [folders, folderId]
  )

  const referenceGroupLabels = useMemo<ReferenceGroupLabels>(
    () => ({
      file: tComposer("mentionGroupFile"),
      agent: tComposer("mentionGroupAgent"),
      session: tComposer("mentionGroupSession"),
      commit: tComposer("mentionGroupCommit"),
      skill: tComposer("mentionGroupSkill"),
    }),
    [tComposer]
  )
  const mentionUiLabels = useMemo<MentionUiLabels>(
    () => ({
      empty: tComposer("mentionEmpty"),
      loading: tComposer("mentionLoading"),
      listbox: tComposer("mentionListLabel"),
      more: tComposer("mentionMore"),
      count: (count: number) => tComposer("mentionCount", { count }),
    }),
    [tComposer]
  )
  const referenceSearch = useReferenceSearch({
    defaultPath: folderPath,
    enabled: true,
    labels: referenceGroupLabels,
  })

  // Probe only while the override is on — no transient agent session otherwise.
  const agentOptions = useAgentOptions(agentType, folderPath, overrideAgent)

  const submit = async () => {
    setError(null)
    const editor = editorRef.current?.getEditor()
    const displayText = (editorRef.current?.getText() ?? prompt).trim()
    if (!title.trim()) return setError(t("errorTitle"))
    if (!displayText) return setError(t("errorPrompt"))
    if (folderId == null) return setError(t("errorFolder"))

    const blocks: PromptInputBlock[] = editor
      ? docToPromptBlocks(editor)
      : [{ type: "text", text: displayText }]

    setSaving(true)
    try {
      let draft: WorkTaskDraft
      if (overrideAgent) {
        const snapshot = await agentOptions.ensure()
        const { mode_id, config_values } = effectiveSelections(
          snapshot,
          modeId,
          configValues
        )
        draft = {
          folder_id: folderId,
          title: title.trim(),
          config: {
            prompt_blocks: blocks,
            display_text: displayText,
            agent_type: agentType,
            mode_id,
            config_values,
            label_snapshot: {
              agent_label: getAgentLabel(agentType) ?? agentType,
              ...snapshotLabels(snapshot, mode_id, config_values),
            },
          },
        }
      } else {
        draft = {
          folder_id: folderId,
          title: title.trim(),
          config: {
            prompt_blocks: blocks,
            display_text: displayText,
            agent_type: null,
            mode_id: null,
            config_values: {},
          },
        }
      }
      await onSubmit(draft)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
        <DialogTitle className="text-base">
          {task ? t("editorTitleEdit") : t("editorTitleNew")}
        </DialogTitle>
      </DialogHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("titlePlaceholder")}
          aria-label={t("titleLabel")}
          className="w-full bg-transparent text-lg font-semibold tracking-tight outline-none placeholder:font-normal placeholder:text-muted-foreground/50"
        />

        <div className="rounded-xl border border-input bg-background transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-inset focus-within:ring-ring/50">
          <RichComposer
            ref={editorRef}
            defaultText={task?.config?.display_text ?? seededText}
            placeholder={t("promptPlaceholder")}
            ariaLabel={t("promptLabel")}
            referenceSearch={referenceSearch}
            mentionUiLabels={mentionUiLabels}
            tabLabels={referenceGroupLabels}
            onChange={setPrompt}
            className="max-h-[14rem] min-h-[6rem]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={folderId != null ? String(folderId) : undefined}
            onValueChange={(v) => setFolderId(Number(v))}
            // A task that already ran is pinned to its folder (its worktree
            // lives there) — the backend rejects a move too.
            disabled={task != null && task.worktree_folder_id != null}
          >
            <SelectTrigger size="sm" className="h-7 gap-1.5 text-xs">
              <Folder
                className="size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              <SelectValue placeholder={t("folderPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {projectFolders.map((f) => (
                <SelectItem key={f.id} value={String(f.id)}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Collapsible open={overrideAgent} onOpenChange={setOverrideAgent}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  "size-3.5 transition-transform",
                  overrideAgent && "rotate-90"
                )}
                aria-hidden="true"
              />
              {t("overrideAgent")}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-2.5 pt-2">
            <p className="text-xs text-muted-foreground">
              {t("overrideAgentHint")}
            </p>
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
          </CollapsibleContent>
        </Collapsible>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
        >
          {t("cancel")}
        </Button>
        <Button type="button" onClick={submit} disabled={saving}>
          {t("save")}
        </Button>
      </div>
    </>
  )
}
