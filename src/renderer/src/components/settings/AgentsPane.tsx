import type { GlobalSettings } from '../../../../shared/types'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { applyAgentPermissionModeViaCatalog } from '@/lib/agent-catalog-authoring'
import { AgentAwakeSetting } from './AgentAwakeSetting'
import { AgentCacheTimerSection } from './AgentCacheTimerSection'
import { AgentRuntimeSetting } from './AgentRuntimeSetting'
import {
  resolveAgentPermissionModeSummary,
  type AgentPermissionMode
} from '../../../../shared/tui-agent-permissions'
import {
  AgentsPaneReadOnlyNotice,
  guardAgentsPaneWrite,
  resolveAgentsPaneReadOnly
} from './agents-pane-read-only'
import { AgentPermissionsSetting } from './AgentPermissionsSetting'
import { AgentStatusHooksSetting, AgentGeneratedTabTitlesSetting } from './AgentBehaviorToggles'
import { AgentCatalogSection } from './AgentCatalogSection'
import { buildCodexSessionSourceHomeControl } from './codex-session-source-home-control'

export { getAgentsPaneSearchEntries } from './agents-search'
export { AgentPermissionsSetting } from './AgentPermissionsSetting'
export { AgentStatusHooksSetting, AgentGeneratedTabTitlesSetting } from './AgentBehaviorToggles'

type AgentsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
  /** Defaults to a paired web client being read-only; explicit value wins (tests). */
  readOnly?: boolean
}

export function AgentsPane({
  settings,
  updateSettings,
  wslSupportedPlatform,
  wslAvailable,
  wslDistros,
  wslCapabilitiesLoading,
  readOnly
}: AgentsPaneProps): React.JSX.Element {
  const isReadOnly = resolveAgentsPaneReadOnly(readOnly)
  // Why: a paired web client renders the catalog view-only; the disabled fieldset
  // blocks interaction and these guards stop any write that slips through, while
  // the host rejects remote authoring at the RPC boundary (defense-in-depth).
  const applyUpdate: AgentsPaneProps['updateSettings'] = (updates) =>
    guardAgentsPaneWrite(isReadOnly, () => void updateSettings(updates))
  // Runtime switching re-detects PATH; the catalog owns its own detection view.
  const { refresh } = useDetectedAgents()

  const agentDefaultArgs = settings.agentDefaultArgs ?? {}
  const agentDefaultEnv = settings.agentDefaultEnv ?? {}
  const agentPermissionMode = resolveAgentPermissionModeSummary({
    agentDefaultArgs,
    agentDefaultEnv
  })

  const saveAgentPermissionMode = (mode: Exclude<AgentPermissionMode, 'mixed'>): void => {
    guardAgentsPaneWrite(
      isReadOnly,
      () => void applyAgentPermissionModeViaCatalog(mode, { agentDefaultArgs, agentDefaultEnv })
    )
  }

  return (
    <div className="min-w-0 space-y-8">
      {isReadOnly && <AgentsPaneReadOnlyNotice />}

      {/* Why: the catalog stays outside the disabled fieldset so its search box
          remains usable in read-only mode; the section scopes disabling to its
          own editable controls (default picker, rows, header actions). */}
      <AgentCatalogSection
        agentCmdOverrides={settings.agentCmdOverrides}
        codexSessionSourceHome={buildCodexSessionSourceHomeControl(settings, applyUpdate)}
        readOnly={isReadOnly}
      />

      <fieldset disabled={isReadOnly} className="m-0 min-w-0 space-y-8 border-0 p-0">
        <AgentRuntimeSetting
          settings={settings}
          updateSettings={applyUpdate}
          refresh={refresh}
          wslSupportedPlatform={wslSupportedPlatform}
          wslAvailable={wslAvailable}
          wslDistros={wslDistros}
          wslCapabilitiesLoading={wslCapabilitiesLoading}
        />

        <AgentStatusHooksSetting settings={settings} updateSettings={applyUpdate} />

        <AgentGeneratedTabTitlesSetting settings={settings} updateSettings={applyUpdate} />

        <AgentAwakeSetting settings={settings} updateSettings={applyUpdate} />

        <AgentCacheTimerSection settings={settings} updateSettings={applyUpdate} />

        <AgentPermissionsSetting mode={agentPermissionMode} onChange={saveAgentPermissionMode} />
      </fieldset>
    </div>
  )
}
