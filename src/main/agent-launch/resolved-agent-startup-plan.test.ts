import { describe, expect, it } from 'vitest'
import { resolveAgentLaunch } from './resolve-agent-launch'
import {
  catalogOf,
  customAgent,
  customId,
  requestOf,
  settingsOf
} from './agent-launch-test-catalog'
import { buildAgentStartupPlanFromResolvedLaunch } from '../../shared/resolved-agent-startup-plan'
import { STARTUP_COMMAND_TEXT_MAX_CHARS } from '../providers/windows-shell-args'
import type { ResolvedAgentLaunch } from '../../shared/agent-launch-host-contract'

function resolvedLaunch(
  overrides: Parameters<typeof requestOf>[0] extends infer _ ? Record<string, unknown> : never = {}
): ResolvedAgentLaunch {
  const outcome = resolveAgentLaunch(
    requestOf({
      selection: {
        kind: 'agent',
        agent: (overrides.agent as ResolvedAgentLaunch['requestedAgent']) ?? 'codex'
      },
      ...(overrides.request as object)
    }),
    (overrides.catalog as ReturnType<typeof catalogOf>) ?? catalogOf({}),
    // Explicit empty args: an absent key falls back to the shipped YOLO
    // defaults, which would clutter the exact-argv assertions below.
    settingsOf({
      agentDefaultArgs: {
        codex: '',
        grok: '',
        gemini: '',
        opencode: '',
        copilot: '',
        autohand: '',
        kiro: '',
        claude: '',
        pi: '',
        hermes: ''
      }
    })
  )
  if (!outcome.ok || !('launch' in outcome)) {
    throw new Error('fixture launch failed to resolve')
  }
  return outcome.launch
}

