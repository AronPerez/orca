// Main-side host-state provider for agent launches (U3). Given a spawn surface's
// execution descriptor (local, WSL, SSH, or runtime), it derives the fixed
// AgentLaunchSpawnTarget the resolver consumes: platform, shell, isRemote, the
// stable execution-host id, the target home path for `~` expansion, the stock
// detection snapshot, and the cross-host transport-confidentiality signal.
//
// The provider NEVER fabricates a value it cannot observe. Detection is null when
// unavailable (never an empty set standing in for "unknown"); the target home is
// null when the host has not resolved it (the resolver then fails
// missing_target_home only for `~`-prefixed values); confidentiality is undefined
// for same-host launches and conservatively false for a cross-host channel whose
// binding cannot be proven. Detection/home resolution are injected async host
// reads so this module stays electron-free and unit-testable.

import { homedir } from 'node:os'
import type { BuiltInTuiAgent, GlobalSettings } from '../../shared/types'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import type { AgentLaunchExecutionHostId } from '../../shared/agent-launch-host-contract'
import { isBuiltInTuiAgent } from '../../shared/tui-agent-config'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../shared/execution-host'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import type { AgentLaunchSpawnTarget } from './agent-launch-spawn'

/** The execution surface a launch targets. isRemote/platform/executionHostId are
 *  derived from this shape; nothing is copied from a client payload. */
export type AgentLaunchHostDescriptor =
  | { kind: 'local'; platform: NodeJS.Platform; shell?: AgentStartupShell }
  | { kind: 'wsl'; distro: string; shell?: AgentStartupShell }
  | { kind: 'ssh'; connectionId: string; platform: NodeJS.Platform; shell?: AgentStartupShell }
  | {
      kind: 'runtime'
      environmentId: string
      platform: NodeJS.Platform
      /** Runtime environments are separate hosts by default; a caller that knows
       *  the env is in-process may set false. */
      isRemote?: boolean
      shell?: AgentStartupShell
    }

/** The stable execution-host id, reusing the shared SSH/runtime encoders and this
 *  feature's `wsl:${distro}` variant (the shared ExecutionHostId grammar has no
 *  WSL arm). */
export function executionHostIdForDescriptor(
  descriptor: AgentLaunchHostDescriptor
): AgentLaunchExecutionHostId {
  switch (descriptor.kind) {
    case 'local':
      return 'local'
    case 'wsl':
      return `wsl:${encodeURIComponent(descriptor.distro)}`
    case 'ssh':
      return toSshExecutionHostId(descriptor.connectionId)
    case 'runtime':
      return toRuntimeExecutionHostId(descriptor.environmentId)
  }
}

/** WSL always executes a Linux userland; every other descriptor names its own
 *  terminal-target platform. */
export function platformForDescriptor(descriptor: AgentLaunchHostDescriptor): NodeJS.Platform {
  return descriptor.kind === 'wsl' ? 'linux' : descriptor.platform
}

/** SSH and (by default) runtime are separate hosts; local and WSL execute on this
 *  machine, matching repoIsRemote (connectionId-only) semantics. */
export function isRemoteForDescriptor(descriptor: AgentLaunchHostDescriptor): boolean {
  if (descriptor.kind === 'ssh') {
    return true
  }
  if (descriptor.kind === 'runtime') {
    return descriptor.isRemote ?? true
  }
  return false
}

/** Conservative confidentiality: same-host launches carry no cross-host transport
 *  (undefined). SSH is authenticated and confidential (true). A runtime channel's
 *  binding cannot be proven from host state alone, so env-bearing launches into it
 *  fail closed (false) unless a caller overrides with an identified binding. */
export function defaultTransportConfidentiality(
  descriptor: AgentLaunchHostDescriptor
): boolean | undefined {
  if (descriptor.kind === 'local' || descriptor.kind === 'wsl') {
    return undefined
  }
  if (descriptor.kind === 'ssh') {
    return true
  }
  return false
}

/** Filter a raw detected-agent list to the stock base agents the resolver gates
 *  on. null/undefined input means detection is unavailable and is preserved as
 *  null (unknown); an empty array is "detection ran, nothing installed" and stays
 *  an empty set — the two must not collapse. */
export function toStockBaseAgentSet(
  detected: readonly string[] | null | undefined
): ReadonlySet<BuiltInTuiAgent> | null {
  if (detected === null || detected === undefined) {
    return null
  }
  const set = new Set<BuiltInTuiAgent>()
  for (const id of detected) {
    if (isBuiltInTuiAgent(id)) {
      set.add(id)
    }
  }
  return set
}

