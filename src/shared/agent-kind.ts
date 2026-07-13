// Mapping from the renderer's `TuiAgent` union (every agent Orca knows how
// to launch) to the closed `agentKindSchema` enum on telemetry events. Every
// shipped agent maps to a concrete telemetry value so dashboards can
// distinguish launch interest instead of collapsing the long tail to `other`.
//
// Lives in `src/shared/` (not the renderer) because main-side telemetry
// emission (`agent_started` from the `pty:spawn` IPC handler) needs the
// same mapping. Centralizing here means a new TuiAgent member is one edit,
// not a sweep across renderer + main.

import type { AgentKind } from './telemetry-events'
import type { BuiltInTuiAgent } from './types'

type ConcreteAgentKind = Exclude<AgentKind, 'other'>

const TUI_AGENT_KIND_BY_AGENT = {
  claude: 'claude-code',
  'claude-agent-teams': 'claude-agent-teams',
  openclaude: 'openclaude',
  codex: 'codex',
  autohand: 'autohand',
  opencode: 'opencode',
  'mimo-code': 'mimo-code',
  pi: 'pi',
  omp: 'omp',
  gemini: 'gemini',
  antigravity: 'antigravity',
  aider: 'aider',
  goose: 'goose',
  amp: 'amp',
  kilo: 'kilo',
  kiro: 'kiro',
  crush: 'crush',
  aug: 'aug',
  cline: 'cline',
  codebuff: 'codebuff',
  'command-code': 'command-code',
  continue: 'continue',
  cursor: 'cursor',
  droid: 'droid',
  kimi: 'kimi',
  'mistral-vibe': 'mistral-vibe',
  'qwen-code': 'qwen-code',
  rovo: 'rovo',
  hermes: 'hermes',
  openclaw: 'openclaw',
  copilot: 'copilot',
  grok: 'grok',
  devin: 'devin',
  ante: 'ante'
} satisfies Record<BuiltInTuiAgent, ConcreteAgentKind>

// Why: `satisfies Record<BuiltInTuiAgent, …>` makes the lookup exhaustive at
// compile time, but stale persisted settings or unsafe IPC casts can carry a
// string outside the union at runtime — fall back to `'other'` so the event
// still emits instead of failing validation and dropping silently. Custom ids
// must be resolved to their catalog-proven base (resolveTuiAgentBaseAgent /
// getAgentIdentity) before calling this; null means "no proven base".
export function tuiAgentToAgentKind(agent: BuiltInTuiAgent | null | undefined): AgentKind {
  return (agent && TUI_AGENT_KIND_BY_AGENT[agent]) || 'other'
}

// Why: the worktree-initial-terminal launch path only carries the telemetry
// `agent_kind`, not the TuiAgent. Reverse the map so that path can stamp the
// tab's launch agent without threading TuiAgent through every startup builder.
const AGENT_BY_TUI_AGENT_KIND: Partial<Record<AgentKind, BuiltInTuiAgent>> = Object.fromEntries(
  Object.entries(TUI_AGENT_KIND_BY_AGENT).map(([agent, kind]) => [kind, agent as BuiltInTuiAgent])
)

export function agentKindToTuiAgent(kind: AgentKind | null | undefined): BuiltInTuiAgent | null {
  if (!kind) {
    return null
  }
  return AGENT_BY_TUI_AGENT_KIND[kind] ?? null
}
