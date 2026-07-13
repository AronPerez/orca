// Result assembly: build the immutable ResolvedAgentLaunch — deep-frozen
// snapshot (resolved command prefix + user argv and admitted user env only, never
// prompt/process/Orca/Agent-Teams ephemeral data), resolved policy, telemetry,
// and the host-private admission fingerprint.

import type { BuiltInTuiAgent, TuiAgent } from '../../shared/types'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import type { TuiAgentConfig } from '../../shared/tui-agent-config'
import { tuiAgentToAgentKind } from '../../shared/agent-kind'
import type { AgentLaunchIntentKind, AgentLaunchNotice } from '../../shared/agent-launch-contract'
import type {
  AgentArgv,
  AgentLaunchExecutionHostId,
  ResolvedAgentLaunch
} from '../../shared/agent-launch-host-contract'
import {
  computeAdmissionFingerprint,
  digestObject,
  type AdmissionFingerprintBasis
} from './agent-launch-fingerprint'
import type { LaunchClientKind } from './resolve-agent-env-admission'
import type { LaunchVariableName, LaunchVariableValues } from './resolve-agent-variables'

export type LaunchTarget = {
  platform: NodeJS.Platform
  execution: 'native' | 'wsl'
  shell: AgentStartupShell
  isRemote: boolean
  executionHostId: AgentLaunchExecutionHostId
}

export type BuildResolvedLaunchParams = {
  mode: 'built-in' | 'custom' | 'safe-fallback'
  requestedAgent: TuiAgent
  baseAgent: BuiltInTuiAgent
  displayLabel: string
  argv: AgentArgv
  /** Provider resume flags appended on a replay; excluded from the snapshot and
   *  durable launch config. */
  resumeArgvSuffix?: readonly string[]
  env: Record<string, string>
  envPolicy: 'full' | 'withheld' | 'none'
  referenced: readonly LaunchVariableName[]
  values: LaunchVariableValues
  notices: readonly AgentLaunchNotice[]
  target: LaunchTarget
  targetHomePath: string | null
  intentKind: AgentLaunchIntentKind
  client: LaunchClientKind
  config: TuiAgentConfig
  basis: AdmissionFingerprintBasis
  definitionDigestSource: unknown
  transportConfidential: boolean | null
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

function frozenEnv(source: Record<string, string>): Readonly<Record<string, string>> {
  const copy = Object.create(null) as Record<string, string>
  for (const key of Object.keys(source)) {
    copy[key] = source[key]
  }
  return Object.freeze(copy)
}

function dedupeNotices(notices: readonly AgentLaunchNotice[]): AgentLaunchNotice[] {
  const seen = new Set<string>()
  const result: AgentLaunchNotice[] = []
  for (const notice of notices) {
    if (!seen.has(notice.code)) {
      seen.add(notice.code)
      result.push(notice)
    }
  }
  return result
}

export function buildResolvedLaunch(params: BuildResolvedLaunchParams): ResolvedAgentLaunch {
  const { config, target } = params

  const snapshot = deepFreeze({
    version: 1 as const,
    requestedAgent: params.requestedAgent,
    baseAgent: params.baseAgent,
    displayLabel: params.displayLabel,
    mode: params.mode,
    argv: [...params.argv] as unknown as AgentArgv,
    agentEnv: frozenEnv(params.env),
    capturedEnvPolicy: params.envPolicy,
    target: {
      platform: target.platform,
      execution: target.execution,
      shell: target.shell,
      isRemote: target.isRemote,
      executionHostId: target.executionHostId
    }
  })

  const fingerprintInputs = {
    basis: params.basis,
    requestedAgent: params.requestedAgent,
    baseAgent: params.baseAgent,
    mode: params.mode,
    definitionDigest: digestObject(params.definitionDigestSource),
    baseEnabled: true,
    builtInCommandConfig:
      params.mode === 'built-in' ? digestObject(params.definitionDigestSource) : '',
    variableValues: params.values,
    remoteEnvAuthorization: params.envPolicy,
    managedProvider: '',
    target: {
      platform: target.platform,
      execution: target.execution,
      shell: target.shell,
      isRemote: target.isRemote,
      executionHostId: target.executionHostId,
      homePath: params.targetHomePath
    },
    transportConfidential: params.transportConfidential
  }
  const fingerprint = computeAdmissionFingerprint(fingerprintInputs)
  // Config-only digest for U4's two-stage worktree recheck: identical to the
  // admission fingerprint but with the volatile path variables excluded, so it
  // stays stable between pre-create identity pinning (worktree path not yet
  // authoritative) and post-create final resolution. Path availability is
  // rechecked separately at final resolution, never folded into this digest.
  const stableInputDigest = computeAdmissionFingerprint({
    ...fingerprintInputs,
    variableValues: { repoPath: null, worktreePath: null }
  })

  return {
    requestedAgent: params.requestedAgent,
    baseAgent: params.baseAgent,
    displayLabel: params.displayLabel,
    argv: snapshot.argv,
    ...(params.resumeArgvSuffix ? { resumeArgvSuffix: params.resumeArgvSuffix } : {}),
    agentEnv: snapshot.agentEnv,
    variables: {
      values: { repoPath: params.values.repoPath, worktreePath: params.values.worktreePath },
      referenced: [...params.referenced]
    },
    snapshot,
    policy: {
      intent: params.intentKind,
      mode: params.mode,
      client: params.client,
      isRemote: target.isRemote,
      platform: target.platform,
      promptInjectionMode: config.promptInjectionMode,
      expectedProcess: config.expectedProcess,
      ...(config.preflightTrust ? { preflightTrust: config.preflightTrust } : {}),
      ...(config.draftPromptFlag ? { draftPromptFlag: config.draftPromptFlag } : {}),
      ...(config.draftPromptEnvVar ? { draftPromptEnvVar: config.draftPromptEnvVar } : {}),
      ...(config.draftPasteReadySignal
        ? { draftPasteReadySignal: config.draftPasteReadySignal }
        : {}),
      env: params.envPolicy
    },
    notices: dedupeNotices(params.notices),
    telemetry: {
      agentKind: tuiAgentToAgentKind(params.baseAgent),
      usedCustomAgent: params.mode === 'custom'
    },
    admissionGuard: { fingerprint, stableInputDigest, basis: params.basis }
  }
}
