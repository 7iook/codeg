"use client"

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react"
import {
  useAcpActions,
  useConnectionStore,
  getCachedSelectors,
  type ClaudeApiRetryState,
  type ConnectionState,
  type PendingPermission,
  type PendingUserMessage,
  type PendingQuestion,
} from "@/contexts/acp-connections-context"
import type {
  AgentType,
  AvailableCommandInfo,
  ConfigStaleKind,
  ConnectionStatus,
  PendingPlanApprovalState,
  PendingQuestionState,
  PromptCapabilitiesInfo,
  QuestionAnswer,
  SessionConfigOptionInfo,
  SessionModeStateInfo,
  PromptInputBlock,
} from "@/lib/types"
import type { SteerOutcome } from "@/lib/steering-queue"
import type { CancelScopePreview, CancelScopeResult } from "@/lib/cancel-scope"

const DEFAULT_PROMPT_CAPABILITIES: PromptCapabilitiesInfo = {
  image: false,
  audio: false,
  embedded_context: false,
}

export interface UseConnectionReturn {
  connectionId: string | null
  /** The agent type of the live connection at this contextKey (null when no
   *  connection exists yet). Lets callers detect a connection still bound to a
   *  PREVIOUS agent — e.g. a draft mid-switch, or a switch the not-installed
   *  preflight blocked before it could tear the old one down — so they can
   *  avoid rendering the previous agent's selectors as the selected one's. */
  agentType: AgentType | null
  /**
   * True when this context attached to a connection another client owns
   * (cross-client viewing). Viewers detach but never `acpDisconnect`, so the
   * unmount cleanup must tear them down even mid-turn (the owner's agent is
   * unaffected) — otherwise the attach subscription leaks past tab close.
   */
  isViewer: boolean
  status: ConnectionStatus | null
  promptCapabilities: PromptCapabilitiesInfo
  supportsFork: boolean
  /** Whether the agent supports mid-turn steering (`_session/steering`), i.e.
   *  injecting a queued message into the RUNNING turn. `undefined` = unknown
   *  (the `initialize` probe hasn't landed, or an older server omitted the
   *  field); consumers treat it the same as unsupported. Deliberately NOT
   *  defaulted to `false` here — that would erase the distinction between
   *  "not answered yet" and "answered no". */
  supportsSteering: boolean | undefined
  selectorsReady: boolean
  hasCachedSelectors: boolean
  sessionId: string | null
  /** The working directory the live connection was established with (null when
   *  not connected). Lets callers detect a connection that is mid-reconnect to a
   *  different cwd and avoid acting on the stale one. */
  connectedWorkingDir: string | null
  modes: SessionModeStateInfo | null
  configOptions: SessionConfigOptionInfo[] | null
  availableCommands: AvailableCommandInfo[] | null
  pendingPermission: PendingPermission | null
  pendingUserMessage: PendingUserMessage | null
  pendingQuestion: PendingQuestion | null
  pendingAskQuestion: PendingQuestionState | null
  pendingPlanApproval: PendingPlanApprovalState | null
  claudeApiRetry: ClaudeApiRetryState | null
  error: string | null
  loadError: string | null
  /** True when the running session is on stale (launch-time) config after a
   *  later settings save. Drives the "restart to apply" banner. */
  configStale: boolean
  /** Which settings surface drifted, for the banner's wording. */
  configStaleKind: ConfigStaleKind | null
  /** Client-local: the user dismissed the stale banner for the current drift. */
  configStaleDismissed: boolean
  /** True for a delegation-spawned child connection (broker-owned). The stale
   *  banner hides for these — the user can't restart a broker-owned process. */
  isDelegationChild: boolean
  /** Launched-but-unresolved background tasks on this connection (async
   *  sub-agents / background shells, accounted from the transcript by the
   *  backend watcher). Drives the "background tasks running" chip; non-zero
   *  also exempts the connection from the idle sweeps. */
  backgroundOutstanding: number
  /** The `agent` / `shell` split of `backgroundOutstanding`, letting the chip
   *  name which kinds its number counted. Both `0` alongside a non-zero
   *  aggregate means the split is unavailable (pre-split backend), not "none of
   *  either" — see `resolveBackgroundTaskKinds`. */
  backgroundOutstandingAgents: number
  backgroundOutstandingShells: number
  /** Epoch ms while a settled background task's follow-up reply is still being
   *  generated/surfaced (cleared when overlay turns arrive). Drives the chip's
   *  transient "syncing results" state so the gap after the running count
   *  disappears isn't a blank void. */
  backgroundSettleSyncingSince: number | null
  connect: (
    agentType: AgentType,
    workingDir?: string,
    sessionId?: string,
    conversationId?: number
  ) => Promise<void>
  disconnect: () => Promise<void>
  /** Restart the session (disconnect + resume same sessionId) so it picks up
   *  current agent/model settings. Returns `true` if it actually restarted,
   *  `false` on a no-op (viewer / delegation child / no connection). */
  reapplyConfig: () => Promise<boolean>
  /** Dismiss the stale banner for the current drift without restarting. */
  dismissConfigStale: () => void
  sendPrompt: (
    blocks: PromptInputBlock[],
    opts?: {
      folderId?: number | null
      conversationId?: number | null
      clientMessageId?: string | null
    }
  ) => Promise<void>
  setMode: (modeId: string) => Promise<void>
  setConfigOption: (configId: string, valueId: string) => Promise<void>
  cancel: () => Promise<void>
  /**
   * Read-only preview of what a stop would cascade into (spec R4.1/R4.2).
   * `null` when there is no connection for this contextKey.
   */
  previewCancelScope: () => Promise<CancelScopePreview | null>
  /**
   * Commit a cancel bounded by a preview token, resolving with what was
   * ACTUALLY terminated. Rejects when the token was refused or the scope moved
   * — both mean nothing was cancelled and the caller must re-preview.
   */
  cancelWithScopeToken: (
    scopeToken: string
  ) => Promise<CancelScopeResult | null>
  /**
   * Inject `blocks` into the RUNNING turn and resolve with the outcome. Never
   * rejects for a refusal — a `failed` / `unknown` outcome is returned so the
   * caller can distinguish "safe to retry" from "must not retry".
   */
  steer: (blocks: PromptInputBlock[], messageId: string) => Promise<SteerOutcome>
  respondPermission: (requestId: string, optionId: string) => Promise<void>
  answerQuestion: (questionId: string, answer: QuestionAnswer) => Promise<void>
}

