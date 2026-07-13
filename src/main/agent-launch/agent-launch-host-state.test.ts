import { describe, expect, it, vi } from 'vitest'
import {
  deriveAgentLaunchHostState,
  defaultTransportConfidentiality,
  describeSpawnExecutionHost,
  detectionUnavailable,
  executionHostIdForDescriptor,
  isRemoteForDescriptor,
  platformForDescriptor,
  resolveLocalTargetHomePath,
  toStockBaseAgentSet,
  type AgentLaunchHostDescriptor,
  type AgentLaunchHostStateDeps
} from './agent-launch-host-state'
import type { GlobalSettings } from '../../shared/types'

function makeDeps(overrides: Partial<AgentLaunchHostStateDeps> = {}): AgentLaunchHostStateDeps {
  return {
    getSettings: () => ({}) as GlobalSettings,
    getCatalogRevision: () => 3,
    detectStockBaseAgents: async () => ['claude', 'codex'],
    resolveTargetHomePath: async () => '/home/dev',
    ...overrides
  }
}

describe('executionHostIdForDescriptor', () => {
  it('maps each surface to its stable host id', () => {
    expect(executionHostIdForDescriptor({ kind: 'local', platform: 'darwin' })).toBe('local')
    expect(executionHostIdForDescriptor({ kind: 'wsl', distro: 'Ubuntu 22.04' })).toBe(
      'wsl:Ubuntu%2022.04'
    )
    expect(
      executionHostIdForDescriptor({ kind: 'ssh', connectionId: 'my host', platform: 'linux' })
    ).toBe('ssh:my%20host')
    expect(
      executionHostIdForDescriptor({ kind: 'runtime', environmentId: 'env/1', platform: 'linux' })
    ).toBe('runtime:env%2F1')
  })
})

describe('platformForDescriptor / isRemoteForDescriptor', () => {
  it('forces linux for WSL and keeps the named platform otherwise', () => {
    expect(platformForDescriptor({ kind: 'wsl', distro: 'Ubuntu' })).toBe('linux')
    expect(platformForDescriptor({ kind: 'local', platform: 'win32' })).toBe('win32')
    expect(platformForDescriptor({ kind: 'ssh', connectionId: 'h', platform: 'linux' })).toBe(
      'linux'
    )
  })

  it('treats SSH and default runtime as remote, local and WSL as local', () => {
    expect(isRemoteForDescriptor({ kind: 'local', platform: 'darwin' })).toBe(false)
    expect(isRemoteForDescriptor({ kind: 'wsl', distro: 'Ubuntu' })).toBe(false)
    expect(isRemoteForDescriptor({ kind: 'ssh', connectionId: 'h', platform: 'linux' })).toBe(true)
    expect(isRemoteForDescriptor({ kind: 'runtime', environmentId: 'e', platform: 'linux' })).toBe(
      true
    )
    expect(
      isRemoteForDescriptor({
        kind: 'runtime',
        environmentId: 'e',
        platform: 'linux',
        isRemote: false
      })
    ).toBe(false)
  })
})

describe('defaultTransportConfidentiality', () => {
  it('is undefined same-host, true for SSH, false for an unproven runtime channel', () => {
    expect(defaultTransportConfidentiality({ kind: 'local', platform: 'darwin' })).toBeUndefined()
    expect(defaultTransportConfidentiality({ kind: 'wsl', distro: 'Ubuntu' })).toBeUndefined()
    expect(
      defaultTransportConfidentiality({ kind: 'ssh', connectionId: 'h', platform: 'linux' })
    ).toBe(true)
    expect(
      defaultTransportConfidentiality({ kind: 'runtime', environmentId: 'e', platform: 'linux' })
    ).toBe(false)
  })
})

describe('toStockBaseAgentSet', () => {
  it('preserves the unknown/known-none distinction and filters to built-ins', () => {
    expect(toStockBaseAgentSet(null)).toBeNull()
    expect(toStockBaseAgentSet(undefined)).toBeNull()
    const none = toStockBaseAgentSet([])
    expect(none).not.toBeNull()
    expect(none!.size).toBe(0)
    const some = toStockBaseAgentSet(['claude', 'not-an-agent', 'codex'])
    expect([...some!].sort()).toEqual(['claude', 'codex'])
  })
})

