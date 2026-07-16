// U5: the host-private session record store's lifecycle invariants — spawn-time
// staging, provider-session bind (by launch token) → durable resume record,
// ownership-key resolution, incompatible/non-resumable bind rejection, spawn-
// failure rollback, dispose-keeps-record, and the one-time legacy handoff.
import { describe, expect, it } from 'vitest'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type { TuiAgent } from '../../shared/types'
import {
  getAgentSessionOwnershipKey,
  type AgentProviderSessionMetadata,
  type AgentSessionOwnershipKey,
  type SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import {
  AgentSessionRecordStore,
  type AgentSessionRecordStoreDurableState,
  type StagedLaunchRegistration
} from './agent-session-record-store'

function snapshot(overrides: Partial<AgentLaunchSnapshot> = {}): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: 'claude',
    baseAgent: 'claude',
    displayLabel: 'Claude',
    mode: 'built-in',
    argv: ['claude'],
    agentEnv: {},
    capturedEnvPolicy: 'none',
    target: {
      platform: 'darwin',
      execution: 'native',
      shell: 'posix',
      isRemote: false,
      executionHostId: 'local'
    },
    ...overrides
  }
}

const SESSION: AgentProviderSessionMetadata = { key: 'session_id', id: 'sess-1' }

function registration(
  overrides: Partial<Omit<StagedLaunchRegistration, 'registeredAt'>> = {}
): Omit<StagedLaunchRegistration, 'registeredAt'> {
  return {
    paneKey: 'pane-a',
    terminalId: 'term-a',
    worktreeId: 'wt-1',
    requestedAgent: 'claude',
    baseAgent: 'claude',
    launchSnapshot: snapshot(),
    launchToken: 'token-a',
    ...overrides
  }
}

const OWNERSHIP: AgentSessionOwnershipKey = {
  worktreeId: 'wt-1',
  baseAgent: 'claude',
  providerSessionId: 'sess-1'
}

/** Register the default pane and bind its provider session by token. */
function registerAndBind(store: AgentSessionRecordStore): void {
  store.register(registration())
  store.bindProviderSessionByToken('token-a', SESSION)
}

