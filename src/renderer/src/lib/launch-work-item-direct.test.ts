import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type * as TuiAgentSelectionModule from '../../../shared/tui-agent-selection'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  createWorktree: vi.fn(),
  ensureDetectedAgents: vi.fn(),
  ensureRemoteDetectedAgents: vi.fn(),
  setSidebarOpen: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  track: vi.fn(),
  getDirectWorkItemDraftContent: vi.fn(),
  resolveDirectSetupDecision: vi.fn(),
  resolveDirectPrStartPoint: vi.fn(),
  agentLaunchFailureMessage: vi.fn(() => 'FAILURE_COPY'),
  agentLaunchRequestErrorMessage: vi.fn(() => 'REJECTION_COPY'),
  store: {} as Record<string, unknown> & {
    ensureDetectedAgents: ReturnType<typeof vi.fn>
    ensureRemoteDetectedAgents: ReturnType<typeof vi.fn>
    createWorktree: ReturnType<typeof vi.fn>
    setSidebarOpen: ReturnType<typeof vi.fn>
  }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.store }
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, message: vi.fn() }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: vi.fn().mockResolvedValue('run')
}))

vi.mock('@/lib/telemetry', () => ({
  track: mocks.track
}))

vi.mock('@/lib/telemetry-agent-kind', () => ({
  resolveTelemetryAgentKind: (agent: string) => agent
}))

vi.mock('@/lib/launch-work-item-direct-draft', () => ({
  getDirectWorkItemDraftContent: mocks.getDirectWorkItemDraftContent
}))

vi.mock('@/lib/launch-work-item-direct-preflight', () => ({
  resolveDirectSetupDecision: mocks.resolveDirectSetupDecision,
  resolveDirectPrStartPoint: mocks.resolveDirectPrStartPoint
}))

vi.mock('@/lib/repo-runtime-owner', () => ({
  getSettingsForRepoRuntimeOwner: () => mocks.store.settings
}))

vi.mock('@/lib/new-workspace', () => ({
  getWorkspaceIntentName: (args: {
    workItem?: { type: 'issue' | 'pr' | 'mr'; number: number; title: string } | null
  }) =>
    args.workItem
      ? {
          displayName:
            args.workItem.type === 'pr'
              ? `PR ${args.workItem.number} - Review`
              : `Issue ${args.workItem.number}`,
          seedName:
            args.workItem.type === 'pr'
              ? `pr-${args.workItem.number}-review`
              : `issue-${args.workItem.number}`
        }
      : null,
  getWorkspaceSeedName: ({ explicitName }: { explicitName?: string }) => explicitName ?? '',
  isGitLabIssueUrl: vi.fn(() => false)
}))

vi.mock('@/lib/agent-launch-failure-copy', () => ({
  agentLaunchFailureMessage: mocks.agentLaunchFailureMessage,
  agentLaunchRequestErrorMessage: mocks.agentLaunchRequestErrorMessage
}))

vi.mock('../../../shared/tui-agent-selection', async () => {
  const actual = await vi.importActual<typeof TuiAgentSelectionModule>(
    '../../../shared/tui-agent-selection'
  )
  return { ...actual, pickTuiAgent: vi.fn(actual.pickTuiAgent) }
})

import { launchWorkItemDirect } from './launch-work-item-direct'
import { pickTuiAgent } from '../../../shared/tui-agent-selection'

/** The trailing `options` arg on createWorktree (index 25) carries the host
 *  `agentLaunch` and the surface-owned `agentLaunchTelemetry`; when no agent
 *  resolves the caller omits it entirely. */
function optionsArg(): { agentLaunch?: unknown; agentLaunchTelemetry?: unknown } | undefined {
  return mocks.createWorktree.mock.calls[0]?.[25]
}

