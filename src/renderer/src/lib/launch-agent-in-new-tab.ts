import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { track } from '@/lib/telemetry'
import { resolveTelemetryAgentKind } from '@/lib/telemetry-agent-kind'
import { deliverLaunchPromptToAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { launchAgentInWebHostTab } from '@/lib/launch-agent-web-host-tab'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveTuiAgentBaseAgent } from '../../../shared/custom-tui-agents'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { seedCommandCodeSubmittedPromptStatus } from '@/lib/command-code-prompt-status-seed'
import type { TuiAgent } from '../../../shared/types'
import type {
  AgentLaunchSourceRecord,
  AgentLaunchSpawnRequest
} from '../../../shared/agent-launch-spawn-request'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'
import { getConnectionIdFromState } from '@/lib/connection-context'

export type LaunchAgentInNewTabArgs = {
  agent: TuiAgent
  worktreeId: string
  /** Tab group the user launched from; keeps split-group launches in that pane instead of the active group. */
  groupId?: string
  /** Optional initial prompt; delivery depends on `promptDelivery` and the agent's prompt mode. */
  prompt?: string
  /** Host-verified saved owner (e.g. a source-control recipe) whose stored
   *  agentArgs/env the host resolves and applies to this launch. Clients send
   *  only the locator; the host owns all command/arg assembly. */
  sourceRecord?: AgentLaunchSourceRecord
  /** Optional working directory for the new terminal session. */
  initialCwd?: string | null
  /** Force generated prompt text out of the shell launch command. `draft`
   *  leaves it editable; `submit-after-ready` sends it once the TUI is ready. */
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  /** Telemetry surface that initiated this launch. Defaults to the tab-bar quick-launch entry point. */
  launchSource?: LaunchSource
  /** User-authored Quick Command label for local tabs created from the tab bar. */
  quickCommandLabel?: string | null
  /** Vestigial: the host now owns platform-dependent command assembly, so this
   *  no longer affects the client launch. Still accepted so the source-control
   *  callers that thread it need not change; retiring that threading is a
   *  follow-up cleanup. */
  launchPlatform?: NodeJS.Platform
  /** Called after the prompt is actually delivered to the agent input path. */
  onPromptDelivered?: () => void
}

export type LaunchAgentInNewTabResult = {
  tabId: string | null
  pasteDraftAfterLaunch: boolean
  promptDeliveryResult?: Promise<{ delivered: boolean; failureNotified: boolean }>
}

/**
 * Create a new terminal tab and queue the agent's launch command, optionally
 * with an initial prompt.
 *
 * Submission mode follows `promptInjectionMode`: argv/flag agents fold the
 * prompt into the launch command; followup-path agents launch empty and get a
 * post-ready draft paste. Callers can override via `promptDelivery`.
 *
 * Default submission mode follows `promptInjectionMode`: argv/flag agents
 * include the prompt directly in the launch command, while followup-path
 * agents launch empty and receive a post-ready draft paste. Generated contexts
 * can override this with draft or submit-after-ready delivery.
 *
 * The host owns command/arg/token assembly on the `agentLaunch` path, so this
 * never validates or aborts on the client: an unlaunchable request (e.g.
 * untokenizable stored args) still creates the tab and surfaces the host's
 * typed failure downstream rather than silently no-op'ing.
 */