describe('AgentSessionRecordStore lifecycle', () => {
  it('a staged registration is not resumable until a provider session binds', () => {
    const store = new AgentSessionRecordStore()
    store.register(registration())
    expect(store.resolveByOwnershipKey(OWNERSHIP)).toBeNull()

    const bound = store.bindProviderSessionByToken('token-a', SESSION)
    expect(bound).not.toBeNull()
    const record = store.resolveByOwnershipKey(OWNERSHIP)
    expect(record?.launchSnapshot).toEqual(snapshot())
    expect(record?.launchToken).toBe('token-a')
    expect(record?.requestedAgent).toBe('claude')
  })

  it('preserves the requested custom identity while keying ownership on the base', () => {
    const store = new AgentSessionRecordStore()
    store.register(
      registration({ requestedAgent: 'custom-agent:claude:reviewer', baseAgent: 'claude' })
    )
    store.bindProviderSessionByToken('token-a', SESSION)
    const record = store.resolveByOwnershipKey(OWNERSHIP)
    expect(record?.requestedAgent).toBe('custom-agent:claude:reviewer')
    expect(record?.baseAgent).toBe('claude')
  })

  it('binding an unknown launch token returns null and stores nothing', () => {
    const store = new AgentSessionRecordStore()
    expect(store.bindProviderSessionByToken('ghost-token', SESSION)).toBeNull()
    expect(store.resolveByOwnershipKey(OWNERSHIP)).toBeNull()
  })

  it('rejects an incompatible provider key type without rewriting the staged identity', () => {
    const store = new AgentSessionRecordStore()
    store.register(registration())
    // Claude keys on session_id; a conversation_id hook is incompatible evidence.
    const bound = store.bindProviderSessionByToken('token-a', { key: 'conversation_id', id: 'x' })
    expect(bound).toBeNull()
    expect(store.resolveByOwnershipKey(OWNERSHIP)).toBeNull()
    // A later compatible hook still binds the same staged registration.
    expect(store.bindProviderSessionByToken('token-a', SESSION)).not.toBeNull()
  })

  it('never binds a non-resumable base', () => {
    const store = new AgentSessionRecordStore()
    store.register(registration({ baseAgent: 'cursor' }))
    expect(store.bindProviderSessionByToken('token-a', SESSION)).toBeNull()
  })

  it('a repeated hook for an already-bound launch is a no-op with no extra persist', () => {
    let persistCalls = 0
    const store = new AgentSessionRecordStore()
    store.setDurablePersistence(() => {
      persistCalls += 1
    })
    store.register(registration())
    expect(store.bindProviderSessionByToken('token-a', SESSION)).not.toBeNull()
    expect(store.bindProviderSessionByToken('token-a', SESSION)).toBeNull()
    expect(persistCalls).toBe(1)
  })

  it('rollback after bind removes the durable record so a failed spawn strands nothing', () => {
    const store = new AgentSessionRecordStore()
    registerAndBind(store)
    store.rollbackByToken('token-a')
    expect(store.resolveByOwnershipKey(OWNERSHIP)).toBeNull()
  })

  it('rollback before bind drops the staged registration and its token index', () => {
    const store = new AgentSessionRecordStore()
    store.register(registration())
    store.rollbackByToken('token-a')
    expect(store.bindProviderSessionByToken('token-a', SESSION)).toBeNull()
  })

  it('dispose keeps the durable record so a slept session still resumes', () => {
    const store = new AgentSessionRecordStore()
    registerAndBind(store)
    store.disposeStagingForPane('pane-a')
    expect(store.resolveByOwnershipKey(OWNERSHIP)?.launchSnapshot).toEqual(snapshot())
  })

  it('dispose clears an unbound pane staging so a late hook cannot bind a torn-down pane', () => {
    const store = new AgentSessionRecordStore()
    // Registered but never bound (spawn failed / pane closed before the hook).
    store.register(registration())
    store.disposeStagingForPane('pane-a')
    expect(store.bindProviderSessionByToken('token-a', SESSION)).toBeNull()
  })

  it('two custom ids on one base/provider session resolve to one owner record', () => {
    const store = new AgentSessionRecordStore()
    store.register(
      registration({ requestedAgent: 'custom-agent:claude:a', launchToken: 'token-a' })
    )
    store.bindProviderSessionByToken('token-a', SESSION)
    store.register(
      registration({
        paneKey: 'pane-b',
        terminalId: 'term-b',
        requestedAgent: 'custom-agent:claude:b',
        launchToken: 'token-b'
      })
    )
    store.bindProviderSessionByToken('token-b', SESSION)
    // Same ownership key: the later bind overwrites; still one record.
    expect(store.durableState().records).toHaveLength(1)
    expect(store.resolveByOwnershipKey(OWNERSHIP)?.requestedAgent).toBe('custom-agent:claude:b')
  })

  it('a fork binds a NEW provider session into its own record and never mutates the source', () => {
    const store = new AgentSessionRecordStore()
    // Source session, bound to sess-1.
    registerAndBind(store)
    const source = store.resolveByOwnershipKey(OWNERSHIP)
    // Fork: its own launch token + a COPY of the source snapshot, but the forked
    // CLI reports a brand-new provider session id, so it keys a distinct record.
    store.register(
      registration({
        paneKey: 'pane-fork',
        terminalId: 'term-fork',
        requestedAgent: 'custom-agent:claude:fork',
        launchToken: 'token-fork'
      })
    )
    store.bindProviderSessionByToken('token-fork', { key: 'session_id', id: 'sess-2-fork' })
    // Source record is untouched (same identity, same token — no ownership claim).
    expect(store.resolveByOwnershipKey(OWNERSHIP)).toEqual(source)
    // The fork owns a separate record under its new provider session id.
    const forkKey: AgentSessionOwnershipKey = {
      worktreeId: 'wt-1',
      baseAgent: 'claude',
      providerSessionId: 'sess-2-fork'
    }
    expect(store.resolveByOwnershipKey(forkKey)?.requestedAgent).toBe('custom-agent:claude:fork')
    expect(store.durableState().records).toHaveLength(2)
  })

  it('forget removes the durable record', () => {
    const store = new AgentSessionRecordStore()
    registerAndBind(store)
    expect(store.forget(OWNERSHIP)).toBe(true)
    expect(store.resolveByOwnershipKey(OWNERSHIP)).toBeNull()
    expect(store.forget(OWNERSHIP)).toBe(false)
  })
})

describe('AgentSessionRecordStore legacy handoff', () => {
  const legacyConfig: SleepingAgentLaunchConfig = {
    agentArgs: '--resume sess-1',
    agentEnv: { FOO: 'bar' }
  }

  it('ingests the legacy config once and keys it by ownership', () => {
    const store = new AgentSessionRecordStore()
    const record = store.ingestLegacyRecord({
      ownershipKey: OWNERSHIP,
      requestedAgent: 'claude',
      providerSession: SESSION,
      legacyLaunchConfig: legacyConfig,
      connectionId: 'ssh:box'
    })
    expect(record.legacyLaunchConfig).toEqual(legacyConfig)
    expect(record.legacyConnectionId).toBe('ssh:box')
    expect(record.launchSnapshot).toBeUndefined()
    expect(store.resolveByOwnershipKey(OWNERSHIP)?.legacyLaunchConfig).toEqual(legacyConfig)
  })

  it('never overwrites a host-owned record on a repeated handoff', () => {
    const store = new AgentSessionRecordStore()
    registerAndBind(store)
    const returned = store.ingestLegacyRecord({
      ownershipKey: OWNERSHIP,
      requestedAgent: 'claude',
      providerSession: SESSION,
      legacyLaunchConfig: legacyConfig,
      connectionId: null
    })
    // The v1-snapshot record wins; the legacy blob is discarded.
    expect(returned.launchSnapshot).toEqual(snapshot())
    expect(returned.legacyLaunchConfig).toBeUndefined()
  })
})

