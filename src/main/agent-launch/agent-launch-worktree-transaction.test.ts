import { describe, expect, it, vi } from 'vitest'
import { AgentLaunchOperationStore } from './agent-launch-operation-store'
import {
  runWorktreeAgentLaunchTransaction,
  type WorktreeAgentLaunchTransactionDeps,
  type WorktreeAgentLaunchTransactionParams,
  type WorktreePendingAgentLaunch
} from './agent-launch-worktree-transaction'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type { AgentStartupPlan } from '../../shared/tui-agent-startup'
import type {
  AgentLaunchFailure,
  AgentLaunchReceipt,
  AgentLaunchRequestError
} from '../../shared/agent-launch-contract'
import type { ExecuteAgentLaunchResult } from './agent-launch-boundary'

const SNAPSHOT: AgentLaunchSnapshot = {
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
  }
}

const PLAN: AgentStartupPlan = {
  agent: 'claude',
  launchCommand: 'claude',
  expectedProcess: 'claude',
  followupPrompt: null,
  launchConfig: { agentArgs: '', agentEnv: {} }
}

const RECEIPT: AgentLaunchReceipt = {
  requestedAgent: 'claude',
  baseAgent: 'claude',
  notices: [],
  launchToken: 'tok-1',
  catalogRevision: 3,
  telemetry: { agentKind: 'claude-code', usedCustomAgent: false }
}

type CallLog = string[]

function makeDeps(overrides: {
  snapshot?: AgentLaunchSnapshot | null
  spawn?: WorktreeAgentLaunchTransactionDeps['spawn']
  log?: CallLog
}): {
  deps: WorktreeAgentLaunchTransactionDeps
  operationStore: AgentLaunchOperationStore
  settle: ReturnType<typeof vi.fn>
  persistPending: ReturnType<typeof vi.fn>
  persistFailure: ReturnType<typeof vi.fn>
  clearPublicPending: ReturnType<typeof vi.fn>
} {
  const log = overrides.log ?? []
  const operationStore = new AgentLaunchOperationStore()
  const settle = vi.fn((token: string, settlement: string) => {
    log.push(`settle:${settlement}:${token}`)
  })
  const persistPending = vi.fn((_pending: WorktreePendingAgentLaunch) => {
    log.push('persistPending')
  })
  const persistFailure = vi.fn(() => {
    log.push('persistFailure')
  })
  const clearPublicPending = vi.fn(() => {
    log.push('clearPublicPending')
  })
  const beginPending = operationStore.beginPending.bind(operationStore)
  operationStore.beginPending = ((entry) => {
    log.push('beginPending')
    return beginPending(entry)
  }) as typeof operationStore.beginPending
  const boundary = {
    pendingSnapshotFor: vi.fn(() =>
      overrides.snapshot === undefined ? SNAPSHOT : overrides.snapshot
    ),
    settleAgentLaunch: settle
  } as unknown as WorktreeAgentLaunchTransactionDeps['boundary']
  const spawn =
    overrides.spawn ??
    vi.fn(async (_plan: unknown, receipt: { launchToken: string }) => {
      log.push('spawn')
      expect(receipt.launchToken).toBe('tok-1')
      return { terminalId: 'term-1' }
    })
  let failureCounter = 0
  const deps: WorktreeAgentLaunchTransactionDeps = {
    boundary,
    operationStore,
    persistPending,
    spawn,
    clearPublicPending,
    persistFailure,
    mintFailureId: () => `fail-${(failureCounter += 1)}`,
    now: () => 1000
  }
  return { deps, operationStore, settle, persistPending, persistFailure, clearPublicPending }
}

function params(
  execute: () => Promise<ExecuteAgentLaunchResult>,
  extra?: Partial<WorktreeAgentLaunchTransactionParams>
): WorktreeAgentLaunchTransactionParams {
  return {
    operationId: 'op-1',
    idempotencyKey: 'idem-1',
    scope: 'wt-1',
    payloadDigest: 'digest-1',
    clientMutationId: null,
    requestedAgent: 'claude',
    intent: 'interactive',
    principal: { kind: 'local' },
    execute,
    ...extra
  }
}

