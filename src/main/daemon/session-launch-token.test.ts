import { describe, expect, it, vi } from 'vitest'
import { Session, type SubprocessHandle } from './session'

function mockSubprocess(): SubprocessHandle {
  return {
    pid: 123,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    dispose: vi.fn()
  } as unknown as SubprocessHandle
}

describe('Session launchToken persistence', () => {
  it('persists the launch token on the record at creation', () => {
    const session = new Session({
      sessionId: 's-1',
      cols: 80,
      rows: 24,
      subprocess: mockSubprocess(),
      shellReadySupported: false,
      launchToken: 'tok-abc'
    })
    expect(session.launchToken).toBe('tok-abc')
    session.dispose()
  })

  it('defaults to null when no launch token is supplied', () => {
    const session = new Session({
      sessionId: 's-2',
      cols: 80,
      rows: 24,
      subprocess: mockSubprocess(),
      shellReadySupported: false
    })
    expect(session.launchToken).toBeNull()
    session.dispose()
  })
})
