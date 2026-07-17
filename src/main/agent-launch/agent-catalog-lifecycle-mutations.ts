// Lifecycle mutations for custom agents: create, duplicate, update-custom,
// delete, set-enabled, and set-default. Each returns one atomic settings patch
// and performs no write on failure.

import type {
  BuiltInTuiAgent,
  CustomTuiAgent,
  CustomTuiAgentId,
  DeletedCustomTuiAgent,
  GlobalSettings,
  TuiAgent
} from '../../shared/types'
import type { CustomAgentDraft } from '../../shared/agent-catalog-snapshot'
import {
  isCustomTuiAgentId,
  mintCustomTuiAgentId,
  normalizeAgentLabelKey,
  type AgentCatalog
} from '../../shared/custom-tui-agents'
import { isBuiltInTuiAgent } from '../../shared/tui-agent-config'
import {
  draftToDefinition,
  labelCollides,
  stripAgentKeyedModelCaches,
  validateDraft,
  type AgentCatalogMutationApplication
} from './agent-catalog-draft-validation'
import {
  pruneTombstones,
  stripRowsSuppressedByPrunedTombstones
} from './agent-catalog-tombstone-gc'
import {
  isLegacyAgentPrefixPlatformAmbiguous,
  tokenizeLegacyAgentPrefix
} from '../../shared/legacy-agent-prefix-tokenizer'
import type { ApplyAgentCatalogMutationArgs, MutationContext } from './agent-catalog-mutations'

export function applyCreate(
  baseAgent: BuiltInTuiAgent,
  draft: CustomAgentDraft,
  context: MutationContext
): AgentCatalogMutationApplication {
  if (!isBuiltInTuiAgent(baseAgent)) {
    return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
  }
  const draftError = validateDraft(draft)
  if (draftError) {
    return draftError
  }
  // Prune before label validation so a freed tombstone label can be reused.
  const { retained, prunedIds } = pruneTombstones(
    context.persistedTombstones,
    context.args.countTombstoneReferences
  )
  const candidateKey = normalizeAgentLabelKey(draft.label)
  if (labelCollides(candidateKey, context.catalog, retained)) {
    return { ok: false, code: 'duplicate_agent_label', field: 'label' }
  }
  const id = mintCustomTuiAgentId(baseAgent)
  const definition = draftToDefinition(id, baseAgent, draft)
  // A pruned tombstone must not resurrect its suppressed same-id row.
  const nextLive = stripRowsSuppressedByPrunedTombstones(
    context.persistedLive,
    prunedIds,
    context.catalog
  )
  return {
    ok: true,
    patch: {
      customTuiAgents: [...nextLive, definition] as CustomTuiAgent[],
      deletedCustomTuiAgents: retained,
      agentCatalogRevision: context.newRevision
    },
    newRevision: context.newRevision,
    mintedId: id,
    prunedTombstoneIds: prunedIds
  }
}

