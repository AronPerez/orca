import { describe, expect, it } from 'vitest'
import {
  buildVaultResumeStartup,
  findVaultResumeSession,
  resolveRevalidatedVaultResume,
  resolveRevalidatedVaultResumeDetails,
  resolveVaultResumeCopyCommand,
  resolveVaultResumeSpawn,
  type VaultResumeSession
} from './agent-launch-vault-resume'
import { RESUMABLE_TUI_AGENTS } from '../../shared/agent-session-resume'
import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentLaunchVaultResumeEntry } from '../../shared/agent-launch-spawn-request'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import { AgentSessionRecordStore } from './agent-session-record-store'

const CUSTOM_CODEX_ID = 'custom-agent:codex:11111111-1111-4111-8111-111111111111' as const

// Agents that are both AI Vault sessions AND resumable providers take the
// structured startup-plan branch; the rest (e.g. OMP) fall through to the
// path-based resume command. G5 requires every resumable provider to be proven.
const RESUMABLE_VAULT_AGENTS = AI_VAULT_AGENTS.filter((agent) =>
  (RESUMABLE_TUI_AGENTS as readonly string[]).includes(agent)
)

function vaultSession(overrides: Partial<VaultResumeSession> = {}): VaultResumeSession {
  return {
    agent: 'codex',
    sessionId: 'sess-abc-123',
    cwd: '/repo/app',
    codexHome: null,
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    ...overrides
  }
}

function entryFor(session: VaultResumeSession): AgentLaunchVaultResumeEntry {
  return {
    executionHostId: session.executionHostId,
    agent: session.agent,
    sessionId: session.sessionId
  }
}

describe('findVaultResumeSession', () => {
  it('matches on executionHostId, agent, and sessionId', () => {
    const target = vaultSession({ sessionId: 'match-me' })
    const sessions = [vaultSession({ sessionId: 'other' }), target]
    expect(findVaultResumeSession(entryFor(target), sessions)).toBe(target)
  })

  it('returns null when any identity field differs', () => {
    const target = vaultSession({ sessionId: 'match-me', agent: 'codex' })
    const sessions = [target]
    expect(findVaultResumeSession({ ...entryFor(target), sessionId: 'nope' }, sessions)).toBeNull()
    expect(findVaultResumeSession({ ...entryFor(target), agent: 'claude' }, sessions)).toBeNull()
    expect(
      findVaultResumeSession({ ...entryFor(target), executionHostId: 'ssh:box' }, sessions)
    ).toBeNull()
  })

  it('ignores the client-echoed filePath entirely (host re-derives identity)', () => {
    const target = vaultSession({ agent: 'omp', filePath: '/host/derived.jsonl' })
    // A client sending a bogus filePath still matches on the three identity
    // fields and the assembly reads the host-discovered filePath, never this one.
    const entry: AgentLaunchVaultResumeEntry = {
      ...entryFor(target),
      filePath: '/attacker/controlled.jsonl'
    }
    expect(findVaultResumeSession(entry, [target])).toBe(target)
  })

  it('uses the locator to distinguish duplicate legacy identities', () => {
    const first = vaultSession({ sessionId: 'same', resumeLocator: 'a'.repeat(64) })
    const second = vaultSession({ sessionId: 'same', resumeLocator: 'b'.repeat(64) })
    expect(
      findVaultResumeSession({ ...entryFor(first), resumeLocator: second.resumeLocator }, [
        first,
        second
      ])
    ).toBe(second)
    expect(findVaultResumeSession(entryFor(first), [first, second])).toBeNull()
  })
})

function capturedSnapshot(): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: CUSTOM_CODEX_ID,
    baseAgent: 'codex',
    displayLabel: 'Codex Sol',
    mode: 'custom',
    argv: ['codex', '--model', 'gpt-5.6-Sol', '-c', 'model_reasoning_effort=medium'],
    agentEnv: {},
    capturedEnvPolicy: 'none',
    target: {
      platform: 'linux',
      execution: 'native',
      shell: 'posix',
      isRemote: false,
      executionHostId: 'local'
    }
  }
}

