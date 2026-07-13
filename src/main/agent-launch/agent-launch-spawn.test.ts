import { describe, expect, it, vi } from 'vitest'
import {
  resolveAgentLaunchSpawn,
  type AgentLaunchSpawnDeps,
  type AgentLaunchSpawnInput,
  type AgentLaunchSpawnTarget
} from './agent-launch-spawn'
import { AgentLaunchBoundary } from './agent-launch-boundary'
import {
  AgentLaunchAdmissionStore,
  LaunchAdmissionCoordinator
} from './agent-launch-admission-store'
import type { CustomTuiAgentId, GlobalSettings } from '../../shared/types'
import type {
  ResolvedAgentLaunch,
  AgentLaunchSnapshot
} from '../../shared/agent-launch-host-contract'
import type { ResolveAgentLaunchRequest } from '../../shared/agent-launch-host-contract'
import type { ResolveAgentLaunchOutcome } from './resolve-agent-launch'
import { customId } from './agent-launch-test-catalog'

function makeSnapshot(): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: 'claude',
    baseAgent: 'claude',
    displayLabel: 'Claude',
    mode: 'built-in',
    argv: ['/opt/resolved-claude', '--tui'],
    agentEnv: {},
    capturedEnvPolicy: 'none',
    target: {
      platform: 'linux',
      execution: 'native',
      shell: 'posix',
      isRemote: false,
      executionHostId: 'local'
    }
  }
}

function makeLaunch(): ResolvedAgentLaunch {
  const snapshot = makeSnapshot()
  return {
    requestedAgent: 'claude',
    baseAgent: 'claude',
    displayLabel: 'Claude',
    argv: snapshot.argv,
    agentEnv: snapshot.agentEnv,
    variables: { values: { repoPath: null, worktreePath: null }, referenced: [] },
    snapshot,
    policy: {
      intent: 'interactive',
      mode: 'built-in',
      client: 'desktop',
      isRemote: false,
      platform: 'linux',
      promptInjectionMode: 'stdin-after-start',
      expectedProcess: 'claude',
      env: 'none'
    },
    notices: [],
    telemetry: { agentKind: 'claude-code', usedCustomAgent: false },
    admissionGuard: { fingerprint: 'fp-1', stableInputDigest: 'sfp-1', basis: 'explicit' }
  }
}

const TARGET: AgentLaunchSpawnTarget = {
  platform: 'linux',
  shell: 'posix',
  isRemote: false,
  executionHostId: 'local',
  targetHomePath: '/home/dev'
}

function makeDeps(
  resolve: (request: ResolveAgentLaunchRequest) => ResolveAgentLaunchOutcome
): AgentLaunchSpawnDeps {
  return {
    getSettings: () => ({}) as GlobalSettings,
    getCatalogRevision: () => 7,
    boundary: new AgentLaunchBoundary({
      admissionStore: new AgentLaunchAdmissionStore(),
      coordinator: new LaunchAdmissionCoordinator()
    }),
    resolve: (request) => resolve(request)
  }
}

function baseInput(overrides: Partial<AgentLaunchSpawnInput> = {}): AgentLaunchSpawnInput {
  return {
    request: { selection: { kind: 'agent', agent: 'claude' }, prompt: 'do the thing' },
    intent: { kind: 'interactive', client: 'desktop' },
    target: TARGET,
    variables: { repoPath: '/repo', worktreePath: '/repo/wt' },
    scope: 'worktree-1',
    principal: { kind: 'local' },
    ...overrides
  }
}

