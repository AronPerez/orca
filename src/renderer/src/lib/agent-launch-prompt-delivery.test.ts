import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pasteDraftWhenAgentReady: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn(),
  settings: {} as { customTuiAgents?: { id: string; baseAgent: string; label: string }[] }
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mocks.pasteDraftWhenAgentReady
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      seedNativeChatLaunchPrompt: mocks.seedNativeChatLaunchPrompt,
      markNativeChatLaunchPromptFailed: mocks.markNativeChatLaunchPromptFailed,
      settings: mocks.settings
    })
  }
}))

import { deliverLaunchPromptToAgentTab } from './agent-launch-prompt-delivery'

describe('deliverLaunchPromptToAgentTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(true)
    mocks.settings = {}
  })

  // Registry safety (oracle 16): a custom id resolves its native-prefill behavior
  // from its base harness; a broken resolution would misreport native delivery as
  // a paste failure. claude delivers via `--prefill`, so a claude-based custom id
  // whose paste no-ops must still count as delivered.
  it('treats a custom-based native-prefill agent delivery as success', async () => {
    const customId = 'custom-agent:claude:11111111-1111-4111-8111-111111111111'
    mocks.settings = {
      customTuiAgents: [{ id: customId, baseAgent: 'claude', label: 'My Claude' }]
    }
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)

    await expect(
      deliverLaunchPromptToAgentTab({
        tabId: 'tab-1',
        agent: customId,
        content: 'Large generated prompt',
        submit: true,
        forcePaste: false
      })
    ).resolves.toBe(true)
    expect(mocks.markNativeChatLaunchPromptFailed).not.toHaveBeenCalled()
  })

  it('seeds a native-chat launch prompt for supported submitted content', async () => {
    await expect(
      deliverLaunchPromptToAgentTab({
        tabId: 'tab-1',
        agent: 'codex',
        content: 'Fix failing checks',
        submit: true,
        forcePaste: true
      })
    ).resolves.toBe(true)

    expect(mocks.seedNativeChatLaunchPrompt).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'codex',
      text: 'Fix failing checks',
      createdAt: expect.any(Number)
    })
    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'codex',
      content: 'Fix failing checks',
      submit: true,
      forcePaste: true,
      timeoutMs: undefined,
      onTimeout: undefined
    })
  })

  it('does not seed for drafts, unsupported agents, or empty content', async () => {
    await deliverLaunchPromptToAgentTab({
      tabId: 'draft-tab',
      agent: 'codex',
      content: 'Review first',
      submit: false,
      forcePaste: false
    })
    await deliverLaunchPromptToAgentTab({
      tabId: 'unsupported-tab',
      agent: 'gemini',
      content: 'Fix failing checks',
      submit: true,
      forcePaste: true
    })
    await deliverLaunchPromptToAgentTab({
      tabId: 'empty-tab',
      agent: 'claude',
      content: '   ',
      submit: true,
      forcePaste: true
    })

    expect(mocks.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()
  })

  it('marks a seeded launch prompt failed when paste delivery returns false', async () => {
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)

    await expect(
      deliverLaunchPromptToAgentTab({
        tabId: 'tab-1',
        agent: 'claude',
        content: 'Large generated prompt',
        submit: true,
        forcePaste: true
      })
    ).resolves.toBe(false)

    expect(mocks.markNativeChatLaunchPromptFailed).toHaveBeenCalledWith('tab-1')
  })

  it('treats native-prefill delivery as success without flagging the seeded prompt', async () => {
    // claude delivers via `--prefill` at launch, so paste no-ops (returns false)
    // when forcePaste is false — that is a native delivery, not a failure.
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)

    await expect(
      deliverLaunchPromptToAgentTab({
        tabId: 'tab-1',
        agent: 'claude',
        content: 'Large generated prompt',
        submit: true,
        forcePaste: false
      })
    ).resolves.toBe(true)

    expect(mocks.seedNativeChatLaunchPrompt).toHaveBeenCalled()
    expect(mocks.markNativeChatLaunchPromptFailed).not.toHaveBeenCalled()
  })

  it('does not mark unseeded launches failed', async () => {
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)

    await deliverLaunchPromptToAgentTab({
      tabId: 'tab-1',
      agent: 'gemini',
      content: 'Large generated prompt',
      submit: true,
      forcePaste: true
    })

    expect(mocks.markNativeChatLaunchPromptFailed).not.toHaveBeenCalled()
  })

  it('passes timeout options through to the paste transport', async () => {
    const onTimeout = vi.fn()

    await deliverLaunchPromptToAgentTab({
      tabId: 'tab-1',
      agent: 'codex',
      content: 'Fix failing checks',
      submit: true,
      forcePaste: true,
      timeoutMs: 123,
      onTimeout
    })

    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 123, onTimeout })
    )
  })
})
