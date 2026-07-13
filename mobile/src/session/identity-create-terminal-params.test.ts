import { describe, expect, it } from 'vitest'
import { buildIdentityCreateTerminalParams } from './identity-create-terminal-params'

describe('buildIdentityCreateTerminalParams', () => {
  it('targets the worktree by id', () => {
    expect(buildIdentityCreateTerminalParams('wt-1').worktree).toBe('id:wt-1')
  })

  // oracle-19: mobile launches ride the host-atomic default pick, never a
  // client-cached agent id, so both createTerminal callers send selection:default.
  it('defers agent selection to the host default', () => {
    expect(buildIdentityCreateTerminalParams('wt-1').agentLaunch).toEqual({
      selection: { kind: 'default' }
    })
  })

  it('never leaks a client-assembled command, env, or pinned agent', () => {
    const params = buildIdentityCreateTerminalParams('wt-1')
    expect(params).not.toHaveProperty('startupCommand')
    expect(params).not.toHaveProperty('env')
    expect(params).not.toHaveProperty('createdWithAgent')
    expect(params.agentLaunch.selection).not.toHaveProperty('agent')
  })
})
