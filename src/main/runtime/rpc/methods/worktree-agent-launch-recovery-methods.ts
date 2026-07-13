// Agent-launch recovery RPC methods for a worktree (U4-U6): retry/forget a
// worktree launch failure, retry/forget a generic background attempt, and the
// redacted capacity-recovery summary. Split out of worktree.ts to keep that file
// under the max-lines limit. Every method scopes admission/idempotency from the
// authenticated clientKind — never from client JSON — and treats the
// expectedFailureId/expectedOperationId fields as anti-race guards, not secrets.

import { defineMethod, type RpcMethod } from '../core'
import {
  WorktreeForgetAgentLaunch,
  WorktreeForgetBackgroundAgentLaunch,
  WorktreeForgetUnknownAgentLaunchSiblings,
  WorktreePendingAgentLaunchSummary,
  WorktreeRetryAgentLaunch,
  WorktreeRetryBackgroundAgentLaunch,
  WorktreeUnknownAgentLaunchSiblingCount
} from './worktree-schemas'

export const WORKTREE_AGENT_LAUNCH_RECOVERY_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'worktree.retryAgentLaunch',
    params: WorktreeRetryAgentLaunch,
    // Authorization is authenticated worktree access, the same boundary as every
    // other worktree mutation.
    handler: async (params, { runtime, clientKind }) =>
      runtime.retryWorktreeAgentLaunch(
        params.worktree,
        {
          expectedFailureId: params.expectedFailureId,
          clientMutationId: params.clientMutationId,
          action: params.action
        },
        clientKind
      )
  }),
  defineMethod({
    name: 'worktree.forgetAgentLaunch',
    params: WorktreeForgetAgentLaunch,
    handler: async (params, { runtime, clientKind }) =>
      runtime.forgetUnknownWorktreeAgentLaunch(
        params.worktree,
        {
          expectedOperationId: params.expectedOperationId,
          clientMutationId: params.clientMutationId
        },
        clientKind
      )
  }),
  defineMethod({
    name: 'worktree.retryBackgroundAgentLaunch',
    params: WorktreeRetryBackgroundAgentLaunch,
    // Authorization is authenticated access to the attempt's worktree.
    handler: async (params, { runtime, clientKind }) =>
      runtime.retryBackgroundAgentLaunch(
        {
          attemptId: params.attemptId,
          expectedFailureId: params.expectedFailureId,
          clientMutationId: params.clientMutationId,
          action: params.action
        },
        clientKind
      )
  }),
  defineMethod({
    name: 'worktree.forgetBackgroundAgentLaunch',
    params: WorktreeForgetBackgroundAgentLaunch,
    handler: async (params, { runtime, clientKind }) =>
      runtime.forgetBackgroundAgentLaunch(
        {
          attemptId: params.attemptId,
          expectedOperationId: params.expectedOperationId,
          clientMutationId: params.clientMutationId
        },
        clientKind
      )
  }),
  defineMethod({
    name: 'worktree.pendingAgentLaunchSummary',
    params: WorktreePendingAgentLaunchSummary,
    // clientKind scopes the admission principal (own rows only). The redacted rows
    // are secret-free and carry no token.
    handler: async (_params, { runtime, clientKind }) =>
      runtime.pendingAgentLaunchSummary(clientKind)
  }),
  defineMethod({
    name: 'worktree.unknownAgentLaunchSiblingCount',
    params: WorktreeUnknownAgentLaunchSiblingCount,
    // Lazy preflight for the ":498 Also forget N other stranded launches" affordance;
    // clientKind scopes the principal, siblings are host-derived, no secrets cross.
    handler: async (params, { runtime, clientKind }) => ({
      count: await runtime.unknownWorktreeAgentLaunchSiblingCount(params.worktree, clientKind)
    })
  }),
  defineMethod({
    name: 'worktree.forgetUnknownAgentLaunchSiblings',
    params: WorktreeForgetUnknownAgentLaunchSiblings,
    // Same-principal bulk forget on the anchor's disconnected host. Never kills or
    // spawns; each sibling settles only its own reservation and self-guards.
    handler: async (params, { runtime, clientKind }) =>
      runtime.forgetUnknownWorktreeAgentLaunchSiblings(params.worktree, clientKind)
  })
]
