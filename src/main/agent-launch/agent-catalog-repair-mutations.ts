// Corrupt-row repair mutations and the repair-token registry. Repair tokens are
// revision-scoped, per-physical-record handles; duplicate-id groups resolve
// atomically. Never persisted, synced, or logged.

import { createHash } from 'node:crypto'
import type { BuiltInTuiAgent, CustomTuiAgent, CustomTuiAgentId } from '../../shared/types'
import type { CustomAgentDraft } from '../../shared/agent-catalog-snapshot'
import {
  mintCustomTuiAgentId,
  normalizeAgentLabelKey,
  type CorruptCatalogRow
} from '../../shared/custom-tui-agents'
import { isBuiltInTuiAgent } from '../../shared/tui-agent-config'
import {
  draftToDefinition,
  labelCollides,
  validateDraft,
  type AgentCatalogMutationApplication
} from './agent-catalog-draft-validation'
import type { MutationContext } from './agent-catalog-mutations'

/** Repair tokens are minted per physical corrupt record and stay stable while
 *  that record (content and position) is unchanged, so editor focus/drafts do
 *  not remount on unrelated revisions. They are never persisted, synced, or
 *  logged, and resolve only with the exact current catalog revision. */
export class AgentCatalogRepairTokenRegistry {
  private readonly tokensByRecordKey = new Map<string, string>()

  private recordKey(row: CorruptCatalogRow): string {
    const contentHash = createHash('sha256')
      .update(JSON.stringify(row.raw) ?? 'null')
      .digest('hex')
    return `${contentHash}:${row.physicalIndex}`
  }

  tokenFor(row: CorruptCatalogRow): string {
    const key = this.recordKey(row)
    const existing = this.tokensByRecordKey.get(key)
    if (existing) {
      return existing
    }
    const token = createHash('sha256')
      .update(`${key}:${crypto.randomUUID()}`)
      .digest('hex')
      .slice(0, 32)
    this.tokensByRecordKey.set(key, token)
    return token
  }

  resolve(token: string, rows: readonly CorruptCatalogRow[]): CorruptCatalogRow | null {
    for (const row of rows) {
      if (this.tokenFor(row) === token) {
        return row
      }
    }
    return null
  }
}

export type RepairContext = MutationContext & { repairTokens: AgentCatalogRepairTokenRegistry }

export function applyRepairCorrupt(
  repairToken: string,
  action:
    | { kind: 'discard' }
    | { kind: 'replace'; baseAgent: BuiltInTuiAgent; draft: CustomAgentDraft },
  context: RepairContext
): AgentCatalogMutationApplication {
  const row = context.repairTokens.resolve(repairToken, context.catalog.corruptRows)
  if (!row) {
    return { ok: false, code: 'stale_agent_repair_token' }
  }
  // Duplicate-id rows reject single-row repair: the group must resolve at once.
  if (row.issues.some((issue) => issue.reason === 'duplicate_id')) {
    return { ok: false, code: 'invalid_agent_field', reason: 'duplicate_id' }
  }
  const nextLive = [...context.persistedLive]
  if (row.physicalIndex < 0 || row.physicalIndex >= nextLive.length) {
    return { ok: false, code: 'stale_agent_repair_token' }
  }
  if (action.kind === 'discard') {
    nextLive.splice(row.physicalIndex, 1)
    return {
      ok: true,
      patch: {
        customTuiAgents: nextLive as CustomTuiAgent[],
        agentCatalogRevision: context.newRevision
      },
      newRevision: context.newRevision,
      prunedTombstoneIds: []
    }
  }
  if (!isBuiltInTuiAgent(action.baseAgent)) {
    return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
  }
  const draftError = validateDraft(action.draft)
  if (draftError) {
    return draftError
  }
  const retained = context.persistedTombstones.filter(
    (tombstone) => context.args.countTombstoneReferences(tombstone.id) !== 0
  )
  const candidateKey = normalizeAgentLabelKey(action.draft.label)
  if (labelCollides(candidateKey, context.catalog, retained)) {
    return { ok: false, code: 'duplicate_agent_label', field: 'label' }
  }
  // Replace mints a new canonical id in the same physical slot for stable
  // visual order; it never creates a tombstone for the untrusted old id and
  // never rebinds any reference.
  const id = mintCustomTuiAgentId(action.baseAgent)
  nextLive.splice(row.physicalIndex, 1, draftToDefinition(id, action.baseAgent, action.draft))
  return {
    ok: true,
    patch: {
      customTuiAgents: nextLive as CustomTuiAgent[],
      agentCatalogRevision: context.newRevision
    },
    newRevision: context.newRevision,
    mintedId: id,
    prunedTombstoneIds: []
  }
}

