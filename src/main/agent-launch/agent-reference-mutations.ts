// Owner-specific agent-reference mutation engine (terminal quick commands,
// commit-message agent choice, Source Control AI settings). Enforces the
// field-level stale-reference write rule so unrelated edits save while a proven
// stale reference is preserved, and a *changed* agent must be a currently
// effectively enabled live identity.

import type {
  CommitMessageAiSettings,
  GlobalSettings,
  TerminalQuickCommand,
  TuiAgent
} from '../../shared/types'
import type { SourceControlAiSettings } from '../../shared/source-control-ai-types'
import type { AgentReferenceMutationRequest } from '../../shared/agent-reference-snapshot'
import { CUSTOM_AGENT_ID } from '../../shared/commit-message-agent-spec'
import { isBuiltInTuiAgent } from '../../shared/tui-agent-config'
import type { AgentCatalog } from '../../shared/custom-tui-agents'
import { supportsTerminalAgentQuickCommand } from '../../shared/terminal-quick-commands'
import { decideAgentField } from './agent-reference-field-decision'

export type AgentReferenceMutationError = {
  ok: false
  code:
    | 'reference_revision_conflict'
    | 'invalid_agent_reference'
    | 'invalid_reference_field'
    | 'agent_reference_payload_too_large'
  owner?: 'quick-command' | 'commit-message' | 'source-control-recipe'
  field?: string
  reason?: 'unknown_agent' | 'disabled_agent' | 'bounds' | 'conflict'
}

export type AgentReferenceMutationApplication =
  | {
      ok: true
      patch: Partial<GlobalSettings>
      newReferenceRevision: number
    }
  | AgentReferenceMutationError

export type ApplyAgentReferenceMutationArgs = {
  settings: GlobalSettings
  request: AgentReferenceMutationRequest
  currentReferenceRevision: number
  catalog: AgentCatalog
}

