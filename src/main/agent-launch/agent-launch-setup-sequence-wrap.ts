import {
  createSequencedSetupAgentCommands,
  type SequencedSetupAgentCommands
} from '../../shared/setup-agent-sequencing'
import { getSetupRunnerCommandPlatformForPath } from '../../shared/setup-runner-command'
import type { AgentStartupPlan } from '../../shared/tui-agent-startup'
import type { WorktreeSetupLaunch } from '../../shared/types'

export type WrappedAgentSpawnCommand = {
  command: string
  env?: Record<string, string>
  wrappedSetupCommand?: string
}

/** Wait-for-agent setup sequencing (#6298) for a resolved agent plan: when the
 *  setup runner requests it, the agent terminal waits on the setup marker, then
 *  runs the resolved launch command carried by the sequenced env.
 *
 *  SECURITY: this MUST be applied AFTER admission, in the spawn path only. The
 *  sequenced env holds the real launch command, so it belongs to the spawned
 *  PTY's env and must never enter the admitted snapshot or a persisted failure —
 *  both are produced upstream from the resolved plan, before this wrap runs. */
export function wrapAgentPlanWithSetupSequence(
  plan: AgentStartupPlan,
  setup: WorktreeSetupLaunch | undefined,
  createSequenced: (args: {
    runnerScriptPath: string
    startupCommand: string
    platform: ReturnType<typeof getSetupRunnerCommandPlatformForPath>
  }) => SequencedSetupAgentCommands = createSequencedSetupAgentCommands
): WrappedAgentSpawnCommand {
  if (setup?.waitForAgentStartup !== true) {
    return { command: plan.launchCommand, ...(plan.env ? { env: plan.env } : {}) }
  }
  const platform = getSetupRunnerCommandPlatformForPath(
    setup.runnerScriptPath,
    process.platform === 'win32' ? 'windows' : 'posix'
  )
  const sequenced = createSequenced({
    runnerScriptPath: setup.runnerScriptPath,
    startupCommand: plan.launchCommand,
    platform
  })
  return {
    command: sequenced.startupCommand,
    env: { ...plan.env, ...sequenced.startupEnv },
    wrappedSetupCommand: sequenced.setupCommand
  }
}
