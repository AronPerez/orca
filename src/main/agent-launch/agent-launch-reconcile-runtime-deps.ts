// Builds the ReconcileAgentLaunchDeps the runtime drives from injected host
// primitives (U6). Keeps the liveness-resolution + owner-routing wiring pure and
// electron-free so it is unit-testable away from the 20k-line runtime; the
// runtime supplies the concrete token probe, host-authority predicate, and owner
// writers.
//
// Liveness follows the plan's reconciliation contract (487-513) exactly:
//   - A launch token matched to a live terminal → `live`; `attributed` is whether
//     that terminal still belongs to the launch's worktree (an unattributed live
//     token is the pane-identity-theft class → invalid_launch_snapshot).
//   - No live token match → `absent` ONLY when the pending's execution host is
//     currently authoritatively listable (local in-process terminals died with
//     main; a reconnected provider just re-listed its terminals). Otherwise the
//     host is a possibly-unreachable survivor → `unknown` (non-retryable, durable)
//     until its own terminal-list/reconnect event re-probes. `isHostAuthoritative`
//     encodes which hosts a given reconcile pass can speak for, so a daemon/SSH
//     survivor is never falsely settled `absent` before its provider reconnects.

import type { AgentLaunchExecutionHostId } from '../../shared/agent-launch-host-contract'
import type { PendingAgentLaunchSnapshot } from './agent-launch-operation-store'
import type { AgentLaunchOperationStore } from './agent-launch-operation-store'
import {
  reconcilePersistenceForIntent,
  type ReconcileIntentRouterArms
} from './agent-launch-reconcile-intent-router'
import type {
  ReconcileAgentLaunchDeps,
  ResolvedLaunchLiveness
} from './agent-launch-worktree-reconcile-writer'

/** A live terminal a launch token currently maps to. `worktreeId` is compared to
 *  the launch's expected worktree for attribution. */
export type LiveTerminalForToken = { ptyId: string; worktreeId: string }

export type ReconcileRuntimeDeps = {
  operationStore: AgentLaunchOperationStore
  /** The live terminal holding a launch token, or null if none is live. */
  liveTerminalByToken: (launchToken: string) => LiveTerminalForToken | null
  /** Whether a non-live pending's host can be spoken for authoritatively in this
   *  reconcile pass (→ `absent`); false leaves it `unknown`. */
  isHostAuthoritative: (executionHostId: AgentLaunchExecutionHostId) => boolean
  /** The worktree a live token must belong to for attribution: the scope for a
   *  worktree launch, the attempt's worktree for a background launch, or null when
   *  the intent has no worktree to compare (attribution then trusts the token). */
  expectedWorktreeId: (pending: PendingAgentLaunchSnapshot) => string | null
  arms: ReconcileIntentRouterArms
  settleBoundary: (launchToken: string, settlement: 'registered' | 'failed') => void
  mintFailureId: () => string
  now?: () => number
}

function resolveLiveness(
  deps: ReconcileRuntimeDeps,
  pending: PendingAgentLaunchSnapshot
): ResolvedLaunchLiveness {
  const live = deps.liveTerminalByToken(pending.launchToken)
  if (live) {
    const expected = deps.expectedWorktreeId(pending)
    return {
      kind: 'live',
      attributed: expected === null || live.worktreeId === expected,
      terminalId: live.ptyId
    }
  }
  const host = pending.snapshot.target.executionHostId
  return deps.isHostAuthoritative(host) ? { kind: 'absent' } : { kind: 'unknown' }
}

export function buildReconcileAgentLaunchDeps(
  deps: ReconcileRuntimeDeps
): ReconcileAgentLaunchDeps {
  return {
    operationStore: deps.operationStore,
    resolveLiveness: (pending) => resolveLiveness(deps, pending),
    persistenceFor: (pending) => reconcilePersistenceForIntent(deps.arms, pending),
    settleBoundary: deps.settleBoundary,
    mintFailureId: deps.mintFailureId,
    now: deps.now
  }
}
