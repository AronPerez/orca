import { describe, expect, it } from 'vitest'
import type { CustomTuiAgent, CustomTuiAgentId, GlobalSettings } from '../../shared/types'
import type { CustomAgentDraft } from '../../shared/agent-catalog-snapshot'
import { normalizeAgentCatalog } from '../../shared/custom-tui-agents'
import {
  AgentCatalogRepairTokenRegistry,
  applyAgentCatalogMutation,
  type ApplyAgentCatalogMutationArgs
} from './agent-catalog-mutations'

const UUID_A = '01234567-89ab-4cde-8f01-23456789abcd'

function customId(base: string, uuid = UUID_A): CustomTuiAgentId {
  return `custom-agent:${base}:${uuid}` as CustomTuiAgentId
}

function liveAgent(overrides: Partial<CustomTuiAgent> = {}): CustomTuiAgent {
  return {
    id: customId('codex'),
    baseAgent: 'codex',
    label: 'My Codex',
    args: '',
    env: {},
    syncEnv: false,
    ...overrides
  }
}

function draft(overrides: Partial<CustomAgentDraft> = {}): CustomAgentDraft {
  return {
    label: 'New Agent',
    commandOverride: null,
    args: '',
    env: {},
    syncEnv: false,
    ...overrides
  }
}

function settingsWith(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    defaultTuiAgent: 'auto',
    disabledTuiAgents: [],
    customTuiAgents: [],
    deletedCustomTuiAgents: [],
    agentCatalogRevision: 5,
    agentCmdOverrides: {},
    ...overrides
  } as GlobalSettings
}

function apply(
  overrides: Partial<ApplyAgentCatalogMutationArgs> & {
    mutation: ApplyAgentCatalogMutationArgs['request']['mutation']
    expectedRevision?: number
  }
) {
  const { mutation, expectedRevision, ...rest } = overrides
  return applyAgentCatalogMutation({
    settings: settingsWith(),
    currentRevision: 5,
    repairTokens: new AgentCatalogRepairTokenRegistry(),
    countTombstoneReferences: () => 0,
    ...rest,
    request: { expectedRevision: expectedRevision ?? 5, mutation }
  })
}

function corruptRowsOf(settings: GlobalSettings) {
  return normalizeAgentCatalog({
    customTuiAgents: settings.customTuiAgents,
    deletedCustomTuiAgents: settings.deletedCustomTuiAgents,
    disabledTuiAgents: settings.disabledTuiAgents,
    defaultTuiAgent: settings.defaultTuiAgent
  }).catalog.corruptRows
}