describe('buildAgentStartupPlanFromResolvedLaunch', () => {
  it('appends an argv prompt once and quotes each element for the target shell', () => {
    const launch = resolvedLaunch()
    const plan = buildAgentStartupPlanFromResolvedLaunch({ launch, prompt: 'fix the tests' })
    expect(plan?.launchCommand).toBe(`'codex' 'fix the tests'`)
    expect(plan?.followupPrompt).toBeNull()
    // The immutable snapshot argv is never extended by the prompt.
    expect(launch.snapshot.argv).toEqual(['codex'])
    expect(plan?.startupCommandDelivery).toBe('shell-ready')
  })

  it('keeps grok option termination before a flag-shaped prompt', () => {
    const launch = resolvedLaunch({ agent: 'grok' })
    const plan = buildAgentStartupPlanFromResolvedLaunch({ launch, prompt: '--version' })
    expect(plan?.launchCommand).toBe(`'grok' '--' '--version'`)
  })

  it('uses the flag modes from resolved policy, not a config re-read', () => {
    const opencode = buildAgentStartupPlanFromResolvedLaunch({
      launch: resolvedLaunch({ agent: 'opencode' }),
      prompt: 'p'
    })
    expect(opencode?.launchCommand).toBe(`'opencode' '--prompt' 'p'`)
    const gemini = buildAgentStartupPlanFromResolvedLaunch({
      launch: resolvedLaunch({ agent: 'gemini' }),
      prompt: 'p'
    })
    expect(gemini?.launchCommand).toBe(`'gemini' '--prompt-interactive' 'p'`)
    const copilot = buildAgentStartupPlanFromResolvedLaunch({
      launch: resolvedLaunch({ agent: 'copilot' }),
      prompt: 'p'
    })
    expect(copilot?.launchCommand).toBe(`'copilot' '-i' 'p'`)
  })

  it('routes stdin-after-start agents through the followup writer with a bare TUI launch', () => {
    const launch = resolvedLaunch({ agent: 'autohand' })
    const plan = buildAgentStartupPlanFromResolvedLaunch({ launch, prompt: 'do the thing' })
    expect(plan?.launchCommand).toBe(`'autohand'`)
    expect(plan?.followupPrompt).toBe('do the thing')
  })

  it('preserves fixed catalog subcommands in the quoted command', () => {
    const launch = resolvedLaunch({ agent: 'kiro' })
    const plan = buildAgentStartupPlanFromResolvedLaunch({
      launch,
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    expect(plan?.launchCommand).toBe(`'kiro-cli' 'chat' '--tui'`)
  })

  it('carries custom argv and admitted env without reparsing', () => {
    const id = customId('codex')
    const launch = resolvedLaunch({
      agent: id,
      catalog: catalogOf({
        customTuiAgents: [
          customAgent({
            id,
            baseAgent: 'codex',
            label: 'Mine',
            commandOverride: '/opt/my tools/codex',
            args: '--model x',
            env: { API_KEY: 'v' }
          })
        ]
      })
    })
    const plan = buildAgentStartupPlanFromResolvedLaunch({ launch, prompt: 'go' })
    expect(plan?.launchCommand).toBe(`'/opt/my tools/codex' '--model' 'x' 'go'`)
    expect(plan?.env).toEqual({ API_KEY: 'v' })
    expect(plan?.launchConfig.agentEnv).toEqual({ API_KEY: 'v' })
  })

  it('returns null for an empty prompt unless the surface allows a bare TUI', () => {
    const launch = resolvedLaunch()
    expect(buildAgentStartupPlanFromResolvedLaunch({ launch, prompt: '  ' })).toBeNull()
    expect(
      buildAgentStartupPlanFromResolvedLaunch({
        launch,
        prompt: '',
        allowEmptyPromptLaunch: true
      })?.launchCommand
    ).toBe(`'codex'`)
  })

  it('keeps a cmd-encodable argv prompt inline on a cmd target', () => {
    const launch = resolvedLaunch({
      request: { platform: 'win32', shell: 'cmd', targetHomePath: 'C:\\Users\\me' }
    })
    const plan = buildAgentStartupPlanFromResolvedLaunch({ launch, prompt: 'fix the tests' })
    expect(plan?.launchCommand).toBe(`"codex" "fix the tests"`)
    expect(plan?.followupPrompt).toBeNull()
  })

  it('routes a cmd-unencodable prompt through the readiness writer, never argv', () => {
    const launch = resolvedLaunch({
      request: { platform: 'win32', shell: 'cmd', targetHomePath: 'C:\\Users\\me' }
    })
    // An embedded double quote would re-split the cmd line and execute the rest.
    const prompt = 'say "hi" && del C:\\Windows'
    const plan = buildAgentStartupPlanFromResolvedLaunch({ launch, prompt })
    expect(plan?.launchCommand).toBe(`"codex"`)
    expect(plan?.followupPrompt).toBe(prompt)
  })

  it('routes a cmd-unencodable draft prompt to the unsubmitted paste path', () => {
    const launch = resolvedLaunch({
      agent: 'claude',
      request: { platform: 'win32', shell: 'cmd', targetHomePath: 'C:\\Users\\me' }
    })
    const plan = buildAgentStartupPlanFromResolvedLaunch({
      launch,
      prompt: 'coverage is 100% done',
      promptDelivery: 'draft'
    })
    expect(plan?.launchCommand).toBe(`"claude"`)
    expect(plan?.launchCommand).not.toContain('--prefill')
    expect(plan?.draftPrompt).toBe('coverage is 100% done')
  })

  it('doubles smart quotes when quoting an argv prompt for a powershell target', () => {
    const launch = resolvedLaunch({
      request: { platform: 'win32', shell: 'powershell', targetHomePath: 'C:\\Users\\me' }
    })
    const plan = buildAgentStartupPlanFromResolvedLaunch({ launch, prompt: 'fix Bob’s tests' })
    expect(plan?.launchCommand).toBe(`& 'codex' 'fix Bob’’s tests'`)
  })

  describe('hermes native startup query', () => {
    it('delivers the prompt via the startup-query env, never the paste writer', () => {
      const launch = resolvedLaunch({ agent: 'hermes' })
      const plan = buildAgentStartupPlanFromResolvedLaunch({ launch, prompt: 'audit the repo' })
      expect(plan?.launchCommand.startsWith(`sh -c '`)).toBe(true)
      expect(plan?.launchCommand).toContain('ORCA_HERMES_STARTUP_QUERY')
      expect(plan?.env).toEqual({ ORCA_HERMES_STARTUP_QUERY: 'audit the repo' })
      expect(plan?.followupPrompt).toBeNull()
      expect(plan?.draftPrompt).toBeUndefined()
      // The durable relaunch config stays a bare TUI launch without the
      // query wrapper or transport env.
      expect(plan?.launchConfig.agentCommand).toBe(`'hermes' '--tui'`)
      expect(plan?.launchConfig.agentEnv).not.toHaveProperty('ORCA_HERMES_STARTUP_QUERY')
    })

    it('wraps the Windows query in an encoded powershell invocation', () => {
      const launch = resolvedLaunch({
        agent: 'hermes',
        request: { platform: 'win32', shell: 'powershell', targetHomePath: 'C:\\Users\\me' }
      })
      const plan = buildAgentStartupPlanFromResolvedLaunch({ launch, prompt: 'audit the repo' })
      expect(plan?.launchCommand.startsWith('powershell.exe -NoProfile -EncodedCommand ')).toBe(
        true
      )
      expect(plan?.env).toEqual({ ORCA_HERMES_STARTUP_QUERY: 'audit the repo' })
    })

    it('carries the query env and wrapper on an SSH remote launch', () => {
      const launch = resolvedLaunch({
        agent: 'hermes',
        request: { isRemote: true, targetHomePath: null }
      })
      const plan = buildAgentStartupPlanFromResolvedLaunch({ launch, prompt: 'remote audit' })
      expect(plan?.launchCommand.startsWith(`sh -c '`)).toBe(true)
      expect(plan?.env).toEqual({ ORCA_HERMES_STARTUP_QUERY: 'remote audit' })
      expect(plan?.followupPrompt).toBeNull()
    })

    it('falls back to the readiness paste when the query exceeds the env bound', () => {
      const launch = resolvedLaunch({ agent: 'hermes' })
      const bigPrompt = 'x'.repeat(25_000)
      const plan = buildAgentStartupPlanFromResolvedLaunch({ launch, prompt: bigPrompt })
      expect(plan?.launchCommand).toBe(`'hermes' '--tui'`)
      expect(plan?.followupPrompt).toBe(bigPrompt)
      expect(plan?.env).toBeUndefined()
    })

    it('leaves draft delivery on the unsubmitted paste path', () => {
      const launch = resolvedLaunch({ agent: 'hermes' })
      const plan = buildAgentStartupPlanFromResolvedLaunch({
        launch,
        prompt: 'draft me',
        promptDelivery: 'draft'
      })
      expect(plan?.launchCommand).toBe(`'hermes' '--tui'`)
      expect(plan?.draftPrompt).toBe('draft me')
      expect(plan?.env).toBeUndefined()
    })
  })

  describe('draft prompt delivery', () => {
    it('appends the native draft flag inline and delivers nothing post-ready', () => {
      const launch = resolvedLaunch({ agent: 'claude' })
      const plan = buildAgentStartupPlanFromResolvedLaunch({
        launch,
        prompt: 'wire the handler',
        promptDelivery: 'draft'
      })
      expect(plan?.launchCommand).toBe(`'claude' '--prefill' 'wire the handler'`)
      expect(plan?.draftPrompt).toBeUndefined()
      expect(plan?.followupPrompt).toBeNull()
    })

    it('sets the draft env var in spawn env only, never the durable snapshot', () => {
      const launch = resolvedLaunch({ agent: 'pi' })
      const plan = buildAgentStartupPlanFromResolvedLaunch({
        launch,
        prompt: 'do it',
        promptDelivery: 'draft'
      })
      expect(plan?.launchCommand).toBe(`'pi'; unset ORCA_PI_PREFILL`)
      expect(plan?.env).toEqual({ ORCA_PI_PREFILL: 'do it' })
      expect(plan?.launchConfig.agentEnv).not.toHaveProperty('ORCA_PI_PREFILL')
      expect(plan?.draftPrompt).toBeUndefined()
    })

    it('returns the draft for post-ready paste when the agent has no native affordance', () => {
      const launch = resolvedLaunch({ agent: 'codex' })
      const plan = buildAgentStartupPlanFromResolvedLaunch({
        launch,
        prompt: 'draft me',
        promptDelivery: 'draft'
      })
      expect(plan?.launchCommand).toBe(`'codex'`)
      expect(plan?.draftPrompt).toBe('draft me')
      expect(plan?.followupPrompt).toBeNull()
    })

    it('falls back to post-ready paste with the FULL text for an oversized inline draft', () => {
      const launch = resolvedLaunch({ agent: 'claude' })
      const bigDraft = 'x'.repeat(STARTUP_COMMAND_TEXT_MAX_CHARS + 100)
      const plan = buildAgentStartupPlanFromResolvedLaunch({
        launch,
        prompt: bigDraft,
        promptDelivery: 'draft',
        maxInlineDraftChars: STARTUP_COMMAND_TEXT_MAX_CHARS
      })
      expect(plan?.launchCommand).toBe(`'claude'`)
      expect(plan?.launchCommand).not.toContain('--prefill')
      expect(plan?.draftPrompt).toBe(bigDraft)
    })

    it('falls back to paste for an env-var draft over the win32 env-block ceiling', () => {
      const launch = resolvedLaunch({
        agent: 'pi',
        request: { platform: 'win32', shell: 'powershell', targetHomePath: 'C:\\Users\\me' }
      })
      const bigDraft = 'x'.repeat(24_001)
      const plan = buildAgentStartupPlanFromResolvedLaunch({
        launch,
        prompt: bigDraft,
        promptDelivery: 'draft'
      })
      expect(plan?.launchCommand).toBe(`& 'pi'`)
      expect(plan?.draftPrompt).toBe(bigDraft)
      expect(plan?.env).toBeUndefined()
    })

    it('still inlines a small env-var draft on win32', () => {
      const launch = resolvedLaunch({
        agent: 'pi',
        request: { platform: 'win32', shell: 'powershell', targetHomePath: 'C:\\Users\\me' }
      })
      const plan = buildAgentStartupPlanFromResolvedLaunch({
        launch,
        prompt: 'do it',
        promptDelivery: 'draft'
      })
      expect(plan?.launchCommand).toBe(
        `& 'pi'; Remove-Item Env:ORCA_PI_PREFILL -ErrorAction SilentlyContinue`
      )
      expect(plan?.env).toEqual({ ORCA_PI_PREFILL: 'do it' })
      expect(plan?.draftPrompt).toBeUndefined()
    })

    it('leaves submit mode unchanged (native draft flag not applied)', () => {
      const launch = resolvedLaunch({ agent: 'claude' })
      const submitted = buildAgentStartupPlanFromResolvedLaunch({
        launch,
        prompt: 'ship it',
        promptDelivery: 'submit'
      })
      expect(submitted?.launchCommand).toBe(`'claude' 'ship it'`)
      expect(submitted?.draftPrompt).toBeUndefined()
    })
  })
})
