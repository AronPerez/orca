import { z } from 'zod'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'
import {
  launchSourceSchema,
  requestKindSchema,
  workspaceSourceSchema
} from '../../../../shared/telemetry-events'
import { sleepingAgentLaunchConfigSchema } from '../../../../shared/workspace-session-sleeping-agents'
import { RUNTIME_NAVIGATION_TARGETS } from '../../../../shared/runtime-navigation'
import { AgentLaunchSpawnRequestSchema } from './agent-launch-spawn-schema'
import { isCanonicalLowercaseUuid } from '../../../agent-launch/agent-launch-operation-store'
import {
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  TriStateLinkedIssue
} from '../schemas'

const OptionalTuiAgent = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value !== undefined && !isTuiAgent(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown TUI agent' })
    }
  })
  .transform((value): TuiAgent | undefined => (isTuiAgent(value) ? value : undefined))
  .optional()

const AutomationWorkspaceProvenanceRequest = z.object({
  automationId: z.string(),
  automationRunId: z.string(),
  dispatchToken: z.string(),
  createRequestId: z.string()
})

export const WorktreeListParams = z.object({
  repo: OptionalString,
  limit: OptionalFiniteNumber
})

export const WorktreeDetectedListParams = z.object({
  repo: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing repo selector'))
})

export const WorktreePsParams = z.object({
  limit: OptionalFiniteNumber
})

export const WorktreeSortOrder = z.object({
  orderedIds: z.array(z.string())
})

export const WorktreeSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

export const WorktreeActivate = WorktreeSelector.extend({
  notifyClients: OptionalBoolean,
  navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional()
})

export const WorktreeCreate = z
  .object({
    repo: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing repo selector')),
    name: OptionalString,
    baseBranch: OptionalString,
    compareBaseRef: OptionalString,
    branchNameOverride: OptionalString,
    linkedIssue: TriStateLinkedIssue,
    linkedPR: TriStateLinkedIssue,
    linkedLinearIssue: z.string().optional(),
    linkedLinearIssueWorkspaceId: z.union([z.string(), z.null()]).optional(),
    linkedLinearIssueOrganizationUrlKey: z.union([z.string(), z.null()]).optional(),
    linkedGitLabMR: TriStateLinkedIssue,
    linkedGitLabIssue: TriStateLinkedIssue,
    linkedBitbucketPR: TriStateLinkedIssue,
    linkedAzureDevOpsPR: TriStateLinkedIssue,
    linkedGiteaPR: TriStateLinkedIssue,
    comment: OptionalString,
    displayName: OptionalString,
    telemetrySource: z
      .unknown()
      .transform((value) => {
        const parsed = workspaceSourceSchema.safeParse(value)
        return parsed.success ? parsed.data : undefined
      })
      .optional(),
    workspaceStatus: OptionalString,
    manualOrder: OptionalFiniteNumber,
    sparseCheckout: z
      .object({
        directories: z.array(z.string()),
        presetId: OptionalString
      })
      .optional(),
    pushTarget: z
      .object({
        remoteName: z.string(),
        branchName: z.string(),
        remoteUrl: OptionalString
      })
      .optional(),
    runHooks: OptionalBoolean,
    activate: OptionalBoolean,
    parentWorkspace: OptionalString,
    envParentWorkspace: OptionalString,
    parentWorktree: OptionalString,
    cwdParentWorktree: OptionalString,
    noParent: OptionalBoolean,
    callerTerminalHandle: OptionalString,
    orchestrationContext: z
      .object({
        parentWorktreeId: OptionalString,
        orchestrationRunId: OptionalString,
        taskId: OptionalString,
        coordinatorHandle: OptionalString
      })
      .optional(),
    setupDecision: z
      .unknown()
      .transform((v) =>
        typeof v === 'string' && (v === 'run' || v === 'skip' || v === 'inherit') ? v : undefined
      )
      .pipe(z.union([z.enum(['run', 'skip', 'inherit']), z.undefined()]))
      .optional(),
    // Why: mobile clients pass a startup command (e.g. 'claude') so the first
    // terminal pane launches the selected agent instead of an idle shell.
    startupCommand: OptionalString,
    startupEnv: z.record(z.string(), z.string()).optional(),
    startupLaunchConfig: sleepingAgentLaunchConfigSchema,
    startupCommandDelivery: z.enum(['fast', 'shell-ready']).optional(),
    // Why: CLI clients should not hardcode agent launch quoting because SSH
    // workspaces execute in a different shell than the client process.
    startupAgent: OptionalTuiAgent,
    startupPrompt: OptionalString,
    // Why: task-driven mobile creates need desktop parity: the host chooses
    // the same default/detected agent and drafts the linked issue/PR URL into it.
    startupDraft: OptionalString,
    createdWithAgent: z
      .unknown()
      .transform((value) => (isTuiAgent(value) ? value : undefined))
      .optional(),
    // Why: mobile retries a create interrupted by a connection migration with the
    // same key so the host dedupes instead of spawning a duplicate worktree.
    clientMutationId: z.string().min(1).max(128).optional(),
    // Host-resolved launch: same one request shape as pty:spawn / terminal.create.
    // When present the host owns resolution and ignores startup*/createdWithAgent.
    agentLaunch: AgentLaunchSpawnRequestSchema.optional(),
    // Surface-owned agent_started fields for a host-emitted interactive create
    // (Option A). Sent only for interactive agentLaunch creates; agent_kind +
    // used_custom_agent are host-derived from the receipt and never accepted here.
    agentLaunchTelemetry: z
      .object({ launch_source: launchSourceSchema, request_kind: requestKindSchema })
      .optional(),
    automationProvenanceRequest: AutomationWorkspaceProvenanceRequest.optional()
  })
  .superRefine((params, ctx) => {
    if ((params.parentWorkspace || params.parentWorktree) && params.noParent === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose either one parent selector or --no-parent.'
      })
    }
    if (params.parentWorkspace && params.parentWorktree) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose either one parent selector or --no-parent.'
      })
    }
    if (params.startupPrompt !== undefined && params.startupAgent === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'startupPrompt requires startupAgent'
      })
    }
  })

