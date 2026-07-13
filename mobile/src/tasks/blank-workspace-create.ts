import type { TuiAgent } from '../../../src/shared/types'
import type { RpcClient } from '../transport/rpc-client'
import { createWorktreeWithNameRetry, type WorktreeCreateResult } from './worktree-create-retry'
import type { WorkspaceCreateSetupDecision } from './workspace-create-params'

// The blank/named create path, extracted from NewWorktreeModal so the modal keeps
// only the UI-coupled setup-trust flow. Assembles worktree.create params and
// applies the shared name-collision retry.
export async function createBlankWorkspace(args: {
  client: RpcClient
  repoId: string
  baseName: string
  startupCommand: string | undefined
  createdWithAgentId: TuiAgent | undefined
  launchParams?: Record<string, unknown>
  comment: string | undefined
  setupDecision: WorkspaceCreateSetupDecision
  supportsIdempotentCutoverRetry: boolean | Promise<boolean>
}): Promise<WorktreeCreateResult> {
  return createWorktreeWithNameRetry({
    client: args.client,
    baseName: args.baseName,
    supportsIdempotentCutoverRetry: args.supportsIdempotentCutoverRetry,
    buildParams: (name) => {
      const launchParams = args.launchParams ?? {
        startupCommand: args.startupCommand,
        ...(args.createdWithAgentId ? { createdWithAgent: args.createdWithAgentId } : {})
      }
      const params: Record<string, unknown> = {
        repo: `id:${args.repoId}`,
        setupDecision: args.setupDecision,
        name,
        ...launchParams
      }
      if (args.comment) {
        params.comment = args.comment
      }
      return params
    }
  })
}
