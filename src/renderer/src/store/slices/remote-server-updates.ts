import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { RemoteServerUpdaterSnapshot } from '../../../../shared/remote-server-update'
import { isUserManagedRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'
import {
  checkingRemoteServerUpdateEntry,
  inspectRemoteServerUpdate,
  runRemoteServerUpdate,
  type RemoteServerUpdateEntry,
  type RemoteServerUpdateTransport
} from '@/runtime/remote-server-update-coordinator'
import { runRemoteServerUpdateBatch } from '@/runtime/remote-server-update-batch'

const MAX_CONCURRENT_REMOTE_SERVER_UPDATES = 2

function callRemoteUpdater<TResult>(
  environmentId: string,
  method: string,
  params?: unknown,
  timeoutMs = 15_000
): Promise<TResult> {
  return window.api.runtimeEnvironments
    .call({ selector: environmentId, method, params, timeoutMs })
    .then((response) => unwrapRuntimeRpcResult(response as RuntimeRpcResponse<TResult>))
}

const transport: RemoteServerUpdateTransport = {
  getRuntimeStatus: (environmentId, timeoutMs) =>
    window.api.runtimeEnvironments
      .getStatus({ selector: environmentId, timeoutMs })
      .then((response) => unwrapRuntimeRpcResult<RuntimeStatus>(response)),
  getUpdaterStatus: (environmentId) =>
    callRemoteUpdater<RemoteServerUpdaterSnapshot>(environmentId, 'updater.getStatus'),
  check: (environmentId, options) =>
    callRemoteUpdater<RemoteServerUpdaterSnapshot>(environmentId, 'updater.check', options),
  download: (environmentId) =>
    callRemoteUpdater<RemoteServerUpdaterSnapshot>(environmentId, 'updater.download'),
  install: (environmentId) => callRemoteUpdater(environmentId, 'updater.install'),
  wait: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

export type RemoteServerUpdatesSlice = {
  remoteServerUpdates: Map<string, RemoteServerUpdateEntry>
  remoteServerUpdatesChecking: boolean
  remoteServerUpdatesRunning: boolean
  remoteServerUpdateDialogOpen: boolean
  remoteServerUpdatesLastCheckedAt: number | null
  setRemoteServerUpdateDialogOpen: (open: boolean) => void
  refreshRemoteServerUpdates: () => Promise<void>
  startRemoteServerUpdates: (environmentIds?: readonly string[]) => Promise<void>
}

export const createRemoteServerUpdatesSlice: StateCreator<
  AppState,
  [],
  [],
  RemoteServerUpdatesSlice
> = (set, get) => ({
  remoteServerUpdates: new Map(),
  remoteServerUpdatesChecking: false,
  remoteServerUpdatesRunning: false,
  remoteServerUpdateDialogOpen: false,
  remoteServerUpdatesLastCheckedAt: null,

  setRemoteServerUpdateDialogOpen: (open) => set({ remoteServerUpdateDialogOpen: open }),

  refreshRemoteServerUpdates: async () => {
    if (get().remoteServerUpdatesChecking || get().remoteServerUpdatesRunning) {
      return
    }
    set({ remoteServerUpdatesChecking: true })
    try {
      const listed = await window.api.runtimeEnvironments.list()
      const environments = listed.filter(isUserManagedRuntimeEnvironment)
      get().setRuntimeEnvironments(listed)
      const initial = new Map(
        environments.map((environment) => [
          environment.id,
          checkingRemoteServerUpdateEntry(environment)
        ])
      )
      set({ remoteServerUpdates: initial })
      const clientVersion = await window.api.updater.getVersion()
      await Promise.allSettled(
        environments.map(async (environment) => {
          const entry = await inspectRemoteServerUpdate(environment, clientVersion, transport)
          set((state) => {
            const next = new Map(state.remoteServerUpdates)
            next.set(environment.id, entry)
            return { remoteServerUpdates: next }
          })
        })
      )
      set({ remoteServerUpdatesLastCheckedAt: Date.now() })
    } finally {
      set({ remoteServerUpdatesChecking: false })
    }
  },

  startRemoteServerUpdates: async (environmentIds) => {
    if (get().remoteServerUpdatesRunning) {
      return
    }
    const selected = new Set(environmentIds ?? [])
    const entries = [...get().remoteServerUpdates.values()].filter(
      (entry) =>
        (entry.phase === 'available' || entry.phase === 'failed') &&
        (selected.size === 0 || selected.has(entry.environmentId))
    )
    if (entries.length === 0) {
      return
    }
    set((state) => {
      const next = new Map(state.remoteServerUpdates)
      for (const entry of entries) {
        next.set(entry.environmentId, { ...entry, phase: 'queued', error: null })
      }
      return { remoteServerUpdates: next, remoteServerUpdatesRunning: true }
    })
    try {
      await runRemoteServerUpdateBatch(
        entries,
        MAX_CONCURRENT_REMOTE_SERVER_UPDATES,
        async (entry) => {
          await runRemoteServerUpdate(entry, transport, (progress) => {
            set((state) => {
              const next = new Map(state.remoteServerUpdates)
              next.set(entry.environmentId, progress)
              return { remoteServerUpdates: next }
            })
          })
        }
      )
    } finally {
      set({ remoteServerUpdatesRunning: false, remoteServerUpdatesLastCheckedAt: Date.now() })
    }
  }
})
