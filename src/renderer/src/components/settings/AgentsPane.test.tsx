import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { useAppStore } from '../../store'
import { getAgentGeneratedTabTitlesTitle } from './agent-generated-tab-title-copy'
import { getAgentStatusHooksTitle } from './agent-status-hooks-copy'
import { getAgentAwakeDescription, getAgentAwakeTitle } from './agent-awake-copy'
import { AgentAwakeSetting } from './AgentAwakeSetting'
import { AgentRuntimeSetting } from './AgentRuntimeSetting'
import {
  AgentPermissionsSetting,
  AgentGeneratedTabTitlesSetting,
  AgentStatusHooksSetting,
  AgentsPane,
  getAgentsPaneSearchEntries
} from './AgentsPane'
import { matchesSettingsSearch } from './settings-search'
import { TooltipProvider } from '../ui/tooltip'

const detectedAgentsMock = vi.hoisted(() => ({
  detectedIds: ['claude'] as TuiAgent[] | null,
  refresh: vi.fn()
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: detectedAgentsMock.detectedIds,
    isLoading: detectedAgentsMock.detectedIds === null,
    isRefreshing: false,
    refresh: detectedAgentsMock.refresh
  })
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

async function flushPromiseQueue(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function renderPane(
  settings: GlobalSettings,
  props: Partial<React.ComponentProps<typeof AgentsPane>> = {}
): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(AgentsPane, {
        settings,
        updateSettings: vi.fn(),
        ...props
      })
    )
  )
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
  if (element.props?.control) {
    visit(element.props.control, cb)
  }
}

function findSwitch(node: unknown, ariaLabel: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.props.role === 'switch' && entry.props['aria-label'] === ariaLabel) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('switch not found')
  }
  return found
}

function findSwitchRow(node: unknown, ariaLabel: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (
      entry.props.ariaLabel === ariaLabel &&
      typeof entry.props.checked === 'boolean' &&
      typeof entry.props.onChange === 'function'
    ) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('switch row not found')
  }
  return found
}

function findSegmentedControl(node: unknown, ariaLabel: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.props.ariaLabel === ariaLabel && typeof entry.props.onChange === 'function') {
      found = entry
    }
  })
  if (!found) {
    throw new Error('segmented control not found')
  }
  return found
}

