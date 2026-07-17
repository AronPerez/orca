// The created-path transaction for a worktree `agentLaunch` (U4). Given the
// stage-2 resolution thunk (executeWorktreeAgentLaunch) and injected persistence/
// spawn callbacks, it enforces the plan's ordering guarantees exactly:
//   1. resolve+admit (the thunk) — a failure released the reservation already;
//   2. persist the public pending metadata AND the private snapshot/token in ONE
//      synchronous write BEFORE the writer, so a crash mid-spawn still self-
//      identifies the terminal by token;
//   3. spawn exactly ONE PTY from the resolved plan (token travels inside it);
//   4. settle — registered clears pending + records `launched`; any post-create
//      failure keeps the workspace, writes a durable `agentLaunchFailure`, and
//      records `failed`. No path spawns a substitute blank terminal (I9).
// A request error performs no owner-state write. Electron-free and injectable.

import type { AgentStartupPlan } from '../../shared/tui-agent-startup'
import type {
  AgentLaunchFailure,
  AgentLaunchIntentKind,
  AgentLaunchReceipt,
  AgentLaunchRequestError,
  PersistedAgentLaunchFailure
} from '../../shared/agent-launch-contract'
import type { TuiAgent } from '../../shared/types'
import type { AgentLaunchBoundary, ExecuteAgentLaunchResult } from './agent-launch-boundary'
import type { AdmissionPrincipal } from './agent-launch-admission-store'
import type { AgentLaunchOperationStore } from './agent-launch-operation-store'

/** Public pending metadata the caller writes onto WorktreeMeta. The private
 *  snapshot/token stay in the operation store and never enter this shape. */
export type WorktreePendingAgentLaunch = {
  operationId: string
  requestedAgent: TuiAgent
  priorFailureId?: string
}

/** Creates and registers exactly ONE PTY from the resolved plan. The receipt
 *  carries the launch token (which travels inside the spawn request) plus the
 *  built-in base agent the terminal binds for process/telemetry keying. Must
 *  throw on spawn/registration failure so the reservation settles `failed`; a
 *  returned value means the PTY is registered and names the terminal id. */
export type WorktreeLaunchSpawn = (
  plan: AgentStartupPlan,
  receipt: AgentLaunchReceipt
) => Promise<{ terminalId: string }>

export type WorktreeAgentLaunchTransactionDeps = {
  boundary: AgentLaunchBoundary
  operationStore: AgentLaunchOperationStore
  /** Public pending metadata write; paired with the private snapshot write in
   *  the same synchronous transaction, before the writer. */
  persistPending: (pending: WorktreePendingAgentLaunch) => void
  spawn: WorktreeLaunchSpawn
  /** Clear the public pending metadata after a registered launch. */
  clearPublicPending: () => void
  /** Persist the durable failure onto WorktreeMeta.agentLaunchFailure and clear
   *  any pending metadata. Must be safe to call whether or not pending was
   *  written (execute-stage vs spawn-stage failure). */
  persistFailure: (failure: PersistedAgentLaunchFailure) => void
  mintFailureId: () => string
  now?: () => number
}

export type WorktreeAgentLaunchTransactionParams = {
  operationId: string
  idempotencyKey: string
  scope: string
  payloadDigest: string
  clientMutationId: string | null
  requestedAgent: TuiAgent
  intent: AgentLaunchIntentKind
  /** Admission principal holding the reservation, persisted into the pending
   *  snapshot so a restart rebuilds capacity counters into the right bucket. */
  principal: AdmissionPrincipal
  priorFailureId?: string
  /** Stage-2 resolution: re-resolve with authoritative paths + pinned identity,
   *  recheck the digest, and convert the held reservation. Releases the
   *  reservation itself on any failure. */
  execute: () => Promise<ExecuteAgentLaunchResult>
}

export type WorktreeAgentLaunchOutcome =
  | { status: 'launched'; receipt: AgentLaunchReceipt; terminalId: string }
  | { status: 'failed'; failure: PersistedAgentLaunchFailure }
  | { status: 'request_error'; requestError: AgentLaunchRequestError }

