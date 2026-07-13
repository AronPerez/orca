import { describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import {
  MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH,
  MAX_QUICK_COMMAND_ID_LENGTH,
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_REPO_ID_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH
} from '../../../../shared/terminal-quick-commands'
import type { GlobalSettings, PersistedUIState } from '../../../../shared/types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { buildAgentCatalogSnapshot } from '../../../agent-launch/agent-catalog-projections'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

// Env-free catalog snapshot stub for handlers that read it beside `settings`.
function emptyAgentCatalogSnapshot(): ReturnType<typeof buildAgentCatalogSnapshot> {
  return {
    version: 1,
    revision: 1,
    defaultAgent: null,
    disabledAgents: [],
    customAgents: [],
    deletedCustomAgents: []
  }
}

function collectStringsAndKeys(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringsAndKeys(item, out)
    }
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      out.push(key)
      collectStringsAndKeys(nested, out)
    }
  }
}

describe('client UI RPC methods', () => {
  it('returns the runtime host agent settings needed by mobile create flows', async () => {
    const settings = {
      defaultTuiAgent: 'codex',
      disabledTuiAgents: ['claude'],
      agentCmdOverrides: { codex: 'codex --profile work' },
      defaultTaskSource: 'gitlab',
      defaultTaskViewPreset: 'my-prs',
      visibleTaskProviders: ['github', 'gitlab'],
      defaultRepoSelection: ['repo-1'],
      defaultLinearTeamSelection: ['team-1'],
      compactWorktreeCards: true,
      minimaxGroupId: 'group-42',
      minimaxUsageModels: 'general,abab6.5',
      githubProjects: {
        pinned: [
          {
            owner: 'stablyai',
            ownerType: 'organization' as const,
            number: 1,
            host: 'ghe.example:8443'
          }
        ],
        recent: [],
        lastViewByProject: {},
        activeProject: null
      }
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientSettings: vi.fn(() => settings),
      getAgentCatalogSnapshot: vi.fn(() => emptyAgentCatalogSnapshot()),
      getAgentReferenceRevision: vi.fn(() => 1)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(makeRequest('settings.get'))

    expect(runtime.getClientSettings).toHaveBeenCalledTimes(1)
    expect(response).toMatchObject({
      ok: true,
      result: { settings, agentReferences: { version: 1, revision: 1 } }
    })
  })

  it('persists the runtime host task source settings for mobile Tasks', async () => {
    const settings = {
      defaultTuiAgent: null,
      disabledTuiAgents: ['claude'],
      agentCmdOverrides: {},
      defaultTaskSource: 'linear',
      defaultTaskViewPreset: 'issues',
      visibleTaskProviders: ['github', 'linear'],
      defaultRepoSelection: ['repo-1', 'repo-2'],
      defaultLinearTeamSelection: ['team-1', 'team-2'],
      experimentalNewWorktreeCardStyle: true,
      compactWorktreeCards: true,
      githubProjects: {
        pinned: [],
        recent: [],
        lastViewByProject: {
          'organization:stablyai:1': { viewId: 'view-1' }
        },
        activeProject: {
          owner: 'stablyai',
          ownerType: 'organization' as const,
          number: 1,
          host: 'ghe.example:8443'
        }
      }
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateClientSettings: vi.fn(() => settings)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('settings.update', {
        defaultTaskSource: 'linear',
        visibleTaskProviders: ['github', 'linear'],
        defaultTaskViewPreset: 'my-prs',
        experimentalNewWorktreeCardStyle: true,
        compactWorktreeCards: true,
        minimaxGroupId: 'group-42',
        minimaxUsageModels: 'general,abab6.5',
        defaultRepoSelection: settings.defaultRepoSelection,
        defaultLinearTeamSelection: ['team-1', 'team-2'],
        githubProjects: settings.githubProjects
      })
    )

    expect(runtime.updateClientSettings).toHaveBeenCalledWith({
      defaultTaskSource: 'linear',
      visibleTaskProviders: ['github', 'linear'],
      defaultTaskViewPreset: 'my-prs',
      experimentalNewWorktreeCardStyle: true,
      compactWorktreeCards: true,
      minimaxGroupId: 'group-42',
      minimaxUsageModels: 'general,abab6.5',
      defaultRepoSelection: settings.defaultRepoSelection,
      defaultLinearTeamSelection: ['team-1', 'team-2'],
      githubProjects: settings.githubProjects
    })
    expect(response).toMatchObject({ ok: true, result: { settings } })

    vi.mocked(runtime.updateClientSettings).mockClear()
    await dispatcher.dispatch(
      makeRequest('settings.update', {
        defaultTaskSource: 'jira',
        visibleTaskProviders: ['github', 'jira']
      })
    )

    expect(runtime.updateClientSettings).toHaveBeenCalledWith({
      defaultTaskSource: 'jira',
      visibleTaskProviders: ['github', 'jira']
    })
  })

  it('normalizes manual bot-author overrides before persisting', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateClientSettings: vi.fn(() => ({}))
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    await dispatcher.dispatch(
      makeRequest('settings.update', {
        prBotAuthorOverrides: [' GretelFlux ', 'gretelflux', 42, '', 'another-bot']
      })
    )

    expect(runtime.updateClientSettings).toHaveBeenCalledWith({
      prBotAuthorOverrides: ['another-bot', 'gretelflux']
    })
  })

  it('loads and normalizes quick commands through the targeted payload', async () => {
    const commands = [
      {
        id: 'review',
        label: 'Review',
        action: 'agent-prompt' as const,
        agent: 'codex' as const,
        prompt: 'Review this diff',
        scope: { type: 'global' as const }
      }
    ]
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientTerminalQuickCommands: vi.fn(() => commands),
      updateClientTerminalQuickCommands: vi.fn(() => commands)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const getResponse = await dispatcher.dispatch(makeRequest('settings.getTerminalQuickCommands'))
    const updateResponse = await dispatcher.dispatch(
      makeRequest('settings.updateTerminalQuickCommands', {
        mutation: {
          type: 'upsert',
          command: {
            id: ' review ',
            label: ' Review ',
            action: 'agent-prompt',
            agent: 'codex',
            prompt: 'Review this diff\n',
            scope: { type: 'global' }
          }
        }
      })
    )

    expect(getResponse).toMatchObject({ ok: true, result: { terminalQuickCommands: commands } })
    expect(runtime.updateClientTerminalQuickCommands).toHaveBeenCalledWith({
      type: 'upsert',
      command: commands[0]
    })
    expect(updateResponse).toMatchObject({
      ok: true,
      result: { terminalQuickCommands: commands }
    })

    await dispatcher.dispatch(
      makeRequest('settings.updateTerminalQuickCommands', {
        mutation: { type: 'delete', id: 'review' }
      })
    )
    expect(runtime.updateClientTerminalQuickCommands).toHaveBeenLastCalledWith({
      type: 'delete',
      id: 'review'
    })
  })

  it('rejects malformed quick-command mutations instead of changing persisted commands', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateClientTerminalQuickCommands: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    for (const mutation of [
      null,
      'not-a-mutation',
      { type: 'delete', id: '' },
      { type: 'upsert', command: null },
      { type: 'upsert', command: { id: 'incomplete' } },
      {
        type: 'upsert',
        command: {
          id: 'unsupported-agent',
          label: 'Unsupported agent',
          action: 'agent-prompt',
          agent: 'aider',
          prompt: 'Review this diff'
        }
      },
      {
        type: 'upsert',
        command: {
          id: 'oversized-command',
          label: 'Oversized command',
          action: 'terminal-command',
          command: 'x'.repeat(MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH + 1),
          appendEnter: true
        }
      },
      {
        type: 'upsert',
        command: {
          id: 'x'.repeat(MAX_QUICK_COMMAND_ID_LENGTH + 1),
          label: 'Oversized id',
          action: 'terminal-command',
          command: 'true',
          appendEnter: true
        }
      },
      {
        type: 'upsert',
        command: {
          id: 'oversized-label',
          label: 'x'.repeat(MAX_QUICK_COMMAND_LABEL_LENGTH + 1),
          action: 'terminal-command',
          command: 'true',
          appendEnter: true
        }
      },
      {
        type: 'upsert',
        command: {
          id: 'oversized-repo',
          label: 'Oversized repo',
          action: 'terminal-command',
          command: 'true',
          appendEnter: true,
          scope: { type: 'repo', repoId: 'x'.repeat(MAX_QUICK_COMMAND_REPO_ID_LENGTH + 1) }
        }
      },
      {
        type: 'upsert',
        command: {
          id: 'oversized-prompt',
          label: 'Oversized prompt',
          action: 'agent-prompt',
          agent: 'codex',
          prompt: 'x'.repeat(MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH + 1)
        }
      },
      { type: 'upsert', command: { id: 'default-pwd', label: 'Removed', command: 'pwd' } }
    ]) {
      const response = await dispatcher.dispatch(
        makeRequest('settings.updateTerminalQuickCommands', { mutation })
      )

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
    expect(runtime.updateClientTerminalQuickCommands).not.toHaveBeenCalled()
  })

  it('caps oversized bot-author override payloads', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateClientSettings: vi.fn(() => ({}))
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    await dispatcher.dispatch(
      makeRequest('settings.update', {
        prBotAuthorOverrides: Array.from(
          { length: 600 },
          (_, i) => `bot-${String(i).padStart(4, '0')}`
        )
      })
    )

    const [update] = vi.mocked(runtime.updateClientSettings).mock.calls[0]!
    expect((update as { prBotAuthorOverrides: string[] }).prBotAuthorOverrides).toHaveLength(500)
  })

  it('routes bot-author deltas to the runtime-owned atomic update', async () => {
    const settings = { prBotAuthorOverrides: ['alice', 'bob'] }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateClientPRBotAuthorOverride: vi.fn(() => settings)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('settings.updatePRBotAuthorOverride', { author: ' Bob ', isBot: true })
    )

    expect(runtime.updateClientPRBotAuthorOverride).toHaveBeenCalledWith({
      author: ' Bob ',
      isBot: true
    })
    expect(response).toMatchObject({ ok: true, result: { settings } })
  })

  it('returns the runtime host persisted UI state', async () => {
    const ui: PersistedUIState = {
      ...getDefaultUIState(),
      groupBy: 'none',
      sortBy: 'smart',
      showActiveOnly: true,
      filterRepoIds: ['repo-1']
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getUIState: vi.fn(() => ui)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ui.get'))

    expect(runtime.getUIState).toHaveBeenCalledTimes(1)
    expect(response).toMatchObject({ ok: true, result: { ui } })
  })

  it('persists UI updates on the runtime host and returns the updated state', async () => {
    const updated: PersistedUIState = {
      ...getDefaultUIState(),
      rightSidebarOpen: false,
      rightSidebarTab: 'checks',
      rightSidebarExplorerView: 'search',
      showActiveOnly: true,
      hideAutomationGeneratedWorkspaces: true,
      filterRepoIds: ['repo-1']
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn(() => updated)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', {
        rightSidebarOpen: false,
        rightSidebarTab: 'checks',
        rightSidebarExplorerView: 'search',
        showActiveOnly: true,
        hideSleepingWorkspaces: true,
        hideAutomationGeneratedWorkspaces: true,
        filterRepoIds: ['repo-1']
      })
    )

    expect(runtime.updateUIState).toHaveBeenCalledWith({
      rightSidebarOpen: false,
      rightSidebarTab: 'checks',
      rightSidebarExplorerView: 'search',
      showActiveOnly: true,
      hideSleepingWorkspaces: true,
      hideAutomationGeneratedWorkspaces: true,
      filterRepoIds: ['repo-1']
    })
    expect(response).toMatchObject({ ok: true, result: { ui: updated } })
  })

  it('accepts persisted literal UI arrays and nested UI state', async () => {
    const updated: PersistedUIState = {
      ...getDefaultUIState(),
      worktreeCardProperties: ['status', 'branch', 'automation', 'inline-agents'],
      _worktreeCardModeDefaulted: true,
      statusBarItems: ['codex', 'kimi', 'minimax', 'grok', 'antigravity', 'ports'],
      _portsStatusBarDefaultAdded: true,
      _kimiStatusBarDefaultAdded: true,
      _minimaxStatusBarDefaultAdded: true,
      _grokStatusBarDefaultAdded: true,
      _antigravityStatusBarDefaultAdded: true,
      taskResumeState: {
        githubMode: 'items',
        githubItemsQuery: 'is:open',
        githubProjectHiddenFieldIdsByView: {
          'project-1:view-1': ['field-1']
        }
      },
      workspaceCleanup: {
        dismissals: {
          'repo::/worktree': {
            worktreeId: 'repo::/worktree',
            dismissedAt: 123,
            fingerprint: 'abc',
            classifierVersion: 2
          }
        }
      },
      featureTipsSeenIds: ['voice-dictation'],
      featureInteractions: {
        tasks: { firstInteractedAt: 100, interactionCount: 2 }
      },
      contextualToursSeenIds: ['tasks'],
      contextualToursAutoEligible: true,
      usageEmptyStateDismissed: true,
      browserDefaultZoomLevel: 1.5,
      manualRepoOrder: [{ hostId: 'runtime:node-b', repoId: 'repo-b' }]
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn(() => updated)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const payload = {
      worktreeCardProperties: ['status', 'branch', 'automation', 'inline-agents'],
      _worktreeCardModeDefaulted: true,
      statusBarItems: ['codex', 'kimi', 'minimax', 'grok', 'antigravity', 'ports'],
      _portsStatusBarDefaultAdded: true,
      _kimiStatusBarDefaultAdded: true,
      _minimaxStatusBarDefaultAdded: true,
      _grokStatusBarDefaultAdded: true,
      _antigravityStatusBarDefaultAdded: true,
      taskResumeState: {
        githubMode: 'items',
        githubItemsQuery: 'is:open',
        githubProjectHiddenFieldIdsByView: {
          'project-1:view-1': ['field-1']
        }
      },
      workspaceCleanup: {
        dismissals: {
          'repo::/worktree': {
            worktreeId: 'repo::/worktree',
            dismissedAt: 123,
            fingerprint: 'abc',
            classifierVersion: 2
          }
        }
      },
      featureTipsSeenIds: ['voice-dictation'],
      featureInteractions: {
        tasks: { firstInteractedAt: 100, interactionCount: 2 }
      },
      contextualToursSeenIds: ['tasks'],
      contextualToursAutoEligible: true,
      usageEmptyStateDismissed: true,
      browserDefaultZoomLevel: 1.5,
      manualRepoOrder: [{ hostId: 'runtime:node-b', repoId: 'repo-b' }]
    }
    const response = await dispatcher.dispatch(makeRequest('ui.set', payload))

    expect(runtime.updateUIState).toHaveBeenCalledWith({
      ...payload,
      worktreeCardProperties: ['status', 'unread', 'branch', 'automation', 'inline-agents']
    })
    expect(response).toMatchObject({ ok: true, result: { ui: updated } })
  })

  it('records a feature interaction through the runtime host', async () => {
    const updated: PersistedUIState = {
      ...getDefaultUIState(),
      featureInteractions: {
        tasks: { firstInteractedAt: 100, interactionCount: 1 }
      }
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      recordFeatureInteraction: vi.fn(() => updated)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ui.recordFeatureInteraction', 'tasks'))

    expect(runtime.recordFeatureInteraction).toHaveBeenCalledWith('tasks')
    expect(response).toMatchObject({ ok: true, result: { ui: updated } })
  })

  it('rejects unknown and malformed UI update fields', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', { showActiveOnly: 'yes', unknownField: true })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('rejects unknown worktree card properties', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', { worktreeCardProperties: ['status', 'pr-status'] })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('rejects star-nag persisted state mutations from remote clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', {
        starNagBaselineAgents: 10,
        starNagAppVersion: '1.2.3',
        starNagAgentValueMomentAppVersion: '1.2.3',
        starNagNextThreshold: 70,
        starNagCompleted: true,
        starNagDeferredUntil: null
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('strips retired worktree card properties from legacy clients', async () => {
    const updated: PersistedUIState = {
      ...getDefaultUIState(),
      worktreeCardProperties: ['status', 'issue']
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn(() => updated)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', { worktreeCardProperties: ['status', 'unread', 'ci', 'pr', 'issue'] })
    )

    expect(runtime.updateUIState).toHaveBeenCalledWith({
      worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr']
    })
    expect(response).toMatchObject({ ok: true, result: { ui: updated } })
  })

  it('rejects each star-nag persisted state mutation field from remote clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
    const forbiddenPayloads = [
      { starNagBaselineAgents: 10 },
      { starNagAppVersion: '1.2.3' },
      { starNagAgentValueMomentAppVersion: '1.2.3' },
      { starNagNextThreshold: 70 },
      { starNagCompleted: true },
      { starNagDeferredUntil: null }
    ]

    for (const payload of forbiddenPayloads) {
      const response = await dispatcher.dispatch(makeRequest('ui.set', payload))
      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('rejects unknown feature interaction ids', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', {
        featureInteractions: {
          unknown: { firstInteractedAt: 100 }
        }
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('rejects unknown feature tip ids', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateUIState: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.set', { featureTipsSeenIds: ['voice-dictation', 'unknown-tip'] })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.updateUIState).not.toHaveBeenCalled()
  })

  it('rejects unknown feature interaction ids for increment RPC', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      recordFeatureInteraction: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ui.recordFeatureInteraction', 'unknown-feature')
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.recordFeatureInteraction).not.toHaveBeenCalled()
  })

  it('rejects legacy agent-authoring settings.update fields without writing settings', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateClientSettings: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    // Kept in the schema so the payload parses and reaches the typed rejection.
    const upgradeRequiredPayloads = [
      { defaultTuiAgent: 'codex' },
      { disabledTuiAgents: ['claude'] },
      { agentDefaultArgs: { codex: '--flag' } },
      { agentDefaultEnv: { codex: { TOKEN: 'x' } } }
    ]
    for (const payload of upgradeRequiredPayloads) {
      const response = await dispatcher.dispatch(makeRequest('settings.update', payload))
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'client_upgrade_required', message: 'client_upgrade_required' }
      })
    }

    // Never-shipped catalog/reference keys are absent from the schema, so strict()
    // rejects them before the handler runs — still no write.
    const strictRejectedPayloads = [
      { customTuiAgents: [] },
      { deletedCustomTuiAgents: [] },
      { agentCatalogRevision: 2 },
      { agentReferenceRevision: 2 },
      { terminalQuickCommands: [] },
      { commitMessageAi: {} },
      { sourceControlAi: {} },
      { agentCmdOverrides: {} }
    ]
    for (const payload of strictRejectedPayloads) {
      const response = await dispatcher.dispatch(makeRequest('settings.update', payload))
      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }

    expect(runtime.updateClientSettings).not.toHaveBeenCalled()
  })

  it('still applies non-agent settings.update fields', async () => {
    const applied = { defaultTaskSource: 'linear' }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateClientSettings: vi.fn(() => applied)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('settings.update', { defaultTaskSource: 'linear', compactWorktreeCards: true })
    )

    expect(runtime.updateClientSettings).toHaveBeenCalledWith({
      defaultTaskSource: 'linear',
      compactWorktreeCards: true
    })
    expect(response).toMatchObject({ ok: true, result: { settings: applied } })
  })

  it('exposes no catalog/reference mutation method on the paired settings surface (oracle-15)', () => {
    // Read-only paired settings: catalog/reference AUTHORING is desktop preload IPC
    // only (settings:mutateAgentCatalog etc.), never a runtime RPC. A paired/mobile
    // client reaches the host solely through these methods, so the ONLY settings
    // writer is the key-guarded settings.update. This guard fails if a future
    // authoring RPC is added to the paired surface without a write-rejection —
    // exactly the walk's "mutation RPCs have no paired write-rejection" concern.
    const names = CLIENT_UI_METHODS.map((method) => method.name)
    const settingsMethods = names.filter((name) => name.startsWith('settings.'))
    expect(settingsMethods.sort()).toEqual([
      'settings.agentReferences.get',
      'settings.get',
      'settings.update',
      // main's PR-bot-author toggle: a plain settings writer, not agent
      // catalog/reference authoring — the mutationLike guard below still holds.
      'settings.updatePRBotAuthorOverride'
    ])
    const mutationVerbs = new Set([
      'mutate',
      'create',
      'update',
      'delete',
      'set',
      'author',
      'rename',
      'duplicate',
      'disable',
      'enable',
      'write',
      'save'
    ])
    const authoringNoun = /agentcatalog|agentreference|customagent/i
    // Exact dot-segment match so a verb like `set` cannot false-match `settings`.
    const mutationLike = names.filter(
      (name) =>
        authoringNoun.test(name) &&
        name
          .toLowerCase()
          .split('.')
          .some((segment) => mutationVerbs.has(segment))
    )
    expect(mutationLike).toEqual([])
  })

  it('returns an env-free agent catalog with version 1 and the revision on settings.get', async () => {
    const settings = { defaultTaskSource: 'github' }
    // A live custom agent whose env holds a secret the projection must never emit.
    const catalogSettings = {
      customTuiAgents: [
        {
          id: 'custom-agent:codex:01234567-89ab-4cde-8f01-23456789abcd',
          baseAgent: 'codex',
          label: 'Secret Codex',
          args: '',
          env: { SECRET_TOKEN: 'super-secret-value' },
          syncEnv: true
        }
      ],
      agentCatalogRevision: 7
    } as unknown as GlobalSettings
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getClientSettings: vi.fn(() => settings),
      getAgentCatalogSnapshot: vi.fn(() => buildAgentCatalogSnapshot(catalogSettings)),
      getAgentReferenceRevision: vi.fn(() => 4)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })

    const response = await dispatcher.dispatch(makeRequest('settings.get'))

    expect(response.ok).toBe(true)
    const result = (response as { result: Record<string, unknown> }).result
    expect(result.agentCatalog).toMatchObject({ version: 1, revision: 7 })
    expect(result.agentReferences).toEqual({ version: 1, revision: 4 })

    const strings: string[] = []
    collectStringsAndKeys(result, strings)
    expect(strings).not.toContain('SECRET_TOKEN')
    expect(strings).not.toContain('super-secret-value')
  })
})
