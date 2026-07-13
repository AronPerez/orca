// U6 orchestration dispatch launch-ownership: identity columns, additive
// structured launch failure alongside the retained generic error, the
// owner-authorized forgotten transition, the tombstone reference accessor, and
// the v5 -> v6 schema migration.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { parsePersistedAgentLaunchFailure } from '../../../shared/agent-launch-failure-schema'
import { retryRecoveryGateForFailureCode } from '../../agent-launch/agent-launch-reconciliation'
import { OrchestrationDb } from './db'

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

const FAILURE = {
  code: 'invalid_launch_snapshot' as const,
  requestedAgent: 'custom-agent:codex:11111111-1111-4111-8111-111111111111' as const,
  baseAgent: 'codex' as const,
  version: 1 as const,
  failureId: 'orch-fail-1',
  intent: 'orchestration' as const,
  occurredAt: 100
}

describe('OrchestrationDb U6 launch identity, structured failure, and forget', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('records the requested/base launch identity on the dispatch row', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const ctx = d.createDispatchContext(task.id, 'term_a', undefined, {
      requestedAgent: FAILURE.requestedAgent,
      baseAgent: 'codex'
    })
    expect(ctx.requested_agent).toBe(FAILURE.requestedAgent)
    expect(ctx.base_agent).toBe('codex')
  })

  it('failDispatch persists the structured launch failure and RETAINS the generic error', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const ctx = d.createDispatchContext(task.id, 'term_a')
    const after = d.failDispatch(ctx.id, 'Unable to build an agent launch plan.', FAILURE)
    expect(after?.last_failure).toBe('Unable to build an agent launch plan.')
    expect(JSON.parse(after?.agent_launch_failure ?? 'null')).toMatchObject({
      code: 'invalid_launch_snapshot',
      failureId: 'orch-fail-1'
    })
  })

  it('failDispatch without a structured failure leaves a fresh context launch-failure free', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const ctx = d.createDispatchContext(task.id, 'term_a')
    d.failDispatch(ctx.id, 'first', FAILURE)
    const ctx2 = d.createDispatchContext(task.id, 'term_a')
    const after = d.failDispatch(ctx2.id, 'second')
    expect(after?.agent_launch_failure).toBeNull()
  })

  it('forgetDispatch settles forgotten + blocks the task, only from dispatched', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const ctx = d.createDispatchContext(task.id, 'term_a')
    const forgotten = d.forgetDispatch(ctx.id)
    expect(forgotten?.status).toBe('forgotten')
    expect(d.getTask(task.id)?.status).toBe('blocked')
    // A second forget (no longer dispatched) is a no-op.
    expect(d.forgetDispatch(ctx.id)).toBeUndefined()
  })

  it('forgetDispatch rejects a failed (not dispatched) context', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const ctx = d.createDispatchContext(task.id, 'term_a')
    d.failDispatch(ctx.id, 'boom')
    expect(d.forgetDispatch(ctx.id)).toBeUndefined()
  })

  it('markDispatchLaunchUnknown writes the card and keeps the dispatch dispatched', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const ctx = d.createDispatchContext(task.id, 'term_a')
    const unknown = { ...FAILURE, code: 'launch_state_unknown' as const, failureId: 'orch-unk-1' }
    const after = d.markDispatchLaunchUnknown(ctx.id, unknown)
    expect(after?.status).toBe('dispatched')
    expect(after?.failure_count).toBe(0)
    expect(JSON.parse(after?.agent_launch_failure ?? 'null')).toMatchObject({
      code: 'launch_state_unknown',
      failureId: 'orch-unk-1'
    })
    // The task is untouched — coexistence, not a settle.
    expect(d.getTask(task.id)?.status).not.toBe('failed')
  })

  it('clearDispatchLaunchFailure drops the card while keeping the dispatch dispatched', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const ctx = d.createDispatchContext(task.id, 'term_a')
    d.markDispatchLaunchUnknown(ctx.id, { ...FAILURE, code: 'launch_state_unknown' as const })
    const after = d.clearDispatchLaunchFailure(ctx.id)
    expect(after?.status).toBe('dispatched')
    expect(after?.agent_launch_failure).toBeNull()
  })

  it('SQLite round trip keeps the failure secret-free and re-normalizable (G6)', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const ctx = d.createDispatchContext(task.id, 'term_a')
    const after = d.failDispatch(ctx.id, 'boom', { ...FAILURE, field: 'env', shell: 'posix' })
    const stored = JSON.parse(after?.agent_launch_failure ?? 'null')
    // The stored JSON carries only whitelisted keys — no argv/env/command/path text.
    for (const key of Object.keys(stored)) {
      expect(ALLOWED_FAILURE_KEYS.has(key)).toBe(true)
    }
    // It normalizes back through the strict schema on read.
    expect(parsePersistedAgentLaunchFailure(stored)).not.toBeNull()
    // A tampered stored blob with secret text fails normalization, and a request
    // error can never parse as the persisted orchestration failure.
    expect(parsePersistedAgentLaunchFailure({ ...stored, agentEnv: { TOKEN: 'x' } })).toBeNull()
    expect(
      parsePersistedAgentLaunchFailure({
        code: 'idempotency_conflict',
        version: 1,
        failureId: 'x',
        intent: 'orchestration',
        occurredAt: 1
      })
    ).toBeNull()
  })

  it('reopening from disk keeps an unknown-launch dispatch non-retryable and secret-free (G6)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-reload-'))
    const file = join(dir, 'orch.db')
    try {
      const first = new OrchestrationDb(file)
      const task = first.createTask({ spec: 'work' })
      const ctx = first.createDispatchContext(task.id, 'term_a')
      const unknown = { ...FAILURE, code: 'launch_state_unknown' as const, failureId: 'orch-unk-1' }
      first.markDispatchLaunchUnknown(ctx.id, unknown)
      first.close()

      // Rehydrate from the same file — a fresh process reading the persisted row.
      const reopened = new OrchestrationDb(file)
      db = reopened
      const row = reopened.getDispatchContextById(ctx.id)
      // Coexistence survives the reload: still dispatched with the unknown card,
      // so the coordinator sees an active dispatch and does not re-dispatch.
      expect(row?.status).toBe('dispatched')
      expect(reopened.getTask(task.id)?.status).not.toBe('failed')

      const stored = JSON.parse(row?.agent_launch_failure ?? 'null')
      // On-disk round trip carries only whitelisted keys — no argv/env/command/path.
      for (const key of Object.keys(stored)) {
        expect(ALLOWED_FAILURE_KEYS.has(key)).toBe(true)
      }
      // The reloaded failure re-normalizes and stays non-retryable.
      expect(parsePersistedAgentLaunchFailure(stored)).not.toBeNull()
      expect(retryRecoveryGateForFailureCode(stored.code).kind).toBe('launch_state_unknown')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('referencedRequestedAgents lists custom ids for the tombstone owner', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    d.createDispatchContext(task.id, 'term_a', undefined, {
      requestedAgent: FAILURE.requestedAgent,
      baseAgent: 'codex'
    })
    const task2 = d.createTask({ spec: 'plain' })
    d.createDispatchContext(task2.id, 'term_b')
    expect(d.referencedRequestedAgents()).toEqual([FAILURE.requestedAgent])
  })

  it('migrates a v5 db, preserving rows, backfilling null columns, and allowing forgotten', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-v5-'))
    const file = join(dir, 'orch.db')
    try {
      const raw = new Database(file)
      raw.exec(`
        CREATE TABLE dispatch_contexts (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, assignee_handle TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','dispatched','completed','failed','circuit_broken')),
          failure_count INTEGER NOT NULL DEFAULT 0, last_failure TEXT,
          dispatched_at TEXT, completed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), last_heartbeat_at TEXT
        );
        INSERT INTO dispatch_contexts (id, task_id, assignee_handle, status, failure_count, last_failure)
          VALUES ('ctx_old', 'task_old', 'term_old', 'failed', 2, 'boom');
      `)
      raw.pragma('user_version = 5')
      raw.close()

      const d = new OrchestrationDb(file)
      db = d
      const row = d.getDispatchContextById('ctx_old')
      expect(row?.last_failure).toBe('boom')
      expect(row?.failure_count).toBe(2)
      expect(row?.requested_agent).toBeNull()
      expect(row?.agent_launch_failure).toBeNull()
      // The widened CHECK now accepts 'forgotten': dispatch a fresh task on the
      // migrated schema and forget it.
      const task = d.createTask({ spec: 'post-migration work' })
      const ctx = d.createDispatchContext(task.id, 'term_new')
      expect(d.forgetDispatch(ctx.id)?.status).toBe('forgotten')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
