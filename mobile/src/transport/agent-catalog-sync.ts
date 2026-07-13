// Why: mobile's per-host cache of the runtime agent catalog. The host owns the
// catalog; mobile only mirrors the env-free revisioned snapshot it publishes on
// `settings.get`, refetching on `agentCatalogChanged` events. Never merges with
// local state and never carries a custom env key or value (env-free by DTO
// construction — no fields are added here).
import type { RpcClient } from './rpc-client'
import type {
  AgentCatalogProjectionError,
  AgentCatalogSnapshot
} from '../../../src/shared/agent-catalog-snapshot'
import {
  createRevisionedSnapshotSync,
  type SnapshotFetchOutcome,
  type SnapshotSyncConnection
} from './revisioned-snapshot-sync'

// The full snapshot or its oversize projection error. Both carry version:1 (the
// client's identity-launch capability signal) and a revision.
export type AgentCatalogValue = AgentCatalogSnapshot | AgentCatalogProjectionError

function parseCatalogValue(raw: unknown): AgentCatalogValue | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const candidate = raw as { version?: unknown; revision?: unknown }
  if (candidate.version !== 1 || typeof candidate.revision !== 'number') {
    return null
  }
  return raw as AgentCatalogValue
}

async function fetchCatalog(client: RpcClient): Promise<SnapshotFetchOutcome<AgentCatalogValue>> {
  let response
  try {
    response = await client.sendRequest('settings.get')
  } catch {
    return { kind: 'unavailable' }
  }
  if (!response || !response.ok) {
    return { kind: 'unavailable' }
  }
  const result = response.result as { agentCatalog?: unknown } | null
  const value = parseCatalogValue(result?.agentCatalog)
  if (!value) {
    return { kind: 'unavailable' }
  }
  const runtimeId = (response as { _meta?: { runtimeId?: string } })._meta?.runtimeId ?? ''
  return { kind: 'value', runtimeId, value }
}

const sync = createRevisionedSnapshotSync<AgentCatalogValue>()

export const agentCatalogSync = {
  getSnapshot: sync.getSnapshot,
  subscribe: sync.subscribe,
  clear: sync.clear,
  openConnection(hostId: string, client: RpcClient): SnapshotSyncConnection {
    return sync.openConnection(hostId, () => fetchCatalog(client))
  }
}
