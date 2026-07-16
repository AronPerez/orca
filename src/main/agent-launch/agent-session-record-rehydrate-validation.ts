// Rehydrate-only structural checks for persisted session records. Persisted JSON
// is untrusted shape; the resume replay paths read snapshot argv/agentEnv/target
// (and legacy agentArgs/agentEnv) without re-validating, so a corrupt payload
// must be dropped at rehydrate for resume to degrade to the in-band
// invalid_launch_snapshot instead of throwing.

import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import { isBuiltInTuiAgent, isTuiAgent } from '../../shared/tui-agent-config'

const SNAPSHOT_MODES: ReadonlySet<unknown> = new Set(['built-in', 'custom', 'safe-fallback'])
const CAPTURED_ENV_POLICIES: ReadonlySet<unknown> = new Set(['full', 'withheld', 'none'])

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  )
}

export function isWellFormedLaunchSnapshot(value: unknown): value is AgentLaunchSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const snapshot = value as Record<string, unknown>
  const target = snapshot.target as Record<string, unknown> | null | undefined
  return Boolean(
    snapshot.version === 1 &&
    isTuiAgent(snapshot.requestedAgent) &&
    isBuiltInTuiAgent(snapshot.baseAgent) &&
    typeof snapshot.displayLabel === 'string' &&
    SNAPSHOT_MODES.has(snapshot.mode) &&
    Array.isArray(snapshot.argv) &&
    snapshot.argv.length > 0 &&
    snapshot.argv.every((element) => typeof element === 'string') &&
    isStringRecord(snapshot.agentEnv) &&
    CAPTURED_ENV_POLICIES.has(snapshot.capturedEnvPolicy) &&
    typeof target === 'object' &&
    target !== null &&
    typeof target.platform === 'string' &&
    (target.execution === 'native' || target.execution === 'wsl') &&
    typeof target.shell === 'string' &&
    typeof target.isRemote === 'boolean' &&
    typeof target.executionHostId === 'string'
  )
}

export function isWellFormedLegacyLaunchConfig(value: unknown): value is SleepingAgentLaunchConfig {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const config = value as Record<string, unknown>
  return (
    (config.agentCommand === undefined || typeof config.agentCommand === 'string') &&
    typeof config.agentArgs === 'string' &&
    isStringRecord(config.agentEnv)
  )
}
