// Built-in agent override mutation: persists per-agent command/args/env overrides
// for a shipped built-in. Built-in prefixes keep multi-token wrapper
// compatibility, so only control characters and hard bounds are save-rejected.

import type { GlobalSettings } from '../../shared/types'
import type { AgentCatalogMutationRequest } from '../../shared/agent-catalog-snapshot'
import { validateCustomAgentEnv } from '../../shared/custom-tui-agents'
import { isBuiltInTuiAgent } from '../../shared/tui-agent-config'
import { fieldError, type AgentCatalogMutationApplication } from './agent-catalog-draft-validation'

type UpdateBuiltInMutation = Extract<
  AgentCatalogMutationRequest['mutation'],
  { kind: 'update-built-in' }
>

export function applyUpdateBuiltIn(
  mutation: UpdateBuiltInMutation,
  settings: GlobalSettings,
  newRevision: number
): AgentCatalogMutationApplication {
  if (!isBuiltInTuiAgent(mutation.agent)) {
    return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
  }
  // Built-in prefixes keep multi-token wrapper compatibility, so only
  // control characters and bounds are save-rejected here; operator tokens
  // fail at launch with a repairable error instead of being reinterpreted.
  const override = mutation.changes.commandOverride
  if (override !== null && override !== undefined) {
    if (override.length > 4096) {
      return { ok: false, code: 'invalid_agent_field', field: 'commandOverride', reason: 'bounds' }
    }
    // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
    if (/[\0\r\n\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(override)) {
      return {
        ok: false,
        code: 'invalid_agent_field',
        field: 'commandOverride',
        reason: 'control_char'
      }
    }
  }
  if (typeof mutation.changes.args === 'string' && mutation.changes.args.length > 8192) {
    return { ok: false, code: 'invalid_agent_field', field: 'args', reason: 'bounds' }
  }
  const envIssues = validateCustomAgentEnv(mutation.changes.env)
  // Built-in env keeps the shipped permissive shape except hard safety
  // bounds; reserved/prototype checks still apply to new writes.
  const blocking = envIssues.find(
    (issue) =>
      issue.reason === 'prototype_key' ||
      issue.reason === 'control_char' ||
      issue.reason === 'env_total_bounds' ||
      issue.reason === 'bounds'
  )
  if (blocking) {
    return fieldError(blocking)
  }
  const agent = mutation.agent
  const nextCmdOverrides = { ...settings.agentCmdOverrides }
  if (override === null || override === undefined || override.trim().length === 0) {
    delete nextCmdOverrides[agent]
  } else {
    nextCmdOverrides[agent] = override
  }
  const nextArgs = { ...settings.agentDefaultArgs }
  if (mutation.changes.args.trim().length === 0) {
    delete nextArgs[agent]
  } else {
    nextArgs[agent] = mutation.changes.args
  }
  const nextEnv = { ...settings.agentDefaultEnv }
  if (Object.keys(mutation.changes.env).length === 0) {
    delete nextEnv[agent]
  } else {
    nextEnv[agent] = { ...mutation.changes.env }
  }
  return {
    ok: true,
    patch: {
      agentCmdOverrides: nextCmdOverrides,
      agentDefaultArgs: nextArgs,
      agentDefaultEnv: nextEnv,
      agentCatalogRevision: newRevision
    },
    newRevision,
    prunedTombstoneIds: []
  }
}
