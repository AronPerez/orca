import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'

const mockCreateTab = vi.fn()
const mockQueueTabStartupCommand = vi.fn()
const mockSetActiveTabType = vi.fn()
const mockSetTabBarOrder = vi.fn()
const mockSetAgentStatus = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()
const mockSeedNativeChatLaunchPrompt = vi.fn()
const mockMarkNativeChatLaunchPromptFailed = vi.fn()
const mockTrack = vi.fn()
const mockToastMessage = vi.fn()

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const store = {
  activeRepoId: 'repo-1',
  activeWorktreeId: 'wt-1',
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: null as string | null
  } as {
    agentCmdOverrides: Record<string, string>
    agentDefaultArgs: Record<string, string>
    agentDefaultEnv: Record<string, Record<string, string>>
    activeRuntimeEnvironmentId: string | null
    terminalWindowsShell?: string
    experimentalNativeChat?: boolean
    openAgentTabsInChatByDefault?: boolean
  },
  projects: [
    {
      id: 'repo-1',
      localWindowsRuntimePreference: { kind: 'inherit-global' as const }
    }
  ] as {
    id: string
    localWindowsRuntimePreference:
      | { kind: 'inherit-global' }
      | { kind: 'windows-host' }
      | { kind: 'wsl'; distro: string | null }
  }[],
  repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/repo' }],
  sshConnectionStates: new Map([['ssh-a', { status: 'connected' }]]),
  transientClearedAgentStatusConnectionIds: {} as Record<string, true>,
  worktreesByRepo: {
    'repo-1': [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        projectId: 'repo-1',
        path: '/repo/worktree',
        displayName: 'main'
      }
    ]
  },
  allWorktrees: vi.fn(() => store.worktreesByRepo['repo-1']),
  tabsByWorktree: {
    'wt-1': [{ id: 'tab-1' }]
  },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  terminalLayoutsByTabId: {} as Record<
    string,
    { activeLeafId: string | null; ptyIdsByLeafId?: Record<string, string> }
  >,
  ptyIdsByTabId: {} as Record<string, string[]>,
  createTab: mockCreateTab,
  closeTab: vi.fn(),
  queueTabStartupCommand: mockQueueTabStartupCommand,
  setActiveTabType: mockSetActiveTabType,
  setTabBarOrder: mockSetTabBarOrder,
  setAgentStatus: mockSetAgentStatus,
  seedNativeChatLaunchPrompt: mockSeedNativeChatLaunchPrompt,
  markNativeChatLaunchPromptFailed: mockMarkNativeChatLaunchPromptFailed
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

const mockToastError = vi.fn()

vi.mock('sonner', () => ({
  toast: { message: mockToastMessage, error: mockToastError }
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: vi.fn(
    (_stored, termIds: string[], editorIds: string[], browserIds: string[]) => [
      ...termIds,
      ...editorIds,
      ...browserIds
    ]
  )
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/lib/telemetry', () => ({
  track: mockTrack,
  tuiAgentToAgentKind: (agent: string) => agent
}))

const mockCreateWebRuntimeSessionTerminal = vi.fn()
const mockIsWebRuntimeSessionActive = vi.fn(() => false)

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mockCreateWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive: mockIsWebRuntimeSessionActive,
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