describe('AgentsPane', () => {
  beforeEach(() => {
    detectedAgentsMock.detectedIds = ['claude']
    detectedAgentsMock.refresh.mockReset()
    useAppStore.setState({
      settingsSearchQuery: '',
      detectedAgentIds: ['claude'],
      isDetectingAgents: false,
      isRefreshingAgents: false
    })
  })

  it('renders the keep-awake toggle from settings', () => {
    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).not.toContain('Agent location')
    expect(markup).not.toContain('Agent runtime')
    expect(markup).not.toContain('aria-label="Agent runtime"')
    expect(markup).toContain('Keep computer awake while agents are working')
    expect(markup).toContain(
      'Keeps this computer and display awake while agents are working. Orca also asks this device to stay awake when the lid is closed, subject to its power policy.'
    )
    expect(markup).toContain('aria-checked="false"')
  })

  it('renders the agent runtime control on Windows-class hosts', () => {
    const markup = renderPane(
      {
        ...getDefaultSettings('/tmp'),
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      },
      { wslSupportedPlatform: true, wslAvailable: true, wslDistros: ['Ubuntu'] }
    )

    expect(markup).not.toContain('Agent location')
    expect(markup).toContain('Agent runtime')
    expect(markup).toContain('aria-label="Agent runtime"')
    expect(markup).toContain('Detect and launch agents in Ubuntu via WSL')
  })

  it('hides the WSL agent location controls on platforms without WSL support', () => {
    const markup = renderPane({
      ...getDefaultSettings('/tmp'),
      localAgentRuntime: 'wsl',
      terminalWindowsShell: 'wsl.exe'
    })

    expect(markup).not.toContain('Agent location')
    expect(markup).not.toContain('aria-label="Agent location"')
    expect(markup).not.toContain('Agent runtime')
    expect(markup).not.toContain('aria-label="Agent runtime"')
    expect(markup).not.toContain('WSL is not available on this machine.')
  })

  it('updates the global project runtime when changing agent runtime', async () => {
    const updateSettings = vi.fn()
    const element = AgentRuntimeSetting({
      settings: getDefaultSettings('/tmp'),
      updateSettings,
      refresh: detectedAgentsMock.refresh,
      wslSupportedPlatform: true,
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      wslCapabilitiesLoading: false
    })
    const control = findSegmentedControl(element, 'Agent runtime')
    const onChange = control.props.onChange as (value: 'windows-host' | 'wsl') => void

    onChange('wsl')
    await flushPromiseQueue()

    expect(updateSettings).toHaveBeenCalledWith({
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
    })
    expect(detectedAgentsMock.refresh).toHaveBeenCalledTimes(1)
  })

  it('describes Windows lid behavior according to the device', () => {
    expect(getAgentAwakeDescription('Windows')).toBe(
      "Keeps this computer and display awake while agents are working. Lid-close behavior follows this device's power settings."
    )
  })

  it('toggles the keep-awake setting with the next value', () => {
    const updateSettings = vi.fn()
    const element = AgentAwakeSetting({
      settings: {
        ...getDefaultSettings('/tmp'),
        keepComputerAwakeWhileAgentsRun: false
      },
      updateSettings
    })

    const keepAwakeTitle = getAgentAwakeTitle()
    const keepAwakeSwitch = findSwitch(element, keepAwakeTitle)
    expect(keepAwakeSwitch.props['aria-label']).toBe(keepAwakeTitle)
    expect(keepAwakeSwitch.props['aria-checked']).toBe(false)

    const onClick = keepAwakeSwitch.props.onClick as () => void
    onClick()

    expect(updateSettings).toHaveBeenCalledWith({
      keepComputerAwakeWhileAgentsRun: true
    })
  })

  it('toggles the agent status hook setting with the next value', () => {
    const updateSettings = vi.fn()
    const element = AgentStatusHooksSetting({
      settings: {
        ...getDefaultSettings('/tmp'),
        agentStatusHooksEnabled: true
      },
      updateSettings
    })

    const statusSwitch = findSwitchRow(element, getAgentStatusHooksTitle())
    expect(statusSwitch.props.checked).toBe(true)

    const onChange = statusSwitch.props.onChange as () => void
    onChange()

    expect(updateSettings).toHaveBeenCalledWith({
      agentStatusHooksEnabled: false
    })
  })

  it('toggles generated tab titles with the next value', () => {
    const updateSettings = vi.fn()
    const element = AgentGeneratedTabTitlesSetting({
      settings: {
        ...getDefaultSettings('/tmp'),
        tabAutoGenerateTitle: false
      },
      updateSettings
    })

    const generatedTitleSwitch = findSwitchRow(element, getAgentGeneratedTabTitlesTitle())
    expect(generatedTitleSwitch.props.checked).toBe(false)

    const onChange = generatedTitleSwitch.props.onChange as () => void
    onChange()

    expect(updateSettings).toHaveBeenCalledWith({
      tabAutoGenerateTitle: true
    })
  })

  it('includes awake and sleep search metadata for the setting', () => {
    expect(matchesSettingsSearch('awake', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('sleep', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('lid', getAgentsPaneSearchEntries())).toBe(true)
  })

  it('includes hook search metadata for the status setting', () => {
    expect(matchesSettingsSearch('hooks', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('waiting', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('codex', getAgentsPaneSearchEntries())).toBe(true)
  })

  it('includes generated title search metadata', () => {
    expect(matchesSettingsSearch('generated title', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('stable session', getAgentsPaneSearchEntries())).toBe(true)
  })

  it('includes enable and hide search metadata for agent visibility', () => {
    expect(matchesSettingsSearch('disable', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('hide', getAgentsPaneSearchEntries())).toBe(true)
  })

  it('includes agent permission search metadata', () => {
    expect(matchesSettingsSearch('permission', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('yolo', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('manual', getAgentsPaneSearchEntries())).toBe(true)
  })

  it('applies the selected agent permission mode from settings without a mixed segment', () => {
    const onChange = vi.fn()
    const element = AgentPermissionsSetting({ mode: 'mixed', onChange })
    const props = element.props.children.props.action.props as {
      value: 'yolo'
      onChange: (value: 'yolo' | 'manual' | 'mixed') => void
      options: { value: string }[]
    }

    expect(props.value).toBe('yolo')
    expect(props.options.map((option) => option.value)).toEqual(['yolo', 'manual'])
    props.onChange('mixed')
    expect(onChange).not.toHaveBeenCalled()

    props.onChange('manual')
    expect(onChange).toHaveBeenCalledWith('manual')
  })

  it('keeps catalog agent ids, labels, and commands discoverable in settings search', () => {
    for (const agent of AGENT_CATALOG) {
      expect(matchesSettingsSearch(agent.id, getAgentsPaneSearchEntries())).toBe(true)
      expect(matchesSettingsSearch(agent.label, getAgentsPaneSearchEntries())).toBe(true)
      expect(matchesSettingsSearch(agent.cmd, getAgentsPaneSearchEntries())).toBe(true)
    }

    expect(matchesSettingsSearch('GitHub Copilot', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('open claude', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('command-code', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('command code', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('agy', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('cursor-agent', getAgentsPaneSearchEntries())).toBe(true)
  })

  it('includes agent runtime search metadata', () => {
    expect(matchesSettingsSearch('agent runtime', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('agent location', getAgentsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('installed agents in wsl', getAgentsPaneSearchEntries())).toBe(
      true
    )
  })

  it('renders authoring controls without a read-only notice on the desktop host', () => {
    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).not.toContain('Agent settings are managed on the desktop')
    expect(markup).not.toContain('disabled=""')
  })

  it('renders a read-only notice and disables authoring on paired clients', () => {
    const markup = renderPane(getDefaultSettings('/tmp'), { readOnly: true })

    expect(markup).toContain('Agent settings are managed on the desktop')
    expect(markup).toContain('use the Orca desktop app')
    // The whole authoring surface is wrapped in a disabled fieldset so no control
    // is interactive; the host also rejects remote authoring (defense-in-depth).
    expect(markup).toContain('<fieldset')
    expect(markup).toContain('disabled=""')
  })
})
