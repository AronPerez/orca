import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const CANONICAL_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

describe('worktree.forgetAgentLaunch RPC', () => {
  it('validates the canonical lowercase UUID clientMutationId before dispatch', async () => {
    const forgetUnknownWorktreeAgentLaunch = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      forgetUnknownWorktreeAgentLaunch
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.forgetAgentLaunch', {
        worktree: 'id:wt-1',
        expectedOperationId: 'op-1',
        // Uppercase is not canonical lowercase form; rejected before any lookup.
        clientMutationId: CANONICAL_UUID.toUpperCase()
      })
    )

    expect(response).toMatchObject({ ok: false })
    expect(forgetUnknownWorktreeAgentLaunch).not.toHaveBeenCalled()
  })

  it('passes a valid request through to the runtime and returns its result', async () => {
    const forgetUnknownWorktreeAgentLaunch = vi.fn().mockResolvedValue({ status: 'forgotten' })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      forgetUnknownWorktreeAgentLaunch
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('worktree.forgetAgentLaunch', {
        worktree: 'id:wt-1',
        expectedOperationId: 'op-1',
        clientMutationId: CANONICAL_UUID
      })
    )

    expect(response).toMatchObject({ ok: true, result: { status: 'forgotten' } })
    // clientKind is undefined for an in-process/local dispatch; it scopes the
    // idempotency principal and is never derived from the client JSON.
    expect(forgetUnknownWorktreeAgentLaunch).toHaveBeenCalledWith(
      'id:wt-1',
      { expectedOperationId: 'op-1', clientMutationId: CANONICAL_UUID },
      undefined
    )
  })
})
