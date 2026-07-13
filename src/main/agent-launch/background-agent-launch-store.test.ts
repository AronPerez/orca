import { describe, expect, it, vi } from 'vitest'
import { BackgroundAgentLaunchStore } from './background-agent-launch-store'
import type { BackgroundAgentLaunchCreateInput } from './background-agent-launch-store'
import type { PersistedAgentLaunchFailure } from '../../shared/agent-launch-contract'
import { parsePersistedAgentLaunchFailure } from '../../shared/agent-launch-failure-schema'
import { retryRecoveryGateForFailureCode } from './agent-launch-reconciliation'

// The only keys a persisted launch failure may carry; anything outside this set
// (an env key/value, argv element, label, or path) would be a leak.
const ALLOWED_FAILURE_KEYS = new Set([
  'code',
  'requestedAgent',
  'baseAgent',
  'variable',
  'field',
  'shell',
  'reason',
  'version',
  'failureId',
  'intent',
  'occurredAt'
])

function createInput(
  overrides: Partial<BackgroundAgentLaunchCreateInput> = {}
): BackgroundAgentLaunchCreateInput {
  return {
    attemptId: 'attempt-1',
    worktreeId: 'repo-a::/srv/app',
    operationId: 'op-1',
    requestedAgent: 'codex',
    baseAgent: 'codex',
    ...overrides
  }
}

function failure(
  code: PersistedAgentLaunchFailure['code'],
  overrides: Partial<PersistedAgentLaunchFailure> = {}
): PersistedAgentLaunchFailure {
  return {
    code,
    requestedAgent: 'codex',
    baseAgent: 'codex',
    version: 1,
    failureId: `fail-${code}`,
    intent: 'background',
    occurredAt: 10,
    ...overrides
  }
}

