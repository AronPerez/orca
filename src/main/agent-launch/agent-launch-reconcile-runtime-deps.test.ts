import { describe, expect, it, vi } from 'vitest'
import type { AgentLaunchExecutionHostId } from '../../shared/agent-launch-host-contract'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type { AgentLaunchIntentKind } from '../../shared/agent-launch-contract'
import {
  AgentLaunchOperationStore,
  type PendingAgentLaunchSnapshot
} from './agent-launch-operation-store'
import { BackgroundAgentLaunchStore } from './background-agent-launch-store'
import {
  buildReconcileAgentLaunchDeps,
  hostAuthorityFromRelistedConnections,
  type LiveTerminalForToken,
  type ReconcileRuntimeDeps
} from './agent-launch-reconcile-runtime-deps'
import type { ReconcileIntentRouterArms } from './agent-launch-reconcile-intent-router'
import {
  reconcileOnePendingAgentLaunch,
  type ReconcileScopePersistence
} from './agent-launch-worktree-reconcile-writer'

function snapshot(executionHostId: AgentLaunchExecutionHostId): AgentLaunchSnapshot {
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
      isRemote: executionHostId !== 'local',
      executionHostId
    }
  }
}

function pending(
  overrides: Partial<PendingAgentLaunchSnapshot> = {},
  executionHostId: AgentLaunchExecutionHostId = 'local'
): PendingAgentLaunchSnapshot {
  return {
    operationId: 'op-1',
    idempotencyKey: 'idem-1',
    scope: 'wt-1',
    clientMutationId: null,
    payloadDigest: 'digest-1',
    launchToken: 'token-1',
    intent: 'interactive' as AgentLaunchIntentKind,
    snapshot: snapshot(executionHostId),
    ...overrides
  }
}

function spyArm(): ReconcileScopePersistence & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    settleLaunched: () => calls.push('launched'),
    settleFailed: () => calls.push('failed'),
    markUnknown: () => calls.push('unknown')
  }
}

function buildDeps(
  overrides: Partial<ReconcileRuntimeDeps> & {
    liveTerminalByToken?: (token: string) => LiveTerminalForToken | null
    arms?: ReconcileIntentRouterArms
  }
): { store: AgentLaunchOperationStore; deps: ReturnType<typeof buildReconcileAgentLaunchDeps> } {
  const store = new AgentLaunchOperationStore()
  const noopArm = (): ReconcileScopePersistence => spyArm()
  const runtimeDeps: ReconcileRuntimeDeps = {
    operationStore: store,
    liveTerminalByToken: overrides.liveTerminalByToken ?? (() => null),
    isHostAuthoritative: overrides.isHostAuthoritative ?? ((id) => id === 'local'),
    expectedWorktreeId: overrides.expectedWorktreeId ?? ((p) => p.scope),
    arms: overrides.arms ?? {
      worktree: noopArm,
      automation: noopArm,
      orchestration: noopArm,
      background: noopArm
    },
    settleBoundary: overrides.settleBoundary ?? vi.fn(),
    mintFailureId: overrides.mintFailureId ?? (() => 'failure-1'),
    now: () => 1000
  }
  return { store, deps: buildReconcileAgentLaunchDeps(runtimeDeps) }
}