describe('launchWorkItemDirect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ensureDetectedAgents.mockResolvedValue(['codex'])
    mocks.ensureRemoteDetectedAgents.mockResolvedValue(['codex'])
    mocks.getDirectWorkItemDraftContent.mockImplementation(
      async (item: { pasteContent?: string }) => item.pasteContent ?? 'linked work item draft'
    )
    mocks.resolveDirectSetupDecision.mockResolvedValue({ kind: 'decided', decision: 'inherit' })
    mocks.resolveDirectPrStartPoint.mockResolvedValue({
      baseBranch: 'abc123',
      compareBaseRef: 'refs/remotes/origin/main',
      branchNameOverride: 'feature/fix',
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })
    mocks.createWorktree.mockResolvedValue({
      created: undefined,
      worktree: { id: 'repo-1::/repo/worktree', path: '/repo/worktree' },
      setup: undefined,
      agentLaunchResult: { status: 'launched' }
    })
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'tab-1' })
    mocks.store = {
      repos: [{ id: 'repo-1', path: '/repo', displayName: 'Repo', addedAt: 1 }],
      settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] },
      ensureDetectedAgents: mocks.ensureDetectedAgents,
      ensureRemoteDetectedAgents: mocks.ensureRemoteDetectedAgents,
      createWorktree: mocks.createWorktree,
      setSidebarOpen: mocks.setSidebarOpen
    } as typeof mocks.store
  })

  it('creates the workspace and sends an identity-only host agentLaunch with the work-item prompt', async () => {
    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        telemetrySource: 'sidebar',
        openModalFallback: vi.fn(),
        item: {
          type: 'issue',
          number: 42,
          title: 'Fix the bug',
          url: 'https://github.com/acme/repo/issues/42',
          pasteContent: 'Fix the failing checks.'
        }
      })
    ).resolves.toBe(true)

    // Agent identity persists via createdWithAgent (index 10) for empty-worktree reopen.
    expect(mocks.createWorktree.mock.calls[0]?.[10]).toBe('codex')
    expect(optionsArg()).toEqual({
      agentLaunch: {
        selection: { kind: 'agent', agent: 'codex' },
        prompt: 'Fix the failing checks.',
        promptDelivery: 'draft',
        allowEmptyPromptLaunch: true
      },
      agentLaunchTelemetry: { launch_source: 'task_page', request_kind: 'new' }
    })
    // The host spawned the primary agent terminal, so the client suppresses its
    // own reopen/auto-create.
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'repo-1::/repo/worktree',
      expect.objectContaining({ hostSpawnedPrimary: true })
    )
    // The host emits agent_started off the resolved receipt at the registered
    // create PTY; the renderer no longer fires it (no double-emit).
    expect(mocks.track).not.toHaveBeenCalledWith('agent_started', expect.anything())
  })

  it('omits promptDelivery for submit-after-ready launches so the host submits after ready', async () => {
    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        promptDelivery: 'submit-after-ready',
        item: {
          type: 'issue',
          number: 42,
          title: 'Fix the bug',
          url: 'https://github.com/acme/repo/issues/42',
          pasteContent: 'Fix the failing checks.'
        }
      })
    ).resolves.toBe(true)

    const agentLaunch = optionsArg()?.agentLaunch as Record<string, unknown>
    expect(agentLaunch).not.toHaveProperty('promptDelivery')
    expect(agentLaunch.allowEmptyPromptLaunch).toBe(true)
  })

  it('threads the fixChecks recipe owner locator into agentLaunch.sourceRecord', async () => {
    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        promptDelivery: 'submit-after-ready',
        sourceControlActionId: 'fixChecks',
        item: {
          type: 'issue',
          number: 42,
          title: 'Fix failing checks',
          url: 'https://github.com/acme/repo/issues/42',
          pasteContent: 'Fix the failing checks.'
        }
      })
    ).resolves.toBe(true)

    const agentLaunch = optionsArg()?.agentLaunch as Record<string, unknown>
    expect(agentLaunch.sourceRecord).toEqual({ owner: 'source-control-recipe', id: 'fixChecks' })
  })

  it('resolves a PR head and uses the short PR identity for the workspace name', async () => {
    mocks.store.settings = { defaultTuiAgent: 'codex', disabledTuiAgents: [] }
    await launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      openModalFallback: vi.fn(),
      item: {
        type: 'pr',
        number: 6934,
        title: 'Fix the bug',
        url: 'https://github.com/stablyai/orca/pull/6934',
        branchName: 'feature/fix',
        baseRefName: 'main',
        isCrossRepository: true
      }
    })

    expect(mocks.resolveDirectPrStartPoint).toHaveBeenCalled()
    const createArgs = mocks.createWorktree.mock.calls[0]
    expect(createArgs?.[1]).toBe('pr-6934-review')
    expect(createArgs?.[2]).toBe('abc123')
    expect(createArgs?.[6]).toBe('PR 6934 - Review')
    expect(createArgs?.[8]).toBe(6934)
    expect(createArgs?.[9]).toEqual({ remoteName: 'origin', branchName: 'feature/fix' })
    expect(createArgs?.[12]).toBe('feature/fix')
    expect(createArgs?.[24]).toBe('refs/remotes/origin/main')
  })

  it('treats a PR-typed GitHub issue URL as an issue without resolving a PR head', async () => {
    const openModalFallback = vi.fn()
    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        telemetrySource: 'sidebar',
        openModalFallback,
        item: {
          type: 'pr',
          number: 6933,
          title: 'The board columns are displayed backwards',
          url: 'https://github.com/stablyai/orca/issues/6933',
          branchName: 'fix-issue-6933',
          baseRefName: 'main',
          isCrossRepository: true
        }
      })
    ).resolves.toBe(true)

    expect(mocks.resolveDirectPrStartPoint).not.toHaveBeenCalled()
    expect(openModalFallback).not.toHaveBeenCalled()
    const createArgs = mocks.createWorktree.mock.calls[0]
    expect(createArgs?.[1]).toBe('issue-6933')
    expect(createArgs?.[2]).toBeUndefined()
    expect(createArgs?.[7]).toBe(6933)
    expect(createArgs?.[8]).toBeUndefined()
  })

  it('uses the Linear identifier in direct-launch workspace names', async () => {
    await launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      telemetrySource: 'sidebar',
      openModalFallback: vi.fn(),
      item: {
        type: 'issue',
        number: null,
        title: 'Ship Linear parity',
        url: 'https://linear.app/acme/issue/ENG-42/ship-linear-parity',
        linearIdentifier: 'ENG-42'
      }
    })

    const createArgs = mocks.createWorktree.mock.calls[0]
    expect(createArgs?.[1]).toBe('eng-42-ship-linear-parity')
    expect(createArgs?.[11]).toBe('ENG-42')
  })

  it('opens the workspace bare with no agentLaunch when no agent is detected', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue([])
    mocks.store.settings = {}

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        item: {
          type: 'issue',
          number: 42,
          title: 'Fix the bug',
          url: 'https://github.com/acme/repo/issues/42'
        }
      })
    ).resolves.toBe(true)

    expect(mocks.createWorktree).toHaveBeenCalled()
    expect(mocks.createWorktree.mock.calls[0]?.[10]).toBeUndefined()
    expect(optionsArg()).toBeUndefined()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'repo-1::/repo/worktree',
      expect.not.objectContaining({ hostSpawnedPrimary: true })
    )
  })

  it('creates the workspace bare and reports when the requested agent override is unavailable', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
    mocks.store.settings = { defaultTuiAgent: 'claude', disabledTuiAgents: [] }

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        agentOverride: 'codex',
        item: {
          type: 'issue',
          number: 1,
          title: 'Fix failing checks',
          url: 'https://github.com/acme/repo/pull/1',
          pasteContent: 'Fix the failing checks.'
        }
      })
    ).resolves.toBe(false)

    expect(mocks.createWorktree).toHaveBeenCalled()
    expect(optionsArg()).toBeUndefined()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Selected agent is not available in the created workspace.'
    )
  })

  it('surfaces a pre-create host rejection without opening a workspace', async () => {
    mocks.createWorktree.mockResolvedValue({
      created: false,
      agentLaunchResult: { status: 'rejected', requestError: { code: 'untrusted_reference' } }
    })

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        sourceControlActionId: 'fixChecks',
        item: {
          type: 'issue',
          number: 42,
          title: 'Fix failing checks',
          url: 'https://github.com/acme/repo/issues/42',
          pasteContent: 'Fix the failing checks.'
        }
      })
    ).resolves.toBe(false)

    expect(mocks.toastError).toHaveBeenCalledWith('REJECTION_COPY')
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('surfaces a pre-create invalid_agent_args failure from the host', async () => {
    mocks.createWorktree.mockResolvedValue({
      created: false,
      agentLaunchResult: {
        status: 'failed',
        failure: { code: 'invalid_agent_args', field: 'args', reason: 'bad', shell: 'posix' }
      }
    })

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        sourceControlActionId: 'fixChecks',
        item: {
          type: 'issue',
          number: 42,
          title: 'Fix failing checks',
          url: 'https://github.com/acme/repo/issues/42',
          pasteContent: 'Fix the failing checks.'
        }
      })
    ).resolves.toBe(false)

    expect(mocks.toastError).toHaveBeenCalledWith('FAILURE_COPY')
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('detects agents on the repo SSH connection for a remote workspace', async () => {
    mocks.store.repos = [
      {
        id: 'repo-1',
        path: '/home/orca/repo',
        displayName: 'Remote Repo',
        addedAt: 1,
        connectionId: 'ssh-1'
      }
    ] as AppState['repos']
    mocks.store.ensureRemoteDetectedAgents.mockResolvedValue(['codex'])
    vi.mocked(pickTuiAgent).mockReturnValueOnce('codex')

    await expect(
      launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: vi.fn(),
        item: {
          type: 'issue',
          number: 77,
          title: 'Fix remote direct launch',
          url: 'https://github.com/acme/repo/issues/77',
          pasteContent: 'Fix it.'
        }
      })
    ).resolves.toBe(true)

    expect(mocks.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
    expect(mocks.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(optionsArg()?.agentLaunch).toBeDefined()
  })
})
