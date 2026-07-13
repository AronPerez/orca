import { describe, expect, it } from 'vitest'
import {
  resolveWindowsShiftEnterEncoding,
  resolveWindowsShiftEnterEncodingForPane
} from './terminal-windows-shift-enter'

describe('resolveWindowsShiftEnterEncoding', () => {
  it('uses CSI-u only for trusted Droid process evidence', () => {
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: 'droid', routingTrusted: true, shellForeground: false }
      })
    ).toBe('csi-u')
    expect(resolveWindowsShiftEnterEncoding({ launchAgentType: 'droid' })).toBe('alt-enter')
  })

  it('does not let hook or OSC-derived status forge Droid input routing', () => {
    const state = {
      paneForegroundAgentByPaneKey: {},
      agentStatusByPaneKey: {
        'tab:pane': { agentType: 'droid' as const }
      },
      agentLaunchConfigByPaneKey: {}
    }

    expect(resolveWindowsShiftEnterEncodingForPane(state, 'tab:pane')).toBe('alt-enter')
  })

  it('keeps the legacy byte for Codex, Antigravity, unknown, and plain panes', () => {
    for (const agent of ['codex', 'antigravity', 'claude', null] as const) {
      expect(
        resolveWindowsShiftEnterEncoding({
          foreground: { agent, shellForeground: false }
        })
      ).toBe('alt-enter')
    }
    expect(resolveWindowsShiftEnterEncoding({})).toBe('alt-enter')
  })

  it('lets current process identity override stale launch ownership', () => {
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: 'antigravity', routingTrusted: true, shellForeground: false },
        launchAgentType: 'droid'
      })
    ).toBe('alt-enter')
  })

  it('fails closed while a newer command generation awaits trusted evidence', () => {
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: 'droid', shellForeground: false },
        launchAgentType: 'droid'
      })
    ).toBe('alt-enter')
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: null, shellForeground: false },
        launchAgentType: 'droid'
      })
    ).toBe('alt-enter')
  })

  it('keeps launch ownership on its original leaf after a split sibling survives', () => {
    const state = {
      paneForegroundAgentByPaneKey: {},
      agentLaunchConfigByPaneKey: {
        'tab:launched-droid': { identity: { agentType: 'droid' } }
      }
    }

    expect(resolveWindowsShiftEnterEncodingForPane(state, 'tab:launched-droid')).toBe('alt-enter')
    // Why: after split→close leaves only the sibling, pane count is no longer
    // ownership evidence; the surviving leaf must keep the legacy fallback.
    expect(resolveWindowsShiftEnterEncodingForPane(state, 'tab:surviving-sibling')).toBe(
      'alt-enter'
    )
  })

  it('clears stale Droid ownership after the foreground returns to the shell', () => {
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: null, shellForeground: true },
        launchAgentType: 'droid'
      })
    ).toBe('alt-enter')
  })

  // Registry safety (oracle 16): a custom id must resolve its Shift+Enter encoding
  // from the base harness, never crash or silently fall back on a raw index.
  const DROID_CUSTOM_ID = 'custom-agent:droid:11111111-1111-4111-8111-111111111111'
  const CODEX_CUSTOM_ID = 'custom-agent:codex:22222222-2222-4222-8222-222222222222'

  it('resolves a custom id to its base harness encoding (droid custom → csi-u)', () => {
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: DROID_CUSTOM_ID, routingTrusted: true, shellForeground: false },
        customTuiAgents: [
          { id: DROID_CUSTOM_ID, baseAgent: 'droid', label: 'Mine', args: '', env: {}, syncEnv: false }
        ]
      })
    ).toBe('csi-u')
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: CODEX_CUSTOM_ID, routingTrusted: true, shellForeground: false },
        customTuiAgents: [
          { id: CODEX_CUSTOM_ID, baseAgent: 'codex', label: 'Mine', args: '', env: {}, syncEnv: false }
        ]
      })
    ).toBe('alt-enter')
  })

  it('resolves a tombstoned custom id through its base and degrades an unknown id', () => {
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: DROID_CUSTOM_ID, routingTrusted: true, shellForeground: false },
        deletedCustomTuiAgents: [
          { id: DROID_CUSTOM_ID, baseAgent: 'droid', label: 'Mine', deletedAt: 1 }
        ]
      })
    ).toBe('csi-u')
    // Unresolvable custom id (neither live nor tombstoned): degrade to the legacy byte.
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: DROID_CUSTOM_ID, routingTrusted: true, shellForeground: false }
      })
    ).toBe('alt-enter')
  })
})
