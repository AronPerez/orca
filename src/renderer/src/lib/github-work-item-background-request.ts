import type { useAppStore } from '@/store'
import { resolveQuickCreateLinkedWorkItemPrompt } from '@/lib/linked-work-item-context'
import { pickQuickWorkspaceAgent } from '@/lib/quick-workspace-agent-selection'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'
import { getWorkspaceIntentName, getWorkspaceSeedName } from '@/lib/new-workspace'
import { toLegacyAutoPreference } from '../../../shared/tui-agent-selection'
import { resolveGitHubWorkItemIdentity } from '@/lib/github-work-item-identity'
import { resolveTelemetryAgentKind } from '@/lib/telemetry-agent-kind'
import type { AgentLaunchSpawnRequest } from '../../../shared/agent-launch-spawn-request'
import type { GitHubWorkItem, GlobalSettings, Repo, TuiAgent } from '../../../shared/types'
import type { TaskSourceContext, WorkspaceRunContext } from '../../../shared/task-source-context'
import type { AgentStartedTelemetry } from '@/lib/worktree-activation'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'

export type GitHubWorkItemBackgroundStoreSnapshot = {
  repos: readonly Repo[]
  pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
  sshConnectionStates: ReturnType<typeof useAppStore.getState>['sshConnectionStates']
  runtimeStatusByEnvironmentId: ReturnType<
    typeof useAppStore.getState
  >['runtimeStatusByEnvironmentId']
  settings:
    | Partial<
        Pick<
          GlobalSettings,
          | 'activeRuntimeEnvironmentId'
          | 'defaultTuiAgent'
          | 'disabledTuiAgents'
          | 'agentCmdOverrides'
          | 'agentDefaultArgs'
          | 'agentDefaultEnv'
          | 'terminalWindowsShell'
        >
      >
    | null
    | undefined
  ensureDetectedAgents: ReturnType<typeof useAppStore.getState>['ensureDetectedAgents']
  ensureRemoteDetectedAgents: ReturnType<typeof useAppStore.getState>['ensureRemoteDetectedAgents']
  ensureRuntimeDetectedAgents: ReturnType<
    typeof useAppStore.getState
  >['ensureRuntimeDetectedAgents']
}

export type BuildInitialGitHubWorkItemRequestArgs = {
  item: GitHubWorkItem
  repoId: string
  taskSourceContext?: TaskSourceContext | null
  workspaceRunContext?: WorkspaceRunContext | null
  telemetrySource?: WorktreeCreationRequest['telemetrySource']
}

type QuickCreateLinkedWorkItemPromptResult = ReturnType<
  typeof resolveQuickCreateLinkedWorkItemPrompt
>

function resolveGitHubWorkItemPrompt(item: GitHubWorkItem): QuickCreateLinkedWorkItemPromptResult {
  const resolver = resolveQuickCreateLinkedWorkItemPrompt as unknown as (
    linkedWorkItem: GitHubWorkItem,
    note: string,
    opts?: { cliAvailable: boolean }
  ) => QuickCreateLinkedWorkItemPromptResult
  return resolver(item, '', { cliAvailable: false })
}

function getWorkspaceRunContextForRepo(
  repo: Repo,
  provided: WorkspaceRunContext | null | undefined
): WorkspaceRunContext | null {
  if (provided) {
    return provided
  }
  const projection = projectHostSetupProjectionFromRepos([repo])
  const project = projection.projects[0]
  const setup = projection.setups[0]
  if (!project || !setup) {
    return null
  }
  return {
    kind: 'workspace-run',
    projectId: project.id,
    hostId: getRepoExecutionHostId(repo),
    projectHostSetupId: setup.id,
    repoId: repo.id,
    path: repo.path
  }
}

export async function resolvePreferredQuickAgentForGitHubWorkItem(
  store: GitHubWorkItemBackgroundStoreSnapshot,
  repo: Repo
): Promise<TuiAgent | null> {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  const detectedAgents =
    host?.kind === 'ssh'
      ? await store.ensureRemoteDetectedAgents(host.targetId)
      : host?.kind === 'runtime'
        ? await store.ensureRuntimeDetectedAgents(host.environmentId)
        : await store.ensureDetectedAgents()
  return pickQuickWorkspaceAgent(
    toLegacyAutoPreference(store.settings?.defaultTuiAgent),
    detectedAgents,
    store.settings?.disabledTuiAgents
  )
}

export function buildGitHubWorkItemAgentLaunch(args: {
  agent: TuiAgent | null
  item: GitHubWorkItem
}): {
  agentLaunch?: AgentLaunchSpawnRequest
  quickTelemetry: AgentStartedTelemetry | null
} {
  const { agent, item } = args
  if (!agent) {
    return { quickTelemetry: null }
  }
  const { prompt: quickPrompt, draftPrompt } = resolveGitHubWorkItemPrompt(item)
  // The host owns command/args/env resolution and picks native-flag vs
  // post-ready paste for the draft; the renderer names only the requested agent
  // and the draft-vs-submit intent. A linked work item's body seeds the draft;
  // otherwise the summary is submitted (empty prompt still launches a bare TUI).
  return {
    agentLaunch: draftPrompt
      ? { selection: { kind: 'agent', agent }, prompt: draftPrompt, promptDelivery: 'draft' }
      : {
          selection: { kind: 'agent', agent },
          ...(quickPrompt ? { prompt: quickPrompt } : {}),
          allowEmptyPromptLaunch: true
        },
    quickTelemetry: {
      agent_kind: resolveTelemetryAgentKind(agent),
      launch_source: 'new_workspace_composer',
      request_kind: 'new'
    }
  }
}

function getGitHubWorkItemName(item: GitHubWorkItem): { seedName: string; displayName?: string } {
  const identity = resolveGitHubWorkItemIdentity(item)
  const intent =
    identity.number !== null
      ? getWorkspaceIntentName({
          sourceText: item.title,
          workItem: { type: identity.type, number: identity.number, title: item.title }
        })
      : null
  return {
    seedName: getWorkspaceSeedName({
      explicitName: intent?.seedName ?? '',
      prompt: '',
      linkedIssueNumber: identity.type === 'issue' ? identity.number : null,
      linkedPR: identity.type === 'pr' ? identity.number : null
    }),
    ...(intent?.displayName ? { displayName: intent.displayName } : {})
  }
}

export function buildInitialGitHubWorkItemRequest(
  args: BuildInitialGitHubWorkItemRequestArgs,
  repo: Repo
): WorktreeCreationRequest {
  const { seedName, displayName } = getGitHubWorkItemName(args.item)
  const workspaceRunContext = getWorkspaceRunContextForRepo(repo, args.workspaceRunContext)
  const ownerHost = parseExecutionHostId(getRepoExecutionHostId(repo))
  const identity = resolveGitHubWorkItemIdentity(args.item)
  return {
    repoId: args.repoId,
    worktreeCreateProgressMode: ownerHost?.kind === 'local' ? 'stepped' : 'indeterminate',
    ...(args.taskSourceContext ? { taskSourceContext: args.taskSourceContext } : {}),
    ...(workspaceRunContext ? { workspaceRunContext } : {}),
    name: seedName,
    ...(displayName ? { displayName } : {}),
    ...(identity.type === 'issue' && identity.number ? { linkedIssue: identity.number } : {}),
    ...(identity.type === 'pr' && identity.number ? { linkedPR: identity.number } : {}),
    ...(args.telemetrySource ? { telemetrySource: args.telemetrySource } : {}),
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    quickTelemetry: null
  }
}