describe('resolveRevalidatedVaultResume', () => {
  it('converts one correlated owner into the ordinary session resume request', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      {
        worktreeId: 'wt-source',
        requestedAgent: CUSTOM_CODEX_ID,
        baseAgent: 'codex',
        providerSession: {
          key: 'session_id',
          id: 'hook-resume-id',
          transcriptPath: '/repo/transcript.jsonl'
        },
        launchSnapshot: capturedSnapshot(),
        registeredAt: 1,
        updatedAt: 1
      }
    ])
    expect(
      resolveRevalidatedVaultResume({
        session: vaultSession({
          sessionId: 'scanner-id',
          filePath: '/repo/transcript.jsonl'
        }),
        sessionRecordStore: store,
        targetExecutionHostId: 'local',
        targetPlatform: 'linux',
        preferredWorktreeId: 'wt-destination'
      })
    ).toEqual({
      kind: 'snapshot',
      request: {
        resume: {
          operation: 'resume',
          sessionKey: {
            worktreeId: 'wt-source',
            baseAgent: 'codex',
            providerSessionId: 'hook-resume-id'
          }
        }
      }
    })
  })

  it('builds a disclosed current-settings fallback only for resumable providers', () => {
    const store = new AgentSessionRecordStore()
    const fallback = resolveRevalidatedVaultResume({
      session: vaultSession(),
      sessionRecordStore: store,
      targetExecutionHostId: 'local',
      targetPlatform: 'linux',
      mintNoticeToken: () => 'notice-token'
    })
    expect(fallback).toMatchObject({
      kind: 'fallback',
      reason: 'missing',
      launchNotices: {
        launchToken: 'notice-token',
        notices: [{ code: 'vault_original_config_unavailable', baseAgent: 'codex' }]
      }
    })
    const unsupported = resolveRevalidatedVaultResume({
      session: vaultSession({ agent: 'omp' }),
      sessionRecordStore: store,
      targetExecutionHostId: 'local',
      targetPlatform: 'linux'
    })
    expect(unsupported.kind).toBe('fallback')
    if (unsupported.kind === 'fallback') {
      expect(unsupported.reason).toBe('unsupported')
      expect(unsupported.launchNotices).toBeUndefined()
    }
  })
})

describe('resolveRevalidatedVaultResumeDetails', () => {
  it('returns the captured argument suffix, including the original effort setting', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      {
        worktreeId: 'wt-source',
        requestedAgent: CUSTOM_CODEX_ID,
        baseAgent: 'codex',
        providerSession: { key: 'session_id', id: 'sess-abc-123' },
        launchSnapshot: capturedSnapshot(),
        registeredAt: 1,
        updatedAt: 1
      }
    ])

    expect(
      resolveRevalidatedVaultResumeDetails({ session: vaultSession(), sessionRecordStore: store })
    ).toEqual({
      status: 'ok',
      args: ['--model', 'gpt-5.6-Sol', '-c', 'model_reasoning_effort=medium']
    })
  })

  it('does not substitute current settings for missing private correlation', () => {
    expect(
      resolveRevalidatedVaultResumeDetails({
        session: vaultSession(),
        sessionRecordStore: new AgentSessionRecordStore()
      })
    ).toEqual({ status: 'unavailable' })
  })
})