describe('launchAgentInNewTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsWebRuntimeSessionActive.mockReturnValue(false)
    mockCreateWebRuntimeSessionTerminal.mockResolvedValue(true)
    store.activeRepoId = 'repo-1'
    store.activeWorktreeId = 'wt-1'
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null
    }
    store.projects = [
      {
        id: 'repo-1',
        localWindowsRuntimePreference: { kind: 'inherit-global' }
      }
    ]
    store.repos = [{ id: 'repo-1', connectionId: null, path: '/repo' }]
    store.sshConnectionStates = new Map([['ssh-a', { status: 'connected' }]])
    store.transientClearedAgentStatusConnectionIds = {}
    store.worktreesByRepo = {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          projectId: 'repo-1',
          path: '/repo/worktree',
          displayName: 'main'
        }
      ]
    }
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    store.openFiles = []
    store.browserTabsByWorktree = {}
    store.tabBarOrderByWorktree = {}
    store.terminalLayoutsByTabId = {}
    store.ptyIdsByTabId = {}
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
  })

  it('stamps the launched agent on the new tab for immediate provider icon bootstrap', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'codex'
    })
  })

  it('opens supported submit-after-ready launches in chat and seeds a launch prompt echo', async () => {
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null,
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'codex',
      viewMode: 'chat'
    })
    expect(mockQueueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        command: expect.not.stringContaining('large generated prompt')
      })
    )
    expect(mockSeedNativeChatLaunchPrompt).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'codex',
      text: 'large generated prompt',
      createdAt: expect.any(Number)
    })
  })

  it('opens local Grok submit-after-ready launches in native chat', async () => {
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null,
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'grok',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'grok',
      quickCommandLabel: undefined,
      viewMode: 'chat'
    })
    expect(mockSeedNativeChatLaunchPrompt).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'grok',
      text: 'large generated prompt',
      createdAt: expect.any(Number)
    })
  })

  it('keeps Model-A SSH Grok launches in terminal mode', async () => {
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null,
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-target-1', path: '/repo' }]
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'grok', worktreeId: 'wt-1' })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'grok',
      quickCommandLabel: undefined
    })
  })

  it('passes quick command labels only to locally-created agent tabs', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      quickCommandLabel: 'Review'
    })

    expect(mockCreateTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      launchAgent: 'codex',
      quickCommandLabel: 'Review'
    })
  })

  it('delegates agent quick launch to the host runtime in paired web clients', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    store.tabsByWorktree = {
      'wt-1': [
        { id: 'tab-1' },
        { id: 'stale-agent-tab', launchAgent: 'claude' } as { id: string; launchAgent: string }
      ]
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        tabId: null,
        pasteDraftAfterLaunch: false
      })
    )
    // Paired web launches route through the same host `agentLaunch` boundary as
    // the local path — identity + launch policy only, never a client command.
    expect(mockCreateWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      activate: true,
      agentLaunch: {
        selection: { kind: 'agent', agent: 'claude' },
        allowEmptyPromptLaunch: true
      },
      viewMode: 'terminal'
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockQueueTabStartupCommand).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(mockSetActiveTabType).toHaveBeenCalledWith('terminal')
    expect(store.closeTab).toHaveBeenCalledWith('stale-agent-tab', {
      reason: 'cleanup'
    })
  })

  it('forwards a prompt launch to paired web runtime hosts through agentLaunch only', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: { codex: '--model gpt-5 --reasoning-effort high' },
      agentDefaultEnv: { codex: { CODEX_PROFILE: 'captured' } },
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'fix the spinner',
      groupId: 'group-1'
    })

    expect(result).toEqual(
      expect.objectContaining({
        tabId: null,
        pasteDraftAfterLaunch: false
      })
    )
    // The host owns argv/env/config assembly (including captured agentDefaultArgs
    // /agentDefaultEnv); the request carries identity + folded prompt only.
    expect(mockCreateWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      targetGroupId: 'group-1',
      activate: true,
      agentLaunch: {
        selection: { kind: 'agent', agent: 'codex' },
        prompt: 'fix the spinner'
      },
      viewMode: 'terminal'
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockQueueTabStartupCommand).not.toHaveBeenCalled()
  })

  it('propagates the default chat mode to paired web runtime launches', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime',
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(mockCreateWebRuntimeSessionTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        agentLaunch: {
          selection: { kind: 'agent', agent: 'codex' },
          allowEmptyPromptLaunch: true
        },
        viewMode: 'chat'
      })
    )
  })

  it('propagates the resolved terminal mode to paired web runtime launches', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime',
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: false
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(mockCreateWebRuntimeSessionTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        agentLaunch: {
          selection: { kind: 'agent', agent: 'codex' },
          allowEmptyPromptLaunch: true
        },
        viewMode: 'terminal'
      })
    )
  })

  it('surfaces a toast when host agent launch fails in paired web clients', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    mockCreateWebRuntimeSessionTerminal.mockResolvedValue(false)
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1'
    })

    await Promise.resolve()
    expect(mockToastError).toHaveBeenCalledWith('Could not launch claude in a new terminal.')
    expect(mockSetActiveTabType).not.toHaveBeenCalled()
  })

  it('queues initial working status for Command Code argv prompt launches', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'fix the spinner'
    })

    const queued = mockQueueTabStartupCommand.mock.calls[0][1]
    // The prompt folds into the host-resolved launch (argv agent); the request
    // carries identity + prompt only — never a client command, config, or token.
    expect(queued.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'command-code' },
      prompt: 'fix the spinner'
    })
    expect(queued.initialAgentStatus).toEqual({
      agent: 'command-code',
      prompt: 'fix the spinner'
    })
    expect(queued.command).toBeFalsy()
    expect(queued).not.toHaveProperty('launchConfig')
    expect(queued).not.toHaveProperty('launchAgent')
    expect(queued).not.toHaveProperty('launchToken')
  })

  it('does not track prompt-sent for argv prompt launches', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'fix the spinner',
      launchSource: 'onboarding'
    })

    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('does not track prompt-sent for draft launches', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'review this before sending',
      promptDelivery: 'draft'
    })

    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('folds a native draft into agentLaunch as an unsubmitted prompt', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: "review Bob's change",
      promptDelivery: 'draft'
    })

    const queued = mockQueueTabStartupCommand.mock.calls[0][1]
    // Draft delivery must survive to the host so it uses the native draft flag
    // (unsubmitted) instead of defaulting to submit; the host owns the argv.
    expect(queued.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'claude' },
      prompt: "review Bob's change",
      promptDelivery: 'draft'
    })
    expect(queued.command).toBeFalsy()
    expect(queued).not.toHaveProperty('launchConfig')
    expect(mockPasteDraftWhenAgentReady).not.toHaveBeenCalled()
  })

  it('folds an oversized local draft into agentLaunch for the host to place', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const prompt = 'x'.repeat(25_000)

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt,
      promptDelivery: 'draft'
    })

    expect(result).not.toHaveProperty('promptDeliveryResult')
    const queued = mockQueueTabStartupCommand.mock.calls[0][1]
    // Local (Path Y): the client no longer estimates inline fit — the whole
    // draft folds into agentLaunch and the host decides inline flag vs env vs
    // post-ready paste. No client-side paste happens.
    expect(queued.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'claude' },
      prompt,
      promptDelivery: 'draft'
    })
    expect(queued.command).toBeFalsy()
    expect(mockPasteDraftWhenAgentReady).not.toHaveBeenCalled()
  })

  it('delivers a remote draft via client paste since the host cannot reach the relay pty', async () => {
    // Remote guard (ledger #18): the host's post-ready draftPrompt paste writes
    // through its local ptyController and never reaches the relay-hosted pty
    // (W6-remote U10 gap). Folding-and-trusting would silently lose a draft the
    // host defers to post-ready, so the client pastes it instead — non-lossy.
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-target-1', path: '/repo' }]
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
    const prompt = "review Bob's change"

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt,
      promptDelivery: 'draft'
    })

    expect(result).not.toHaveProperty('promptDeliveryResult')
    const queued = mockQueueTabStartupCommand.mock.calls[0][1]
    // Launch bare — the draft rides the client paste, not agentLaunch.
    expect(queued.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'claude' },
      allowEmptyPromptLaunch: true
    })
    expect(queued.command).toBeFalsy()
    // forcePaste overrides the native-prefill no-op so claude's draft-flag base
    // still receives the paste (nothing was folded to prefill it).
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        content: prompt,
        agent: 'claude',
        submit: false,
        forcePaste: true
      })
    )
  })

  it('logs rejected non-deferred prompt delivery without exposing it to callers', async () => {
    const error = new Error('paste failed')
    const originalConsole = console
    const consoleError = vi.fn()
    vi.stubGlobal('console', { ...originalConsole, error: consoleError })
    mockPasteDraftWhenAgentReady.mockRejectedValue(error)
    // A remote draft takes the client paste path, so a rejected paste hits the
    // fire-and-forget catch that logs without surfacing to callers.
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-target-1', path: '/repo' }]
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    try {
      const result = launchAgentInNewTab({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: "review Bob's change",
        promptDelivery: 'draft'
      })

      expect(result).not.toHaveProperty('promptDeliveryResult')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(consoleError).toHaveBeenCalledWith('Prompt delivery failed after launch', error)
    } finally {
      vi.stubGlobal('console', originalConsole)
    }
  })

  it('seeds working after Command Code submit-after-ready prompt delivery', async () => {
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-a', path: '/repo' }]
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })
    store.terminalLayoutsByTabId = {
      'tab-1': {
        activeLeafId: LEAF_ID,
        ptyIdsByLeafId: { [LEAF_ID]: toAppSshPtyId('ssh-a', 'pty-1') }
      }
    }
    store.ptyIdsByTabId = { 'tab-1': [toAppSshPtyId('ssh-a', 'pty-1')] }
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    await Promise.resolve()
    await Promise.resolve()

    const queued = mockQueueTabStartupCommand.mock.calls[0][1]
    // submit-after-ready launches bare and pastes the prompt post-ready, so the
    // request carries allowEmptyPromptLaunch and never a client command/config.
    expect(queued.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'command-code' },
      allowEmptyPromptLaunch: true
    })
    expect(queued.command).toBeFalsy()
    expect(queued).not.toHaveProperty('launchConfig')
    expect(queued).not.toHaveProperty('launchAgent')
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        content: 'large generated prompt',
        agent: 'command-code',
        submit: true,
        forcePaste: true
      })
    )
    expect(mockSetAgentStatus).toHaveBeenCalledWith(
      `tab-1:${LEAF_ID}`,
      {
        state: 'working',
        prompt: 'large generated prompt',
        agentType: 'command-code'
      },
      undefined,
      undefined,
      { connectionId: 'ssh-a' }
    )
    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('does not recreate SSH status when clear arrives before disconnect state', async () => {
    let finishDelivery: ((delivered: boolean) => void) | undefined
    mockPasteDraftWhenAgentReady.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishDelivery = resolve
      })
    )
    store.repos = [{ id: 'repo-1', connectionId: 'ssh-a', path: '/repo' }]
    const ptyId = toAppSshPtyId('ssh-a', 'pty-1')
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'pending prompt',
      promptDelivery: 'submit-after-ready'
    })
    store.terminalLayoutsByTabId = {
      'tab-1': { activeLeafId: LEAF_ID, ptyIdsByLeafId: { [LEAF_ID]: ptyId } }
    }
    store.ptyIdsByTabId = { 'tab-1': [ptyId] }

    // Why: explicit disconnect sends the transient clear before its state
    // event, while the old connection can still appear connected and bound.
    store.transientClearedAgentStatusConnectionIds = { 'ssh-a': true }
    finishDelivery?.(true)
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })

    expect(mockSetAgentStatus).not.toHaveBeenCalled()
  })

  it('does not track prompt-sent when submit-after-ready delivery fails', async () => {
    mockPasteDraftWhenAgentReady.mockResolvedValue(false)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: false
    })
    await Promise.resolve()

    expect(mockTrack).not.toHaveBeenCalledWith('agent_prompt_sent', expect.anything())
  })

  it('marks failed submit-after-ready delivery as notified after readiness timeout toast', async () => {
    mockPasteDraftWhenAgentReady.mockImplementation(({ onTimeout }) => {
      onTimeout?.()
      return Promise.resolve(false)
    })
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' } as never] }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(mockToastMessage).toHaveBeenCalledWith(
      "Your prompt wasn't sent — paste it once the agent is ready."
    )
  })

  it('marks a cancelled submit-after-ready launch notified when the user closed the tab', async () => {
    mockPasteDraftWhenAgentReady.mockImplementation(({ onTimeout }) => {
      onTimeout?.()
      return Promise.resolve(false)
    })
    // User closed the tab before the agent became ready — it is gone from the list.
    store.tabsByWorktree = { 'wt-1': [] }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(mockToastMessage).not.toHaveBeenCalled()
  })

  it('marks a cancelled submit-after-ready launch notified when the user switched worktrees', async () => {
    mockPasteDraftWhenAgentReady.mockImplementation(({ onTimeout }) => {
      onTimeout?.()
      return Promise.resolve(false)
    })
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' } as never] }
    store.activeWorktreeId = 'wt-2'
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(mockToastMessage).not.toHaveBeenCalled()
  })

  it('leaves a genuine launch failure unnotified so the caller surfaces it', async () => {
    mockPasteDraftWhenAgentReady.mockImplementation(({ onTimeout }) => {
      onTimeout?.()
      return Promise.resolve(false)
    })
    // PTY never spawned: a real failure, not a user cancellation.
    store.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: null } as never] }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'command-code',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: false
    })
    expect(mockToastMessage).not.toHaveBeenCalled()
  })

  it('launches a submit-after-ready prompt bare, never in argv or the request', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    const queued = mockQueueTabStartupCommand.mock.calls[0][1]
    // The generated prompt is pasted post-ready, so the host-resolved request
    // launches bare — the prompt never rides the request (nor an argv command).
    expect(queued.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'codex' },
      allowEmptyPromptLaunch: true
    })
    expect(queued.agentLaunch.prompt).toBeUndefined()
    expect(queued.command).toBeFalsy()
  })

  it('proceeds with untokenizable stored args instead of aborting to a silent no-op', async () => {
    // Option A (ledger #16): the client no longer builds or validates the launch
    // command, so untokenizable stored args (unterminated quote) no longer abort
    // to a silent null. The tab is created and the host surfaces the typed
    // invalid-args failure downstream.
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: { codex: '--model "unterminated' },
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(result).not.toBeNull()
    expect(mockCreateTab).toHaveBeenCalled()
    const queued = mockQueueTabStartupCommand.mock.calls[0][1]
    expect(queued.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'codex' },
      allowEmptyPromptLaunch: true
    })
    expect(queued.command).toBeFalsy()
  })

  it('threads a source-control recipe owner locator into agentLaunch, never client args', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'codex',
      worktreeId: 'wt-1',
      // Only the recipe owner locator reaches the host; it resolves and validates
      // the recipe's stored args itself. The client never assembles or sends args.
      sourceRecord: { owner: 'source-control-recipe', id: 'fixChecks' }
    })

    const queued = mockQueueTabStartupCommand.mock.calls[0][1]
    expect(queued.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'codex' },
      allowEmptyPromptLaunch: true,
      sourceRecord: { owner: 'source-control-recipe', id: 'fixChecks' }
    })
    expect(queued.agentLaunch).not.toHaveProperty('agentArgs')
  })

  it('routes a bare quick launch through agentLaunch with no client command, config, or token', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    const queued = mockQueueTabStartupCommand.mock.calls[0][1]
    expect(queued.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: 'codex' },
      allowEmptyPromptLaunch: true
    })
    expect(queued.command).toBeFalsy()
    expect(queued).not.toHaveProperty('launchConfig')
    expect(queued).not.toHaveProperty('launchAgent')
    expect(queued).not.toHaveProperty('launchToken')
    expect(queued).not.toHaveProperty('env')
  })

  it('keys the fold-vs-paste decision on the resolved base agent for a custom id', async () => {
    // A custom id whose base (aider) is a stdin-after-start followup agent must
    // take the paste path: launch bare, deliver the prompt post-ready. Without
    // base-keying, the raw custom id indexes TUI_AGENT_CONFIG as `any`, reads
    // promptInjectionMode as undefined, and wrongly folds the prompt into argv.
    const customId = 'custom-agent:aider:11111111-1111-4111-8111-111111111111'
    store.settings = {
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      activeRuntimeEnvironmentId: null,
      customTuiAgents: [
        { id: customId, baseAgent: 'aider', label: 'My Aider', args: '', env: {}, syncEnv: false }
      ]
    } as never
    // The client no longer assembles a startup plan (host owns it), so no builder
    // stub is needed — this observes the base-keyed fold-vs-paste decision alone.
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: customId as never,
      worktreeId: 'wt-1',
      prompt: 'fix the flaky test'
    })

    const queued = mockQueueTabStartupCommand.mock.calls[0][1]
    expect(queued.agentLaunch).toEqual({
      selection: { kind: 'agent', agent: customId },
      allowEmptyPromptLaunch: true
    })
    expect(queued.agentLaunch.prompt).toBeUndefined()
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-1',
        content: 'fix the flaky test',
        agent: customId,
        submit: false
      })
    )
  })
})
