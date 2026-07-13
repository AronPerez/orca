import { useAppStore } from '@/store'
import type {
  LaunchAgentBackgroundSessionArgs,
  LaunchAgentBackgroundSessionResult
} from '@/lib/agent-background-session-contract'
import { scheduleAgentBackgroundDraft } from '@/lib/agent-background-draft-delivery'
import { AgentLaunchSpawnOutcomeError } from '@/lib/agent-launch-spawn-outcome-error'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { resolveTuiAgentConfig } from '../../../shared/custom-tui-agents'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  registerEagerPtyBuffer,
  subscribeToPtyExit,
  type EagerPtyHandle
} from '@/components/terminal-pane/pty-dispatcher'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { retireProvider, retireUnownedTerminal } from '@/lib/retire-unowned-background-terminal'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  subscribeToRuntimeTerminalData,
  toRemoteRuntimePtyId
} from '@/runtime/runtime-terminal-stream'
import type {
  RuntimeTerminalCreate,
  RuntimeTerminalCreateAgentLaunchFailure
} from '../../../shared/runtime-types'
import type { AgentLaunchSpawnRequest } from '../../../shared/agent-launch-spawn-request'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import { isMainTerminalSideEffectAuthorityForPty } from '@/components/terminal-pane/terminal-side-effect-facts-handler'
import { runBestEffortAgentBackgroundCleanups } from '@/lib/agent-background-session-cleanup'
import { bindAutomationTerminal } from '@/lib/automation-terminal-ownership'
import { createBackgroundAgentStatusConsumer } from '@/lib/background-agent-status-consumer'

