import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState } from '../../shared/types'

const {
  applyAgentStatusHooksEnabledMock,
  callMock,
  getCliStatusMock,
  getDefaultUserDataPathMock,
  getManagedAgentHookStatusesMock
} = vi.hoisted(() => ({
  applyAgentStatusHooksEnabledMock: vi.fn(),
  callMock: vi.fn(),
  getCliStatusMock: vi.fn(() =>
    Promise.resolve({
      id: 'test-status',
      ok: true,
      result: {
        app: { running: false, pid: null },
        runtime: { state: 'not_running', reachable: false, runtimeId: null },
        graph: { state: 'not_running' }
      },
      _meta: { runtimeId: 'test' }
    })
  ),
  getDefaultUserDataPathMock: vi.fn(),
  getManagedAgentHookStatusesMock: vi.fn()
}))

vi.mock('../runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = getCliStatusMock
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    constructor(readonly response: unknown) {
      super('rpc_failure', 'rpc failure')
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError,
    getDefaultUserDataPath: getDefaultUserDataPathMock
  }
})

vi.mock('../../main/agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock,
  getManagedAgentHookStatuses: getManagedAgentHookStatusesMock
}))

import { main } from '../index'

function readDataFile(userDataPath: string): PersistedState {
  return JSON.parse(readFileSync(join(userDataPath, 'orca-data.json'), 'utf-8')) as PersistedState
}

function writeDataFile(userDataPath: string, state: PersistedState): void {
  mkdirSync(userDataPath, { recursive: true })
  writeFileSync(join(userDataPath, 'orca-data.json'), JSON.stringify(state, null, 2), 'utf-8')
}

async function runAgentHooksOff(userDataPath: string): Promise<void> {
  getDefaultUserDataPathMock.mockReturnValue(userDataPath)
  await main(['agent', 'hooks', 'off', '--json'], userDataPath)
}

describe('agent hooks CLI handler', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-agent-hooks-cli-'))
    applyAgentStatusHooksEnabledMock.mockReset()
    applyAgentStatusHooksEnabledMock.mockReturnValue([])
    callMock.mockReset()
    getCliStatusMock.mockClear()
    getManagedAgentHookStatusesMock.mockReturnValue([])
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('keeps new card style off when creating offline settings for a fresh profile', async () => {
    await runAgentHooksOff(userDataPath)

    const persisted = readDataFile(userDataPath)

    expect(persisted.settings.experimentalNewWorktreeCardStyle).toBe(false)
    expect(persisted.settings.agentStatusHooksEnabled).toBe(false)
  })

  it('keeps missing new card style off when updating offline settings', async () => {
    const existing = getDefaultPersistedState(userDataPath)
    delete existing.settings.experimentalNewWorktreeCardStyle
    writeDataFile(userDataPath, existing)

    await runAgentHooksOff(userDataPath)

    expect(readDataFile(userDataPath).settings.experimentalNewWorktreeCardStyle).toBe(false)
  })

  it('preserves an existing explicit new card style opt-in when updating offline settings', async () => {
    const existing = getDefaultPersistedState(userDataPath)
    existing.settings.experimentalNewWorktreeCardStyle = true
    writeDataFile(userDataPath, existing)

    await runAgentHooksOff(userDataPath)

    expect(readDataFile(userDataPath).settings.experimentalNewWorktreeCardStyle).toBe(true)
  })

  const AGENT_CATALOG_KEYS = [
    'agentCatalogSchemaVersion',
    'agentCatalogRevision',
    'agentReferenceRevision',
    'defaultTuiAgent',
    'disabledTuiAgents',
    'customTuiAgents',
    'deletedCustomTuiAgents'
  ] as const

  it('never stamps agent-catalog schema fields onto an existing pre-v1 file', async () => {
    const existing = getDefaultPersistedState(userDataPath)
    const settings = existing.settings as unknown as Record<string, unknown>
    for (const key of AGENT_CATALOG_KEYS) {
      delete settings[key]
    }
    // Pre-v1 legacy shape: an explicit null default, no schema stamp.
    settings.defaultTuiAgent = null
    writeDataFile(userDataPath, existing)

    await runAgentHooksOff(userDataPath)

    const persisted = readDataFile(userDataPath).settings as unknown as Record<string, unknown>
    expect(persisted.agentStatusHooksEnabled).toBe(false)
    expect(persisted.defaultTuiAgent).toBeNull()
    for (const key of AGENT_CATALOG_KEYS) {
      if (key === 'defaultTuiAgent') {
        continue
      }
      expect(persisted, key).not.toHaveProperty(key)
    }
    // Non-catalog defaults still normalize.
    expect(persisted.experimentalNewWorktreeCardStyle).toBe(false)
  })

  it('round-trips an existing v1 catalog byte-for-byte through an offline update', async () => {
    const existing = getDefaultPersistedState(userDataPath)
    const settings = existing.settings as unknown as Record<string, unknown>
    settings.agentCatalogSchemaVersion = 1
    settings.agentCatalogRevision = 7
    settings.agentReferenceRevision = 3
    settings.customTuiAgents = [{ id: 'custom-abc', label: 'My Agent', baseAgent: 'claude' }]
    settings.deletedCustomTuiAgents = [{ id: 'custom-gone' }]
    writeDataFile(userDataPath, existing)

    await runAgentHooksOff(userDataPath)

    const persisted = readDataFile(userDataPath).settings as unknown as Record<string, unknown>
    expect(persisted.agentCatalogSchemaVersion).toBe(1)
    expect(persisted.agentCatalogRevision).toBe(7)
    expect(persisted.agentReferenceRevision).toBe(3)
    expect(persisted.customTuiAgents).toEqual([
      { id: 'custom-abc', label: 'My Agent', baseAgent: 'claude' }
    ])
    expect(persisted.deletedCustomTuiAgents).toEqual([{ id: 'custom-gone' }])
  })

  it('refuses the offline write when the file carries a newer agent-catalog schema', async () => {
    const existing = getDefaultPersistedState(userDataPath)
    ;(existing.settings as unknown as Record<string, unknown>).agentCatalogSchemaVersion = 2
    writeDataFile(userDataPath, existing)
    const before = readFileSync(join(userDataPath, 'orca-data.json'), 'utf-8')

    await runAgentHooksOff(userDataPath)

    expect(process.exitCode).toBe(1)
    expect(readFileSync(join(userDataPath, 'orca-data.json'), 'utf-8')).toBe(before)
    expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
  })
})
