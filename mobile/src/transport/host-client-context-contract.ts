// Why: the shared-client context contract lives apart from the provider so
// consumer hooks depend on the shape, not the provider's connection plumbing.
import { createContext, useContext } from 'react'
import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { ConnectionState, HostProfile } from './types'

export type HostClientContextValue = {
  acquire: (hostId: string, host?: HostProfile) => RpcClient | null
  release: (hostId: string) => void
  forceReconnect: (hostId: string) => Promise<void>
  closeHost: (hostId: string) => void
  getState: (hostId: string) => ConnectionState
  getReconnectAttempt: (hostId: string) => number
  // Why: timestamp (ms epoch) of the last successful 'connected' state
  // transition for this host, or null if never connected this session.
  // Used by the UI to escalate "Reconnecting…" into a "host appears
  // unreachable, re-pair?" prompt.
  getLastConnectedAt: (hostId: string) => number | null
  getActivePath: (hostId: string) => MobileConnectionPath
  subscribeHostState: (hostId: string, listener: (state: ConnectionState) => void) => () => void
  getAllClients: () => Array<{ hostId: string; client: RpcClient }>
  subscribeAllHosts: (listener: () => void) => () => void
  // Why: lets the home screen feed already-loaded HostProfiles in so we
  // don't pay loadHosts() latency twice (once in the focus-effect, again
  // inside openEntry).
  primeHosts: (hosts: HostProfile[]) => void
}

export const HostClientContext = createContext<HostClientContextValue | null>(null)

export function useHostClientContext(): HostClientContextValue {
  const ctx = useContext(HostClientContext)
  if (!ctx) {
    throw new Error('useHostClient must be used inside <RpcClientProvider>')
  }
  return ctx
}
