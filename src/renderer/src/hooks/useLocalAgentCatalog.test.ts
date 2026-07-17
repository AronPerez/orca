// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { LocalAgentCatalogSnapshot } from '../../../shared/agent-catalog-snapshot'
import { useLocalAgentCatalog } from './useLocalAgentCatalog'

function snapshot(revision: number): LocalAgentCatalogSnapshot {
  return {
    version: 1,
    revision,
    defaultAgent: 'auto',
    disabledAgents: [],
    customAgents: [],
    deletedCustomAgents: [],
    repairIssues: [],
    projection: { status: 'ready', bytes: 0, maxBytes: 524_288 },
    localStorage: { status: 'ready', bytes: 0, maxBytes: 16_777_216 }
  } as LocalAgentCatalogSnapshot
}

const getLocal = vi.fn<() => Promise<LocalAgentCatalogSnapshot>>()
let settingsChangedCallback: ((updates: Record<string, unknown>) => void) | null = null

beforeEach(() => {
  getLocal.mockReset()
  getLocal.mockResolvedValue(snapshot(1))
  settingsChangedCallback = null
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      agentCatalog: { getLocal },
      onChanged: (cb: (updates: Record<string, unknown>) => void) => {
        settingsChangedCallback = cb
        return () => {
          settingsChangedCallback = null
        }
      }
    }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useLocalAgentCatalog', () => {
  it('loads the snapshot on mount and clears the loading flag', async () => {
    const { result } = renderHook(() => useLocalAgentCatalog())
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))
    expect(result.current.loading).toBe(false)
    expect(getLocal).toHaveBeenCalledTimes(1)
  })

  it('adopts a mutation-returned snapshot without a refetch', async () => {
    const { result } = renderHook(() => useLocalAgentCatalog())
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))
    act(() => result.current.applySnapshot(snapshot(4)))
    expect(result.current.snapshot?.revision).toBe(4)
    expect(getLocal).toHaveBeenCalledTimes(1)
  })

  it('refetches when a narrow catalog settings slice changes', async () => {
    getLocal.mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(2))
    const { result } = renderHook(() => useLocalAgentCatalog())
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))

    act(() => settingsChangedCallback?.({ defaultTuiAgent: 'codex' }))
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(2))
    expect(getLocal).toHaveBeenCalledTimes(2)
  })

  it('refetches when custom-agent catalog settings slices change', async () => {
    getLocal
      .mockResolvedValueOnce(snapshot(1))
      .mockResolvedValueOnce(snapshot(2))
      .mockResolvedValueOnce(snapshot(3))
      .mockResolvedValueOnce(snapshot(4))
    const { result } = renderHook(() => useLocalAgentCatalog())
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))

    // Authoring mutations patch these keys; every mounted consumer must refetch.
    act(() => settingsChangedCallback?.({ customTuiAgents: [] }))
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(2))
    act(() => settingsChangedCallback?.({ deletedCustomTuiAgents: [] }))
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(3))
    act(() => settingsChangedCallback?.({ agentCatalogRevision: 7 }))
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(4))
    expect(getLocal).toHaveBeenCalledTimes(4)
  })

  it('ignores unrelated settings changes', async () => {
    const { result } = renderHook(() => useLocalAgentCatalog())
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))
    act(() => settingsChangedCallback?.({ theme: 'dark' }))
    expect(getLocal).toHaveBeenCalledTimes(1)
  })

  it('neither re-renders nor reloads when an unrelated settings slice changes', async () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useLocalAgentCatalog()
    })
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1))
    const rendersAfterLoad = renders
    const snapshotRef = result.current.snapshot
    act(() => settingsChangedCallback?.({ theme: 'dark', fontSize: 14 }))
    // The catalog UI subscribes to no whole-settings store, so an unrelated slice
    // fires no setState: no reload, no re-render, stable snapshot identity (oracle 25).
    expect(getLocal).toHaveBeenCalledTimes(1)
    expect(renders).toBe(rendersAfterLoad)
    expect(result.current.snapshot).toBe(snapshotRef)
  })

  it('does not let a stale in-flight load overwrite an adopted snapshot', async () => {
    let resolveFirst: ((value: LocalAgentCatalogSnapshot) => void) | null = null
    getLocal.mockImplementationOnce(
      () => new Promise<LocalAgentCatalogSnapshot>((resolve) => (resolveFirst = resolve))
    )
    const { result } = renderHook(() => useLocalAgentCatalog())
    act(() => result.current.applySnapshot(snapshot(9)))
    // The mount load resolves late; its result must be ignored.
    act(() => resolveFirst?.(snapshot(1)))
    await waitFor(() => expect(result.current.snapshot?.revision).toBe(9))
  })
})
