// Maps a host-resolved agent-launch failure/rejection (U3) to a localized,
// user-facing message. The host returns a typed AgentLaunchSpawnOutcome for
// pre-spawn failures; every launch surface renders the same copy through its
// existing error affordance (toast/error state). Keep messages client-safe:
// the failure carries only codes and repair hints, never argv/env/paths/labels,
// so copy stays generic and points the user at Settings when a fix is needed.

import { translate } from '@/i18n/i18n'
import type {
  AgentLaunchFailure,
  AgentLaunchFailureCode,
  AgentLaunchRequestError
} from '../../../shared/agent-launch-contract'
import type { AgentLaunchSpawnOutcome } from '../../../shared/agent-launch-spawn-request'

/** Which surface renders the failure. `agent_configuration_changed` reads
 *  differently on the durable post-create card (the change happened mid-create)
 *  versus a pre-spawn launch surface (the change happened before launch). */
export type AgentLaunchFailureSurface = 'post-create' | 'pre-spawn'

function failureCodeMessage(
  code: AgentLaunchFailureCode,
  surface: AgentLaunchFailureSurface
): string {
  switch (code) {
    case 'unknown_agent':
      return translate(
        'agentLaunch.failure.unknownAgent',
        'That agent no longer exists. Pick another agent and try again.'
      )
    case 'no_agent_selected':
      return translate('agentLaunch.failure.noAgentSelected', 'Select an agent before launching.')
    case 'agent_definition_needs_repair':
      return translate(
        'agentLaunch.failure.needsRepair',
        "This agent's setup is incomplete. Finish configuring it in Settings, then try again."
      )
    case 'custom_agent_disabled':
      return translate(
        'agentLaunch.failure.customDisabled',
        'This agent is turned off. Enable it in Settings to launch it.'
      )
    case 'agent_configuration_changed':
      // Retry is an explicit adoption of the now-current configuration; the copy
      // names when the change happened so the user isn't sent to Settings to
      // "review" a change that Retry already adopts.
      return surface === 'post-create'
        ? translate(
            'agentLaunch.failure.configurationChangedPostCreate',
            'Agent settings changed while this workspace was being created. Retry to launch with the current settings, or choose another agent.'
          )
        : translate(
            'agentLaunch.failure.configurationChangedPreSpawn',
            'Agent settings changed before launch. Retry with the current settings, or choose another agent.'
          )
    case 'base_agent_disabled':
      return translate(
        'agentLaunch.failure.baseDisabled',
        'The underlying agent is turned off. Enable it in Settings to launch.'
      )
    case 'base_agent_unavailable':
      return translate(
        'agentLaunch.failure.baseUnavailable',
        "The underlying agent isn't available on this host."
      )
    case 'missing_variable':
      return translate(
        'agentLaunch.failure.missingVariable',
        "Couldn't resolve the workspace path for this launch."
      )
    case 'missing_target_home':
      return translate(
        'agentLaunch.failure.missingTargetHome',
        "Couldn't resolve the home directory on the target host."
      )
    case 'invalid_command_override':
      return translate(
        'agentLaunch.failure.invalidCommandOverride',
        "This agent's command override is invalid. Fix it in Settings."
      )
    case 'invalid_agent_args':
      return translate(
        'agentLaunch.failure.invalidArgs',
        "This agent's launch arguments are invalid. Fix them in Settings."
      )
    case 'invalid_agent_env':
      return translate(
        'agentLaunch.failure.invalidEnv',
        "This agent's launch environment is invalid. Fix it in Settings."
      )
    case 'secure_env_transport_unavailable':
      return translate(
        'agentLaunch.failure.secureEnvUnavailable',
        "Can't securely send this agent's environment to the remote host."
      )
    case 'launch_command_too_long':
      return translate(
        'agentLaunch.failure.commandTooLong',
        'The launch command is too long to run. Shorten the agent arguments or prompt.'
      )
    case 'invalid_launch_snapshot':
      return translate(
        'agentLaunch.failure.invalidSnapshot',
        "This agent's saved launch details are no longer valid."
      )
    case 'trust_preflight_failed':
      return translate(
        'agentLaunch.failure.trustPreflightFailed',
        "Couldn't confirm workspace trust for this agent. Try again."
      )
    case 'spawn_failed':
      return translate(
        'agentLaunch.failure.spawnFailed',
        "The agent couldn't be started. Try again."
      )
    case 'launch_state_unknown':
      return translate(
        'agentLaunch.failure.stateUnknown',
        'The launch status is unknown. Check the terminal before retrying.'
      )
    case 'launch_capacity_exceeded':
      // Never implies the agent definition itself is invalid; points at the
      // capacity-recovery affordance instead of a passive "wait".
      return translate(
        'agentLaunch.failure.capacityExceeded',
        'Too many agent launches are still pending on this host. Reconnect or forget stranded launches, then try again.'
      )
  }
}

/** Localized copy for a launch-attempt failure. `surface` selects owner-accurate
 *  copy for `agent_configuration_changed`; it defaults to a pre-spawn launch
 *  surface (composer/dialog/picker), and the durable post-create card passes
 *  'post-create'. */
export function agentLaunchFailureMessage(
  failure: AgentLaunchFailure,
  surface: AgentLaunchFailureSurface = 'pre-spawn'
): string {
  return failureCodeMessage(failure.code, surface)
}

/** Localized copy for a request/control-plane rejection (no launch attempt). */
export function agentLaunchRequestErrorMessage(error: AgentLaunchRequestError): string {
  switch (error.code) {
    case 'idempotency_conflict':
      return translate(
        'agentLaunch.requestError.idempotencyConflict',
        'This launch is already in progress.'
      )
    case 'stale_agent_launch_failure':
      return translate(
        'agentLaunch.requestError.staleFailure',
        'This launch was already resolved. Refresh and try again.'
      )
    case 'untrusted_reference':
      return translate(
        'agentLaunch.requestError.untrustedReference',
        "This launch source couldn't be verified."
      )
  }
}

/** Localized copy for either arm of a non-launched AgentLaunchSpawnOutcome. */
export function agentLaunchOutcomeErrorMessage(
  outcome: Extract<AgentLaunchSpawnOutcome, { status: 'failed' | 'rejected' }>
): string {
  return outcome.status === 'failed'
    ? agentLaunchFailureMessage(outcome.failure)
    : agentLaunchRequestErrorMessage(outcome.requestError)
}