describe('buildReconcileAgentLaunchDeps liveness', () => {
  it('resolves a live token in the launch worktree as attributed', () => {
    const arm = spyArm()
    const { store, deps } = buildDeps({
      liveTerminalByToken: () => ({ ptyId: 'term-9', worktreeId: 'wt-1' }),
      arms: {
        worktree: () => arm,
        automation: () => arm,
        orchestration: () => arm,
        background: () => arm
      }
    })
    const entry = pending()
    store.beginPending(entry)

    const outcome = reconcileOnePendingAgentLaunch(deps, entry)

    expect(outcome).toEqual({ kind: 'launched' })
    expect(arm.calls).toEqual(['launched'])
  })

  it('resolves a live token in a different worktree as unattributed (theft class)', () => {
    const arm = spyArm()
    const { store, deps } = buildDeps({
      liveTerminalByToken: () => ({ ptyId: 'term-hijack', worktreeId: 'wt-OTHER' }),
      arms: {
        worktree: () => arm,
        automation: () => arm,
        orchestration: () => arm,
        background: () => arm
      }
    })
    const entry = pending()
    store.beginPending(entry)

    const outcome = reconcileOnePendingAgentLaunch(deps, entry)

    expect(outcome).toEqual({ kind: 'invalid_launch_snapshot' })
    // Non-settling card write: pending survives so the thief terminal's exit
    // can re-derive spawn_failed (Retry re-opens) instead of a dead-end.
    expect(arm.calls).toEqual(['unknown'])
  })

  it('treats a live token with an UNRESOLVABLE worktree as attributed, never absent', () => {
    // Regression (L2-#6): a re-listed SSH session whose worktree inference
    // failed is invisible to ptysById but its token match is identity proof.
    // It must settle launched — not absent/spawn_failed (duplicate Retry) and
    // not unattributed/invalid_launch_snapshot (false theft class).
    const arm = spyArm()
    const { store, deps } = buildDeps({
      liveTerminalByToken: () => ({ ptyId: 'ssh-term-1', worktreeId: null }),
      isHostAuthoritative: () => true,
      arms: {
        worktree: () => arm,
        automation: () => arm,
        orchestration: () => arm,
        background: () => arm
      }
    })
    const entry = pending({}, 'ssh:host-a')
    store.beginPending(entry)

    const outcome = reconcileOnePendingAgentLaunch(deps, entry)

    expect(outcome).toEqual({ kind: 'launched' })
    expect(arm.calls).toEqual(['launched'])
  })

  it('settles a non-live local pending as absent → spawn_failed (host is authoritative)', () => {
    const arm = spyArm()
    const { store, deps } = buildDeps({
      isHostAuthoritative: (id) => id === 'local',
      arms: {
        worktree: () => arm,
        automation: () => arm,
        orchestration: () => arm,
        background: () => arm
      }
    })
    const entry = pending({}, 'local')
    store.beginPending(entry)

    const outcome = reconcileOnePendingAgentLaunch(deps, entry)

    expect(outcome).toEqual({ kind: 'spawn_failed' })
    expect(arm.calls).toEqual(['failed'])
  })

  it('keeps a non-live remote pending unknown when its host is not authoritative', () => {
    const arm = spyArm()
    const { store, deps } = buildDeps({
      isHostAuthoritative: (id) => id === 'local',
      arms: {
        worktree: () => arm,
        automation: () => arm,
        orchestration: () => arm,
        background: () => arm
      }
    })
    const entry = pending({ launchToken: 'token-r' }, 'ssh:host-a')
    store.beginPending(entry)

    const outcome = reconcileOnePendingAgentLaunch(deps, entry)

    expect(outcome).toEqual({ kind: 'launch_state_unknown' })
    expect(arm.calls).toEqual(['unknown'])
    // Coexistence: the reservation and pending survive for a later reconnect probe.
    expect(store.getPending('token-r')).not.toBeNull()
  })

  it('settles a remote pending absent once its host becomes authoritative (reconnect probe)', () => {
    const arm = spyArm()
    const { store, deps } = buildDeps({
      isHostAuthoritative: (id) => id === 'local' || id === 'ssh:host-a',
      arms: {
        worktree: () => arm,
        automation: () => arm,
        orchestration: () => arm,
        background: () => arm
      }
    })
    const entry = pending({ launchToken: 'token-r' }, 'ssh:host-a')
    store.beginPending(entry)

    const outcome = reconcileOnePendingAgentLaunch(deps, entry)

    expect(outcome).toEqual({ kind: 'spawn_failed' })
    expect(arm.calls).toEqual(['failed'])
  })

  it('settles a remote pending absent when its connection re-listed in this pass', () => {
    const arm = spyArm()
    const { store, deps } = buildDeps({
      isHostAuthoritative: hostAuthorityFromRelistedConnections(new Set(['host-a'])),
      arms: {
        worktree: () => arm,
        automation: () => arm,
        orchestration: () => arm,
        background: () => arm
      }
    })
    const entry = pending({ launchToken: 'token-r' }, 'ssh:host-a')
    store.beginPending(entry)

    const outcome = reconcileOnePendingAgentLaunch(deps, entry)

    expect(outcome).toEqual({ kind: 'spawn_failed' })
    expect(arm.calls).toEqual(['failed'])
  })

  it('routes a background pending to the background store keyed by attempt id', () => {
    const background = new BackgroundAgentLaunchStore({ now: () => 1000 })
    background.create({
      attemptId: 'attempt-7',
      worktreeId: 'wt-bg',
      operationId: 'op-bg',
      requestedAgent: 'claude',
      baseAgent: 'claude'
    })
    const { store, deps } = buildDeps({
      isHostAuthoritative: () => true,
      expectedWorktreeId: () => 'wt-bg',
      arms: {
        worktree: () => spyArm(),
        automation: () => spyArm(),
        orchestration: () => spyArm(),
        background: (attemptId) => background.persistenceForAttempt(attemptId)
      }
    })
    const entry = pending(
      { scope: 'attempt-7', launchToken: 'token-bg', intent: 'background' },
      'local'
    )
    store.beginPending(entry)

    const outcome = reconcileOnePendingAgentLaunch(deps, entry)

    // Local + no live token → absent → spawn_failed lands in the attempt record.
    expect(outcome).toEqual({ kind: 'spawn_failed' })
    expect(background.get('attempt-7')?.state).toBe('failed')
    expect(background.get('attempt-7')?.failure?.code).toBe('spawn_failed')
  })
})

describe('hostAuthorityFromRelistedConnections', () => {
  const authority = hostAuthorityFromRelistedConnections(new Set(['host-a', 'runtime-ssh-env-1']))

  it('always speaks for local and WSL hosts (they execute on this machine)', () => {
    expect(authority('local')).toBe(true)
    expect(authority('wsl:Ubuntu')).toBe(true)
    // Even a pass with no remote listings speaks for the local machine.
    expect(hostAuthorityFromRelistedConnections(new Set())('wsl:Ubuntu')).toBe(true)
  })

  it('speaks for an SSH host only when its connection re-listed in this pass', () => {
    expect(authority('ssh:host-a')).toBe(true)
    expect(authority('ssh:host-b')).toBe(false)
    expect(hostAuthorityFromRelistedConnections(new Set())('ssh:host-a')).toBe(false)
  })

  it('maps a runtime host to its runtime-owned SSH connection', () => {
    expect(authority('runtime:env-1')).toBe(true)
    expect(authority('runtime:env-2')).toBe(false)
  })

  it('never speaks for a malformed host id', () => {
    expect(authority('ssh:' as AgentLaunchExecutionHostId)).toBe(false)
  })
})