describe('buildVaultResumeStartup', () => {
  it('appends the provider resume argv exactly once for every resumable vault agent', () => {
    for (const agent of RESUMABLE_VAULT_AGENTS) {
      const session = vaultSession({ agent: agent as AiVaultAgent, sessionId: `id-${agent}` })
      const startup = buildVaultResumeStartup({ session, hostPlatform: 'linux' })
      expect(startup.command).toContain(`id-${agent}`)
      // The session id is the resume target and must appear exactly once.
      expect(startup.command.split(`id-${agent}`).length - 1).toBe(1)
      expect(startup.launchConfig).toBeDefined()
      // The queued command re-enters the session's cwd before launching.
      expect(startup.command).toContain('/repo/app')
    }
  })

  it('resumes Antigravity by conversation id on the structured startup-plan path', () => {
    // Antigravity's resume argv keys on conversation_id; a hardcoded session_id
    // key would silently drop it to the unstructured fallback (no launchConfig).
    const session = vaultSession({ agent: 'antigravity', sessionId: 'conv-42' })
    const startup = buildVaultResumeStartup({ session, hostPlatform: 'linux' })
    expect(startup.command).toContain('--conversation')
    expect(startup.command).toContain('conv-42')
    expect(startup.launchConfig).toBeDefined()
  })

  it('resumes OMP by its host-derived transcript path, not the client field', () => {
    const session = vaultSession({
      agent: 'omp',
      sessionId: 'omp-sess',
      filePath: '/host/transcripts/omp-sess.jsonl'
    })
    const startup = buildVaultResumeStartup({ session, hostPlatform: 'linux' })
    // OMP is non-resumable → the path-based fallback resumes by absolute path.
    expect(startup.command).toContain('/host/transcripts/omp-sess.jsonl')
    expect(startup.launchConfig).toBeUndefined()
  })

  it('replays a remote session command verbatim without re-deriving it', () => {
    const session = vaultSession({
      agent: 'codex',
      executionHostId: 'ssh:box',
      executionHostPlatform: 'linux',
      resumeCommand: 'REMOTE_READY_COMMAND --resume remote-id'
    })
    const startup = buildVaultResumeStartup({ session, hostPlatform: 'darwin' })
    expect(startup.command).toBe('REMOTE_READY_COMMAND --resume remote-id')
    expect(startup.launchConfig).toBeUndefined()
    expect(startup.env).toBeUndefined()
  })

  it('rewrites a WSL UNC Codex home to POSIX when the target is linux', () => {
    const session = vaultSession({
      agent: 'codex',
      codexHome: '\\\\wsl$\\Ubuntu\\home\\me\\.codex'
    })
    const startup = buildVaultResumeStartup({ session, hostPlatform: 'linux' })
    expect(startup.command).toContain('/home/me/.codex')
    expect(startup.command).not.toContain('wsl$')
  })

  it('honors a per-agent command override', () => {
    const session = vaultSession({ agent: 'codex', sessionId: 'ov-id' })
    const startup = buildVaultResumeStartup({
      session,
      hostPlatform: 'linux',
      settings: { agentCmdOverrides: { codex: 'my-codex' } }
    })
    expect(startup.command).toContain('my-codex')
  })
})

describe('resolveVaultResumeCopyCommand', () => {
  it('returns the assembled command for a discovered entry', () => {
    const session = vaultSession({ agent: 'codex', sessionId: 'copy-id' })
    const result = resolveVaultResumeCopyCommand({
      entry: entryFor(session),
      sessions: [session],
      hostPlatform: 'linux'
    })
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.command).toBe(
        buildVaultResumeStartup({ session, hostPlatform: 'linux' }).command
      )
    }
  })

  it('fails closed with invalid_launch_snapshot when the host did not discover the entry', () => {
    const session = vaultSession({ sessionId: 'known' })
    const result = resolveVaultResumeCopyCommand({
      entry: { ...entryFor(session), sessionId: 'unknown' },
      sessions: [session],
      hostPlatform: 'linux'
    })
    expect(result).toEqual({
      status: 'failed',
      failure: { code: 'invalid_launch_snapshot' }
    })
  })
})

describe('resolveVaultResumeSpawn (U7 runtime resume-via-arm)', () => {
  it('assembles the full startup (command/env/launchConfig) for a discovered resume', () => {
    const session = vaultSession({ agent: 'codex', sessionId: 'spawn-id' })
    const result = resolveVaultResumeSpawn({
      vaultResume: { operation: 'resume', entry: entryFor(session) },
      sessions: [session],
      hostPlatform: 'linux'
    })
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      const expected = buildVaultResumeStartup({ session, hostPlatform: 'linux' })
      expect(result.startup.command).toBe(expected.command)
      expect(result.startup.launchConfig).toEqual(expected.launchConfig)
    }
  })

  it('fails closed for an entry the host did not discover', () => {
    const session = vaultSession({ sessionId: 'known' })
    const result = resolveVaultResumeSpawn({
      vaultResume: { operation: 'resume', entry: { ...entryFor(session), sessionId: 'unknown' } },
      sessions: [session],
      hostPlatform: 'linux'
    })
    expect(result).toEqual({ status: 'failed', failure: { code: 'invalid_launch_snapshot' } })
  })

  it('fails closed for a copy op reaching the spawn arm (misroute)', () => {
    // copy is served by the dedicated command method; a copy op must never spawn.
    const session = vaultSession({ sessionId: 'copy-misroute' })
    const result = resolveVaultResumeSpawn({
      vaultResume: { operation: 'copy', entry: entryFor(session) },
      sessions: [session],
      hostPlatform: 'linux'
    })
    expect(result).toEqual({ status: 'failed', failure: { code: 'invalid_launch_snapshot' } })
  })
})