export const WorktreePrefetchCreateBase = z.object({
  repo: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing repo selector')),
  baseBranch: OptionalString
})

export const WorktreeSet = WorktreeSelector.extend({
  displayName: OptionalString,
  // Why: empty comments are meaningful metadata updates, so use the plain
  // string parser instead of OptionalString's empty-as-undefined behavior.
  comment: OptionalPlainString,
  linkedIssue: TriStateLinkedIssue,
  linkedPR: TriStateLinkedIssue,
  linkedLinearIssue: z.union([z.string(), z.null()]).optional(),
  linkedLinearIssueWorkspaceId: z.union([z.string(), z.null()]).optional(),
  linkedLinearIssueOrganizationUrlKey: z.union([z.string(), z.null()]).optional(),
  linkedGitLabMR: TriStateLinkedIssue,
  linkedGitLabIssue: TriStateLinkedIssue,
  linkedBitbucketPR: TriStateLinkedIssue,
  linkedAzureDevOpsPR: TriStateLinkedIssue,
  linkedGiteaPR: TriStateLinkedIssue,
  isArchived: OptionalBoolean,
  isUnread: OptionalBoolean,
  isPinned: OptionalBoolean,
  sortOrder: OptionalFiniteNumber,
  manualOrder: OptionalFiniteNumber,
  lastActivityAt: OptionalFiniteNumber,
  createdAt: OptionalFiniteNumber,
  sparseDirectories: z.array(z.string()).optional(),
  sparseBaseRef: OptionalString,
  sparsePresetId: OptionalString,
  baseRef: OptionalString,
  workspaceStatus: OptionalString,
  pushTarget: z
    .object({
      remoteName: z.string(),
      branchName: z.string(),
      remoteUrl: OptionalString
    })
    .nullable()
    .optional(),
  diffComments: z.array(z.unknown()).optional(),
  mobileDiffReview: z.unknown().optional(),
  parentWorktree: OptionalString,
  noParent: OptionalBoolean
}).superRefine((params, ctx) => {
  if (params.parentWorktree && params.noParent === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Choose either --parent-worktree or --no-parent, not both.'
    })
  }
})