describe('resolveAgentLaunchSpawn', () => {
  it('resolves the command from host state, never a client-supplied command/env', async () => {
    const resolve = vi.fn((_request: ResolveAgentLaunchRequest) => ({
      ok: true as const,
      launch: makeLaunch()
    }))
    const deps = makeDeps(resolve)
    const result = await resolveAgentLaunchSpawn(deps, baseInput())

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    // The launch command comes from the resolved argv, not any client input.
    expect(result.plan.launchCommand).toContain('/opt/resolved-claude')
    expect(result.receipt.catalogRevision).toBe(7)

    const request = resolve.mock.calls[0]![0]
    expect(request.selection).toEqual({ kind: 'agent', agent: 'claude' })
    expect(request.platform).toBe('linux')
    expect(request.executionHostId).toBe('local')
    expect(request.targetHomePath).toBe('/home/dev')
    // The request is assembled only from host inputs; it has no command/env keys.
    expect('command' in request).toBe(false)
    expect('env' in request).toBe(false)
  })

  it('derives persisted default reference for a default selection', async () => {
    const resolve = vi.fn((_request: ResolveAgentLaunchRequest) => ({
      ok: true as const,
      launch: makeLaunch()
    }))
    const deps = makeDeps(resolve)
    await resolveAgentLaunchSpawn(
      deps,
      baseInput({ request: { selection: { kind: 'default' }, prompt: 'x' } })
    )
    expect(resolve.mock.calls[0]![0].reference).toEqual({ kind: 'persisted', owner: 'default' })
  })

  it('resolves a source-control recipe id to its stored agentArgs as perLaunchArgs (U7)', async () => {
    const resolve = vi.fn((_request: ResolveAgentLaunchRequest) => ({
      ok: true as const,
      launch: makeLaunch()
    }))
    const deps = makeDeps(resolve)
    await resolveAgentLaunchSpawn(
      deps,
      baseInput({
        request: {
          selection: { kind: 'agent', agent: 'claude' },
          prompt: 'x',
          sourceRecord: { owner: 'source-control-recipe', id: 'fixChecks' }
        },
        recipeRepo: {
          sourceControlAi: { actionOverrides: { fixChecks: { agentArgs: '--recipe one' } } }
        }
      })
    )
    // The host reads recipe.agentArgs from settings and threads it; the client
    // sent only the recipe id, never args.
    expect(resolve.mock.calls[0]![0].perLaunchArgs).toBe('--recipe one')
    expect(resolve.mock.calls[0]![0].reference).toEqual({
      kind: 'persisted',
      owner: 'source-control-recipe'
    })
  })

  it('rejects an unknown recipe action id with untrusted_reference and never resolves (U7)', async () => {
    const resolve = vi.fn((_request: ResolveAgentLaunchRequest) => ({
      ok: true as const,
      launch: makeLaunch()
    }))
    const deps = makeDeps(resolve)
    const result = await resolveAgentLaunchSpawn(
      deps,
      baseInput({
        request: {
          selection: { kind: 'agent', agent: 'claude' },
          prompt: 'x',
          sourceRecord: { owner: 'source-control-recipe', id: 'not-a-real-action' }
        }
      })
    )
    expect(result).toEqual({ ok: false, requestError: { code: 'untrusted_reference' } })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('leaves perLaunchArgs unset for a non-recipe sourceRecord (U7)', async () => {
    const resolve = vi.fn((_request: ResolveAgentLaunchRequest) => ({
      ok: true as const,
      launch: makeLaunch()
    }))
    const deps = makeDeps(resolve)
    await resolveAgentLaunchSpawn(
      deps,
      baseInput({
        request: {
          selection: { kind: 'agent', agent: 'claude' },
          prompt: 'x',
          sourceRecord: { owner: 'quick-command', id: 'qc-1' }
        }
      })
    )
    expect('perLaunchArgs' in resolve.mock.calls[0]![0]).toBe(false)
  })

  it('derives live-selection reference for a bare agent selection', async () => {
    const resolve = vi.fn((_request: ResolveAgentLaunchRequest) => ({
      ok: true as const,
      launch: makeLaunch()
    }))
    const deps = makeDeps(resolve)
    await resolveAgentLaunchSpawn(deps, baseInput())
    expect(resolve.mock.calls[0]![0].reference).toEqual({ kind: 'live-selection' })
  })

  it('derives a persisted owner reference from a validated source record', async () => {
    const resolve = vi.fn((_request: ResolveAgentLaunchRequest) => ({
      ok: true as const,
      launch: makeLaunch()
    }))
    const deps = makeDeps(resolve)
    await resolveAgentLaunchSpawn(
      deps,
      baseInput({
        request: {
          selection: { kind: 'agent', agent: 'claude' },
          prompt: 'x',
          sourceRecord: { owner: 'session', id: 's-1' }
        }
      })
    )
    expect(resolve.mock.calls[0]![0].reference).toEqual({ kind: 'persisted', owner: 'session' })
  })

  it('propagates a typed resolution failure without a plan', async () => {
    const resolve = vi.fn((_request: ResolveAgentLaunchRequest) => ({
      ok: false as const,
      failure: { code: 'base_agent_unavailable' as const, baseAgent: 'claude' as const }
    }))
    const deps = makeDeps(resolve)
    const result = await resolveAgentLaunchSpawn(deps, baseInput())
    expect(result).toEqual({
      ok: false,
      failure: { code: 'base_agent_unavailable', baseAgent: 'claude' }
    })
  })
})

// M-1 / plan §1364: Source Control AI runs the same custom-agent launch for a
// GitHub, a GitLab, and a generic (non-GitHub/GitLab) review fixture. The
// provider adapter supplies task text/URL (commandInputTemplate); it must not
// reinterpret the agent id or assemble its command — recipe resolution reads
// only agentArgs, so the launch is provider-neutral by construction.
describe('Source Control AI custom-agent launch is provider-neutral (M-1, §1364)', () => {
  const REVIEW_ACTION = 'resolveComments'
  const CUSTOM: CustomTuiAgentId = customId('claude', '00000000-0000-4000-8000-0000000000c1')

  const PROVIDER_FIXTURES = [
    { name: 'GitHub', template: 'GitHub PR review: https://github.com/acme/app/pull/12' },
    {
      name: 'GitLab',
      template: 'GitLab MR review: https://gitlab.com/acme/app/-/merge_requests/34'
    },
    {
      name: 'Gitea (generic non-GitHub/GitLab)',
      template: 'Gitea review: https://gitea.example.com/acme/app/pulls/7'
    }
  ] as const

  // Each provider configures the SAME custom-agent recipe args on the review
  // action but a DIFFERENT provider task-text template. Returns the resolver
  // request the host assembled.
  async function resolvedRequestFor(template: string): Promise<ResolveAgentLaunchRequest> {
    const resolve = vi.fn((_request: ResolveAgentLaunchRequest) => ({
      ok: true as const,
      launch: makeLaunch()
    }))
    const deps = makeDeps(resolve)
    await resolveAgentLaunchSpawn(
      deps,
      baseInput({
        request: {
          selection: { kind: 'agent', agent: CUSTOM },
          prompt: 'x',
          sourceRecord: { owner: 'source-control-recipe', id: REVIEW_ACTION }
        },
        recipeRepo: {
          sourceControlAi: {
            actionOverrides: {
              [REVIEW_ACTION]: { agentArgs: '--review one', commandInputTemplate: template }
            }
          }
        }
      })
    )
    return resolve.mock.calls[0]![0]
  }

  for (const fixture of PROVIDER_FIXTURES) {
    it(`${fixture.name}: threads the identical recipe args and preserves the custom agent id`, async () => {
      const request = await resolvedRequestFor(fixture.template)
      expect(request.perLaunchArgs).toBe('--review one')
      expect(request.selection).toEqual({ kind: 'agent', agent: CUSTOM })
      expect(request.reference).toEqual({ kind: 'persisted', owner: 'source-control-recipe' })
      // The provider's task text/URL never enters the resolved launch args.
      expect(request.perLaunchArgs).not.toMatch(/https?:|github|gitlab|gitea/i)
    })
  }

  it('all three providers resolve byte-identical launch args and agent identity', async () => {
    const [gh, gl, generic] = await Promise.all(
      PROVIDER_FIXTURES.map((fixture) => resolvedRequestFor(fixture.template))
    )
    expect(gh.perLaunchArgs).toBe(gl.perLaunchArgs)
    expect(gl.perLaunchArgs).toBe(generic.perLaunchArgs)
    expect(gh.selection).toEqual(generic.selection)
    expect(gh.reference).toEqual(generic.reference)
  })
})
