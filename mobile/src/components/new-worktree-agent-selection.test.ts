import { describe, expect, it } from 'vitest'

import type { AgentCatalogSnapshot } from '../../../src/shared/agent-catalog-snapshot'
import type { TuiAgent } from '../../../src/shared/types'
import {
  buildSelectableNewWorktreeAgentOptions,
  NEW_WORKTREE_BLANK_AGENT,
  newWorktreeAgentOptionFor,
  pickPreferredNewWorktreeAgent,
  resolveNewWorktreeAgentSelection,
  type NewWorktreeAgentOption
} from './new-worktree-agent-selection'

function catalogWithClaudeCustom(): AgentCatalogSnapshot {
  return {
    version: 1,
    revision: 4,
    defaultAgent: 'auto',
    disabledAgents: [],
    customAgents: [
      {
        id: 'custom-agent:claude:one',
        baseAgent: 'claude',
        label: 'My Claude',
        args: '',
        syncEnv: false,
        status: 'ready',
        envState: 'none',
        availabilityCheck: 'baseline-detection'
      }
    ],
    deletedCustomAgents: []
  }
}

const claudeCustomOption: NewWorktreeAgentOption = {
  id: 'custom-agent:claude:one' as TuiAgent,
  label: 'My Claude',
  isCustom: true,
  baseAgent: 'claude'
}

describe('new worktree agent selection', () => {
  it('picks the preferred detected agent when there is no user override', () => {
    const selected = newWorktreeAgentOptionFor('claude')
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: selected,
      agentOverridden: false,
      runtimeSettings: { defaultTuiAgent: 'codex' },
      detectedAgentIds: new Set(['claude', 'codex'])
    })

    expect(resolved).toEqual({
      selectedAgent: newWorktreeAgentOptionFor('codex'),
      agentOverridden: false
    })
  })

  it('keeps an available user override', () => {
    const selected = newWorktreeAgentOptionFor('codex')
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: selected,
      agentOverridden: true,
      runtimeSettings: { defaultTuiAgent: 'claude' },
      detectedAgentIds: new Set(['claude', 'codex'])
    })

    expect(resolved).toEqual({ selectedAgent: selected, agentOverridden: true })
  })

  it('clears an unavailable user override after detection completes', () => {
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: newWorktreeAgentOptionFor('codex'),
      agentOverridden: true,
      runtimeSettings: { defaultTuiAgent: 'claude' },
      detectedAgentIds: new Set(['claude'])
    })

    expect(resolved).toEqual({
      selectedAgent: newWorktreeAgentOptionFor('claude'),
      agentOverridden: false
    })
  })

  it('clears a disabled user override after detection completes', () => {
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: newWorktreeAgentOptionFor('codex'),
      agentOverridden: true,
      runtimeSettings: { defaultTuiAgent: 'claude', disabledTuiAgents: ['codex'] },
      detectedAgentIds: new Set(['claude', 'codex'])
    })

    expect(resolved).toEqual({
      selectedAgent: newWorktreeAgentOptionFor('claude'),
      agentOverridden: false
    })
  })

  it('keeps blank terminal as an explicit override', () => {
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: NEW_WORKTREE_BLANK_AGENT,
      agentOverridden: true,
      runtimeSettings: { defaultTuiAgent: 'claude' },
      detectedAgentIds: new Set(['claude'])
    })

    expect(resolved).toEqual({
      selectedAgent: NEW_WORKTREE_BLANK_AGENT,
      agentOverridden: true
    })
  })

  it('leaves closed modal state untouched', () => {
    const selected = newWorktreeAgentOptionFor('codex')
    const resolved = resolveNewWorktreeAgentSelection({
      visible: false,
      selectedAgent: selected,
      agentOverridden: true,
      runtimeSettings: { defaultTuiAgent: 'claude' },
      detectedAgentIds: new Set(['claude'])
    })

    expect(resolved).toEqual({ selectedAgent: selected, agentOverridden: true })
  })

  it('uses blank when no detected agent is known', () => {
    expect(pickPreferredNewWorktreeAgent({ defaultTuiAgent: null }, new Set()).id).toBe('__blank__')
  })

  it('keeps a custom override when its base harness is detected', () => {
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: claudeCustomOption,
      agentOverridden: true,
      runtimeSettings: { defaultTuiAgent: 'codex' },
      detectedAgentIds: new Set(['claude', 'codex'])
    })

    expect(resolved).toEqual({ selectedAgent: claudeCustomOption, agentOverridden: true })
  })

  it('repairs a custom override when its base harness is not detected', () => {
    const resolved = resolveNewWorktreeAgentSelection({
      visible: true,
      selectedAgent: claudeCustomOption,
      agentOverridden: true,
      runtimeSettings: { defaultTuiAgent: 'codex' },
      detectedAgentIds: new Set(['codex'])
    })

    expect(resolved).toEqual({
      selectedAgent: newWorktreeAgentOptionFor('codex'),
      agentOverridden: false
    })
  })
})

describe('buildSelectableNewWorktreeAgentOptions', () => {
  it('returns only built-in rows for a null snapshot', () => {
    const options = buildSelectableNewWorktreeAgentOptions({
      snapshot: null,
      includeCustomAgents: true,
      detectedAgentIds: null,
      disabledTuiAgents: undefined
    })
    expect(options.every((option) => option.isCustom !== true)).toBe(true)
    expect(options.some((option) => option.id === '__blank__')).toBe(false)
  })

  it('shows a custom row when its base harness is detected', () => {
    const options = buildSelectableNewWorktreeAgentOptions({
      snapshot: catalogWithClaudeCustom(),
      includeCustomAgents: true,
      detectedAgentIds: new Set(['claude']),
      disabledTuiAgents: undefined
    })
    expect(options.some((option) => option.id === 'custom-agent:claude:one')).toBe(true)
  })

  it('hides a custom row when its base harness is not detected', () => {
    const options = buildSelectableNewWorktreeAgentOptions({
      snapshot: catalogWithClaudeCustom(),
      includeCustomAgents: true,
      detectedAgentIds: new Set(['codex']),
      disabledTuiAgents: undefined
    })
    expect(options.some((option) => option.id === 'custom-agent:claude:one')).toBe(false)
  })

  it('omits customs when the gate flag is off even with a snapshot', () => {
    const options = buildSelectableNewWorktreeAgentOptions({
      snapshot: catalogWithClaudeCustom(),
      includeCustomAgents: false,
      detectedAgentIds: null,
      disabledTuiAgents: undefined
    })
    expect(options.every((option) => option.isCustom !== true)).toBe(true)
  })
})
