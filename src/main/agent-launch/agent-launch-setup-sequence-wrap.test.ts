import { describe, expect, it, vi } from 'vitest'
import { wrapAgentPlanWithSetupSequence } from './agent-launch-setup-sequence-wrap'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
import type { AgentStartupPlan } from '../../shared/tui-agent-startup'
import type { WorktreeSetupLaunch } from '../../shared/types'

const PLAN: AgentStartupPlan = {
  agent: 'claude',
  launchCommand: 'claude --resume',
  expectedProcess: 'claude',
  followupPrompt: null,
  launchConfig: { agentArgs: '', agentEnv: {} },
  env: { ORCA_AGENT_ENV: 'user-value' }
}

const SETUP: WorktreeSetupLaunch = {
  runnerScriptPath: '/wt/.orca/setup.sh',
  waitForAgentStartup: true
} as WorktreeSetupLaunch

describe('wrapAgentPlanWithSetupSequence', () => {
  it('passes the plan through unchanged when setup does not wait for agent startup', () => {
    const wrapped = wrapAgentPlanWithSetupSequence(PLAN, undefined)
    expect(wrapped.command).toBe('claude --resume')
    expect(wrapped.env).toEqual({ ORCA_AGENT_ENV: 'user-value' })
    expect(wrapped.wrappedSetupCommand).toBeUndefined()
    // The real launch command is never moved into the sequenced env.
    expect(wrapped.env).not.toHaveProperty(SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV)
  })

  it('carries the resolved launch command in the SPAWN env only when waiting for setup', () => {
    const createSequenced = vi.fn(() => ({
      setupCommand: 'run-setup && touch marker',
      startupCommand: 'wait-for marker; exec "$ORCA_SEQUENCED_STARTUP_COMMAND"',
      startupEnv: { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'claude --resume' }
    }))
    const wrapped = wrapAgentPlanWithSetupSequence(PLAN, SETUP, createSequenced)

    // createSequenced is fed the resolved launch command as the startup command.
    expect(createSequenced).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerScriptPath: '/wt/.orca/setup.sh',
        startupCommand: 'claude --resume'
      })
    )
    // The spawned command is the wait-then-run wrapper, not the raw agent command.
    expect(wrapped.command).toBe('wait-for marker; exec "$ORCA_SEQUENCED_STARTUP_COMMAND"')
    expect(wrapped.command).not.toBe('claude --resume')
    // The real launch command travels in the spawn env (this env is applied by the
    // caller AFTER admission, so it never reaches the admitted snapshot).
    expect(wrapped.env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]).toBe('claude --resume')
    // User agent env is preserved alongside the sequenced key.
    expect(wrapped.env?.ORCA_AGENT_ENV).toBe('user-value')
    expect(wrapped.wrappedSetupCommand).toBe('run-setup && touch marker')
  })
})
