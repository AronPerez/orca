// U6: the runtime backing for the automation resolve-only agent-launch gate.
// classifyAgentLaunchForAutomation resolves the agent WITHOUT spawning and maps a
// known launch failure to a PLAIN structured failure; the service stamps the
// persisted wrapper at its single persist point (ledger #12). A resolvable agent
// returns null so dispatch proceeds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'

const testState = { dir: '' }

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
}

const REPO: Repo = {
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1
}

describe('OrcaRuntimeService.classifyAgentLaunchForAutomation (U6)', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-classify-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('returns a plain structured failure for a disabled base agent (no wrapper mint)', async () => {
    const store = await createStore()
    store.addRepo(REPO)
    store.updateSettings({ disabledTuiAgents: ['claude'] })
    const runtime = new OrcaRuntimeService(store)

    const failure = runtime.classifyAgentLaunchForAutomation('claude', REPO, 'run-1')

    expect(failure).not.toBeNull()
    expect(failure?.code).toBe('base_agent_disabled')
    // Plain failure only — the persisted wrapper fields are the service's to mint.
    expect(failure).not.toHaveProperty('failureId')
    expect(failure).not.toHaveProperty('version')
    expect(failure).not.toHaveProperty('intent')
    expect(failure).not.toHaveProperty('occurredAt')
  })

  it('returns null for a resolvable (enabled) agent so dispatch proceeds', async () => {
    const store = await createStore()
    store.addRepo(REPO)
    const runtime = new OrcaRuntimeService(store)

    expect(runtime.classifyAgentLaunchForAutomation('claude', REPO, 'run-1')).toBeNull()
  })
})