describe('BackgroundAgentLaunchStore', () => {
  it('creates an attempt in pending before resolution and is idempotent on attemptId', () => {
    const store = new BackgroundAgentLaunchStore({ now: () => 1 })
    const created = store.create(createInput())
    expect(created).toMatchObject({ state: 'pending', failure: null, forgottenAt: null })
    // A replay of the same attempt id returns the existing record unchanged.
    const replay = store.create(createInput({ requestedAgent: 'claude' }))
    expect(replay.requestedAgent).toBe('codex')
    expect(store.all()).toHaveLength(1)
  })

  it('settles launched, clearing any prior failure', () => {
    const store = new BackgroundAgentLaunchStore()
    store.create(createInput())
    store.settleFailed('attempt-1', failure('spawn_failed'))
    store.settleLaunched('attempt-1')
    expect(store.get('attempt-1')).toMatchObject({ state: 'launched', failure: null })
  })

  it('settles failed with the durable code+hint failure', () => {
    const store = new BackgroundAgentLaunchStore()
    store.create(createInput())
    store.settleFailed('attempt-1', failure('spawn_failed'))
    expect(store.get('attempt-1')).toMatchObject({
      state: 'failed',
      failure: { code: 'spawn_failed' }
    })
  })

  it('markUnknown keeps the attempt pending and coexists with the unknown failure', () => {
    const store = new BackgroundAgentLaunchStore()
    store.create(createInput())
    store.markUnknown('attempt-1', failure('launch_state_unknown'))
    const attempt = store.get('attempt-1')
    expect(attempt?.state).toBe('pending')
    expect(attempt?.failure?.code).toBe('launch_state_unknown')
  })

  it('keeps the launch_state_unknown failureId stable across reconcile re-runs', () => {
    const store = new BackgroundAgentLaunchStore()
    store.create(createInput())
    store.markUnknown('attempt-1', failure('launch_state_unknown', { failureId: 'first' }))
    store.markUnknown('attempt-1', failure('launch_state_unknown', { failureId: 'second' }))
    // A churning failureId would reset the client's expectedFailureId guard.
    expect(store.get('attempt-1')?.failure?.failureId).toBe('first')
  })

  it('forgets only from launch_state_unknown, retaining the failure and stamping forgottenAt', () => {
    const store = new BackgroundAgentLaunchStore({ now: () => 77 })
    store.create(createInput())
    // Cannot forget a plain pending attempt (no unknown failure).
    expect(store.forget('attempt-1')).toBe(false)
    store.markUnknown('attempt-1', failure('launch_state_unknown'))
    expect(store.forget('attempt-1')).toBe(true)
    expect(store.get('attempt-1')).toMatchObject({
      state: 'forgotten',
      forgottenAt: 77,
      failure: { code: 'launch_state_unknown' }
    })
    // A second forget is a no-op (no longer unknown).
    expect(store.forget('attempt-1')).toBe(false)
  })

  it('cannot forget a failed (not unknown) attempt', () => {
    const store = new BackgroundAgentLaunchStore()
    store.create(createInput())
    store.settleFailed('attempt-1', failure('spawn_failed'))
    expect(store.forget('attempt-1')).toBe(false)
  })

  it('projects attempts filtered to a worktree', () => {
    const store = new BackgroundAgentLaunchStore()
    store.create(createInput({ attemptId: 'a', worktreeId: 'wt-1' }))
    store.create(createInput({ attemptId: 'b', worktreeId: 'wt-1' }))
    store.create(createInput({ attemptId: 'c', worktreeId: 'wt-2' }))
    expect(store.listForWorktree('wt-1').map((a) => a.attemptId)).toEqual(['a', 'b'])
  })

  it('exposes referenced requested agents including forgotten attempts', () => {
    const store = new BackgroundAgentLaunchStore()
    store.create(createInput({ attemptId: 'a', requestedAgent: 'custom-agent:codex:1' }))
    store.markUnknown('a', failure('launch_state_unknown'))
    store.forget('a')
    expect(store.referencedRequestedAgents()).toContain('custom-agent:codex:1')
  })

  it('drives the durable sink on every mutation and rebuilds without writing back', () => {
    const sink = vi.fn()
    const store = new BackgroundAgentLaunchStore()
    store.setDurablePersistence(sink)
    store.create(createInput())
    store.settleFailed('attempt-1', failure('spawn_failed'))
    expect(sink).toHaveBeenCalledTimes(2)
    const snapshot = store.durableState()

    const rebuilt = new BackgroundAgentLaunchStore()
    const rebuiltSink = vi.fn()
    rebuilt.setDurablePersistence(rebuiltSink)
    rebuilt.rebuildFrom(snapshot.attempts)
    // Rehydrate must not echo back into the sink.
    expect(rebuiltSink).not.toHaveBeenCalled()
    expect(rebuilt.get('attempt-1')?.state).toBe('failed')
  })

  it('durable-state round trip keeps the attempt failure secret-free and re-normalizable (G6)', () => {
    const store = new BackgroundAgentLaunchStore()
    store.create(createInput())
    store.settleFailed('attempt-1', failure('missing_variable', { field: 'env', shell: 'posix' }))

    // The durable snapshot serialized to its on-disk form.
    const onDisk = JSON.stringify(store.durableState())
    const parsed = JSON.parse(onDisk) as ReturnType<BackgroundAgentLaunchStore['durableState']>
    const persistedFailure = parsed.attempts[0].failure
    // No secret text can appear in the failure record: an env key/value, argv
    // element, command, label or path would have to surface as a substring.
    const persistedFailureText = JSON.stringify(persistedFailure)
    for (const marker of ['agentEnv', 'agentArgs', 'argv', 'command', 'label', 'path']) {
      expect(persistedFailureText).not.toContain(marker)
    }
    // The stored failure carries only whitelisted keys and re-normalizes.
    for (const key of Object.keys(persistedFailure ?? {})) {
      expect(ALLOWED_FAILURE_KEYS.has(key)).toBe(true)
    }
    expect(parsePersistedAgentLaunchFailure(persistedFailure)).not.toBeNull()
    // A tampered on-disk blob with secret text fails normalization.
    expect(
      parsePersistedAgentLaunchFailure({ ...persistedFailure, agentEnv: { TOKEN: 'x' } })
    ).toBeNull()
  })

  it('reload from disk keeps an unknown-state attempt non-retryable (G6)', () => {
    const store = new BackgroundAgentLaunchStore()
    store.create(createInput())
    store.markUnknown('attempt-1', failure('launch_state_unknown'))

    // Persist to disk and rebuild a fresh store from the reloaded snapshot.
    const reloaded = JSON.parse(JSON.stringify(store.durableState())) as ReturnType<
      BackgroundAgentLaunchStore['durableState']
    >
    const rebuilt = new BackgroundAgentLaunchStore()
    rebuilt.rebuildFrom(reloaded.attempts)

    const attempt = rebuilt.get('attempt-1')
    // Coexistence survives the reload: still pending with the unknown failure.
    expect(attempt?.state).toBe('pending')
    expect(attempt?.failure?.code).toBe('launch_state_unknown')
    // The retry gate still blocks — no auto-relaunch without an explicit owner
    // action, so the reconciler cannot re-dispatch the attempt.
    expect(retryRecoveryGateForFailureCode(attempt?.failure?.code).kind).toBe(
      'launch_state_unknown'
    )
  })

  it('persistenceForAttempt binds the reconcile slice to one attempt', () => {
    const store = new BackgroundAgentLaunchStore()
    store.create(createInput())
    const persistence = store.persistenceForAttempt('attempt-1')
    persistence.markUnknown(failure('launch_state_unknown'))
    expect(store.get('attempt-1')?.failure?.code).toBe('launch_state_unknown')
    persistence.settleLaunched()
    expect(store.get('attempt-1')?.state).toBe('launched')
  })
})