export async function launchAgentBackgroundSession(
  args: LaunchAgentBackgroundSessionArgs
): Promise<LaunchAgentBackgroundSessionResult | null> {
  const { agent, worktreeId, prompt, launchSource, title, onData, onExit, onAgentStatus } = args
  const store = useAppStore.getState()
  const worktree = store.allWorktrees().find((entry) => entry.id === worktreeId)
  const repo = worktree ? store.repos.find((entry) => entry.id === worktree.repoId) : null
  if (!worktree) {
    throw new Error('The target workspace is no longer available.')
  }
  // Why: a custom id inherits its base harness's trust preset; resolve the base
  // from the requested id before reading the built-in-only config so a
  // custom-based agent still pre-marks trust and a tombstoned id degrades.
  const preflight = resolveTuiAgentConfig(
    agent,
    store.settings?.customTuiAgents,
    store.settings?.deletedCustomTuiAgents
  )?.preflightTrust
  if (preflight && worktree.path && window.api.agentTrust?.markTrusted) {
    try {
      await window.api.agentTrust.markTrusted({
        preset: preflight,
        workspacePath: worktree.path
      })
    } catch {
      // Best-effort: continue with launch. The user can still accept the trust menu.
    }
  }
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  // Why (U3): the host resolves the requested identity, folds the prompt into the
  // launch command per the resolved base agent's injection mode, and mints the
  // launch token. The client sends identity + prompt only — never a command,
  // launch config, agent env, or the token.
  const agentLaunch: AgentLaunchSpawnRequest = {
    selection: { kind: 'agent', agent },
    prompt: trimmedPrompt,
    ...(hasPrompt ? {} : { allowEmptyPromptLaunch: true })
  }

  // Why: automation runs should start without revealing the workspace.
  // Spawn the PTY immediately, then attach an inactive tab to the live session.
  const tab = store.createTab(worktreeId, undefined, undefined, {
    activate: false,
    recordInteraction: false
  })
  // Why: agent hook callbacks are keyed by pane, and background automation
  // tabs never mount a TerminalPane to inject this env for us. createBrowserUuid
  // (not crypto.randomUUID) because the latter is undefined in non-secure
  // browser contexts — the LAN web client served over plain HTTP.
  const leafId = createBrowserUuid()
  const paneKey = makePaneKey(tab.id, leafId)
  // Why: `title` labels the tab/worktree entry. Pane titles render as an
  // in-terminal title row, so background sessions must not persist it there.
  store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId))
  // Why (contract B): structural pane-identity env is renderer-owned context —
  // the renderer creates the pane. ORCA_AGENT_LAUNCH_TOKEN is NOT sent; the host
  // injects it from the admission-minted receipt token.
  const paneEnv = {
    ORCA_PANE_KEY: paneKey,
    ORCA_TAB_ID: tab.id,
    ORCA_WORKTREE_ID: worktreeId
  }
  const sshConnectionId = repo?.connectionId ?? null
  // Route by the worktree's owner host, not the focused runtime.
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(store, worktreeId)
  )
  let ptyId = ''
  let runtimeTerminalHandle: string | null = null
  let exitHandled = false
  let eagerPtyBuffer: EagerPtyHandle | null = null
  let terminalOwnership: ReturnType<typeof bindAutomationTerminal> = null
  // Why: the launch token is not known until the host returns the receipt, so
  // capture it (and the resolved launch config) post-spawn for store bookkeeping.
  let launchToken: string | null = null
  let resolvedLaunchConfig: SleepingAgentLaunchConfig | undefined
  // Why: the host returns a followup prompt only when it resolved a stdin-after-
  // start base agent (the prompt cannot fold into the launch command). Capture
  // it locally so the readiness-gated paste writer delivers it after mount; the
  // runtime path delivers its own followup, so this stays local-branch only.
  let localFollowupPrompt: string | null = null
  let unsubscribeExit = (): void => {},
    unsubscribeData = (): void => {}
  const handleExit = (exitPtyId: string, code: number): void => {
    if (exitHandled) {
      return
    }
    exitHandled = true
    unsubscribeExit()
    unsubscribeData()
    useAppStore.getState().clearTabPtyId(tab.id, exitPtyId)
    useAppStore.getState().clearAgentLaunchConfig(paneKey)
    onExit?.(exitPtyId, code)
  }
  // Why: local/SSH status facts already pass through main's authoritative
  // scanner; remote-runtime bytes still need this renderer-side store write.
  const mainOwnsAgentStatusWrites = isMainTerminalSideEffectAuthorityForPty({
    settings: store.settings,
    runtimeEnvironmentId: runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null
  })
  const agentStatusConsumer = createBackgroundAgentStatusConsumer({
    paneKey,
    getLaunchToken: () => launchToken,
    mainOwnsAgentStatusWrites,
    expectedConnectionId: repo ? (repo.connectionId ?? null) : undefined,
    runtimeEnvironmentId: runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null,
    getPtyId: () => ptyId,
    onAgentStatus
  })
  const handleData = (data: string): void => {
    onData?.(data)
    agentStatusConsumer.consume(data)
  }
  try {
    if (runtimeTarget.kind === 'environment') {
      // Why: runtime environments execute on the server; using local pty.spawn
      // would silently run automation on the client for a remote workspace.
      const created = await callRuntimeRpc<
        { terminal: RuntimeTerminalCreate } | RuntimeTerminalCreateAgentLaunchFailure
      >(
        runtimeTarget,
        'terminal.create',
        {
          worktree: toRuntimeWorktreeSelector(worktreeId),
          agentLaunch,
          env: paneEnv,
          title,
          tabId: tab.id,
          leafId,
          // Why: local renderer owns the hidden tab; remote runtime should not reveal UI.
          presentation: 'background'
        },
        { timeoutMs: 15_000 }
      )
      // Why: a pre-spawn host failure/rejection created no terminal — throw the
      // typed outcome (structured failure for the owner record + the localized
      // message) and let the catch retire the hidden tab.
      if (!('terminal' in created)) {
        throw new AgentLaunchSpawnOutcomeError(created.agentLaunch)
      }
      const terminal = created.terminal
      // Why: the runtime terminal-create result is receipt-only (never echoes the
      // resolved launch config); pane identity/attribution rides the receipt token
      // and the status stream, so there is no client config to register here.
      launchToken = terminal.agentLaunch?.receipt.launchToken ?? null
      runtimeTerminalHandle = terminal.handle
      ptyId = toRemoteRuntimePtyId(runtimeTerminalHandle, runtimeTarget.environmentId)
    } else {
      const result = await window.api.pty.spawn({
        cols: 120,
        rows: 40,
        cwd: worktree.path,
        agentLaunch,
        env: paneEnv,
        connectionId: sshConnectionId,
        worktreeId,
        tabId: tab.id,
        leafId,
        // Host overwrites agent_kind from the resolved receipt before the emit,
        // so this host-resolved launch threads only the surface-owned fields.
        telemetry: {
          launch_source: launchSource ?? 'unknown',
          request_kind: 'new'
        }
      })
      // Why: a pre-spawn host failure/rejection has no `id` — throw the typed
      // outcome (structured failure for the owner record + the localized
      // message) and let the catch retire the hidden tab.
      if (!('id' in result)) {
        throw new AgentLaunchSpawnOutcomeError(result.agentLaunch)
      }
      ptyId = result.id
      launchToken =
        result.agentLaunch?.status === 'launched' ? result.agentLaunch.receipt.launchToken : null
      resolvedLaunchConfig = result.launchConfig
      localFollowupPrompt = result.followupPrompt ?? null
    }
    if (
      await retireUnownedTerminal({
        tabId: tab.id,
        ptyId,
        runtimeTarget,
        runtimeTerminalHandle,
        onRetire: () => {
          exitHandled = true
          store.clearAgentLaunchConfig(paneKey)
        }
      })
    ) {
      return null
    }
    if (resolvedLaunchConfig && launchToken) {
      store.registerAgentLaunchConfig(paneKey, resolvedLaunchConfig, {
        agentType: agent,
        launchToken,
        tabId: tab.id,
        leafId
      })
    }
    terminalOwnership = bindAutomationTerminal(tab, paneKey, ptyId, runtimeTarget.kind, title)
    if (agent === 'command-code' && hasPrompt) {
      // Why: Command Code does not expose a prompt-start hook; seed working for
      // hidden prompt launches so sidebar/activity surfaces do not stay idle.
      const routing = agentStatusConsumer.resolveRouting()
      if (routing) {
        store.setAgentStatus(
          paneKey,
          { state: 'working', prompt: trimmedPrompt, agentType: agent },
          undefined,
          undefined,
          routing,
          {
            ...(resolvedLaunchConfig ? { launchConfig: resolvedLaunchConfig } : {}),
            ...(launchToken ? { launchToken } : {})
          }
        )
      }
    }

    if (runtimeTarget.kind === 'environment') {
      if (!runtimeTerminalHandle) {
        throw new Error('Runtime terminal id is invalid.')
      }
      unsubscribeData = await subscribeToRuntimeTerminalData(
        store.settings,
        ptyId,
        `desktop:background:${tab.id}`,
        handleData
      )
      void callRuntimeRpc<{ wait: { exitCode?: number | null } }>(
        runtimeTarget,
        'terminal.wait',
        { terminal: runtimeTerminalHandle, for: 'exit' },
        { timeoutMs: 24 * 60 * 60 * 1000 }
      )
        .then((result) => handleExit(ptyId, result.wait.exitCode ?? 0))
        .catch(() => {})
    } else {
      eagerPtyBuffer = registerEagerPtyBuffer(ptyId, handleExit)
      unsubscribeData = subscribeToPtyData(ptyId, handleData)
      // Why: opening the workspace attaches a real terminal transport and disposes
      // the eager exit handler. This sidecar keeps automation completion tracking
      // alive regardless of whether the tab is hidden or mounted.
      unsubscribeExit = subscribeToPtyExit(ptyId, (code) => handleExit(ptyId, code))
    }

    // Why: bind the explicit PTY and ownership before mount; an earlier mount
    // can double-spawn, while later tracking can miss user takeover.
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tab.id] })

    if (localFollowupPrompt) {
      // Why: stdin-after-start agents (aider) receive the prompt as a post-ready
      // bracketed paste + submit, since it could not fold into the launch command.
      scheduleAgentBackgroundDraft(tab.id, localFollowupPrompt, agent)
    }

    return { tabId: tab.id, paneKey, ptyId, terminalOwnership }
  } catch (error) {
    // Why: terminal creation and stream subscription are separate remote calls.
    // A failure between them must not strand an invisible runtime terminal.
    exitHandled = true
    terminalOwnership?.release()
    runBestEffortAgentBackgroundCleanups(unsubscribeExit, unsubscribeData)
    runBestEffortAgentBackgroundCleanups(() => eagerPtyBuffer?.dispose())
    runBestEffortAgentBackgroundCleanups(() => store.clearTabPtyId(tab.id, ptyId))
    runBestEffortAgentBackgroundCleanups(() => store.clearAgentLaunchConfig(paneKey))
    if (ptyId) {
      await retireProvider({ ptyId, runtimeTarget, runtimeTerminalHandle })
    }
    // Why: a launch-failure cleanup close is not a user close — keep it out of
    // the Cmd+Shift+T reopen stack.
    runBestEffortAgentBackgroundCleanups(() =>
      store.closeTab(tab.id, { recordInteraction: false, reason: 'cleanup' })
    )
    throw error
  }
}
