import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcSuccess } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'
import type {
  CreatedRuntimeWorktreeCreateResult,
  RuntimeWorktreeCreateResult
} from '../../shared/runtime-types'
import { buildWorktree } from '../test-fixtures'
import {
  getWorktreeCreateAgentLaunch,
  handleWorktreeCreatePreRejection,
  printWorktreeCreateResult,
  type AgentLaunchSource
} from './worktree-create-agent-launch'

type Flags = Map<string, string | boolean>

function flags(entries: Record<string, string | boolean>): Flags {
  return new Map(Object.entries(entries))
}

function envelope(
  result: RuntimeWorktreeCreateResult
): RuntimeRpcSuccess<RuntimeWorktreeCreateResult> {
  return { id: 'req_create', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function createdWorktree(
  agentLaunchResult?: CreatedRuntimeWorktreeCreateResult['agentLaunchResult']
): CreatedRuntimeWorktreeCreateResult {
  return {
    worktree: buildWorktree(
      '/tmp/repo/feature',
      'feature',
      'abc',
      'repo-1'
    ) as unknown as CreatedRuntimeWorktreeCreateResult['worktree'],
    lineage: null,
    warnings: [],
    ...(agentLaunchResult ? { agentLaunchResult } : {})
  }
}

const LAUNCHED = {
  status: 'launched' as const,
  receipt: {
    requestedAgent: 'codex' as const,
    baseAgent: 'codex' as const,
    notices: [],
    launchToken: 'tok-1',
    catalogRevision: 1,
    telemetry: { agentKind: 'codex' as const, usedCustomAgent: false }
  }
}

beforeEach(() => {
  process.exitCode = 0
})

afterEach(() => {
  process.exitCode = 0
  vi.restoreAllMocks()
})

describe('getWorktreeCreateAgentLaunch', () => {
  it('maps --agent <id> to an explicit agent selection carrying the prompt', () => {
    const launch = getWorktreeCreateAgentLaunch(flags({ agent: 'codex', prompt: 'do it' }))
    expect(launch).toEqual({
      request: {
        selection: { kind: 'agent', agent: 'codex' },
        allowEmptyPromptLaunch: true,
        prompt: 'do it'
      },
      source: { via: 'flag', id: 'codex' }
    })
  })

  it('maps a bare --agent to the stored default selection', () => {
    const launch = getWorktreeCreateAgentLaunch(flags({ agent: true }))
    expect(launch).toEqual({
      request: { selection: { kind: 'default' }, allowEmptyPromptLaunch: true },
      source: { via: 'default' }
    })
  })

  it('returns undefined when no agent is requested', () => {
    expect(getWorktreeCreateAgentLaunch(flags({ name: 'feature' }))).toBeUndefined()
  })

  it('rejects --prompt without --agent before any RPC', () => {
    expect(() => getWorktreeCreateAgentLaunch(flags({ prompt: 'hi' }))).toThrow(
      '--prompt requires --agent'
    )
  })

  it('rejects a valueless --prompt', () => {
    expect(() => getWorktreeCreateAgentLaunch(flags({ agent: 'codex', prompt: true }))).toThrow(
      'Missing value for --prompt'
    )
  })

  it('keeps an explicit empty --prompt as an empty draft', () => {
    const launch = getWorktreeCreateAgentLaunch(flags({ agent: 'codex', prompt: '' }))
    expect(launch?.request).toEqual({
      selection: { kind: 'agent', agent: 'codex' },
      allowEmptyPromptLaunch: true,
      prompt: ''
    })
  })

  it('rejects a malformed agent id as invalid_argument', () => {
    try {
      getWorktreeCreateAgentLaunch(flags({ agent: 'not a real agent!!' }))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeClientError)
      expect((error as RuntimeClientError).code).toBe('invalid_argument')
    }
  })
})

const FLAG_SOURCE: AgentLaunchSource = { via: 'flag', id: 'ghost' }
const DEFAULT_SOURCE: AgentLaunchSource = { via: 'default' }

describe('handleWorktreeCreatePreRejection', () => {
  it('returns the created arm unchanged when the worktree was created', () => {
    const created = createdWorktree(LAUNCHED)
    const result = handleWorktreeCreatePreRejection(envelope(created), FLAG_SOURCE, false)
    expect(result).toBe(created)
    expect(process.exitCode).toBe(0)
  })

  it('prints the stable code and human line to stderr and exits non-zero on a failed rejection', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = envelope({
      created: false,
      agentLaunchResult: { status: 'failed', failure: { code: 'unknown_agent' } }
    })

    const result = handleWorktreeCreatePreRejection(response, FLAG_SOURCE, false)

    expect(result).toBeNull()
    expect(errSpy.mock.calls[0][0]).toBe('unknown_agent')
    expect(errSpy.mock.calls[1][0]).toContain('ghost')
    expect(errSpy.mock.calls[1][0]).toContain('--agent')
    expect(process.exitCode).toBe(1)
  })

  it('names the stored default agent for a default-sourced rejection', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = envelope({
      created: false,
      agentLaunchResult: {
        status: 'failed',
        failure: { code: 'base_agent_disabled', baseAgent: 'codex' }
      }
    })

    handleWorktreeCreatePreRejection(response, DEFAULT_SOURCE, false)

    expect(errSpy.mock.calls[0][0]).toBe('base_agent_disabled')
    expect(errSpy.mock.calls[1][0]).toContain('stored default')
    expect(process.exitCode).toBe(1)
  })

  it('surfaces a request-error rejection code and exits non-zero', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = envelope({
      created: false,
      agentLaunchResult: { status: 'rejected', requestError: { code: 'idempotency_conflict' } }
    })

    handleWorktreeCreatePreRejection(response, FLAG_SOURCE, false)

    expect(errSpy.mock.calls[0][0]).toBe('idempotency_conflict')
    expect(process.exitCode).toBe(1)
  })

  it('prints the typed rejection envelope in JSON mode without a stderr line', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = envelope({
      created: false,
      agentLaunchResult: { status: 'failed', failure: { code: 'unknown_agent' } }
    })

    handleWorktreeCreatePreRejection(response, FLAG_SOURCE, true)

    expect(logSpy.mock.calls.flat().join('\n')).toContain('unknown_agent')
    expect(errSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})