export function applyDuplicate(
  sourceAgent: TuiAgent,
  label: string,
  context: MutationContext
): AgentCatalogMutationApplication {
  const settings = context.args.settings
  let baseAgent: BuiltInTuiAgent
  let draft: CustomAgentDraft
  if (isBuiltInTuiAgent(sourceAgent)) {
    baseAgent = sourceAgent
    const prefix = settings.agentCmdOverrides?.[sourceAgent]
    let commandOverride: string | null = null
    let prefixArgs = ''
    if (typeof prefix === 'string' && prefix.trim().length > 0) {
      // Main repeats the cross-shell equivalence gate even when the dialog was
      // bypassed: an ambiguous raw prefix must not be split by guessing one
      // platform's grammar.
      if (isLegacyAgentPrefixPlatformAmbiguous(prefix)) {
        return {
          ok: false,
          code: 'invalid_agent_field',
          field: 'commandOverride',
          reason: 'platform_ambiguous'
        }
      }
      // Ambiguity is excluded, so every grammar agrees — posix serves. A uniform
      // tokenize failure (operator/control/unterminated) surfaces for repair
      // instead of being split.
      const tokenized = tokenizeLegacyAgentPrefix(prefix, 'posix')
      if (!tokenized.ok) {
        return {
          ok: false,
          code: 'invalid_agent_field',
          field: 'commandOverride',
          reason: tokenized.reason
        }
      }
      commandOverride = tokenized.tokens[0] ?? null
      prefixArgs = tokenized.tokens.slice(1).join(' ')
    }
    const userArgs = settings.agentDefaultArgs?.[sourceAgent] ?? ''
    const combinedArgs = [prefixArgs, userArgs].filter((part) => part.length > 0).join(' ')
    draft = {
      label,
      commandOverride,
      args: combinedArgs,
      env: { ...settings.agentDefaultEnv?.[sourceAgent] },
      syncEnv: false
    }
  } else {
    // Duplicate requires a live source at the expected revision — never a
    // tombstone (deleted config is unrecoverable by design).
    const source = context.catalog.liveById.get(sourceAgent as CustomTuiAgentId)
    if (!source) {
      return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
    }
    baseAgent = source.baseAgent
    draft = {
      label,
      commandOverride: source.commandOverride ?? null,
      args: source.args,
      env: { ...source.env },
      // Duplicate always resets paired-launch env opt-in to off.
      syncEnv: false
    }
  }
  // A duplicate of a disabled live custom stays enabled: the new id is not in
  // disabledTuiAgents and the user re-disables explicitly if wanted.
  return applyCreate(baseAgent, draft, context)
}

export function applyUpdateCustom(
  id: CustomTuiAgentId,
  changes: CustomAgentDraft,
  context: MutationContext
): AgentCatalogMutationApplication {
  const { args, catalog, persistedLive, persistedTombstones, newRevision } = context
  const existing = catalog.liveById.get(id)
  const repairRow = catalog.repairRequiredById.get(id)
  if (!existing && !repairRow) {
    return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
  }
  const baseAgent = existing?.baseAgent ?? repairRow?.baseAgent
  if (!baseAgent) {
    return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
  }
  const draftError = validateDraft(changes)
  if (draftError) {
    return draftError
  }
  const candidateKey = normalizeAgentLabelKey(changes.label)
  // The label check passes against pruned tombstones, so the prune must land in
  // the same write (applyCreate's rule) or a live agent could take a freed
  // tombstone's label while the same-label tombstone stays persisted.
  const { retained, prunedIds } = pruneTombstones(
    persistedTombstones,
    args.countTombstoneReferences
  )
  if (labelCollides(candidateKey, catalog, retained, id)) {
    return { ok: false, code: 'duplicate_agent_label', field: 'label' }
  }
  const nextDefinition = draftToDefinition(id, baseAgent, changes)
  // A pruned tombstone must not resurrect its suppressed same-id row; updates
  // preserve the row's physical index (creation-order authority).
  const nextLive = stripRowsSuppressedByPrunedTombstones(persistedLive, prunedIds, catalog).map(
    (row) => {
      const rowId = (row as { id?: unknown })?.id
      return rowId === id ? nextDefinition : row
    }
  )
  return {
    ok: true,
    patch: {
      customTuiAgents: nextLive as CustomTuiAgent[],
      deletedCustomTuiAgents: retained,
      agentCatalogRevision: newRevision
    },
    newRevision,
    prunedTombstoneIds: prunedIds
  }
}

