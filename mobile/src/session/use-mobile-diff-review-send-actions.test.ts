import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'

// The hook only needs Platform.OS (via ../platform/haptics) and Clipboard, so a
// minimal mock avoids pulling in the real react-native/expo-clipboard modules,
// which the vitest node environment cannot parse.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('../platform/haptics', () => ({ triggerSuccess: vi.fn() }))

const { useMobileDiffReviewSendActions } = await import('./use-mobile-diff-review-send-actions')

function success(result: unknown): RpcResponse {
  return { id: 'x', ok: true, result, _meta: { runtimeId: 'r' } }
}

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

function createHarness(sendRequest: RpcClient['sendRequest']) {
  const client = { sendRequest } as unknown as RpcClient
  let handlers: ReturnType<typeof useMobileDiffReviewSendActions> | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    handlers = useMobileDiffReviewSendActions({
      client,
      connState: 'connected',
      worktreeId: 'wt-1',
      screenState: { kind: 'loading' },
      setActionError: () => {},
      setSendSheet: () => {},
      saveCommentsAndReviewState: async () => {}
    })
    return null
  }

  const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
  try {
    act(() => {
      renderer = create(createElement(Harness))
    })
  } finally {
    restoreConsoleError()
  }
  if (!handlers || !renderer) {
    throw new Error('mobile diff review send-actions hook did not render')
  }
  return { handlers, unmount: () => act(() => renderer?.unmount()) }
}

describe('useMobileDiffReviewSendActions createTerminalAndSend', () => {
  // Regression for L4-m11: a pre-spawn agentLaunch failure (tombstoned/disabled
  // agent, capacity, ...) is an RPC success with no `tab` key. This must surface
  // the typed failure code, not the generic "invalid response" message.
  it('throws with the typed failure code on a pre-spawn agentLaunch failure', async () => {
    const sendRequest = vi.fn().mockResolvedValueOnce(
      success({
        agentLaunch: { status: 'failed', failure: { code: 'launch_capacity_exceeded' } }
      })
    )
    const { handlers, unmount } = createHarness(sendRequest)

    await expect(handlers.createTerminalAndSend([])).rejects.toThrow(
      "Couldn't start the agent (launch_capacity_exceeded)."
    )
    expect(sendRequest).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('throws the generic message when the created-terminal response is malformed', async () => {
    const sendRequest = vi.fn().mockResolvedValueOnce(success({ tab: { type: 'terminal' } }))
    const { handlers, unmount } = createHarness(sendRequest)

    await expect(handlers.createTerminalAndSend([])).rejects.toThrow(
      'Created terminal response was invalid'
    )
    unmount()
  })
})
