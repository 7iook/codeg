import type { AgentType } from "@/lib/types"

/**
 * Terminal resume-command templates per agent CLI, for the conversation
 * header's "copy resume command" action (pattern borrowed from
 * claude-code-history-viewer's `getResumeCommand`).
 *
 * Fail-closed on BOTH axes:
 *  - The session id is pasted into a shell command, so only the charset the
 *    CLIs actually emit (UUIDs / hex hashes) is allowed — a crafted or
 *    corrupted external_id must not be able to extend the command.
 *  - Agents whose CLI resume syntax is unverified return null (the menu item
 *    hides) rather than guessing a command that silently fails in the user's
 *    terminal. Extend the table as syntaxes are confirmed.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/

export function getAgentResumeCommand(
  agentType: AgentType,
  externalId: string | null | undefined
): string | null {
  if (!externalId || !SAFE_SESSION_ID.test(externalId)) return null
  switch (agentType) {
    case "claude_code":
      return `claude --resume ${externalId}`
    case "codex":
      return `codex resume ${externalId}`
    case "kimi_code":
      return `kimi -r ${externalId}`
    default:
      return null
  }
}