export function applyDelete(
  id: CustomTuiAgentId,
  onDefault: 'keep' | 'base' | 'auto' | 'clear',
  context: MutationContext
): AgentCatalogMutationApplication {
  const { catalog, args } = context
  const existing = catalog.liveById.get(id) ?? null
  const repairRow = catalog.repairRequiredById.get(id) ?? null
  if (!existing && !repairRow) {
    return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
  }
  const baseAgent = existing?.baseAgent ?? repairRow?.baseAgent
  const label = existing?.label ?? repairRow?.label ?? ''
  if (!baseAgent) {
    return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
  }
  // Tombstone before removing the live entry so a crash between the two can
  // only over-retain, never resurrect or orphan references.
  const tombstone: DeletedCustomTuiAgent = {
    id,
    baseAgent,
    label,
    deletedAt: Date.now()
  }
  const nextTombstones = [
    ...context.persistedTombstones.filter((entry) => entry.id !== id),
    tombstone
  ]
  const nextLive = context.persistedLive.filter((row) => (row as { id?: unknown })?.id !== id)
  const nextDisabled = (args.settings.disabledTuiAgents ?? []).filter((entry) => entry !== id)

  const patch: Partial<GlobalSettings> = {
    customTuiAgents: nextLive as CustomTuiAgent[],
    deletedCustomTuiAgents: nextTombstones,
    disabledTuiAgents: nextDisabled,
    agentCatalogRevision: context.newRevision,
    ...stripAgentKeyedModelCaches(args.settings, id)
  }

  if (args.settings.defaultTuiAgent === id) {
    switch (onDefault) {
      case 'keep':
        break
      case 'base':
        // Rebinding to the base requires the base to be currently enabled;
        // otherwise fall through to clear so the default never lands disabled.
        patch.defaultTuiAgent = catalog.disabledAgents.has(baseAgent) ? null : baseAgent
        break
      case 'auto':
        patch.defaultTuiAgent = 'auto'
        break
      case 'clear':
        patch.defaultTuiAgent = null
        break
    }
  }

  return {
    ok: true,
    patch,
    newRevision: context.newRevision,
    prunedTombstoneIds: []
  }
}

export function applySetEnabled(
  agent: TuiAgent,
  enabled: boolean,
  context: { args: ApplyAgentCatalogMutationArgs; catalog: AgentCatalog; newRevision: number }
): AgentCatalogMutationApplication {
  const { catalog, args } = context
  const known =
    isBuiltInTuiAgent(agent) ||
    (isCustomTuiAgentId(agent) &&
      (catalog.liveById.has(agent) || catalog.repairRequiredById.has(agent)))
  if (!known) {
    return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
  }
  const current = args.settings.disabledTuiAgents ?? []
  const without = current.filter((entry) => entry !== agent)
  const nextDisabled = enabled ? without : [...without, agent]
  const patch: Partial<GlobalSettings> = {
    disabledTuiAgents: nextDisabled,
    agentCatalogRevision: context.newRevision
  }
  if (!enabled && isBuiltInTuiAgent(agent)) {
    // Disabling a base repairs a base/derivative default to null in the same
    // write: no fallback is launchable under a disabled base. Auto stays Auto.
    const currentDefault = args.settings.defaultTuiAgent
    if (currentDefault === agent) {
      patch.defaultTuiAgent = null
    } else if (isCustomTuiAgentId(currentDefault ?? undefined)) {
      const identity =
        catalog.liveById.get(currentDefault as CustomTuiAgentId) ??
        catalog.tombstonesById.get(currentDefault as CustomTuiAgentId) ??
        catalog.repairRequiredById.get(currentDefault as CustomTuiAgentId)
      if (identity && 'baseAgent' in identity && identity.baseAgent === agent) {
        patch.defaultTuiAgent = null
      }
    }
  }
  return { ok: true, patch, newRevision: context.newRevision, prunedTombstoneIds: [] }
}

export function applySetDefault(
  target: TuiAgent | 'auto' | 'blank',
  catalog: AgentCatalog,
  newRevision: number
): AgentCatalogMutationApplication {
  if (target !== 'auto' && target !== 'blank') {
    const identity = isBuiltInTuiAgent(target)
      ? target
      : catalog.liveById.get(target)
        ? target
        : null
    if (!identity) {
      return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
    }
    const base = isBuiltInTuiAgent(target)
      ? target
      : catalog.liveById.get(target as CustomTuiAgentId)?.baseAgent
    if (
      catalog.disabledAgents.has(target) ||
      (base !== undefined && catalog.disabledAgents.has(base))
    ) {
      return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
    }
  }
  return {
    ok: true,
    patch: { defaultTuiAgent: target, agentCatalogRevision: newRevision },
    newRevision,
    prunedTombstoneIds: []
  }
}