function derive(conn: ConnectionState | undefined) {
  if (!conn) return null
  return conn
}

// ConnectionState fields that change at streaming frequency but are NOT part of
// `UseConnectionReturn` (no consumer renders them), so a change to one of these
// alone must NOT re-render this hook's consumers:
//   - `liveMessage`: the accumulating assistant message (per STREAM_BATCH),
//     rendered from the conversation-runtime store instead.
//   - `lastAppliedSeq`: the seq-dedup cursor, advanced by EVENT_APPLIED after
//     EVERY accepted envelope — so without excluding it a `content_delta` token
//     would still churn the snapshot and re-render the keep-alive panel per event.
const CONN_NON_RENDER_KEYS = new Set<keyof ConnectionState>([
  "liveMessage",
  "lastAppliedSeq",
  // Out-of-turn tool-call registry: read only inside the reducer (permission
  // enrichment); no useConnection consumer renders it, and it can churn per
  // background tool event.
  "outOfTurnToolCalls",
])

// Shallow-equal two connection snapshots for RENDER purposes: equal iff every
// field a useConnection consumer can observe is identical. Keys are iterated
// dynamically so a newly-added ConnectionState field is compared by default
// (fail toward re-rendering, never toward a silently-missed update); only the
// explicitly internal keys above are ignored. Exported for tests.
export function connRenderEqual(
  a: ConnectionState | null,
  b: ConnectionState | null
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const aKeys = Object.keys(a) as (keyof ConnectionState)[]
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) {
    if (CONN_NON_RENDER_KEYS.has(key)) continue
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}

