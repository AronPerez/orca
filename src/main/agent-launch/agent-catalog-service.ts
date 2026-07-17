// Main-owned agent-catalog service: the single authoring authority. Desktop
// Settings mutate through it (never by writing whole settings arrays), it owns
// repair tokens and the tombstone reference index, and it enforces the local
// (16 MiB) and remote-projection (512 KiB) payload budgets before any write.

import type { Store } from '../persistence'
import type { BuiltInTuiAgent, CustomTuiAgentId, GlobalSettings } from '../../shared/types'
import type {
  AgentCatalogMutationRequest,
  AgentCatalogMutationResult,
  LocalAgentCatalogSnapshot,
  LocalCustomAgentDraftResult
} from '../../shared/agent-catalog-snapshot'
import { MAX_LOCAL_AGENT_DRAFT_BYTES } from '../../shared/agent-catalog-snapshot'
import { utf8ByteLength } from '../../shared/custom-tui-agents'
import {
  AgentCatalogRepairTokenRegistry,
  applyAgentCatalogMutation
} from './agent-catalog-mutations'
import {
  buildAgentCatalogSnapshot,
  buildLocalAgentCatalogSnapshot,
  measureAgentCatalogProjection,
  measureLocalAgentCatalogStorage,
  normalizeCatalogFromSettings
} from './agent-catalog-projections'
import {
  AgentTombstoneReferenceIndex,
  type AgentReferenceSummary
} from './agent-tombstone-reference-index'
import { registerBuiltInOwnerScanners } from './agent-catalog-owner-scanners'
import {
  buildAgentReferenceSnapshot,
  measureAgentReferenceProjection
} from './agent-reference-snapshot-projection'
import {
  agentCatalogMigrationBlockedError,
  isSecurityReducingMutation,
  type AgentCatalogMigrationBlockedError
} from './agent-catalog-write-policy'
import { getHostAgentSessionRecordStore } from './agent-session-record-store-host'
import { applyAgentReferenceMutation } from './agent-reference-mutations'
import type {
  AgentReferenceMutationRequest,
  AgentReferenceMutationResult,
  AgentReferenceProjectionError,
  AgentReferenceSnapshot,
  BaseDisableImpact,
  LocalAgentReferenceSnapshot
} from '../../shared/agent-reference-snapshot'

let serviceInstance: AgentCatalogService | null = null
let serviceStore: Store | null = null

/** One service per Store instance (profile switching replaces the Store). Both
 *  local IPC and the runtime RPC layer must share this instance so repair
 *  tokens and reference scanners agree. */
export function getOrCreateAgentCatalogService(store: Store): AgentCatalogService {
  if (!serviceInstance || serviceStore !== store) {
    serviceInstance = new AgentCatalogService(store)
    serviceStore = store
  }
  return serviceInstance
}

export class AgentCatalogService {
  private readonly repairTokens = new AgentCatalogRepairTokenRegistry()
  private readonly referenceIndex = new AgentTombstoneReferenceIndex()
  private readonly changeListeners = new Set<(revision: number) => void>()

  constructor(private readonly store: Store) {
    registerBuiltInOwnerScanners(this.referenceIndex, this.store)
  }

  /** Later units (worktree pending launches, background attempts, orchestration,
   *  sleeping sessions) register their owner scanners through this. */
  get tombstoneReferenceIndex(): AgentTombstoneReferenceIndex {
    return this.referenceIndex
  }

