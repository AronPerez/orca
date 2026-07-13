// createTerminal's host-resolved agentLaunch wiring: the resolved plan (never the
// client command) spawns exactly one PTY; a pre-spawn typed failure creates none
// and returns the failure arm. Resolution itself is unit-tested separately; here
// it is mocked so the test exercises only createTerminal's spawn/settle wiring.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { resolveTerminalAgentLaunch } from './terminal-agent-launch-resolution'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./terminal-agent-launch-resolution', () => ({
  resolveTerminalAgentLaunch: vi.fn()
}))

const resolveMock = vi.mocked(resolveTerminalAgentLaunch)

function stubLaunchScope(runtime: OrcaRuntimeService, path = '/repo/app'): void {
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: 'wt-1',
    path,
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
}

const RECEIPT = {
  requestedAgent: 'claude' as const,
  baseAgent: 'claude' as const,
  notices: [],
  launchToken: 'tok-1',
  catalogRevision: 1,
  telemetry: { agentKind: 'claude-code' as const, usedCustomAgent: false }
}

describe('createTerminal host-resolved agentLaunch', () => {
  it('spawns exactly one PTY from the resolved plan, ignoring the client command', async () => {
    resolveMock.mockResolvedValue({
      kind: 'resolved',
      admissionToken: 'tok-1',
      receipt: RECEIPT,
      fields: {
        command: 'claude --tui',
        launchConfig: { agentArgs: '', agentEnv: {} },
        launchAgent: 'claude',
        launchToken: 'tok-1'
      }
    })
    const runtime = new OrcaRuntimeService()
    stubLaunchScope(runtime)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-1' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const result = await runtime.createTerminal('id:wt-1', {
      command: 'evil --client-controlled',
      agentLaunch: { selection: { kind: 'agent', agent: 'claude' }, prompt: 'hi' }
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ command: 'claude --tui' }))
    expect('handle' in result).toBe(true)
    if (!('handle' in result)) {
      return
    }
    expect(result.ptyId).toBe('pty-1')
    expect(result.agentLaunch).toEqual({ status: 'launched', receipt: RECEIPT })
  })

  it('creates no PTY and returns the failure arm for a pre-spawn typed failure', async () => {
    resolveMock.mockResolvedValue({
      kind: 'failed',
      outcome: { status: 'failed', failure: { code: 'base_agent_disabled', baseAgent: 'claude' } }
    })
    const runtime = new OrcaRuntimeService()
    stubLaunchScope(runtime)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-1' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const result = await runtime.createTerminal('id:wt-1', {
      agentLaunch: { selection: { kind: 'agent', agent: 'claude' }, prompt: 'hi' }
    })

    expect(spawn).not.toHaveBeenCalled()
    expect(result).toEqual({
      agentLaunch: {
        status: 'failed',
        failure: { code: 'base_agent_disabled', baseAgent: 'claude' }
      }
    })
  })
})
