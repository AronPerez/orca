import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'

// The module imports `safeStorage` at top for its Electron cipher factory; these
// tests inject their own cipher, so a bare stub keeps the import resolvable.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (value: Buffer) => value.toString('utf-8')
  }
}))

import type { HostSessionLaunchRecord } from './agent-session-record-store'
import {
  agentSessionRecordStorePath,
  decodeAgentSessionRecordStore,
  encodeAgentSessionRecordStore,
  loadAgentSessionRecordStoreState,
  writeAgentSessionRecordStoreState,
  type AgentSessionRecordCipher
} from './agent-session-record-store-persistence'

function reversibleCipher(available: boolean): AgentSessionRecordCipher {
  return {
    available: () => available,
    encrypt: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf-8'),
    decrypt: (ciphertext) => ciphertext.toString('utf-8').replace(/^enc:/, '')
  }
}

const snapshot: AgentLaunchSnapshot = {
  version: 1,
  requestedAgent: 'claude',
  baseAgent: 'claude',
  displayLabel: 'Claude',
  mode: 'built-in',
  argv: ['claude'],
  agentEnv: { SECRET_TOKEN: 'do-not-leak' },
  capturedEnvPolicy: 'full',
  target: {
    platform: 'linux',
    execution: 'native',
    shell: 'posix',
    isRemote: false,
    executionHostId: 'local'
  }
}

const record: HostSessionLaunchRecord = {
  worktreeId: 'wt-1',
  requestedAgent: 'custom-agent:claude:reviewer',
  baseAgent: 'claude',
  providerSession: { key: 'session_id', id: 'sess-1' },
  launchSnapshot: snapshot,
  launchToken: 'secret-token',
  registeredAt: 1,
  updatedAt: 2
}

describe('agent-session-record-store persistence envelope', () => {
  it('encrypts the records section and round-trips through decode', () => {
    const cipher = reversibleCipher(true)
    const encoded = encodeAgentSessionRecordStore({ records: [record] }, cipher)
    expect(encoded.records.format).toBe('electron-safe-storage-v1')
    const decoded = decodeAgentSessionRecordStore(encoded, cipher)
    expect(decoded.records).toEqual([record])
  })

  it('falls back to hardened plaintext when encryption is unavailable', () => {
    const cipher = reversibleCipher(false)
    const encoded = encodeAgentSessionRecordStore({ records: [record] }, cipher)
    expect(encoded.records.format).toBe('plaintext-v1')
    expect(decodeAgentSessionRecordStore(encoded, cipher).records).toEqual([record])
  })

  it('drops records rather than blocking boot when the cipher is unavailable at decode', () => {
    const encoded = encodeAgentSessionRecordStore({ records: [record] }, reversibleCipher(true))
    // Keychain reset: encrypted section can no longer be read.
    expect(decodeAgentSessionRecordStore(encoded, reversibleCipher(false)).records).toEqual([])
  })

  it('returns empty state for an unknown version', () => {
    expect(decodeAgentSessionRecordStore({ version: 9 }, reversibleCipher(true))).toEqual({
      records: []
    })
  })
})

describe('agent-session-record-store persistence file I/O', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-session-records-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes an encrypted file whose bytes do not contain the plaintext secret', () => {
    const path = agentSessionRecordStorePath(dir)
    const cipher = reversibleCipher(true)
    writeAgentSessionRecordStoreState(path, { records: [record] }, cipher)
    const raw = readFileSync(path, 'utf-8')
    expect(raw).not.toContain('do-not-leak')
    expect(raw).not.toContain('secret-token')
    expect(loadAgentSessionRecordStoreState(path, cipher).records).toEqual([record])
  })

  it('returns empty state when the file is absent', () => {
    expect(
      loadAgentSessionRecordStoreState(agentSessionRecordStorePath(dir), reversibleCipher(true))
    ).toEqual({ records: [] })
  })
})