export function launchAgentInNewTab(args: LaunchAgentInNewTabArgs): LaunchAgentInNewTabResult {
  const {
    agent,
    worktreeId,
    groupId,
    prompt,
    sourceRecord,
    initialCwd,
    promptDelivery = 'auto-submit',
    launchSource,
    quickCommandLabel,
    onPromptDelivered
  } = args
  const store = useAppStore.getState()
  const worktree = store.allWorktrees?.().find((entry: { id: string }) => entry.id === worktreeId)
  const repo = worktree ? store.repos?.find((entry) => entry.id === worktree.repoId) : null
  // Why: on a remote (SSH/relay) target the host delivers a post-ready draft
  // through its local ptyController, which never reaches the relay-hosted pty
  // (the W6-remote U10 gap). A folded draft the host defers to post-ready would
  // be silently lost there, so the draft branch below routes to a client-side
  // paste on remote instead.
  const isRemote = repo ? repoIsRemote(repo) : false
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  // Why: key the fold-vs-paste decision on the resolved BASE agent. Under
  // noImplicitAny:false a custom id would index TUI_AGENT_CONFIG as `any`,
  // reading promptInjectionMode as undefined and silently folding a
  // stdin-after-start base into argv instead of pasting after start. A custom
  // id inherits its base's injection mode; an unresolvable id is unlaunchable
  // downstream, so treat it as non-followup here.
  const baseAgent = resolveTuiAgentBaseAgent(
    agent,
    store.settings?.customTuiAgents,
    store.settings?.deletedCustomTuiAgents
  )
  const isFollowupPath =
    baseAgent !== null && TUI_AGENT_CONFIG[baseAgent].promptInjectionMode === 'stdin-after-start'
  // Why: argv/flag agents fold the prompt into the launch command and
  // auto-submit — keeping behavior consistent with the composer/tab-bar `+`
  // mental model, where the prompt is "the first turn the user sent".
  // Followup-path and generated-context launches can deliver a prompt via
  // post-launch bracketed paste; callers decide whether that paste remains a
  // draft or submits after readiness.
  // The host assembles and validates the launch; the client only decides
  // whether the prompt folds into that launch or is pasted after readiness.
  let pasteDraftAfterLaunch: string | null = null
  let submitPastedPrompt = false
  let forcePasteAfterLaunch = false
  let promptDeliveryResult: Promise<{ delivered: boolean; failureNotified: boolean }> | undefined

  if (hasPrompt && promptDelivery === 'submit-after-ready') {
    // Why: generated multi-line prompts are too large to echo through a shell
    // argv/prefill command. Launch cleanly, then paste+submit inside the TUI.
    pasteDraftAfterLaunch = trimmedPrompt
    submitPastedPrompt = true
    forcePasteAfterLaunch = true
  } else if (hasPrompt && promptDelivery === 'draft') {
    // Local: fold the draft into the host launch (pasteDraftAfterLaunch stays
    // null). The host owns whether it lands via an inline flag, an env var, or a
    // post-ready draftPrompt paste (draftParts/maxInlineDraftChars) — no client
    // command estimate. Remote: the host's post-ready draftPrompt paste writes
    // through its local ptyController and never reaches the relay-hosted pty
    // (W6-remote U10 gap), so a folded draft the host defers to post-ready would
    // be silently lost. Deliver via a client paste instead — the same text
    // arrives; forcePaste overrides the native-prefill no-op so a
    // draftPromptFlag/env base still receives it (nothing was folded to prefill).
    if (isRemote) {
      pasteDraftAfterLaunch = trimmedPrompt
      forcePasteAfterLaunch = true
    }
  } else if (hasPrompt && isFollowupPath) {
    pasteDraftAfterLaunch = trimmedPrompt
  }

  // Why: the prompt rides `agentLaunch` only when it folds into the launch
  // itself (argv/flag agents, native draft flag). Every post-ready paste path
  // (submit-after-ready, oversized draft, stdin-after-start followup) launches
  // bare and the renderer delivers the prompt below, so the request carries
  // `allowEmptyPromptLaunch` instead. A native draft fold must stay UNSUBMITTED,
  // so forward `promptDelivery: 'draft'` — without it the host defaults to
  // submit and auto-sends the draft.
  const promptFoldsIntoLaunch = pasteDraftAfterLaunch === null && hasPrompt
  const agentLaunch: AgentLaunchSpawnRequest = {
    selection: { kind: 'agent', agent },
    ...(promptFoldsIntoLaunch
      ? {
          prompt: trimmedPrompt,
          ...(promptDelivery === 'draft' ? { promptDelivery: 'draft' as const } : {})
        }
      : { allowEmptyPromptLaunch: true }),
    // Why: recipe-driven launches name the saved owner so the host resolves and
    // applies its stored agentArgs (and env) itself; the client never sends args.
    ...(sourceRecord ? { sourceRecord } : {})
  }

  // Why: the remote host can't infer this client's draft/default view choice, so decide it here for paired tabs too.
  const viewModePromptDelivery =
    hasPrompt && isFollowupPath && promptDelivery === 'auto-submit' ? 'draft' : promptDelivery
  const initialViewModeProps = initialAgentTabViewModeProps(store.settings, {
    agent,
    promptDelivery: viewModePromptDelivery,
    nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
      getConnectionIdFromState(store, worktreeId)
    )
  })

  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(store, worktreeId)
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    const webHostDelivery = launchAgentInWebHostTab({
      // Why: route the paired-web launch through the same host `agentLaunch`
      // boundary as the local path — the host owns command/config/token assembly,
      // so the client never sends an assembled startup plan here (the last
      // client-assembled launch on this surface).
      agent,
      worktreeId,
      environmentId: runtimeEnvironmentId,
      groupId,
      cwd: initialCwd,
      hasPrompt,
      agentLaunch,
      ...(pasteDraftAfterLaunch !== null
        ? {
            promptAfterReady: {
              content: pasteDraftAfterLaunch,
              submit: submitPastedPrompt,
              forcePaste: forcePasteAfterLaunch
            }
          }
        : {}),
      // Why: omission means terminal locally, but would let a paired host apply
      // its own default; send the client's resolved terminal choice explicitly.
      viewMode: initialViewModeProps.viewMode ?? 'terminal',
      onPromptDelivered
    })
    return {
      tabId: null,
      pasteDraftAfterLaunch: pasteDraftAfterLaunch !== null,
      ...(pasteDraftAfterLaunch !== null && promptDelivery === 'submit-after-ready'
        ? { promptDeliveryResult: webHostDelivery }
        : {})
    }
  }

  // Why: queue startup BEFORE TerminalPane mounts — it snapshots pendingStartupByTabId in useState on first render.
  // Why: followup path pastes an unsubmitted draft, so gate the initial chat view like a draft launch, not auto-submit.
  const tab = store.createTab(worktreeId, groupId, undefined, {
    launchAgent: agent,
    quickCommandLabel,
    ...initialViewModeProps
  })
  if (initialCwd?.trim()) {
    // Why: queue before mount so local, WSL, and SSH continuations preserve their subdirectory.
    store.queueTabInitialCwd(tab.id, initialCwd)
  }
  store.queueTabStartupCommand(tab.id, {
    // The host owns command/config/token assembly on the agentLaunch path; the
    // client only names the requested identity and prompt/launch policy.
    command: '',
    agentLaunch,
    ...(agent === 'command-code' && hasPrompt && promptDelivery === 'auto-submit'
      ? { initialAgentStatus: { agent, prompt: trimmedPrompt } }
      : {}),
    // Host overwrites agent_kind from the resolved receipt before the emit, so
    // this host-resolved launch threads only the surface-owned fields.
    telemetry: {
      launch_source: launchSource ?? 'tab_bar_quick_launch',
      request_kind: 'new'
    }
  })
  // Why: schedule the bracketed-paste-after-ready follow-up immediately after
  // the startup command is queued. Fire-and-forget so callers keep a
  // synchronous launch result. The helper short-circuits
  // for agents with a `draftPromptFlag`, so calling it on the followup path
  // is safe even when the draft was already injected via the native flag.
  if (pasteDraftAfterLaunch !== null) {
    // Why: onTimeout surfaces silent paste failures — a stalled readiness wait would otherwise drop notes silently.
    let failureNotified = false
    const deliveryPromise = deliverLaunchPromptToAgentTab({
      tabId: tab.id,
      content: pasteDraftAfterLaunch,
      agent,
      submit: submitPastedPrompt,
      forcePaste: forcePasteAfterLaunch,
      onTimeout: () => {
        const state = useAppStore.getState()
        const tabsForWorktree = state.tabsByWorktree[worktreeId] ?? []
        const currentTab = tabsForWorktree.find((t) => t.id === tab.id)
        if (currentTab?.ptyId === null) {
          // Why: PTY never spawned = genuine launch failure; stay silent so the caller emits the sole notice.
          return
        }
        if (!currentTab || state.activeWorktreeId !== worktreeId) {
          // Why: user cancelled (closed tab / switched worktrees); mark notified so the deferred caller suppresses its toast too.
          failureNotified = true
          return
        }
        toast.message(
          translate(
            'auto.lib.launch.agent.in.new.tab.a5a1f7033f',
            "Your {{value0}} wasn't sent — paste it once the agent is ready.",
            { value0: submitPastedPrompt ? 'prompt' : 'notes' }
          )
        )
        failureNotified = true
        track('agent_error', {
          error_class: 'paste_readiness_timeout',
          agent_kind: resolveTelemetryAgentKind(agent)
        })
      }
    }).then((delivered) => {
      if (delivered) {
        if (agent === 'command-code' && submitPastedPrompt) {
          // Why: Command Code has no prompt-submit hook; when Orca submits a
          // generated prompt after readiness, seed working at delivery time.
          seedCommandCodeSubmittedPromptStatus(worktreeId, tab.id, trimmedPrompt)
        }
        onPromptDelivered?.()
      }
      return { delivered, failureNotified: !delivered && failureNotified }
    })
    if (promptDelivery === 'submit-after-ready') {
      promptDeliveryResult = deliveryPromise
    } else {
      void deliveryPromise.catch((error) =>
        console.error('Prompt delivery failed after launch', error)
      )
    }
  } else if (hasPrompt) {
    onPromptDelivered?.()
  }

  // Why: without setActiveTabType('terminal') a worktree showing an editor keeps rendering it and the new tab stays hidden.
  store.setActiveTabType('terminal')

  // Why: persist tab-bar order so reconcileTabOrder doesn't fall back to terminals-first and jump the new tab to index 0.
  const fresh = useAppStore.getState()
  const termIds = (fresh.tabsByWorktree[worktreeId] ?? []).map((t) => t.id)
  const editorIds = fresh.openFiles.filter((f) => f.worktreeId === worktreeId).map((f) => f.id)
  const browserIds = (fresh.browserTabsByWorktree?.[worktreeId] ?? []).map((t) => t.id)
  const base = reconcileTabOrder(
    fresh.tabBarOrderByWorktree[worktreeId],
    termIds,
    editorIds,
    browserIds
  )
  const order = base.filter((id) => id !== tab.id)
  order.push(tab.id)
  fresh.setTabBarOrder(worktreeId, order)

  return {
    tabId: tab.id,
    pasteDraftAfterLaunch: pasteDraftAfterLaunch !== null,
    ...(promptDeliveryResult ? { promptDeliveryResult } : {})
  }
}
