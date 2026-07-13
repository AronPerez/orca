// Host-private store for GENERIC background agent-launch attempts (U6). The
// owner record for unattended launches that have no automation run or
// orchestration dispatch to land in. Kept SEPARATE from the interactive
// two-stage worktree pending launch (plan §U6) so a background failure survives
// reload, points at its worktree, and reconciles through the shared tri-state
// reconciler without conflating with WorktreeMeta.
//
// State model mirrors WorktreeMeta.pendingAgentLaunch + agentLaunchFailure:
//   pending                 → created before resolution; may coexist with a
//                             launch_state_unknown failure (the reservation and
//                             private snapshot survive until proof or Forget).
//   launched                → settled success; failure cleared.
//   failed                  → durable spawn/invalid failure; retryable.
//   forgotten               → owner forgot an unknown attempt; failure retained,
//                             forgottenAt stamped; the reservation is freed.
//
// Pure container: admission/liveness/persistence orchestration live in the
// runtime; this store only owns the record lifecycle and its durable sink.

import type {
  BackgroundAgentLaunchAttempt,
  BackgroundAgentLaunchState
} from '../../shared/background-agent-launch'
import type { PersistedAgentLaunchFailure } from '../../shared/agent-launch-contract'
import type { TuiAgent, BuiltInTuiAgent } from '../../shared/types'
import type { ReconcileScopePersistence } from './agent-launch-worktree-reconcile-writer'

/** Fields fixed when an attempt is created (before resolution). */
export type BackgroundAgentLaunchCreateInput = {
  attemptId: string
  worktreeId: string
  operationId: string
  requestedAgent: TuiAgent
  baseAgent: BuiltInTuiAgent | null
}

/** The durable half snapshotted for the host-private sink: every attempt. */
export type BackgroundAgentLaunchStoreDurableState = {
  attempts: readonly BackgroundAgentLaunchAttempt[]
}

export class BackgroundAgentLaunchStore {
  private readonly attempts = new Map<string, BackgroundAgentLaunchAttempt>()
  private readonly now: () => number
  private onDurableMutation: ((state: BackgroundAgentLaunchStoreDurableState) => void) | null = null

  constructor(deps?: { now?: () => number }) {
    this.now = deps?.now ?? (() => Date.now())
  }

  /** Attach (or replace) the durable sink. Not called during rehydrate, so the
   *  load path never writes back the state it just read. */
  setDurablePersistence(sink: (state: BackgroundAgentLaunchStoreDurableState) => void): void {
    this.onDurableMutation = sink
  }

  durableState(): BackgroundAgentLaunchStoreDurableState {
    return { attempts: [...this.attempts.values()] }
  }

  private persistDurable(): void {
    this.onDurableMutation?.(this.durableState())
  }

  /** Create the attempt BEFORE resolution. Idempotent on attemptId: a repeated
   *  create (idempotency replay) returns the existing record unchanged. */
  create(input: BackgroundAgentLaunchCreateInput): BackgroundAgentLaunchAttempt {
    const existing = this.attempts.get(input.attemptId)
    if (existing) {
      return existing
    }
    const at = this.now()
    const attempt: BackgroundAgentLaunchAttempt = {
      attemptId: input.attemptId,
      worktreeId: input.worktreeId,
      operationId: input.operationId,
      requestedAgent: input.requestedAgent,
      baseAgent: input.baseAgent,
      state: 'pending',
      failure: null,
      createdAt: at,
      updatedAt: at,
      forgottenAt: null
    }
    this.attempts.set(attempt.attemptId, attempt)
    this.persistDurable()
    return attempt
  }

  get(attemptId: string): BackgroundAgentLaunchAttempt | null {
    return this.attempts.get(attemptId) ?? null
  }

  /** Client-safe projection filtered to one worktree (Worktree.backgroundAgentLaunches). */
  listForWorktree(worktreeId: string): BackgroundAgentLaunchAttempt[] {
    return [...this.attempts.values()].filter((a) => a.worktreeId === worktreeId)
  }

  all(): BackgroundAgentLaunchAttempt[] {
    return [...this.attempts.values()]
  }

  /** Requested identities of every live attempt, for the tombstone reference
   *  index's background owner (§217). A forgotten attempt still references its
   *  id until pruned, keeping a deleted custom id's tombstone retained. */
  referencedRequestedAgents(): TuiAgent[] {
    return [...this.attempts.values()].map((a) => a.requestedAgent)
  }

  private transition(
    attemptId: string,
    state: BackgroundAgentLaunchState,
    failure: PersistedAgentLaunchFailure | null,
    forgottenAt: number | null
  ): BackgroundAgentLaunchAttempt | null {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) {
      return null
    }
    const next: BackgroundAgentLaunchAttempt = {
      ...attempt,
      state,
      failure,
      forgottenAt,
      updatedAt: this.now()
    }
    this.attempts.set(attemptId, next)
    this.persistDurable()
    return next
  }

  settleLaunched(attemptId: string): void {
    this.transition(attemptId, 'launched', null, null)
  }

  settleFailed(attemptId: string, failure: PersistedAgentLaunchFailure): void {
    this.transition(attemptId, 'failed', failure, null)
  }

  /** Coexistence rule: keep the attempt `pending` and record ONLY the durable
   *  unknown failure. Keeps an existing launch_state_unknown failureId stable so
   *  the client's expectedFailureId guard does not churn across reconcile re-runs. */
  markUnknown(attemptId: string, failure: PersistedAgentLaunchFailure): void {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) {
      return
    }
    const stableFailure =
      attempt.failure?.code === 'launch_state_unknown'
        ? { ...failure, failureId: attempt.failure.failureId }
        : failure
    this.transition(attemptId, 'pending', stableFailure, null)
  }

  /** Owner-authorized Forget of an unknown attempt. Retains the failure, stamps
   *  forgottenAt, moves to `forgotten`. Never spawns/kills — the caller frees the
   *  admission reservation separately. Only valid from a launch_state_unknown
   *  attempt; other states return false without mutation. */
  forget(attemptId: string): boolean {
    const attempt = this.attempts.get(attemptId)
    // Valid only from the coexistence state (pending + unknown failure). A
    // forgotten attempt retains its unknown failure, so also gate on `pending`
    // to reject a second forget.
    if (
      !attempt ||
      attempt.state !== 'pending' ||
      attempt.failure?.code !== 'launch_state_unknown'
    ) {
      return false
    }
    this.transition(attemptId, 'forgotten', attempt.failure, this.now())
    return true
  }

  /** Drop an attempt entirely (retention pruning; never a recovery path). */
  delete(attemptId: string): boolean {
    const deleted = this.attempts.delete(attemptId)
    if (deleted) {
      this.persistDurable()
    }
    return deleted
  }

  /** The reconcile persistence slice for one attempt, bound so the shared writer
   *  drives settle/markUnknown by scope=attemptId. */
  persistenceForAttempt(attemptId: string): ReconcileScopePersistence {
    return {
      settleLaunched: () => this.settleLaunched(attemptId),
      settleFailed: (failure) => this.settleFailed(attemptId, failure),
      markUnknown: (failure) => this.markUnknown(attemptId, failure)
    }
  }

  /** Rehydrate attempts at startup. Not routed through the sink. */
  rebuildFrom(attempts: Iterable<BackgroundAgentLaunchAttempt>): void {
    this.attempts.clear()
    for (const attempt of attempts) {
      this.attempts.set(attempt.attemptId, attempt)
    }
  }
}
