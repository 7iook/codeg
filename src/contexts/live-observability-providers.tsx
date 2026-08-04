"use client"

/**
 * The providers that make live sub-agent work observable, composed in one
 * place: `DelegationProvider` (codeg's own delegated sub-sessions, keyed by the
 * parent's `delegate_to_agent` tool-use id), `SubagentTranscriptProvider`
 * (Claude's BUILT-IN Agent/Task sub-agents, keyed by that Task's tool-use id),
 * and `ObservatoryActionsProvider` (the cancel request and the two
 * reconciliation reads that act on the first of those).
 *
 * They are siblings by construction: both listen on the same `useAcpEvent`
 * fanout, both index by a parent tool-use id, and both are read by renderers
 * deep in the message list that have no `contextKey` in hand. Composing them
 * here keeps the workspace layout's provider stack from growing another level
 * for what is one concern — observing sub-agent work — and gives future
 * observability providers one obvious place to land.
 *
 * Order: delegation outermost, matching the previous layout nesting so a
 * delegation child's transcript context resolution is unchanged. The actions
 * provider is innermost because it CONSUMES the delegation projection, and it
 * belongs at this level rather than in the panel so that one reconnect fires one
 * authoritative read per running row no matter how many panes are open.
 */

import type { ReactNode } from "react"

import { DelegationProvider } from "@/contexts/delegation-context"
import { ObservatoryActionsProvider } from "@/contexts/observatory-actions-context"
import { SubagentTranscriptProvider } from "@/contexts/subagent-transcript-context"

export function LiveObservabilityProviders({
  children,
}: {
  children: ReactNode
}) {
  return (
    <DelegationProvider>
      <SubagentTranscriptProvider>
        <ObservatoryActionsProvider>{children}</ObservatoryActionsProvider>
      </SubagentTranscriptProvider>
    </DelegationProvider>
  )
}
