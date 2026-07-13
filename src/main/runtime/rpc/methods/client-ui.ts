import type { PersistedUIState } from '../../../../shared/types'
import { defineMethod, type RpcMethod } from '../core'
import {
  FeatureInteractionIdParam,
  PRBotAuthorOverrideUpdate,
  SettingsUpdate,
  UiUpdate
} from './client-ui-schemas'
import { TerminalQuickCommandsUpdate } from './terminal-quick-command-rpc-schema'

// Why: agent catalog/reference state is owned by the atomic mutation APIs, not
// the generic settings write. A legacy client that includes any of these keys is
// rejected wholesale with client_upgrade_required (no partial apply) so it cannot
// erase a custom reference it is too old to represent. Fields never shipped by an
// old settings.update client (custom/tombstone arrays, revisions, reference
// owners) are absent from the schema above and fail strict() before reaching the
// handler; they are listed here only for defense in depth.
const AGENT_REJECTED_SETTINGS_UPDATE_KEYS = [
  'defaultTuiAgent',
  'disabledTuiAgents',
  'agentCmdOverrides',
  'agentDefaultArgs',
  'agentDefaultEnv',
  'customTuiAgents',
  'deletedCustomTuiAgents',
  'agentCatalogRevision',
  'agentReferenceRevision',
  'terminalQuickCommands',
  'commitMessageAi',
  'sourceControlAi'
] as const

export const CLIENT_UI_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'settings.get',
    params: null,
    handler: (_params, { runtime }) => ({
      settings: runtime.getClientSettings(),
      agentCatalog: runtime.getAgentCatalogSnapshot(),
      // Small capability descriptor; the full snapshot ships from
      // settings.agentReferences.get so the two never compete under one frame.
      agentReferences: { version: 1 as const, revision: runtime.getAgentReferenceRevision() }
    })
  }),
  defineMethod({
    name: 'settings.agentReferences.get',
    params: null,
    handler: (_params, { runtime }) => ({ agentReferences: runtime.getAgentReferenceSnapshot() })
  }),
  defineMethod({
    name: 'settings.update',
    params: SettingsUpdate,
    handler: (params, { runtime }) => {
      const provided = params as Record<string, unknown>
      for (const key of AGENT_REJECTED_SETTINGS_UPDATE_KEYS) {
        if (key in provided) {
          throw new Error('client_upgrade_required')
        }
      }
      return { settings: runtime.updateClientSettings(params) }
    }
  }),
  defineMethod({
    name: 'settings.getTerminalQuickCommands',
    params: null,
    // Why: command bodies can total ~240 KB, so keep unrelated settings reads
    // from carrying them over every paired/relay connection.
    handler: (_params, { runtime }) => ({
      terminalQuickCommands: runtime.getClientTerminalQuickCommands()
    })
  }),
  defineMethod({
    name: 'settings.updateTerminalQuickCommands',
    params: TerminalQuickCommandsUpdate,
    handler: (params, { runtime }) => ({
      terminalQuickCommands: runtime.updateClientTerminalQuickCommands(params.mutation)
    })
  }),
  defineMethod({
    name: 'settings.updatePRBotAuthorOverride',
    params: PRBotAuthorOverrideUpdate,
    handler: (params, { runtime }) => ({
      settings: runtime.updateClientPRBotAuthorOverride(params)
    })
  }),
  defineMethod({
    name: 'ui.get',
    params: null,
    handler: (_params, { runtime }) => ({ ui: runtime.getUIState() })
  }),
  defineMethod({
    name: 'ui.set',
    params: UiUpdate,
    handler: (params, { runtime }) => ({
      ui: runtime.updateUIState(params as Partial<PersistedUIState>)
    })
  }),
  defineMethod({
    name: 'ui.recordFeatureInteraction',
    params: FeatureInteractionIdParam,
    handler: (params, { runtime }) => ({
      ui: runtime.recordFeatureInteraction(params)
    })
  })
]
