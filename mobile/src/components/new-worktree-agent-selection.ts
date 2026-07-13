import type { BuiltInTuiAgent, TuiAgent } from '../../../src/shared/types'
import type { AgentCatalogValue } from '../transport/agent-catalog-sync'
import { isMobileTuiAgentEnabled } from '../tasks/mobile-tui-agents'
import {
  buildMobileAgentPickerRows,
  type MobileAgentPickerOptions
} from '../tasks/mobile-agent-catalog-projection'
import { pickWorkspaceAgent } from '../tasks/workspace-agent-selection'

export type NewWorktreeRuntimeSettings = {
  defaultTuiAgent?: TuiAgent | 'blank' | null
  disabledTuiAgents?: TuiAgent[]
}

export type NewWorktreeAgentOption = {
  id: TuiAgent | '__blank__'
  label: string
  faviconDomain?: string
  isCustom?: boolean
  // Present only on custom rows: the base harness whose icon the row shows.
  baseAgent?: BuiltInTuiAgent
}

/** Picker options sourced from the host's env-free synced catalog, falling back to
 *  the static built-in rows when no snapshot is passed. Customs stay off until the
 *  identity-launch flip enables them (see `MobileAgentPickerOptions`). */
export function buildNewWorktreeAgentOptions(
  snapshot: AgentCatalogValue | null,
  options: MobileAgentPickerOptions = {}
): NewWorktreeAgentOption[] {
  return buildMobileAgentPickerRows(snapshot, options).map((row) => ({
    id: row.id,
    label: row.label,
    ...(row.faviconDomain ? { faviconDomain: row.faviconDomain } : {}),
    isCustom: row.isCustom,
    ...(row.baseAgent ? { baseAgent: row.baseAgent } : {})
  }))
}

export const NEW_WORKTREE_AGENT_OPTIONS: NewWorktreeAgentOption[] =
  buildNewWorktreeAgentOptions(null)

export const NEW_WORKTREE_BLANK_AGENT: NewWorktreeAgentOption = {
  id: '__blank__',
  label: 'Blank Terminal'
}

export function newWorktreeAgentOptionFor(id: string | null | undefined): NewWorktreeAgentOption {
  if (id === 'blank' || id === '__blank__') {
    return NEW_WORKTREE_BLANK_AGENT
  }
  return NEW_WORKTREE_AGENT_OPTIONS.find((agent) => agent.id === id) ?? NEW_WORKTREE_BLANK_AGENT
}

export function pickPreferredNewWorktreeAgent(
  settings: NewWorktreeRuntimeSettings | null,
  detectedAgentIds: Set<string> | null
): NewWorktreeAgentOption {
  return newWorktreeAgentOptionFor(
    pickWorkspaceAgent(
      {
        defaultTuiAgent: settings?.defaultTuiAgent,
        disabledTuiAgents: settings?.disabledTuiAgents
      },
      detectedAgentIds
    )
  )
}

function isNewWorktreeAgentOptionSelectable(
  option: NewWorktreeAgentOption,
  detectedAgentIds: Set<string> | null,
  disabledTuiAgents: TuiAgent[] | undefined
): boolean {
  if (option.id === '__blank__') {
    return true
  }
  if (option.isCustom && option.baseAgent) {
    // Why: a custom agent's availability keys off its base harness — custom ids
    // never appear in the built-in detection set, so gating on the id would hide
    // every custom row and repair away a custom selection.
    return detectedAgentIds === null || detectedAgentIds.has(option.baseAgent)
  }
  if (!isMobileTuiAgentEnabled(option.id, disabledTuiAgents)) {
    return false
  }
  return detectedAgentIds === null || detectedAgentIds.has(option.id)
}

/** Picker rows sourced from the host's env-free synced catalog and narrowed to what
 *  is launchable on the target connection. Customs are gated on their base harness'
 *  detection; the projection already excludes disabled/repair-required customs. */
export function buildSelectableNewWorktreeAgentOptions(args: {
  snapshot: AgentCatalogValue | null
  includeCustomAgents: boolean
  detectedAgentIds: Set<string> | null
  disabledTuiAgents?: TuiAgent[]
}): NewWorktreeAgentOption[] {
  const { snapshot, includeCustomAgents, detectedAgentIds, disabledTuiAgents } = args
  return buildNewWorktreeAgentOptions(snapshot, { includeCustomAgents }).filter((option) =>
    isNewWorktreeAgentOptionSelectable(option, detectedAgentIds, disabledTuiAgents)
  )
}

function isSelectableAgent(
  agent: NewWorktreeAgentOption,
  settings: NewWorktreeRuntimeSettings | null,
  detectedAgentIds: Set<string> | null
): boolean {
  return isNewWorktreeAgentOptionSelectable(agent, detectedAgentIds, settings?.disabledTuiAgents)
}

export function resolveNewWorktreeAgentSelection({
  visible,
  selectedAgent,
  agentOverridden,
  runtimeSettings,
  detectedAgentIds
}: {
  visible: boolean
  selectedAgent: NewWorktreeAgentOption
  agentOverridden: boolean
  runtimeSettings: NewWorktreeRuntimeSettings | null
  detectedAgentIds: Set<string> | null
}): { selectedAgent: NewWorktreeAgentOption; agentOverridden: boolean } {
  if (!visible) {
    return { selectedAgent, agentOverridden }
  }

  const preferred = pickPreferredNewWorktreeAgent(runtimeSettings, detectedAgentIds)
  if (!agentOverridden) {
    return { selectedAgent: preferred, agentOverridden: false }
  }

  if (
    detectedAgentIds !== null &&
    !isSelectableAgent(selectedAgent, runtimeSettings, detectedAgentIds)
  ) {
    return { selectedAgent: preferred, agentOverridden: false }
  }

  return { selectedAgent, agentOverridden: true }
}
