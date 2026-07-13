// Resolve the closed telemetry `agent_kind` for a launch/telemetry event from a
// TuiAgent. Custom ids carry no static kind, so their base is resolved through
// the live settings catalog before mapping; unknown/unproven ids fall back to
// `'other'` inside tuiAgentToAgentKind.
//
// Why: this module must not import '@/store' — it is reachable from store
// slices through the launch libs, and a module-scope store edge creates an
// initialization cycle (createXSlice undefined under test import order). The
// store registers its settings source here right after creation instead.
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { resolveTuiAgentBaseAgent } from '../../../shared/custom-tui-agents'
import type { AgentKind } from '../../../shared/telemetry-events'
import type { CustomTuiAgent, DeletedCustomTuiAgent, TuiAgent } from '../../../shared/types'

type TelemetryAgentCatalogSettings = {
  customTuiAgents?: CustomTuiAgent[]
  deletedCustomTuiAgents?: DeletedCustomTuiAgent[]
}

let catalogSettingsSource: () => TelemetryAgentCatalogSettings | null | undefined = () => null

export function registerTelemetryAgentCatalogSource(
  source: () => TelemetryAgentCatalogSettings | null | undefined
): void {
  catalogSettingsSource = source
}

export function resolveTelemetryAgentKind(agent: TuiAgent | null | undefined): AgentKind {
  const settings = catalogSettingsSource()
  return tuiAgentToAgentKind(
    resolveTuiAgentBaseAgent(agent, settings?.customTuiAgents, settings?.deletedCustomTuiAgents)
  )
}