export function applyResolveDuplicateId(
  duplicateId: CustomTuiAgentId,
  rows: readonly {
    repairToken: string
    action:
      | { kind: 'keep-for-existing-references'; repairedDraft: CustomAgentDraft }
      | { kind: 'discard' }
      | { kind: 'replace'; baseAgent: BuiltInTuiAgent; draft: CustomAgentDraft }
  }[],
  context: RepairContext
): AgentCatalogMutationApplication {
  const groupRows = context.catalog.corruptRows.filter(
    (row) => row.id === duplicateId && row.issues.some((issue) => issue.reason === 'duplicate_id')
  )
  if (groupRows.length === 0) {
    return { ok: false, code: 'stale_agent_repair_token' }
  }
  // The submitted tokens must cover the exact current duplicate group once each.
  const resolved = new Map<CorruptCatalogRow, (typeof rows)[number]>()
  for (const submitted of rows) {
    const row = context.repairTokens.resolve(submitted.repairToken, groupRows)
    if (!row || resolved.has(row)) {
      return { ok: false, code: 'stale_agent_repair_token' }
    }
    resolved.set(row, submitted)
  }
  if (resolved.size !== groupRows.length) {
    return { ok: false, code: 'stale_agent_repair_token' }
  }
  const keeps = rows.filter((row) => row.action.kind === 'keep-for-existing-references')
  if (keeps.length > 1) {
    return { ok: false, code: 'invalid_agent_field', reason: 'duplicate_id' }
  }

  const parsedBase = context.catalog.corruptRows.find((row) => row.id === duplicateId)?.baseAgent
  const replacements = new Map<number, CustomTuiAgent | null>()
  let mintedId: CustomTuiAgentId | undefined
  const retained = context.persistedTombstones.filter(
    (tombstone) => context.args.countTombstoneReferences(tombstone.id) !== 0
  )
  const pendingLabels: string[] = []
  for (const [row, submitted] of resolved) {
    if (submitted.action.kind === 'discard') {
      replacements.set(row.physicalIndex, null)
      continue
    }
    if (submitted.action.kind === 'keep-for-existing-references') {
      if (!parsedBase) {
        return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
      }
      const draftError = validateDraft(submitted.action.repairedDraft)
      if (draftError) {
        return draftError
      }
      const key = normalizeAgentLabelKey(submitted.action.repairedDraft.label)
      if (labelCollides(key, context.catalog, retained) || pendingLabels.includes(key)) {
        return { ok: false, code: 'duplicate_agent_label', field: 'label' }
      }
      pendingLabels.push(key)
      // The kept row preserves the old id only after this explicit choice.
      replacements.set(
        row.physicalIndex,
        draftToDefinition(duplicateId, parsedBase, submitted.action.repairedDraft)
      )
      continue
    }
    if (!isBuiltInTuiAgent(submitted.action.baseAgent)) {
      return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
    }
    const draftError = validateDraft(submitted.action.draft)
    if (draftError) {
      return draftError
    }
    const key = normalizeAgentLabelKey(submitted.action.draft.label)
    if (labelCollides(key, context.catalog, retained) || pendingLabels.includes(key)) {
      return { ok: false, code: 'duplicate_agent_label', field: 'label' }
    }
    pendingLabels.push(key)
    const id = mintCustomTuiAgentId(submitted.action.baseAgent)
    mintedId = id
    replacements.set(
      row.physicalIndex,
      draftToDefinition(id, submitted.action.baseAgent, submitted.action.draft)
    )
  }

  const nextLive: unknown[] = []
  context.persistedLive.forEach((row, index) => {
    if (!replacements.has(index)) {
      nextLive.push(row)
      return
    }
    const replacement = replacements.get(index)
    if (replacement !== null && replacement !== undefined) {
      nextLive.push(replacement)
    }
  })

  return {
    ok: true,
    patch: {
      customTuiAgents: nextLive as CustomTuiAgent[],
      agentCatalogRevision: context.newRevision
    },
    newRevision: context.newRevision,
    ...(mintedId ? { mintedId } : {}),
    prunedTombstoneIds: []
  }
}