describe('AgentSessionRecordStore durable persistence', () => {
  it('routes bind/ingest/forget through the sink and rehydrates by ownership key', () => {
    let persisted: AgentSessionRecordStoreDurableState = { records: [] }
    const store = new AgentSessionRecordStore()
    store.setDurablePersistence((state) => {
      persisted = state
    })
    registerAndBind(store)
    expect(persisted.records).toHaveLength(1)

    const rebuilt = new AgentSessionRecordStore()
    rebuilt.rebuildRecordsFrom(persisted.records)
    expect(rebuilt.resolveByOwnershipKey(OWNERSHIP)?.launchToken).toBe('token-a')
  })

  it('register alone does not persist; only a bound record is durable', () => {
    let calls = 0
    const store = new AgentSessionRecordStore()
    store.setDurablePersistence(() => {
      calls += 1
    })
    store.register(registration())
    expect(calls).toBe(0)
    store.bindProviderSessionByToken('token-a', SESSION)
    expect(calls).toBe(1)
  })

  it('rehydrate keys records on the base+session, not the persisted array order', () => {
    const store = new AgentSessionRecordStore()
    const other = getAgentSessionOwnershipKey({
      worktreeId: 'wt-2',
      baseAgent: 'codex',
      providerSessionId: 'sess-2'
    })
    store.rebuildRecordsFrom([
      {
        worktreeId: 'wt-1',
        requestedAgent: 'claude',
        baseAgent: 'claude',
        providerSession: SESSION,
        launchSnapshot: snapshot(),
        registeredAt: 1,
        updatedAt: 1
      },
      {
        worktreeId: 'wt-2',
        requestedAgent: 'codex',
        baseAgent: 'codex',
        providerSession: { key: 'session_id', id: 'sess-2' },
        launchSnapshot: snapshot({ baseAgent: 'codex', requestedAgent: 'codex' }),
        registeredAt: 2,
        updatedAt: 2
      }
    ])
    expect(store.resolveByOwnershipKey(OWNERSHIP)?.baseAgent).toBe('claude')
    expect(
      store.resolveByOwnershipKey({
        worktreeId: 'wt-2',
        baseAgent: 'codex',
        providerSessionId: 'sess-2'
      })?.baseAgent
    ).toBe('codex')
    expect(other).toContain('codex')
  })

  it('rehydrate strips a shape-corrupt snapshot so resume degrades in-band, not a throw', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      {
        worktreeId: 'wt-1',
        requestedAgent: 'claude',
        baseAgent: 'claude',
        providerSession: SESSION,
        // Corrupt persisted snapshot (no argv/agentEnv/target): the replay path
        // reads those fields without re-validating shape.
        launchSnapshot: { version: 1 } as unknown as AgentLaunchSnapshot,
        registeredAt: 1,
        updatedAt: 1
      }
    ])
    const record = store.resolveByOwnershipKey(OWNERSHIP)
    expect(record).not.toBeNull()
    expect(record?.launchSnapshot).toBeUndefined()
  })

  it('rehydrate strips a shape-corrupt legacy config and drops an invalid requested identity', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      {
        worktreeId: 'wt-1',
        requestedAgent: 'claude',
        baseAgent: 'claude',
        providerSession: SESSION,
        legacyLaunchConfig: {
          agentArgs: 42,
          agentEnv: null
        } as unknown as SleepingAgentLaunchConfig,
        registeredAt: 1,
        updatedAt: 1
      },
      {
        worktreeId: 'wt-2',
        requestedAgent: { hijacked: true } as unknown as TuiAgent,
        baseAgent: 'codex',
        providerSession: { key: 'session_id', id: 'sess-2' },
        registeredAt: 1,
        updatedAt: 1
      }
    ])
    expect(store.resolveByOwnershipKey(OWNERSHIP)?.legacyLaunchConfig).toBeUndefined()
    expect(
      store.resolveByOwnershipKey({
        worktreeId: 'wt-2',
        baseAgent: 'codex',
        providerSessionId: 'sess-2'
      })
    ).toBeNull()
  })
})