/** Map a terminal spawn's connection + cwd to its execution-host descriptor.
 *  An SSH target (connectionId present) infers platform from the remote cwd's
 *  path shape — the same heuristic the runtime uses — because the IPC boundary
 *  has no synchronous remote-platform probe; its home/detection stay honest
 *  unknowns until a caller that can probe supplies them. A local target uses
 *  this machine's platform and Windows shell family. WSL/runtime hosts are
 *  described by callers that know the distro/env id. */
export function describeSpawnExecutionHost(args: {
  connectionId?: string | null
  cwd?: string | null
  terminalWindowsShell?: string | null
}): AgentLaunchHostDescriptor {
  if (args.connectionId) {
    return {
      kind: 'ssh',
      connectionId: args.connectionId,
      platform: args.cwd && isWindowsAbsolutePathLike(args.cwd) ? 'win32' : 'linux'
    }
  }
  const shell = resolveLocalWindowsAgentStartupShell({
    platform: process.platform,
    isRemote: false,
    terminalWindowsShell: args.terminalWindowsShell
  })
  return {
    kind: 'local',
    platform: process.platform,
    ...(shell ? { shell } : {})
  }
}

export type AgentLaunchHostStateDeps = {
  getSettings: () => GlobalSettings
  getCatalogRevision: () => number
  /** Detect stock base agents on the target's baseline PATH. Return null when
   *  detection is genuinely unavailable — never an empty list to mean unknown. */
  detectStockBaseAgents: (
    descriptor: AgentLaunchHostDescriptor
  ) => Promise<readonly string[] | null>
  /** Resolve the target host's home dir for `~` expansion, or null when the host
   *  has not resolved it (SSH before resolveHome, an unknown WSL distro $HOME). */
  resolveTargetHomePath: (descriptor: AgentLaunchHostDescriptor) => Promise<string | null>
  /** Override the default confidentiality derivation when a cross-host channel's
   *  binding is identifiable (e.g. a runtime env reached over SSH). */
  resolveTransportConfidentiality?: (descriptor: AgentLaunchHostDescriptor) => boolean | undefined
}

/** The surface-specific host state a launch resolves against: the live settings
 *  accessors and the fixed target/variables snapshot. Settings and the normalized
 *  catalog are read live per resolution by resolveAgentLaunchSpawn; the target and
 *  variables are the immutable per-surface derivation captured here. */
export type AgentLaunchHostState = {
  getSettings: () => GlobalSettings
  getCatalogRevision: () => number
  target: AgentLaunchSpawnTarget
  variables: { repoPath: string | null; worktreePath: string | null }
}

/** Derive the per-surface host state for a launch. Performs the async host reads
 *  (detection, target home) once, up front, so the boundary's synchronous
 *  re-resolution inside the admission coordinator only re-reads settings. */
export async function deriveAgentLaunchHostState(
  deps: AgentLaunchHostStateDeps,
  descriptor: AgentLaunchHostDescriptor,
  variables: { repoPath?: string | null; worktreePath?: string | null }
): Promise<AgentLaunchHostState> {
  const platform = platformForDescriptor(descriptor)
  const isRemote = isRemoteForDescriptor(descriptor)
  const executionHostId = executionHostIdForDescriptor(descriptor)
  const [detected, targetHomePath] = await Promise.all([
    deps.detectStockBaseAgents(descriptor),
    deps.resolveTargetHomePath(descriptor)
  ])
  const confidentiality = (deps.resolveTransportConfidentiality ?? defaultTransportConfidentiality)(
    descriptor
  )

  const target: AgentLaunchSpawnTarget = {
    platform,
    ...(descriptor.shell ? { shell: descriptor.shell } : {}),
    isRemote,
    executionHostId,
    targetHomePath: targetHomePath ?? null,
    detectedStockBaseAgents: toStockBaseAgentSet(detected),
    ...(confidentiality !== undefined ? { transportConfidentialityAvailable: confidentiality } : {})
  }

  return {
    getSettings: deps.getSettings,
    getCatalogRevision: deps.getCatalogRevision,
    target,
    variables: {
      repoPath: variables.repoPath ?? null,
      worktreePath: variables.worktreePath ?? null
    }
  }
}

/** Default detection resolver: detection unavailable (unknown). Callers that can
 *  run real stock detection inject their own; the honest default never claims an
 *  agent is missing. */
export const detectionUnavailable = async (): Promise<null> => null

/** Default home resolver: this machine's home dir for a local target, null
 *  otherwise (a remote/WSL home must be resolved by the host that owns it). */
export async function resolveLocalTargetHomePath(
  descriptor: AgentLaunchHostDescriptor
): Promise<string | null> {
  return descriptor.kind === 'local' ? homedir() : null
}
