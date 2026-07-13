// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace
}))

import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'
import { useAppStore } from '@/store'

function makeProjectGroup(): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/repo/platform',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'hi',
    folderPath: '/repo/platform/hi',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function startupFromLastActivation(): Record<string, unknown> | undefined {
  return mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup as
    | Record<string, unknown>
    | undefined
}

describe('submitFolderWorkspaceCreate', () => {
  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    Object.assign(window, {
      api: {
        agentTrust: {
          markTrusted: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
  })

  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    Reflect.deleteProperty(window, 'api')
    vi.restoreAllMocks()
  })

  it('closes the composer after creation even when reveal fails', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const onOpenChange = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.activateAndRevealFolderWorkspace.mockImplementation(() => {
      throw new Error('activation failed')
    })

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'hi',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: false,
      createFolderWorkspace,
      onOpenChange
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'hi',
      connectionId: null,
      linkedTask: null
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      runtimeEnvironmentId: null
    })
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to activate folder workspace after create:',
      expect.any(Error)
    )
  })

  it('marks a blank folder workspace for first-input rename when launching an agent with a note', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const onOpenChange = vi.fn()

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Fix the flaky checkout flow',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      launchSource: 'new_workspace_composer',
      runtimeEnvironmentId: 'env-1',
      createFolderWorkspace,
      onOpenChange
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Platform workspace',
      connectionId: null,
      linkedTask: null,
      createdWithAgent: 'codex',
      pendingFirstAgentMessageRename: true
    })
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      expect.objectContaining({
        runtimeEnvironmentId: 'env-1',
        startup: expect.objectContaining({
          command: '',
          launchAgent: 'codex',
          telemetry: expect.objectContaining({ launch_source: 'new_workspace_composer' })
        })
      })
    )
    // Why: the host owns command/args/env resolution now; the renderer names only
    // the requested agent and folds the plain note in as the submitted first turn.
    expect(startupFromLastActivation()?.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'codex' },
      prompt: 'Fix the flaky checkout flow',
      allowEmptyPromptLaunch: true
    })
  })

  it('does not mark first-input rename when the folder workspace has an explicit name', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'Checkout polish',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Fix the flaky checkout flow',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Checkout polish',
      connectionId: null,
      linkedTask: null,
      createdWithAgent: 'codex'
    })
  })

  it('does not mark first-input rename when a linked work item owns the folder workspace name', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'github' as const,
      type: 'issue' as const,
      number: 42,
      title: 'Restore checkout polish',
      url: 'https://github.com/stablyai/orca/issues/42',
      repoId: 'repo-1'
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'Use the issue context',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Restore checkout polish',
      connectionId: null,
      linkedTask: linkedWorkItem,
      createdWithAgent: 'codex'
    })
  })

  it('keeps linked Codex context out of the launch and declares a draft delivery', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'github' as const,
      type: 'pr' as const,
      number: 91,
      title: 'Restore linked quick-create',
      url: 'https://github.com/stablyai/orca/pull/91',
      repoId: 'repo-1'
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'Review this before starting',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      launchSource: 'new_workspace_composer',
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Restore linked quick-create',
      connectionId: null,
      linkedTask: linkedWorkItem,
      createdWithAgent: 'codex'
    })
    expect(window.api.agentTrust?.markTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/repo/platform/hi'
    })
    // Why: the host owns native-flag vs post-ready paste; the renderer only names
    // the reviewable draft intent and its content (never a command).
    expect(startupFromLastActivation()?.command).toBe('')
    expect(startupFromLastActivation()?.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'codex' },
      prompt: `Review this before starting\n\n${linkedWorkItem.url}`,
      promptDelivery: 'draft'
    })
  })

  it('pre-marks remote linked Codex folder workspaces trusted before the draft launch', async () => {
    const createFolderWorkspace = vi.fn(async () =>
      makeFolderWorkspace({
        connectionId: 'ssh-1',
        folderPath: '/home/alice/platform/Trust remote folder draft'
      })
    )
    const linkedWorkItem = {
      provider: 'github' as const,
      type: 'pr' as const,
      number: 92,
      title: 'Trust remote folder draft',
      url: 'https://github.com/stablyai/orca/pull/92',
      repoId: 'repo-1'
    }
    const projectGroup = {
      ...makeProjectGroup(),
      connectionId: 'ssh-1',
      parentPath: '/home/alice/platform'
    }

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: '',
      quickAgent: 'codex',
      autoRenameBranchFromWork: false,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(window.api.agentTrust?.markTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/home/alice/platform/Trust remote folder draft',
      connectionId: 'ssh-1'
    })
    expect(startupFromLastActivation()?.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'codex' },
      prompt: linkedWorkItem.url,
      promptDelivery: 'draft'
    })
  })

  // Registry safety (oracle 16): a custom quick-create agent must pre-mark trust
  // with its base harness's preset, not crash on the built-in-only config index.
  it('pre-marks a custom-based quick agent using its base harness trust preset', async () => {
    const customId = 'custom-agent:codex:11111111-1111-4111-8111-111111111111'
    const originalSettings = useAppStore.getState().settings
    useAppStore.setState({
      settings: {
        ...originalSettings,
        customTuiAgents: [
          { id: customId, baseAgent: 'codex', label: 'My Codex', args: '', env: {}, syncEnv: false }
        ]
      }
    } as never)
    try {
      const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
      await submitFolderWorkspaceCreate({
        projectGroup: makeProjectGroup(),
        name: 'Custom trust',
        lastAutoName: '',
        linkedWorkItem: {
          provider: 'github' as const,
          type: 'pr' as const,
          number: 7,
          title: 'Custom trust',
          url: 'https://github.com/stablyai/orca/pull/7',
          repoId: 'repo-1'
        },
        note: '',
        quickAgent: customId,
        autoRenameBranchFromWork: false,
        createFolderWorkspace,
        onOpenChange: vi.fn()
      })

      expect(window.api.agentTrust?.markTrusted).toHaveBeenCalledWith({
        preset: 'codex',
        workspacePath: '/repo/platform/hi'
      })
    } finally {
      useAppStore.setState({ settings: originalSettings } as never)
    }
  })

  it('folds non-linked notes into the launch for agents that need stdin after launch', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: 'Aider followup',
      lastAutoName: '',
      linkedWorkItem: null,
      note: 'Fix the failing folder prompt flow',
      quickAgent: 'aider',
      autoRenameBranchFromWork: false,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    // Why: the host resolves aider's stdin-after-start injection and returns the
    // followup prompt; the pty-connection paste writer submits it after readiness.
    expect(startupFromLastActivation()?.command).toBe('')
    expect(startupFromLastActivation()?.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'aider' },
      prompt: 'Fix the failing folder prompt flow',
      allowEmptyPromptLaunch: true
    })
  })

  it('declares a draft launch for linked agents with prefill support', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'gitlab' as const,
      type: 'mr' as const,
      number: 17,
      title: 'Review folder workspace draft',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/17',
      repoId: 'repo-1'
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'Check the migration path',
      quickAgent: 'claude',
      autoRenameBranchFromWork: true,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    const agentLaunch = startupFromLastActivation()?.agentLaunch as
      | { selection: unknown; prompt: string; promptDelivery: string }
      | undefined
    expect(agentLaunch?.selection).toEqual({ kind: 'agent', agent: 'claude' })
    expect(agentLaunch?.promptDelivery).toBe('draft')
    expect(agentLaunch?.prompt).toContain('Check the migration path')
    expect(agentLaunch?.prompt).toContain(linkedWorkItem.url)
  })

  it('declares a draft launch for link-only Linear folder workspaces', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'linear' as const,
      type: 'issue' as const,
      number: 0,
      title: 'Ship Linear source drafts',
      url: 'https://linear.app/acme/issue/ENG-77/ship-linear-source-drafts',
      linearIdentifier: 'ENG-77',
      linkedContext: {
        provider: 'linear' as const,
        version: 1 as const,
        renderedText: [
          'Linear issue context snapshot',
          'Identifier: ENG-77',
          'Title: Ship Linear source drafts',
          'Description:',
          'Distinctive folder Linear body.'
        ].join('\n')
      }
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'User note stays above source',
      quickAgent: 'claude',
      autoRenameBranchFromWork: true,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'ENG-77 Ship Linear source drafts',
      connectionId: null,
      linkedTask: {
        provider: 'linear',
        type: 'issue',
        number: 0,
        title: 'Ship Linear source drafts',
        url: 'https://linear.app/acme/issue/ENG-77/ship-linear-source-drafts',
        linearIdentifier: 'ENG-77'
      },
      createdWithAgent: 'claude'
    })
    const agentLaunch = startupFromLastActivation()?.agentLaunch as
      | { prompt: string; promptDelivery: string }
      | undefined
    expect(agentLaunch?.promptDelivery).toBe('draft')
    expect(agentLaunch?.prompt).toContain('User note stays above source')
    expect(agentLaunch?.prompt).toContain('Linked Linear issue: ENG-77')
    expect(agentLaunch?.prompt).toContain(
      'https://linear.app/acme/issue/ENG-77/ship-linear-source-drafts'
    )
    expect(agentLaunch?.prompt).not.toContain('Distinctive folder Linear body.')
    expect(agentLaunch?.prompt).not.toContain('--- BEGIN LINKED WORK ITEM CONTEXT ---')
    expect(agentLaunch?.prompt).not.toContain('orca linear')
  })

  it('keeps explicit blank linked folder creates free of an agent launch', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const linkedWorkItem = {
      provider: 'github' as const,
      type: 'issue' as const,
      number: 42,
      title: 'Restore checkout polish',
      url: 'https://github.com/stablyai/orca/issues/42',
      repoId: 'repo-1'
    }

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem,
      note: 'Keep this as metadata only',
      quickAgent: null,
      autoRenameBranchFromWork: true,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Restore checkout polish',
      connectionId: null,
      linkedTask: linkedWorkItem
    })
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      runtimeEnvironmentId: null
    })
  })

  it('does not mark first-input rename without submitted first input', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitFolderWorkspaceCreate({
      projectGroup: makeProjectGroup(),
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '   ',
      quickAgent: 'codex',
      autoRenameBranchFromWork: true,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'Platform workspace',
      connectionId: null,
      linkedTask: null,
      createdWithAgent: 'codex'
    })
  })

  it('passes the raw note prompt through for a local WSL UNC folder group', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const projectGroup = {
      ...makeProjectGroup(),
      parentPath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\platform'
    }

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'WSL folder',
      lastAutoName: '',
      linkedWorkItem: null,
      note: "Use Bob's POSIX startup",
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    // Why: shell quoting is the host's responsibility now; the renderer forwards
    // the raw prompt text unquoted.
    expect(startupFromLastActivation()?.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'claude' },
      prompt: "Use Bob's POSIX startup",
      allowEmptyPromptLaunch: true
    })
  })

  it('passes the raw note prompt through for a remote Windows folder group', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())
    const projectGroup = {
      ...makeProjectGroup(),
      connectionId: 'ssh-windows',
      parentPath: 'C:\\Users\\alice\\platform'
    }

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'Remote Windows folder',
      lastAutoName: '',
      linkedWorkItem: null,
      note: "Use Bob's Windows startup",
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      createFolderWorkspace,
      onOpenChange: vi.fn()
    })

    expect(startupFromLastActivation()?.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'claude' },
      prompt: "Use Bob's Windows startup",
      allowEmptyPromptLaunch: true
    })
  })

  it('preserves SSH group ownership when creating and activating a folder workspace', async () => {
    const projectGroup = {
      ...makeProjectGroup(),
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1'
    }
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace({ connectionId: 'ssh-1' }))
    const onOpenChange = vi.fn()

    await submitFolderWorkspaceCreate({
      projectGroup,
      name: 'SSH workspace',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: false,
      runtimeEnvironmentId: null,
      createFolderWorkspace,
      onOpenChange
    })

    expect(createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: 'group-1',
      name: 'SSH workspace',
      connectionId: 'ssh-1',
      linkedTask: null
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      runtimeEnvironmentId: null
    })
  })

  it('returns false when folder workspace creation fails without returning a workspace', async () => {
    const createFolderWorkspace = vi.fn(async () => null)
    const onOpenChange = vi.fn()

    await expect(
      submitFolderWorkspaceCreate({
        projectGroup: makeProjectGroup(),
        name: 'hi',
        lastAutoName: '',
        linkedWorkItem: null,
        note: '',
        quickAgent: null,
        autoRenameBranchFromWork: false,
        createFolderWorkspace,
        onOpenChange
      })
    ).resolves.toBe(false)

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
  })
})