export function useConnection(contextKey: string): UseConnectionReturn {
  const store = useConnectionStore()
  const actions = useAcpActions()

  const subscribe = useCallback(
    (cb: () => void) => store.subscribeKey(contextKey, cb),
    [store, contextKey]
  )
  // Keep the snapshot reference STABLE across streaming-only changes (liveMessage
  // and the lastAppliedSeq dedup cursor) so this hook — and its consumers,
  // notably the keep-alive conversation panel — do NOT re-render on every
  // streaming token. The live message reaches the UI via the conversation-runtime
  // store (mirrored there by the connection dispatch; see
  // `registerLiveMessageSink`), so no useConnection consumer renders it. A
  // per-instance cache recomputes the stable snapshot only when a render-relevant
  // field changes; a contextKey change resets it.
  const cacheRef = useRef<{
    key: string
    raw: ConnectionState | null
    stable: ConnectionState | null
  }>({ key: contextKey, raw: null, stable: null })
  const getSnapshot = useCallback((): ConnectionState | null => {
    const cache = cacheRef.current
    if (cache.key !== contextKey) {
      cache.key = contextKey
      cache.raw = null
      cache.stable = null
    }
    const raw = derive(store.getConnection(contextKey))
    if (raw === cache.raw) return cache.stable
    cache.raw = raw
    if (connRenderEqual(cache.stable, raw)) {
      // Only internal streaming state (liveMessage / lastAppliedSeq) changed →
      // keep the previous reference so consumers don't re-render per token.
      return cache.stable
    }
    cache.stable = raw
    return raw
  }, [store, contextKey])
  const connection = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const connectionId = connection?.connectionId ?? null
  const agentType = connection?.agentType ?? null
  const isViewer = connection?.isViewer ?? false
  const status = connection?.status ?? null
  const promptCapabilities =
    connection?.promptCapabilities ?? DEFAULT_PROMPT_CAPABILITIES
  const supportsFork = connection?.supportsFork ?? false
  // No `?? false`: `undefined` means the capability probe hasn't answered, which
  // consumers must be able to tell apart from a confirmed "no" (R2.2).
  const supportsSteering = connection?.supportsSteering
  const selectorsReady = connection?.selectorsReady ?? false
  const sessionId = connection?.sessionId ?? null
  const cached = connection?.agentType
    ? getCachedSelectors(connection.agentType)
    : null
  const hasCachedSelectors = cached !== null
  const connectedWorkingDir = connection?.workingDir ?? null
  const modes = connection?.modes ?? cached?.modes ?? null
  const configOptions =
    connection?.configOptions ?? cached?.configOptions ?? null
  const availableCommands = connection?.availableCommands ?? null
  const pendingPermission = connection?.pendingPermission ?? null
  const pendingUserMessage = connection?.pendingUserMessage ?? null
  const pendingQuestion = connection?.pendingQuestion ?? null
  const pendingAskQuestion = connection?.pendingAskQuestion ?? null
  const pendingPlanApproval = connection?.pendingPlanApproval ?? null
  const claudeApiRetry = connection?.claudeApiRetry ?? null
  const error = connection?.error ?? null
  const loadError = connection?.loadError ?? null
  const configStale = connection?.configStale ?? false
  const configStaleKind = connection?.configStaleKind ?? null
  const configStaleDismissed = connection?.configStaleDismissed ?? false
  const isDelegationChild = connection?.isDelegationChild ?? false
  const backgroundOutstanding = connection?.backgroundOutstanding ?? 0
  const backgroundOutstandingAgents =
    connection?.backgroundOutstandingAgents ?? 0
  const backgroundOutstandingShells =
    connection?.backgroundOutstandingShells ?? 0
  const backgroundSettleSyncingSince =
    connection?.backgroundSettleSyncingSince ?? null

  const connect = useCallback(
    (
      agentType: AgentType,
      workingDir?: string,
      sessionId?: string,
      conversationId?: number
    ) =>
      actions.connect(
        contextKey,
        agentType,
        workingDir,
        sessionId,
        conversationId
      ),
    [actions, contextKey]
  )

  const disconnect = useCallback(
    () => actions.disconnect(contextKey),
    [actions, contextKey]
  )

  const sendPrompt = useCallback(
    (
      blocks: PromptInputBlock[],
      opts?: {
        folderId?: number | null
        conversationId?: number | null
        clientMessageId?: string | null
      }
    ) => actions.sendPrompt(contextKey, blocks, opts),
    [actions, contextKey]
  )

  const setMode = useCallback(
    (modeId: string) => actions.setMode(contextKey, modeId),
    [actions, contextKey]
  )

  const setConfigOption = useCallback(
    (configId: string, valueId: string) =>
      actions.setConfigOption(contextKey, configId, valueId),
    [actions, contextKey]
  )

  const cancel = useCallback(
    () => actions.cancel(contextKey),
    [actions, contextKey]
  )

  const previewCancelScope = useCallback(
    () => actions.previewCancelScope(contextKey),
    [actions, contextKey]
  )

  const cancelWithScopeToken = useCallback(
    (scopeToken: string) =>
      actions.cancelWithScopeToken(contextKey, scopeToken),
    [actions, contextKey]
  )

  const steer = useCallback(
    (blocks: PromptInputBlock[], messageId: string) =>
      actions.steer(contextKey, blocks, messageId),
    [actions, contextKey]
  )

  const respondPermission = useCallback(
    (requestId: string, optionId: string) =>
      actions.respondPermission(contextKey, requestId, optionId),
    [actions, contextKey]
  )

  const answerQuestion = useCallback(
    (questionId: string, answer: QuestionAnswer) =>
      actions.answerQuestion(contextKey, questionId, answer),
    [actions, contextKey]
  )

  const reapplyConfig = useCallback(
    () => actions.reapplyConfig(contextKey),
    [actions, contextKey]
  )

  const dismissConfigStale = useCallback(
    () => actions.dismissConfigStale(contextKey),
    [actions, contextKey]
  )

  return useMemo(
    () => ({
      connectionId,
      agentType,
      isViewer,
      status,
      promptCapabilities,
      supportsFork,
      supportsSteering,
      selectorsReady,
      hasCachedSelectors,
      sessionId,
      connectedWorkingDir,
      modes,
      configOptions,
      availableCommands,
      pendingPermission,
      pendingUserMessage,
      pendingQuestion,
      pendingAskQuestion,
      pendingPlanApproval,
      claudeApiRetry,
      error,
      loadError,
      configStale,
      configStaleKind,
      configStaleDismissed,
      isDelegationChild,
      backgroundOutstanding,
      backgroundOutstandingAgents,
      backgroundOutstandingShells,
      backgroundSettleSyncingSince,
      connect,
      disconnect,
      reapplyConfig,
      dismissConfigStale,
      sendPrompt,
      setMode,
      setConfigOption,
      cancel,
      previewCancelScope,
      cancelWithScopeToken,
      steer,
      respondPermission,
      answerQuestion,
    }),
    [
      connectionId,
      agentType,
      isViewer,
      status,
      promptCapabilities,
      supportsFork,
      supportsSteering,
      selectorsReady,
      hasCachedSelectors,
      sessionId,
      connectedWorkingDir,
      modes,
      configOptions,
      availableCommands,
      pendingPermission,
      pendingUserMessage,
      pendingQuestion,
      pendingAskQuestion,
      pendingPlanApproval,
      claudeApiRetry,
      error,
      loadError,
      configStale,
      configStaleKind,
      configStaleDismissed,
      isDelegationChild,
      backgroundOutstanding,
      backgroundOutstandingAgents,
      backgroundOutstandingShells,
      backgroundSettleSyncingSince,
      connect,
      disconnect,
      reapplyConfig,
      dismissConfigStale,
      sendPrompt,
      setMode,
      setConfigOption,
      cancel,
      previewCancelScope,
      cancelWithScopeToken,
      steer,
      respondPermission,
      answerQuestion,
    ]
  )
}