describe('deriveAgentLaunchHostState', () => {
  it('derives a full local target with detection and home', async () => {
    const state = await deriveAgentLaunchHostState(
      makeDeps(),
      { kind: 'local', platform: 'darwin' },
      { repoPath: '/repo', worktreePath: '/repo/wt' }
    )
    expect(state.target.platform).toBe('darwin')
    expect(state.target.isRemote).toBe(false)
    expect(state.target.executionHostId).toBe('local')
    expect(state.target.targetHomePath).toBe('/home/dev')
    expect([...state.target.detectedStockBaseAgents!].sort()).toEqual(['claude', 'codex'])
    // Same-host: confidentiality is omitted (undefined), not false.
    expect('transportConfidentialityAvailable' in state.target).toBe(false)
    expect(state.variables).toEqual({ repoPath: '/repo', worktreePath: '/repo/wt' })
    expect(state.getCatalogRevision()).toBe(3)
  })

  it('carries an SSH target with confidential transport and derived host id', async () => {
    const state = await deriveAgentLaunchHostState(
      makeDeps({ resolveTargetHomePath: async () => '/home/remote' }),
      { kind: 'ssh', connectionId: 'box-1', platform: 'linux', shell: 'posix' },
      {}
    )
    expect(state.target.isRemote).toBe(true)
    expect(state.target.executionHostId).toBe('ssh:box-1')
    expect(state.target.shell).toBe('posix')
    expect(state.target.targetHomePath).toBe('/home/remote')
    expect(state.target.transportConfidentialityAvailable).toBe(true)
  })

  it('derives a WSL target as local linux with a wsl host id', async () => {
    const state = await deriveAgentLaunchHostState(
      makeDeps({ resolveTargetHomePath: async () => null }),
      { kind: 'wsl', distro: 'Ubuntu' },
      { repoPath: '/mnt/c/repo' }
    )
    expect(state.target.platform).toBe('linux')
    expect(state.target.isRemote).toBe(false)
    expect(state.target.executionHostId).toBe('wsl:Ubuntu')
    // Home unknown -> null so the resolver fails missing_target_home for ~ prefixes.
    expect(state.target.targetHomePath).toBeNull()
    expect('transportConfidentialityAvailable' in state.target).toBe(false)
  })

  it('fails closed on a runtime channel: remote, plaintext-conservative confidentiality', async () => {
    const state = await deriveAgentLaunchHostState(
      makeDeps(),
      { kind: 'runtime', environmentId: 'sandbox-9', platform: 'linux' },
      {}
    )
    expect(state.target.isRemote).toBe(true)
    expect(state.target.executionHostId).toBe('runtime:sandbox-9')
    expect(state.target.transportConfidentialityAvailable).toBe(false)
  })

  it('honors an injected confidentiality override for an identified binding', async () => {
    const state = await deriveAgentLaunchHostState(
      makeDeps({ resolveTransportConfidentiality: () => true }),
      { kind: 'runtime', environmentId: 'sandbox-9', platform: 'linux' },
      {}
    )
    expect(state.target.transportConfidentialityAvailable).toBe(true)
  })

  it('passes honest unknowns through when detection and home are unavailable', async () => {
    const state = await deriveAgentLaunchHostState(
      makeDeps({
        detectStockBaseAgents: detectionUnavailable,
        resolveTargetHomePath: async () => null
      }),
      { kind: 'ssh', connectionId: 'box-1', platform: 'linux' },
      {}
    )
    expect(state.target.detectedStockBaseAgents).toBeNull()
    expect(state.target.targetHomePath).toBeNull()
  })

  it('normalizes missing variables to null', async () => {
    const state = await deriveAgentLaunchHostState(
      makeDeps(),
      { kind: 'local', platform: 'linux' },
      {}
    )
    expect(state.variables).toEqual({ repoPath: null, worktreePath: null })
  })

  it('runs the async host reads exactly once', async () => {
    const detect = vi.fn(async () => ['claude'])
    const home = vi.fn(async () => '/home/dev')
    await deriveAgentLaunchHostState(
      makeDeps({ detectStockBaseAgents: detect, resolveTargetHomePath: home }),
      { kind: 'local', platform: 'linux' },
      {}
    )
    expect(detect).toHaveBeenCalledTimes(1)
    expect(home).toHaveBeenCalledTimes(1)
  })
})

describe('describeSpawnExecutionHost', () => {
  it('describes a local target with this machine platform', () => {
    const descriptor = describeSpawnExecutionHost({ connectionId: null, cwd: '/repo' })
    expect(descriptor.kind).toBe('local')
    expect(descriptor).toMatchObject({ kind: 'local', platform: process.platform })
  })

  it('describes an SSH target and infers linux from a POSIX cwd', () => {
    const descriptor = describeSpawnExecutionHost({
      connectionId: 'host-1',
      cwd: '/home/user/repo'
    })
    expect(descriptor).toEqual({ kind: 'ssh', connectionId: 'host-1', platform: 'linux' })
  })

  it('infers win32 for an SSH target with a Windows-shaped cwd', () => {
    const descriptor = describeSpawnExecutionHost({
      connectionId: 'host-1',
      cwd: 'C:\\Users\\me\\repo'
    })
    expect(descriptor).toEqual({ kind: 'ssh', connectionId: 'host-1', platform: 'win32' })
  })

  it('defaults an SSH target to linux when the cwd is unknown', () => {
    const descriptor = describeSpawnExecutionHost({ connectionId: 'host-1' })
    expect(descriptor).toEqual({ kind: 'ssh', connectionId: 'host-1', platform: 'linux' })
  })
})

describe('resolveLocalTargetHomePath', () => {
  it('returns a home dir for local and null for every other surface', async () => {
    const local: AgentLaunchHostDescriptor = { kind: 'local', platform: process.platform }
    await expect(resolveLocalTargetHomePath(local)).resolves.toEqual(expect.any(String))
    await expect(
      resolveLocalTargetHomePath({ kind: 'ssh', connectionId: 'h', platform: 'linux' })
    ).resolves.toBeNull()
    await expect(resolveLocalTargetHomePath({ kind: 'wsl', distro: 'Ubuntu' })).resolves.toBeNull()
  })
})