export const WorktreeRemove = WorktreeSelector.extend({
  force: OptionalBoolean,
  runHooks: OptionalBoolean
})

export const WorktreeForceDeleteBranch = WorktreeSelector.extend({
  branchName: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing branch name')),
  expectedHead: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing expected branch head'))
})

export const WorktreeResolvePrBase = z.object({
  repo: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing repo selector')),
  prNumber: z
    .unknown()
    .transform((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
    .pipe(z.number().int().positive('Missing PR number')),
  headRefName: OptionalString,
  baseRefName: OptionalString,
  isCrossRepository: OptionalBoolean
})

export const WorktreeResolveMrBase = z.object({
  repo: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing repo selector')),
  mrIid: z
    .unknown()
    .transform((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
    .pipe(z.number().int().positive('Missing MR number')),
  sourceBranch: OptionalString,
  targetBranch: OptionalString,
  isCrossRepository: OptionalBoolean
})

// clientMutationId is required in canonical lowercase UUID form BEFORE any
// idempotency lookup/write; expectedFailureId is an anti-race guard shown in
// client metadata, never an authorization secret.
export const WorktreeRetryAgentLaunch = WorktreeSelector.extend({
  expectedFailureId: z.string().min(1).max(256),
  clientMutationId: z.string().refine(isCanonicalLowercaseUuid, {
    message: 'clientMutationId must be a canonical lowercase UUID'
  }),
  action: z.union([
    z.object({ kind: z.literal('retry-same') }),
    z.object({
      kind: z.literal('change-agent'),
      agent: z.custom<TuiAgent>(isTuiAgent, { message: 'Unknown agent' })
    })
  ])
})

export const WorktreeForgetAgentLaunch = WorktreeSelector.extend({
  // expectedOperationId is an anti-race guard from client-visible worktree
  // metadata, never authorization.
  expectedOperationId: z.string().min(1).max(256),
  clientMutationId: z.string().refine(isCanonicalLowercaseUuid, {
    message: 'clientMutationId must be a canonical lowercase UUID'
  })
})

// Generic background attempt Forget/Retry (U6). Keyed by the host-minted attempt
// id (not a worktree selector — a worktree may host several background attempts),
// which is client-visible attempt metadata and an anti-race guard, never a secret.
export const WorktreeRetryBackgroundAgentLaunch = z.object({
  attemptId: z.string().min(1).max(256),
  expectedFailureId: z.string().min(1).max(256),
  clientMutationId: z.string().refine(isCanonicalLowercaseUuid, {
    message: 'clientMutationId must be a canonical lowercase UUID'
  }),
  action: z.union([
    z.object({ kind: z.literal('retry-same') }),
    z.object({
      kind: z.literal('change-agent'),
      agent: z.custom<TuiAgent>(isTuiAgent, { message: 'Unknown agent' })
    })
  ])
})

export const WorktreeForgetBackgroundAgentLaunch = z.object({
  attemptId: z.string().min(1).max(256),
  expectedOperationId: z.string().min(1).max(256),
  clientMutationId: z.string().refine(isCanonicalLowercaseUuid, {
    message: 'clientMutationId must be a canonical lowercase UUID'
  })
})

// The capacity-recovery summary takes no params: the principal is scoped from the
// authenticated clientKind, never from client JSON, so there is nothing to carry.
export const WorktreePendingAgentLaunchSummary = z.object({})

// Same-principal bulk forget (§U9 ledger #15 / plan :498). Both carry only the
// anchor worktree selector: the principal is scoped from the authenticated
// clientKind, the disconnected host + eligible siblings are derived host-side, and
// no per-launch operation id fits a bulk op — every sibling self-guards internally.
export const WorktreeUnknownAgentLaunchSiblingCount = WorktreeSelector
export const WorktreeForgetUnknownAgentLaunchSiblings = WorktreeSelector
