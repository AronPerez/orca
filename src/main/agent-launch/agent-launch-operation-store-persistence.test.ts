import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

import type {
  AgentLaunchOperationStoreDurableState,
  PendingAgentLaunchSnapshot,
  SettledAgentLaunchOperation
} from './agent-launch-operation-store'
import {
  agentLaunchOperationStorePath,
  decodeAgentLaunchOperationStore,
  encodeAgentLaunchOperationStore,
  loadAgentLaunchOperationStoreState,
  writeAgentLaunchOperationStoreState,
  type AgentLaunchOperationCipher
} from './agent-launch-operation-store-persistence'

// XOR-ish reversible transform standing in for safeStorage so the envelope
// round-trip is exercised without an OS keychain, and the on-disk pending bytes
// are verifiably NOT the plaintext.
function reversibleCipher(available: boolean): AgentLaunchOperationCipher {
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

function pending(token: string): PendingAgentLaunchSnapshot {
  return {
    operationId: `op-${token}`,
    idempotencyKey: `key-${token}`,
    scope: 'r1::/wt',
    clientMutationId: null,
    payloadDigest: `digest-${token}`,
    launchToken: token,
    intent: 'interactive',
    snapshot
  }
}

function settled(operationId: string): SettledAgentLaunchOperation {
  return {
    operationId,
    idempotencyKey: `key-${operationId}`,
    scope: 'r1::/wt',
    payloadDigest: `digest-${operationId}`,
    status: 'launched',
    terminalId: 'term-1',
    failureId: null,
    settledAt: 10
  }
}

describe('agent-launch operation-store persistence', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-launch-store-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips both halves through encrypted encode/decode', () => {
    const cipher = reversibleCipher(true)
    const state: AgentLaunchOperationStoreDurableState = {
      pending: [pending('tok-a')],
      settled: [settled('op-1')]
    }
    const decoded = decodeAgentLaunchOperationStore(
      encodeAgentLaunchOperationStore(state, cipher),
      cipher
    )
    expect(decoded.pending).toEqual(state.pending)
    expect(decoded.settled).toEqual(state.settled)
  })

  it('encrypts the pending section so the token never appears in cleartext on disk', () => {
    const cipher = reversibleCipher(true)
    const path = agentLaunchOperationStorePath(dir)
    writeAgentLaunchOperationStoreState(
      path,
      { pending: [pending('super-secret-token')], settled: [] },
      cipher
    )
    const bytes = readFileSync(path, 'utf-8')
    expect(bytes).not.toContain('super-secret-token')
    expect(bytes).not.toContain('do-not-leak')
    const reloaded = loadAgentLaunchOperationStoreState(path, cipher)
    expect(reloaded.pending[0]?.launchToken).toBe('super-secret-token')
  })

  it('falls back to a hardened plaintext pending section when encryption is unavailable', () => {
    const cipher = reversibleCipher(false)
    const path = agentLaunchOperationStorePath(dir)
    writeAgentLaunchOperationStoreState(path, { pending: [pending('tok-b')], settled: [] }, cipher)
    const reloaded = loadAgentLaunchOperationStoreState(path, cipher)
    expect(reloaded.pending[0]?.launchToken).toBe('tok-b')
  })

  it('returns empty state for a missing file', () => {
    expect(
      loadAgentLaunchOperationStoreState(agentLaunchOperationStorePath(dir), reversibleCipher(true))
    ).toEqual({
      pending: [],
      settled: []
    })
  })

  it('keeps the settled ledger but drops pending when the pending section cannot be decrypted', () => {
    // Written with an available cipher, reloaded with an unavailable one: the
    // encrypted pending cannot be read, but the plaintext ledger survives.
    const path = agentLaunchOperationStorePath(dir)
    writeAgentLaunchOperationStoreState(
      path,
      { pending: [pending('tok-c')], settled: [settled('op-2')] },
      reversibleCipher(true)
    )
    const reloaded = loadAgentLaunchOperationStoreState(path, reversibleCipher(false))
    expect(reloaded.pending).toEqual([])
    expect(reloaded.settled).toEqual([settled('op-2')])
  })

  it('returns empty state for a corrupt file', () => {
    const path = agentLaunchOperationStorePath(dir)
    writeFileSync(path, '{ not json', 'utf-8')
    expect(loadAgentLaunchOperationStoreState(path, reversibleCipher(true))).toEqual({
      pending: [],
      settled: []
    })
  })
})