describe('printWorktreeCreateResult', () => {
  it('prints the created worktree and leaves the exit code clean on a launched result', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const created = createdWorktree(LAUNCHED)

    printWorktreeCreateResult(envelope(created), created, FLAG_SOURCE, false)

    expect(logSpy).toHaveBeenCalled()
    expect(process.exitCode).toBe(0)
  })

  it('prints the retained worktree then the stderr contract and exits non-zero on a post-create failure', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const created = createdWorktree({
      status: 'failed',
      failure: {
        code: 'missing_variable',
        version: 1,
        failureId: 'f1',
        intent: 'cli',
        occurredAt: 0,
        variable: 'worktreePath'
      }
    })

    printWorktreeCreateResult(envelope(created), created, FLAG_SOURCE, false)

    // Stable post-create output: the retained worktree prints on stdout first.
    expect(logSpy.mock.calls.flat().join('\n')).toContain('/tmp/repo/feature')
    expect(errSpy.mock.calls[0][0]).toBe('missing_variable')
    expect(process.exitCode).toBe(1)
  })

  it('keeps the failure inside the JSON envelope without a stderr line', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const created = createdWorktree({
      status: 'failed',
      failure: {
        code: 'spawn_failed',
        version: 1,
        failureId: 'f2',
        intent: 'cli',
        occurredAt: 0
      }
    })

    printWorktreeCreateResult(envelope(created), created, FLAG_SOURCE, true)

    expect(logSpy.mock.calls.flat().join('\n')).toContain('spawn_failed')
    expect(errSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})