describe('repair-corrupt', () => {
  function corruptSettings() {
    // A malformed id cannot be addressed by id: identity-empty corrupt row.
    const malformed = {
      id: 'custom-agent:codex:not-a-uuid',
      baseAgent: 'codex',
      label: 'Bad',
      args: '',
      env: {},
      syncEnv: false
    }
    return settingsWith({ customTuiAgents: [malformed as unknown as CustomTuiAgent] })
  }

  it('discard removes only the selected physical row', () => {
    const settings = corruptSettings()
    const registry = new AgentCatalogRepairTokenRegistry()
    const rows = corruptRowsOf(settings)
    expect(rows).toHaveLength(1)
    const token = registry.tokenFor(rows[0])
    const result = apply({
      settings,
      repairTokens: registry,
      mutation: { kind: 'repair-corrupt', repairToken: token, action: { kind: 'discard' } }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.patch.customTuiAgents).toEqual([])
  })

  it('replace mints a new id in place and never tombstones the untrusted old id', () => {
    const settings = corruptSettings()
    const registry = new AgentCatalogRepairTokenRegistry()
    const token = registry.tokenFor(corruptRowsOf(settings)[0])
    const result = apply({
      settings,
      repairTokens: registry,
      mutation: {
        kind: 'repair-corrupt',
        repairToken: token,
        action: { kind: 'replace', baseAgent: 'claude', draft: draft({ label: 'Replaced' }) }
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.patch.customTuiAgents).toHaveLength(1)
    expect(result.patch.customTuiAgents?.[0]).toMatchObject({
      baseAgent: 'claude',
      label: 'Replaced'
    })
    expect(result.patch.customTuiAgents?.[0].id).toBe(result.mintedId)
    expect(result.patch.deletedCustomTuiAgents).toBeUndefined()
  })

  it('rejects stale tokens without writing', () => {
    const settings = corruptSettings()
    const result = apply({
      settings,
      mutation: { kind: 'repair-corrupt', repairToken: 'stale', action: { kind: 'discard' } }
    })
    expect(result).toEqual({ ok: false, code: 'stale_agent_repair_token' })
  })

  it('rejects single-row repair for duplicate-id rows', () => {
    const id = customId('codex')
    const settings = settingsWith({
      customTuiAgents: [liveAgent({ id, label: 'One' }), liveAgent({ id, label: 'Two' })]
    })
    const registry = new AgentCatalogRepairTokenRegistry()
    const rows = corruptRowsOf(settings)
    const token = registry.tokenFor(rows[0])
    const result = apply({
      settings,
      repairTokens: registry,
      mutation: { kind: 'repair-corrupt', repairToken: token, action: { kind: 'discard' } }
    })
    expect(result).toMatchObject({ ok: false, reason: 'duplicate_id' })
  })
})

describe('resolve-duplicate-id', () => {
  const id = customId('codex')
  function duplicateSettings() {
    return settingsWith({
      customTuiAgents: [liveAgent({ id, label: 'One' }), liveAgent({ id, label: 'Two' })]
    })
  }

  it('commits the whole group atomically with at most one kept canonical row', () => {
    const settings = duplicateSettings()
    const registry = new AgentCatalogRepairTokenRegistry()
    const rows = corruptRowsOf(settings)
    expect(rows).toHaveLength(2)
    const result = apply({
      settings,
      repairTokens: registry,
      mutation: {
        kind: 'resolve-duplicate-id',
        duplicateId: id,
        rows: [
          {
            repairToken: registry.tokenFor(rows[0]),
            action: {
              kind: 'keep-for-existing-references',
              repairedDraft: draft({ label: 'Kept' })
            }
          },
          {
            repairToken: registry.tokenFor(rows[1]),
            action: { kind: 'replace', baseAgent: 'codex', draft: draft({ label: 'Split Off' }) }
          }
        ]
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const live = result.patch.customTuiAgents ?? []
    expect(live).toHaveLength(2)
    expect(live[0]).toMatchObject({ id, label: 'Kept' })
    expect(live[1].id).not.toBe(id)
    expect(live[1]).toMatchObject({ label: 'Split Off' })
  })

  it('allows resolving with no kept row, leaving the old id unknown', () => {
    const settings = duplicateSettings()
    const registry = new AgentCatalogRepairTokenRegistry()
    const rows = corruptRowsOf(settings)
    const result = apply({
      settings,
      repairTokens: registry,
      mutation: {
        kind: 'resolve-duplicate-id',
        duplicateId: id,
        rows: [
          { repairToken: registry.tokenFor(rows[0]), action: { kind: 'discard' } },
          { repairToken: registry.tokenFor(rows[1]), action: { kind: 'discard' } }
        ]
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.patch.customTuiAgents).toEqual([])
  })

  it('rejects an incomplete group, repeated tokens, or two keeps', () => {
    const settings = duplicateSettings()
    const registry = new AgentCatalogRepairTokenRegistry()
    const rows = corruptRowsOf(settings)
    const incomplete = apply({
      settings,
      repairTokens: registry,
      mutation: {
        kind: 'resolve-duplicate-id',
        duplicateId: id,
        rows: [{ repairToken: registry.tokenFor(rows[0]), action: { kind: 'discard' } }]
      }
    })
    expect(incomplete).toEqual({ ok: false, code: 'stale_agent_repair_token' })

    const repeated = apply({
      settings,
      repairTokens: registry,
      mutation: {
        kind: 'resolve-duplicate-id',
        duplicateId: id,
        rows: [
          { repairToken: registry.tokenFor(rows[0]), action: { kind: 'discard' } },
          { repairToken: registry.tokenFor(rows[0]), action: { kind: 'discard' } }
        ]
      }
    })
    expect(repeated).toEqual({ ok: false, code: 'stale_agent_repair_token' })

    const twoKeeps = apply({
      settings,
      repairTokens: registry,
      mutation: {
        kind: 'resolve-duplicate-id',
        duplicateId: id,
        rows: [
          {
            repairToken: registry.tokenFor(rows[0]),
            action: { kind: 'keep-for-existing-references', repairedDraft: draft({ label: 'A' }) }
          },
          {
            repairToken: registry.tokenFor(rows[1]),
            action: { kind: 'keep-for-existing-references', repairedDraft: draft({ label: 'B' }) }
          }
        ]
      }
    })
    expect(twoKeeps).toMatchObject({ ok: false, code: 'invalid_agent_field' })
  })

  it('applies nothing when one row in the group is invalid (oracle 36)', () => {
    // Failure-side atomicity: the first row is fully valid and would be kept, but
    // the second row's draft is invalid. The mutation must reject wholesale with
    // no patch — the valid row's mid-loop accumulation is never committed.
    const settings = duplicateSettings()
    const registry = new AgentCatalogRepairTokenRegistry()
    const rows = corruptRowsOf(settings)
    const result = apply({
      settings,
      repairTokens: registry,
      mutation: {
        kind: 'resolve-duplicate-id',
        duplicateId: id,
        rows: [
          {
            repairToken: registry.tokenFor(rows[0]),
            action: {
              kind: 'keep-for-existing-references',
              repairedDraft: draft({ label: 'Kept' })
            }
          },
          {
            repairToken: registry.tokenFor(rows[1]),
            action: { kind: 'replace', baseAgent: 'codex', draft: draft({ label: '' }) }
          }
        ]
      }
    })
    // field:'label' pins the failure to row1's draft validation, not row0's
    // parsedBase guard (which returns invalid_agent_field with no field) — so this
    // can only pass if row0 was accepted mid-loop and then discarded on reject.
    expect(result).toMatchObject({ ok: false, code: 'invalid_agent_field', field: 'label' })
    expect((result as { patch?: unknown }).patch).toBeUndefined()
  })
})

describe('resolve-duplicate-id covering a base-mismatch corrupt row (L1-#4)', () => {
  const id = customId('codex')

  it('resolves a group whose second record is corrupt (base mismatch) in one repair', () => {
    const settings = settingsWith({
      customTuiAgents: [
        liveAgent({ id, label: 'One' }),
        // Same id, but persisted baseAgent disagrees with the id's base.
        { ...liveAgent({ id, label: 'Two' }), baseAgent: 'claude' } as CustomTuiAgent
      ]
    })
    const registry = new AgentCatalogRepairTokenRegistry()
    const rows = corruptRowsOf(settings)
    // Both records must surface as duplicate_id group members or repair loops.
    const groupRows = rows.filter(
      (row) => row.id === id && row.issues.some((issue) => issue.reason === 'duplicate_id')
    )
    expect(groupRows).toHaveLength(2)

    const result = apply({
      settings,
      repairTokens: registry,
      mutation: {
        kind: 'resolve-duplicate-id',
        duplicateId: id,
        rows: [
          {
            repairToken: registry.tokenFor(groupRows[0]),
            action: {
              kind: 'keep-for-existing-references',
              repairedDraft: draft({ label: 'Kept' })
            }
          },
          { repairToken: registry.tokenFor(groupRows[1]), action: { kind: 'discard' } }
        ]
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const live = result.patch.customTuiAgents ?? []
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ id, label: 'Kept', baseAgent: 'codex' })
  })
})

describe('repair-token registry eviction (L1-#8)', () => {
  function corruptRowWith(index: number) {
    return {
      label: null,
      issues: [{ field: 'identity' as const, reason: 'empty' as const }],
      rawBytes: 10,
      physicalIndex: index,
      raw: { id: `bad-${index}` }
    }
  }

  it('caps the registry instead of growing one entry per historical corrupt-row state', () => {
    const registry = new AgentCatalogRepairTokenRegistry()
    for (let i = 0; i < 1000; i += 1) {
      registry.tokenFor(corruptRowWith(i))
    }
    const size = (registry as unknown as { tokensByRecordKey: Map<string, string> })
      .tokensByRecordKey.size
    expect(size).toBeLessThanOrEqual(256)
  })

  it('keeps recently re-requested tokens stable across unrelated churn', () => {
    const registry = new AgentCatalogRepairTokenRegistry()
    const pinned = corruptRowWith(0)
    const pinnedToken = registry.tokenFor(pinned)
    for (let i = 1; i < 300; i += 1) {
      registry.tokenFor(corruptRowWith(i))
      // Re-request as snapshots would on every revision; recency keeps it live.
      expect(registry.tokenFor(pinned)).toBe(pinnedToken)
    }
  })
})
