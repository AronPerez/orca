import type { AgentLaunchSpawnRequest } from '../../../src/shared/agent-launch-spawn-request'

// Why: mobile agent launches send identity only — the host runs its own
// newest-revision default pick (oracle-19) rather than a client-cached agent id.
// Hosts without agent-launch identity support strip the extra field and spawn a
// plain terminal, matching the prior behavior, so this is safe to send always.
export function buildIdentityCreateTerminalParams(worktreeId: string): {
  worktree: string
  agentLaunch: AgentLaunchSpawnRequest
} {
  return {
    worktree: `id:${worktreeId}`,
    agentLaunch: { selection: { kind: 'default' } }
  }
}