describe('runWorktreeAgentLaunchTransaction', () => {
  it('persists pending (public + private) before spawning, then settles launched', async () => {
    const log: CallLog = []
    const { deps, operationStore } = makeDeps({ log })
    const outcome = await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    expect(outcome).toEqual({ status: 'launched', receipt: RECEIPT, terminalId: 'term-1' })
    // Both persistence writes precede the writer; the private write is first.
    expect(log.indexOf('beginPending')).toBeLessThan(log.indexOf('spawn'))
    expect(log.indexOf('persistPending')).toBeLessThan(log.indexOf('spawn'))
    expect(log.indexOf('spawn')).toBeLessThan(log.indexOf('settle:registered:tok-1'))
    // Pending is cleared (public + private) and the ledger records launched.
    expect(operationStore.getPending('tok-1')).toBeNull()
    const settled = operationStore.findSettledByIdempotencyKey('wt-1', 'idem-1')
    expect(settled).toMatchObject({ status: 'launched', terminalId: 'term-1', failureId: null })
  })

  it('keeps only client-safe fields in the public pending metadata', async () => {
    const { deps, persistPending } = makeDeps({})
    await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }), {
        priorFailureId: 'prev-fail'
      })
    )
    expect(persistPending).toHaveBeenCalledWith({
      operationId: 'op-1',
      requestedAgent: 'claude',
      priorFailureId: 'prev-fail'
    })
    const pending = persistPending.mock.calls[0][0]
    expect(Object.keys(pending).sort()).toEqual(['operationId', 'priorFailureId', 'requestedAgent'])
  })

  it('records a durable failure and spawns zero PTYs when execute fails', async () => {
    const log: CallLog = []
    const failure: AgentLaunchFailure = {
      code: 'agent_configuration_changed',
      requestedAgent: 'claude'
    }
    const { deps, operationStore, persistFailure } = makeDeps({ log })
    const outcome = await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: false, failure }))
    )
    expect(log).not.toContain('spawn')
    expect(log).not.toContain('beginPending')
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.failure).toMatchObject({
        code: 'agent_configuration_changed',
        version: 1,
        failureId: 'fail-1',
        intent: 'interactive',
        occurredAt: 1000
      })
    }
    expect(persistFailure).toHaveBeenCalledTimes(1)
    expect(operationStore.findSettledByIdempotencyKey('wt-1', 'idem-1')).toMatchObject({
      status: 'failed',
      failureId: 'fail-1',
      terminalId: null
    })
  })

  it('settles failed and records a durable failure when the writer throws', async () => {
    const log: CallLog = []
    const spawn = vi.fn(async () => {
      log.push('spawn')
      throw new Error('pty boom')
    })
    const { deps, operationStore, persistFailure } = makeDeps({ log, spawn })
    const outcome = await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    // Pending was persisted before the writer, then rolled to a failure.
    expect(log.indexOf('beginPending')).toBeLessThan(log.indexOf('spawn'))
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(log).toContain('settle:failed:tok-1')
    expect(operationStore.getPending('tok-1')).toBeNull()
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.failure.code).toBe('spawn_failed')
    }
    expect(persistFailure).toHaveBeenCalledTimes(1)
  })

  it('marks the token spawn-in-flight for the whole beginPending→settle window', async () => {
    // Regression (L4-M2): a reconcile pass firing while the spawn is running
    // must be able to skip this token — the PTY registers it only after spawn
    // resolves, so mid-spawn it looks absent and would false-settle.
    const { deps, operationStore } = makeDeps({})
    let inFlightDuringSpawn: boolean | null = null
    deps.spawn = vi.fn(async () => {
      inFlightDuringSpawn = operationStore.isSpawnInFlight('tok-1')
      return { terminalId: 'term-1' }
    })
    await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    expect(inFlightDuringSpawn).toBe(true)
    expect(operationStore.isSpawnInFlight('tok-1')).toBe(false)
  })

  it('clears the in-flight mark when the spawn throws', async () => {
    const spawn = vi.fn(async () => {
      throw new Error('pty boom')
    })
    const { deps, operationStore } = makeDeps({ spawn })
    await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    expect(operationStore.isSpawnInFlight('tok-1')).toBe(false)
  })

  it('writes the settled ledger entry BEFORE clearing the pending snapshot (both arms)', async () => {
    // Regression (L3b-#9): a crash between the two durable writes must never
    // lose both the pending attribution and the settled entry.
    const order: string[] = []
    const { deps, operationStore } = makeDeps({})
    const recordSettled = operationStore.recordSettled.bind(operationStore)
    operationStore.recordSettled = ((entry) => {
      order.push(`recordSettled:${entry.status}`)
      return recordSettled(entry)
    }) as typeof operationStore.recordSettled
    const clearPending = operationStore.clearPending.bind(operationStore)
    operationStore.clearPending = ((token) => {
      order.push('clearPending')
      return clearPending(token)
    }) as typeof operationStore.clearPending

    await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    expect(order).toEqual(['recordSettled:launched', 'clearPending'])

    order.length = 0
    deps.spawn = vi.fn(async () => {
      throw new Error('pty boom')
    })
    await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({
        ok: true,
        plan: PLAN,
        receipt: { ...RECEIPT, launchToken: 'tok-2' }
      }))
    )
    expect(order).toEqual(['recordSettled:failed', 'clearPending'])
  })

  it('performs no owner-state write on a request error', async () => {
    const requestError: AgentLaunchRequestError = { code: 'idempotency_conflict' }
    const { deps, operationStore, persistFailure, persistPending } = makeDeps({})
    const outcome = await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: false, requestError }))
    )
    expect(outcome).toEqual({ status: 'request_error', requestError })
    expect(persistFailure).not.toHaveBeenCalled()
    expect(persistPending).not.toHaveBeenCalled()
    expect(operationStore.settledForScope('wt-1')).toHaveLength(0)
  })

  it('fails closed and spawns nothing when the admitted snapshot is missing', async () => {
    const log: CallLog = []
    const { deps, persistFailure } = makeDeps({ log, snapshot: null })
    const outcome = await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    expect(log).not.toContain('spawn')
    expect(log).toContain('settle:failed:tok-1')
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.failure.code).toBe('invalid_launch_snapshot')
    }
    expect(persistFailure).toHaveBeenCalledTimes(1)
  })
})
