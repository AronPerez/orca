export type MessageType =
  | 'status'
  | 'dispatch'
  | 'worker_done'
  | 'merge_ready'
  | 'escalation'
  | 'handoff'
  | 'decision_gate'
  | 'heartbeat'

export type MessagePriority = 'normal' | 'high' | 'urgent'

export type TaskStatus = 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'

// `forgotten` (U6) is an additive terminal disposition: an owner forgot a
// dispatch stranded in `launch_state_unknown`. Old readers that predate it must
// see legacy `failed` (projectDispatchStatusForLegacyReaders) because the remote
// process may still exist, so the task blocks until an explicit Retry.
export type DispatchStatus =
  | 'pending'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'circuit_broken'
  | 'forgotten'

/** Project a dispatch status for a reader that lacks the additive `forgotten`
 *  disposition. Every other status is unchanged. */
export function projectDispatchStatusForLegacyReaders(
  status: DispatchStatus
): Exclude<DispatchStatus, 'forgotten'> {
  return status === 'forgotten' ? 'failed' : status
}

export type GateStatus = 'pending' | 'resolved' | 'timeout'

export type CoordinatorStatus = 'idle' | 'running' | 'completed' | 'failed'

export type MessageRow = {
  id: string
  from_handle: string
  to_handle: string
  subject: string
  body: string
  type: MessageType
  priority: MessagePriority
  thread_id: string | null
  payload: string | null
  read: number
  sequence: number
  created_at: string
  delivered_at: string | null
  sender_pane_key: string | null
}

export type TaskRow = {
  id: string
  parent_id: string | null
  created_by_terminal_handle: string | null
  task_title: string | null
  display_name: string | null
  spec: string
  status: TaskStatus
  deps: string
  result: string | null
  created_at: string
  completed_at: string | null
}

export type DispatchContextRow = {
  id: string
  task_id: string
  assignee_handle: string | null
  assignee_pane_key: string | null
  status: DispatchStatus
  failure_count: number
  last_failure: string | null
  dispatched_at: string | null
  completed_at: string | null
  created_at: string
  last_heartbeat_at: string | null
  // U6 additive columns (all nullable; old rows read null and old readers ignore
  // them, keeping `last_failure`). requested/base identity validate launch
  // ownership; agent_launch_failure is the JSON-encoded structured launch
  // failure alongside the retained generic `last_failure` string.
  requested_agent: string | null
  base_agent: string | null
  agent_launch_failure: string | null
}

export type DecisionGateRow = {
  id: string
  task_id: string
  question: string
  options: string
  status: GateStatus
  resolution: string | null
  created_at: string
  resolved_at: string | null
}

export type CoordinatorRun = {
  id: string
  spec: string
  status: CoordinatorStatus
  coordinator_handle: string
  poll_interval_ms: number
  created_at: string
  completed_at: string | null
}