export function applyAgentReferenceMutation(
  args: ApplyAgentReferenceMutationArgs
): AgentReferenceMutationApplication {
  const { settings, request, currentReferenceRevision, catalog } = args
  if (request.expectedReferenceRevision !== currentReferenceRevision) {
    return { ok: false, code: 'reference_revision_conflict' }
  }
  const newReferenceRevision = currentReferenceRevision + 1
  const mutation = request.mutation

  switch (mutation.kind) {
    case 'quick-command-save': {
      const incoming = mutation.command
      if (
        !incoming ||
        typeof incoming !== 'object' ||
        typeof incoming.id !== 'string' ||
        incoming.id.length === 0 ||
        typeof incoming.label !== 'string'
      ) {
        return {
          ok: false,
          code: 'invalid_reference_field',
          owner: 'quick-command',
          reason: 'bounds'
        }
      }
      const commands = settings.terminalQuickCommands ?? []
      const existing = commands.find((command) => command.id === incoming.id)
      let toStore: TerminalQuickCommand = incoming
      if (incoming.action === 'agent-prompt') {
        const storedAgent =
          existing && existing.action === 'agent-prompt' ? existing.agent : undefined
        const decision = decideAgentField({
          incoming: incoming.agent,
          stored: storedAgent,
          catalog,
          allowCustomSentinel: false
        })
        if (!decision.ok) {
          return {
            ok: false,
            code: 'invalid_agent_reference',
            owner: 'quick-command',
            field: 'agent',
            reason: decision.reason
          }
        }
        // An agent-prompt quick command cannot exist without an agent: an
        // omitted field keeps the stored reference; there is nothing to clear to.
        const agent = decision.value === undefined ? storedAgent : decision.value
        if (agent === null || agent === undefined || agent === CUSTOM_AGENT_ID) {
          return {
            ok: false,
            code: 'invalid_agent_reference',
            owner: 'quick-command',
            field: 'agent',
            reason: 'unknown_agent'
          }
        }
        // Base capability must hold at save time: normalization silently drops
        // stdin-after-start rows later, so an incapable base must fail the save
        // rather than return ok while the command vanishes. A stale custom id
        // whose base cannot be proven stays preserved per the field-level rule.
        const capabilityBase = isBuiltInTuiAgent(agent)
          ? agent
          : catalog.liveById.get(agent)?.baseAgent
        if (capabilityBase !== undefined && !supportsTerminalAgentQuickCommand(capabilityBase)) {
          return {
            ok: false,
            code: 'invalid_agent_reference',
            owner: 'quick-command',
            field: 'agent',
            reason: 'unknown_agent'
          }
        }
        toStore = { ...incoming, agent }
      }
      const next = existing
        ? commands.map((command) => (command.id === incoming.id ? toStore : command))
        : [...commands, toStore]
      return {
        ok: true,
        patch: { terminalQuickCommands: next, agentReferenceRevision: newReferenceRevision },
        newReferenceRevision
      }
    }
    case 'quick-command-delete': {
      const commands = settings.terminalQuickCommands ?? []
      const next = commands.filter((command) => command.id !== mutation.id)
      return {
        ok: true,
        patch: { terminalQuickCommands: next, agentReferenceRevision: newReferenceRevision },
        newReferenceRevision
      }
    }
    case 'quick-commands-reorder': {
      const commands = settings.terminalQuickCommands ?? []
      const byId = new Map(commands.map((command) => [command.id, command]))
      if (
        mutation.orderedIds.length !== commands.length ||
        mutation.orderedIds.some((id) => !byId.has(id)) ||
        new Set(mutation.orderedIds).size !== mutation.orderedIds.length
      ) {
        return {
          ok: false,
          code: 'invalid_reference_field',
          owner: 'quick-command',
          reason: 'conflict'
        }
      }
      const next = mutation.orderedIds.map((id) => byId.get(id) as TerminalQuickCommand)
      return {
        ok: true,
        patch: { terminalQuickCommands: next, agentReferenceRevision: newReferenceRevision },
        newReferenceRevision
      }
    }
    case 'commit-message-update': {
      const stored = settings.commitMessageAi
      const decision = decideAgentField({
        incoming: 'agentId' in mutation.changes ? mutation.changes.agentId : undefined,
        stored: stored?.agentId ?? null,
        catalog,
        allowCustomSentinel: true
      })
      if (!decision.ok) {
        return {
          ok: false,
          code: 'invalid_agent_reference',
          owner: 'commit-message',
          field: 'agentId',
          reason: decision.reason
        }
      }
      const next: CommitMessageAiSettings = {
        ...(stored as CommitMessageAiSettings),
        ...mutation.changes,
        agentId:
          decision.value === undefined
            ? (stored?.agentId ?? null)
            : (decision.value as CommitMessageAiSettings['agentId'])
      }
      return {
        ok: true,
        patch: { commitMessageAi: next, agentReferenceRevision: newReferenceRevision },
        newReferenceRevision
      }
    }
    case 'source-control-update': {
      const stored = settings.sourceControlAi
      const decision = decideAgentField({
        incoming: 'agentId' in mutation.changes ? mutation.changes.agentId : undefined,
        stored: stored?.agentId ?? null,
        catalog,
        allowCustomSentinel: true
      })
      if (!decision.ok) {
        return {
          ok: false,
          code: 'invalid_agent_reference',
          owner: 'source-control-recipe',
          field: 'agentId',
          reason: decision.reason
        }
      }
      // Per-action recipes apply the same field-level rule row by row.
      let nextActions = stored?.actions
      if (mutation.changes.actions !== undefined) {
        const incomingActions = mutation.changes.actions ?? {}
        const merged: NonNullable<SourceControlAiSettings['actions']> = {
          ...stored?.actions
        }
        for (const [actionId, incomingAction] of Object.entries(incomingActions)) {
          // A "__proto__" key would hit the setter in the keyed assignment
          // below and rewrite merged's prototype instead of storing a row.
          if (actionId === '__proto__' || actionId === 'constructor' || actionId === 'prototype') {
            continue
          }
          const storedAction = stored?.actions?.[actionId as keyof typeof merged]
          if (incomingAction === undefined) {
            continue
          }
          const storedAgent =
            storedAction && typeof storedAction === 'object' && 'agentId' in storedAction
              ? (storedAction as { agentId?: unknown }).agentId
              : undefined
          const incomingAgent =
            incomingAction && typeof incomingAction === 'object' && 'agentId' in incomingAction
              ? (incomingAction as { agentId?: unknown }).agentId
              : undefined
          const actionDecision = decideAgentField({
            incoming: incomingAgent,
            stored: storedAgent ?? null,
            catalog,
            allowCustomSentinel: true
          })
          if (!actionDecision.ok) {
            return {
              ok: false,
              code: 'invalid_agent_reference',
              owner: 'source-control-recipe',
              field: actionId,
              reason: actionDecision.reason
            }
          }
          merged[actionId as keyof typeof merged] = {
            ...(storedAction as object),
            ...(incomingAction as object),
            agentId:
              actionDecision.value === undefined
                ? ((storedAgent ?? null) as TuiAgent | 'custom' | null)
                : (actionDecision.value as TuiAgent | 'custom' | null)
          } as NonNullable<SourceControlAiSettings['actions']>[keyof typeof merged]
        }
        nextActions = merged
      }
      const next: SourceControlAiSettings = {
        ...(stored as SourceControlAiSettings),
        ...mutation.changes,
        agentId:
          decision.value === undefined
            ? (stored?.agentId ?? null)
            : (decision.value as SourceControlAiSettings['agentId']),
        ...(nextActions !== undefined ? { actions: nextActions } : {})
      }
      return {
        ok: true,
        patch: { sourceControlAi: next, agentReferenceRevision: newReferenceRevision },
        newReferenceRevision
      }
    }
  }
}
