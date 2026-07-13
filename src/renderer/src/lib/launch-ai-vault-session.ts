import { useAppStore } from '@/store'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import { AGENT_LAUNCH_IDENTITY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { AiVaultAgent } from '../../../shared/ai-vault-types'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { AgentLaunchVaultResumeRequest } from '../../../shared/agent-launch-spawn-request'
import type { TabSplitDirection } from '@/store/slices/tabs'

export type LaunchAiVaultSessionInNewTabResult =
  | { tabId: string; groupId?: string }
  | { tabId: null; groupId?: string; runtimeLaunch: Promise<boolean> }

export function launchAiVaultSessionInNewTab(args: {
  agent: AiVaultAgent
  worktreeId: string
  command: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: SleepingAgentLaunchConfig
  // Vault-resume rides the host-owned arm: the host re-validates the discovered
  // entry and assembles command/env itself. Both the desktop and the web-runtime
  // paths send it now (the runtime intercepts vaultResume on its own
  // session.tabs.createTerminal).
  agentLaunch?: AgentLaunchVaultResumeRequest
  targetGroupId?: string
  splitDirection?: TabSplitDirection
}): LaunchAiVaultSessionInNewTabResult {
  const store = useAppStore.getState()
  let targetGroupId = args.targetGroupId
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(store, args.worktreeId)
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    // A confirmed identity-capable runtime owns the resume from the arm, so drop
    // the client command entirely (never a spawn input on a capable host). When
    // the arm is absent, or the runtime's advertised capability is unknown/legacy,
    // keep the command — a pre-identity host strips the arm, so without the command
    // the user would get a silent bare terminal (the AGENT_LAUNCH_IDENTITY floor is
    // a static, additive capability, so an older runtime connects without it).
    const runtimeCapabilities = runtimeEnvironmentId
      ? store.runtimeStatusByEnvironmentId.get(runtimeEnvironmentId)?.status?.capabilities
      : undefined
    const hostOwnsResume =
      Boolean(args.agentLaunch) &&
      Boolean(runtimeCapabilities?.includes(AGENT_LAUNCH_IDENTITY_RUNTIME_CAPABILITY))
    const runtimeLaunch = createWebRuntimeSessionTerminal({
      worktreeId: args.worktreeId,
      environmentId: runtimeEnvironmentId,
      ...(targetGroupId ? { targetGroupId } : {}),
      ...(hostOwnsResume ? {} : { command: args.command }),
      ...(args.agentLaunch ? { agentLaunch: args.agentLaunch } : {}),
      ...(args.env ? { env: args.env } : {}),
      ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
      ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
      launchAgent: args.agent,
      activate: true
    }).then((created) => {
      if (created) {
        useAppStore.getState().setActiveTabType('terminal')
      }
      return created
    })
    return {
      tabId: null,
      ...(targetGroupId ? { groupId: targetGroupId } : {}),
      runtimeLaunch
    }
  }

  if (args.splitDirection && targetGroupId) {
    targetGroupId =
      store.createEmptySplitGroup(args.worktreeId, targetGroupId, args.splitDirection) ??
      targetGroupId
  }

  const tab = store.createTab(args.worktreeId, targetGroupId)
  store.queueTabStartupCommand(tab.id, {
    // On the host-resolved arm the command is empty — the host assembles it; the
    // legacy branch (drag-drop payload) still submits the client-built command.
    command: args.agentLaunch ? '' : args.command,
    ...(args.agentLaunch
      ? { agentLaunch: args.agentLaunch, launchAgent: args.agent }
       : {
           ...(args.env ? { env: args.env } : {}),
           ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
           ...(args.launchConfig ? { launchConfig: args.launchConfig, launchAgent: args.agent } : {})
         }),
    telemetry: {
      agent_kind: tuiAgentToAgentKind(args.agent),
      launch_source: 'sidebar',
      request_kind: 'resume'
    }
  })
  store.setActiveTabType('terminal')

  const fresh = useAppStore.getState()
  const termIds = (fresh.tabsByWorktree[args.worktreeId] ?? []).map((t) => t.id)
  const editorIds = fresh.openFiles.filter((f) => f.worktreeId === args.worktreeId).map((f) => f.id)
  const browserIds = (fresh.browserTabsByWorktree?.[args.worktreeId] ?? []).map((t) => t.id)
  const base = reconcileTabOrder(
    fresh.tabBarOrderByWorktree[args.worktreeId],
    termIds,
    editorIds,
    browserIds
  )
  const order = base.filter((id) => id !== tab.id)
  order.push(tab.id)
  fresh.setTabBarOrder(args.worktreeId, order)

  return { tabId: tab.id, groupId: targetGroupId }
}