  onDidChange(listener: (revision: number) => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  getRevision(): number {
    return this.store.getSettings().agentCatalogRevision ?? 1
  }

  getLocalSnapshot(): LocalAgentCatalogSnapshot {
    return buildLocalAgentCatalogSnapshot(this.store.getSettings(), this.repairTokens)
  }

  getRemoteSnapshot(): ReturnType<typeof buildAgentCatalogSnapshot> {
    return buildAgentCatalogSnapshot(this.store.getSettings())
  }

  /** Local-desktop-only reference summary for delete confirmation and "Review
   *  references"; owner kind + count only, no prompt/config/env. */
  getReferenceSummaries(id: CustomTuiAgentId): AgentReferenceSummary[] {
    return this.referenceIndex.summarizeReferences(id)
  }

  /** §973 base-disable impact: the counts of persisted-owner references and
   *  resumable sessions that will block when a built-in base is disabled. Saved
   *  references include the base id and any live custom derivative of it (a
   *  derivative can't launch without its harness); sessions are counted by base
   *  and excluded from the reference scan so the two counts never overlap. Counts
   *  only — never a label or config. Enabled-derivative counts stay client-side. */
  getBaseDisableImpact(base: BuiltInTuiAgent): BaseDisableImpact {
    const catalog = normalizeCatalogFromSettings(this.store.getSettings())
    const derivativeIds = new Set<string>()
    for (const agent of catalog.liveCustomAgents) {
      if (agent.baseAgent === base) {
        derivativeIds.add(agent.id)
      }
    }
    const matches = (value: unknown): boolean =>
      value === base || (typeof value === 'string' && derivativeIds.has(value))
    const saved = this.referenceIndex.countMatchingReferences(matches, {
      excludeOwners: new Set(['session'])
    })
    let resumableSessions: BaseDisableImpact['resumableSessions']
    try {
      resumableSessions = {
        count: getHostAgentSessionRecordStore().countRecordsByBase(base),
        atLeast: false
      }
    } catch {
      resumableSessions = { count: 0, atLeast: true }
    }
    return {
      savedReferences: { count: saved.count, atLeast: !saved.complete },
      resumableSessions
    }
  }

  /** Single-record full-env editor read, access-checked by the preload boundary
   *  and capped at 1 MiB. Never registered as a runtime RPC. */
  getLocalDraft(
    locator: { id: CustomTuiAgentId } | { repairToken: string },
    expectedRevision: number
  ): LocalCustomAgentDraftResult | { status: 'stale' } {
    const settings = this.store.getSettings()
    const revision = settings.agentCatalogRevision ?? 1
    if (expectedRevision !== revision) {
      return { status: 'stale' }
    }
    const catalog = normalizeCatalogFromSettings(settings)
    const raw: unknown =
      'id' in locator
        ? (catalog.liveById.get(locator.id) ??
          catalog.repairRequiredById.get(locator.id)?.raw ??
          null)
        : this.repairTokens.resolve(locator.repairToken, [
            ...catalog.corruptRows,
            ...catalog.repairRequiredById.values()
          ])?.raw
    if (raw === null || raw === undefined) {
      return { status: 'stale' }
    }
    const bytes = utf8ByteLength(JSON.stringify(raw) ?? 'null')
    if (bytes > MAX_LOCAL_AGENT_DRAFT_BYTES) {
      return { status: 'too-large', revision, bytes, maxBytes: MAX_LOCAL_AGENT_DRAFT_BYTES }
    }
    const record = raw as Record<string, unknown>
    return {
      status: 'ready',
      revision,
      draft: {
        label: typeof record.label === 'string' ? record.label : '',
        commandOverride: typeof record.commandOverride === 'string' ? record.commandOverride : null,
        args: typeof record.args === 'string' ? record.args : '',
        env:
          record.env && typeof record.env === 'object' && !Array.isArray(record.env)
            ? ({ ...(record.env as Record<string, string>) } as Record<string, string>)
            : {},
        syncEnv: record.syncEnv === true
      }
    }
  }

  getReferenceRevision(): number {
    return this.store.getSettings().agentReferenceRevision ?? 1
  }

  /** Remote (runtime RPC) reference snapshot; typed projection error when over
   *  the 512 KiB frame budget. */
  getRemoteReferenceSnapshot(): AgentReferenceSnapshot | AgentReferenceProjectionError {
    const settings = this.store.getSettings()
    const snapshot = buildAgentReferenceSnapshot(settings)
    const { tooLarge } = measureAgentReferenceProjection(settings)
    if (tooLarge) {
      return {
        version: 1,
        revision: snapshot.revision,
        code: 'agent_reference_payload_too_large',
        maxBytes: 524_288
      }
    }
    return snapshot
  }

  /** Uncapped authoring/repair view over local preload IPC only. */
  getLocalReferenceSnapshot(): LocalAgentReferenceSnapshot {
    const settings = this.store.getSettings()
    const snapshot = buildAgentReferenceSnapshot(settings)
    const { bytes, tooLarge } = measureAgentReferenceProjection(settings)
    return {
      ...snapshot,
      projection: tooLarge
        ? { status: 'too-large', bytes, maxBytes: 524_288 }
        : { status: 'ready', bytes, maxBytes: 524_288 }
    }
  }

  /** Non-null while the profile is pinned pre-v1 by a failed backup; all
   *  catalog/reference mutations are gated on it. */
  private getMigrationBlockedError(): AgentCatalogMigrationBlockedError | null {
    return agentCatalogMigrationBlockedError(this.store)
  }

  mutateReferences(
    request: AgentReferenceMutationRequest
  ): AgentReferenceMutationResult<LocalAgentReferenceSnapshot> | AgentCatalogMigrationBlockedError {
    // The failed-backup invariant is "no v1 write": reference mutations stamp
    // agentReferenceRevision, so they are blocked alongside catalog mutations.
    const blocked = this.getMigrationBlockedError()
    if (blocked) {
      return blocked
    }
    const settings = this.store.getSettings()
    const currentReferenceRevision = settings.agentReferenceRevision ?? 1
    const application = applyAgentReferenceMutation({
      settings,
      request,
      currentReferenceRevision,
      catalog: normalizeCatalogFromSettings(settings)
    })
    if (!application.ok) {
      return {
        ok: false,
        code: application.code,
        referenceRevision: currentReferenceRevision,
        catalogRevision: this.getRevision(),
        ...(application.code === 'reference_revision_conflict'
          ? { snapshot: this.getLocalReferenceSnapshot() }
          : {}),
        ...(application.owner ? { owner: application.owner } : {}),
        ...(application.field ? { field: application.field } : {}),
        ...(application.reason ? { reason: application.reason } : {})
      }
    }
    // The 512 KiB remote-projection budget is checked on the post-mutation
    // snapshot; a non-growing write still commits so an over-budget profile can
    // always be edited back under budget (mirrors mutate()'s security-reducing
    // allowlist).
    const projected = measureAgentReferenceProjection({
      ...settings,
      ...application.patch
    } as GlobalSettings)
    if (projected.tooLarge && projected.bytes > measureAgentReferenceProjection(settings).bytes) {
      return {
        ok: false,
        code: 'agent_reference_payload_too_large',
        referenceRevision: currentReferenceRevision,
        catalogRevision: this.getRevision()
      }
    }
    // Owner change commits before any prune; a failure between the two leaves
    // the tombstone conservatively retained for the next indexed recheck.
    this.store.updateSettings(application.patch, { notifyListeners: true })
    this.pruneUnreferencedTombstonesAfterReferenceRemoval()
    return {
      ok: true,
      referenceRevision: application.newReferenceRevision,
      catalogRevision: this.getRevision(),
      snapshot: this.getLocalReferenceSnapshot()
    }
  }

  /** Reference-aware prune run after a reference removal; a prune advances and
   *  publishes the catalog revision so receivers replace their snapshot. */
  private pruneUnreferencedTombstonesAfterReferenceRemoval(): void {
    const settings = this.store.getSettings()
    const tombstones = settings.deletedCustomTuiAgents ?? []
    if (tombstones.length === 0) {
      return
    }
    const retained = tombstones.filter(
      (tombstone) => this.referenceIndex.countReferences(tombstone.id) !== 0
    )
    if (retained.length === tombstones.length) {
      return
    }
    const newRevision = (settings.agentCatalogRevision ?? 1) + 1
    this.store.updateSettings(
      { deletedCustomTuiAgents: retained, agentCatalogRevision: newRevision },
      { notifyListeners: true }
    )
    for (const listener of this.changeListeners) {
      listener(newRevision)
    }
  }

  mutate(
    request: AgentCatalogMutationRequest
  ): AgentCatalogMutationResult | AgentCatalogMigrationBlockedError {
    // A failed pinned pre-v1 backup means no v1 write may land on the profile;
    // fail closed here so authoring cannot bypass the migration invariant.
    const blocked = this.getMigrationBlockedError()
    if (blocked) {
      return blocked
    }
    const settings = this.store.getSettings()
    const currentRevision = settings.agentCatalogRevision ?? 1
    const application = applyAgentCatalogMutation({
      settings,
      request,
      currentRevision,
      repairTokens: this.repairTokens,
      countTombstoneReferences: (id) => this.referenceIndex.countReferences(id)
    })
    if (!application.ok) {
      return {
        ok: false,
        code: application.code,
        revision: currentRevision,
        ...(application.code === 'catalog_revision_conflict'
          ? { snapshot: this.getLocalSnapshot() }
          : {}),
        ...(application.field ? { field: application.field } : {}),
        ...(application.reason ? { reason: application.reason } : {}),
        ...(application.envEntryIndex !== undefined
          ? { envEntryIndex: application.envEntryIndex }
          : {})
      }
    }

    // Payload budgets are checked on the post-mutation state; while a budget is
    // exceeded only the security-reducing allowlist may still commit.
    const nextSettings = { ...settings, ...application.patch }
    const localStorageStatus = measureLocalAgentCatalogStorage(nextSettings as GlobalSettings)
    const projectionStatus = measureAgentCatalogProjection(nextSettings as GlobalSettings)
    if (localStorageStatus.status === 'too-large' && !isSecurityReducingMutation(request)) {
      return { ok: false, code: 'agent_catalog_local_payload_too_large', revision: currentRevision }
    }
    if (projectionStatus.status === 'too-large' && !isSecurityReducingMutation(request)) {
      return { ok: false, code: 'agent_catalog_payload_too_large', revision: currentRevision }
    }

    this.store.updateSettings(application.patch, { notifyListeners: true })
    for (const listener of this.changeListeners) {
      listener(application.newRevision)
    }
    return { ok: true, revision: application.newRevision, snapshot: this.getLocalSnapshot() }
  }
}
