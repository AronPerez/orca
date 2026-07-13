// U5: opaque one-release legacy-config replay. Proves provider resume flags are
// appended exactly once to the one-shot command (never the durable config), that
// Orca attribution env is stripped, and that every failure mode fails closed to
// invalid_launch_snapshot without a partial replay.
import { describe, expect, it } from 'vitest'
import {
  RESUMABLE_TUI_AGENTS,
  getAgentResumeArgv,
  providerSessionKeyForResumableBase
} from '../../shared/agent-session-resume'
import { buildLegacyResumeReplay } from './agent-launch-legacy-replay'

function replay(overrides: Partial<Parameters<typeof buildLegacyResumeReplay>[0]> = {}) {
  return buildLegacyResumeReplay({
    legacyLaunchConfig: { agentCommand: 'claude', agentArgs: '--model opus', agentEnv: {} },
    requestedAgent: 'claude',
    baseAgent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    shell: 'posix',
    recordedConnectionId: null,
    currentConnectionId: null,
    ...overrides
  })
}

describe('buildLegacyResumeReplay', () => {
  it('appends the provider resume flags to the one-shot command only', () => {
    const result = replay()
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.launchCommand).toContain('--resume')
    expect(result.launchCommand).toContain('sess-1')
    // Durable config keeps the base args only, so a fresh relaunch never re-resumes.
    expect(result.launchConfig.agentArgs).toBe('--model opus')
    expect(result.launchConfig.agentArgs).not.toContain('--resume')
    expect(result.launchConfig.agentCommand).toBe('claude')
  })

  it('appends resume argv once for every resumable base', () => {
    for (const base of RESUMABLE_TUI_AGENTS) {
      const key = providerSessionKeyForResumableBase(base)
      const providerSession = { key, id: 'sess-9' } as const
      const result = replay({ baseAgent: base, requestedAgent: base, providerSession })
      expect(result.ok, `base ${base}`).toBe(true)
      if (!result.ok) {
        continue
      }
      const resumeArgv = getAgentResumeArgv(base, providerSession)
      expect(resumeArgv).not.toBeNull()
      // The final flag/value pair appears exactly once in the one-shot command.
      const lastFlag = resumeArgv?.at(-2)
      if (lastFlag) {
        const occurrences = result.launchCommand.split(lastFlag).length - 1
        expect(occurrences, `base ${base} flag ${lastFlag}`).toBe(1)
      }
    }
  })

  it('strips Orca attribution and tmux identity env before replay', () => {
    const result = replay({
      legacyLaunchConfig: {
        agentCommand: 'claude',
        agentArgs: '',
        agentEnv: {
          FOO: 'bar',
          ORCA_PANE_KEY: 'p',
          ORCA_AGENT_LAUNCH_TOKEN: 't',
          TMUX: 'x',
          TMUX_PANE: '%1'
        }
      }
    })
    expect(result.ok && result.launchConfig.agentEnv).toEqual({ FOO: 'bar' })
  })

  it('strips captured Agent Teams identity and the shim PATH prefix from the durable config', () => {
    const result = replay({
      legacyLaunchConfig: {
        agentCommand: 'claude',
        agentArgs: '',
        agentEnv: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          TERM: 'screen-256color',
          TMUX: 'x',
          TMUX_PANE: '%1',
          ORCA_AGENT_TEAMS_TOKEN: 'stale-token',
          ORCA_AGENT_TEAMS_SHIM_DIR: '/home/me/.orca/teams-bin',
          PATH: '/home/me/.orca/teams-bin:/usr/bin',
          MY_TOKEN: 'keep'
        }
      }
    })
    // Generated team identity and stale token are gone; the user PATH tail and
    // custom key survive so the downstream path can regenerate a fresh team plan.
    expect(result.ok && result.launchConfig.agentEnv).toEqual({
      PATH: '/usr/bin',
      MY_TOKEN: 'keep'
    })
  })

  it('fails closed when the recorded owner differs from the current owner', () => {
    expect(replay({ recordedConnectionId: 'ssh:a', currentConnectionId: 'ssh:b' }).ok).toBe(false)
  })

  it('fails closed on an empty command', () => {
    expect(
      replay({ legacyLaunchConfig: { agentCommand: '', agentArgs: '', agentEnv: {} } }).ok
    ).toBe(false)
    expect(replay({ legacyLaunchConfig: { agentArgs: '', agentEnv: {} } }).ok).toBe(false)
  })

  it('fails closed on a control character in the command', () => {
    expect(
      replay({ legacyLaunchConfig: { agentCommand: 'claude\n rm', agentArgs: '', agentEnv: {} } })
        .ok
    ).toBe(false)
  })

  it('fails closed when the session key type does not match the base', () => {
    // claude is session_id-keyed; a conversation_id session cannot resume it.
    expect(replay({ providerSession: { key: 'conversation_id', id: 'x' } }).ok).toBe(false)
  })
})