function persistedFailure(
  deps: WorktreeAgentLaunchTransactionDeps,
  params: WorktreeAgentLaunchTransactionParams,
  failure: AgentLaunchFailure,
  nowFn: () => number
): { status: 'failed'; failure: PersistedAgentLaunchFailure } {
  const persisted: PersistedAgentLaunchFailure = {
    ...failure,
    version: 1,
    failureId: deps.mintFailureId(),
    intent: params.intent,
    occurredAt: nowFn()
  }
  // Keep the workspace; the durable failure card offers Retry/Choose agent.
  deps.persistFailure(persisted)
  deps.operationStore.recordSettled({
    operationId: params.operationId,
    idempotencyKey: params.idempotencyKey,
    scope: params.scope,
    payloadDigest: params.payloadDigest,
    status: 'failed',
    terminalId: null,
    failureId: persisted.failureId,
    settledAt: nowFn()
  })
  return { status: 'failed', failure: persisted }
}

/** Run the created-path transaction. The git worktree already exists; a failure
 *  here NEVER rolls it back and NEVER spawns a substitute shell. */
export async function runWorktreeAgentLaunchTransaction(
  deps: WorktreeAgentLaunchTransactionDeps,
  params: WorktreeAgentLaunchTransactionParams
): Promise<WorktreeAgentLaunchOutcome> {
  const nowFn = deps.now ?? Date.now
  const execution = await params.execute()
  if (!execution.ok) {
    if ('requestError' in execution) {
      // Request errors perform no owner-state write; the reservation is already
      // released by execute.
      return { status: 'request_error', requestError: execution.requestError }
    }
    return persistedFailure(deps, params, execution.failure, nowFn)
  }
  const { plan, receipt } = execution
  const snapshot = deps.boundary.pendingSnapshotFor(receipt.launchToken)
  if (!snapshot) {
    // The admitted token must carry a private snapshot; a missing one cannot be
    // attributed, so fail closed rather than spawn an unattributable terminal.
    deps.boundary.settleAgentLaunch(receipt.launchToken, 'failed')
    return persistedFailure(
      deps,
      params,
      {
        code: 'invalid_launch_snapshot',
        requestedAgent: receipt.requestedAgent,
        baseAgent: receipt.baseAgent
      },
      nowFn
    )
  }

  // ONE persistence transaction before the writer: private snapshot/token first,
  // then the client-safe pending metadata. Both synchronous so no mutation lands
  // between them and a mid-spawn crash still resolves via the persisted token.
  deps.operationStore.beginPending({
    operationId: params.operationId,
    idempotencyKey: params.idempotencyKey,
    scope: params.scope,
    clientMutationId: params.clientMutationId,
    payloadDigest: params.payloadDigest,
    launchToken: receipt.launchToken,
    intent: params.intent,
    principal: params.principal,
    snapshot
  })
  deps.persistPending({
    operationId: params.operationId,
    requestedAgent: receipt.requestedAgent,
    ...(params.priorFailureId ? { priorFailureId: params.priorFailureId } : {})
  })

  let terminalId: string
  try {
    const spawned = await deps.spawn(plan, receipt)
    terminalId = spawned.terminalId
  } catch {
    deps.boundary.settleAgentLaunch(receipt.launchToken, 'failed')
    // Settled ledger entry (inside persistedFailure) BEFORE clearPending: a
    // crash between the two durable writes must never lose both the pending
    // attribution and the settled entry — either alone reconciles/replays.
    const failed = persistedFailure(
      deps,
      params,
      {
        code: 'spawn_failed',
        requestedAgent: receipt.requestedAgent,
        baseAgent: receipt.baseAgent
      },
      nowFn
    )
    deps.operationStore.clearPending(receipt.launchToken)
    return failed
  }

  // Registered: move attribution into the boundary's retained handoff, append
  // the settled `launched` ledger entry, then clear the pending (private +
  // public). Settled-before-clear so a crash between the durable writes leaves
  // at least one record of the launch (recordSettled replay is idempotent).
  deps.boundary.settleAgentLaunch(receipt.launchToken, 'registered')
  deps.operationStore.recordSettled({
    operationId: params.operationId,
    idempotencyKey: params.idempotencyKey,
    scope: params.scope,
    payloadDigest: params.payloadDigest,
    status: 'launched',
    terminalId,
    failureId: null,
    settledAt: nowFn()
  })
  deps.operationStore.clearPending(receipt.launchToken)
  deps.clearPublicPending()
  return { status: 'launched', receipt, terminalId }
}
