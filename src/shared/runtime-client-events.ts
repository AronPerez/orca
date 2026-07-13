import type {
  CreatedWorktreeResult,
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch,
  WorktreeStartupLaunch
} from './types'
import type { SshConnectionState } from './ssh-types'

export type RuntimeClientEvent =
  | { type: 'reposChanged' }
  | { type: 'worktreesChanged'; repoId: string }
  // Why: SSH connections live on the runtime host; paired clients have no IPC
  // channel for ssh:state-changed, so without this event their reconnect
  // overlays never learn the host connected (STA-1468).
  | { type: 'sshStateChanged'; targetId: string; state: SshConnectionState }
  | {
      type: 'linearLinkedIssueUpdated'
      worktreeId: string
      identifier: string
      workspaceId: string
    }
  // Why: the agent catalog and its reference owners sync as revisioned full
  // snapshots. A revision bump announces the new number so connected
  // mobile/paired clients refetch the affected snapshot; reconnect always does
  // a full hydrate, so a missed event self-heals.
  | { type: 'agentCatalogChanged'; revision: number }
  | { type: 'agentReferencesChanged'; revision: number }
  | {
      type: 'activateWorktree'
      repoId: string
      worktreeId: string
      setup?: WorktreeSetupLaunch
      startup?: WorktreeStartupLaunch
      defaultTabs?: WorktreeDefaultTabsLaunch
    }

export type RuntimeClientEventStreamMessage =
  | ({ type: 'ready'; subscriptionId: string } & {
      snapshot?: {
        // Reserved for future hydration. Current clients refresh through the
        // existing repo/worktree RPCs after receiving server events.
        repos?: unknown[]
      }
    })
  | RuntimeClientEvent
  | { type: 'end' }

export type RuntimeActivateWorktreeEvent = Extract<RuntimeClientEvent, { type: 'activateWorktree' }>

export function toRuntimeActivateWorktreeEvent(
  repoId: string,
  worktreeId: string,
  setup?: CreatedWorktreeResult['setup'],
  startup?: WorktreeStartupLaunch,
  defaultTabs?: CreatedWorktreeResult['defaultTabs']
): RuntimeActivateWorktreeEvent {
  return {
    type: 'activateWorktree',
    repoId,
    worktreeId,
    ...(setup ? { setup } : {}),
    ...(startup ? { startup } : {}),
    ...(defaultTabs ? { defaultTabs } : {})
  }
}
