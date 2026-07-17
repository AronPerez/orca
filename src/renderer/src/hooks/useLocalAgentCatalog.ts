import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalAgentCatalogSnapshot } from '../../../shared/agent-catalog-snapshot'

export type UseLocalAgentCatalog = {
  /** Null while the first `getLocal` is in flight. */
  snapshot: LocalAgentCatalogSnapshot | null
  loading: boolean
  /** Re-read the local snapshot from the host (desktop preload IPC only). */
  refetch: () => void
  /** Adopt the authoritative snapshot a local mutation just returned, without a
   *  refetch round-trip. Supersedes any in-flight `getLocal`. */
  applySnapshot: (snapshot: LocalAgentCatalogSnapshot) => void
}

/**
 * Live local agent-catalog snapshot for the Settings catalog UI (custom agents,
 * repair rows, projection/storage status). The catalog is desktop-local preload
 * IPC — never a runtime RPC — so this hook is only meaningful on the desktop host.
 *
 * Why: custom agents live in the local snapshot, not in `GlobalSettings`, so the
 * pane cannot derive them from the settings store. Default/disabled selection can
 * still change out-of-band (another window, menu), so we refetch on those narrow
 * settings slices to keep rows and the default picker consistent.
 */
export function useLocalAgentCatalog(): UseLocalAgentCatalog {
  const [snapshot, setSnapshot] = useState<LocalAgentCatalogSnapshot | null>(null)
  const requestTokenRef = useRef(0)
  const mountedRef = useRef(true)

  const load = useCallback(() => {
    const token = (requestTokenRef.current += 1)
    void window.api.settings.agentCatalog.getLocal().then((next) => {
      if (mountedRef.current && token === requestTokenRef.current) {
        setSnapshot(next)
      }
    })
  }, [])

  const applySnapshot = useCallback((next: LocalAgentCatalogSnapshot) => {
    // Bump the token so an in-flight refetch cannot overwrite this fresher result.
    requestTokenRef.current += 1
    setSnapshot(next)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    load()
    const unsubscribe = window.api.settings.onChanged((updates) => {
      // Custom-agent mutations patch customTuiAgents/deletedCustomTuiAgents (and
      // bump agentCatalogRevision); without these keys, always-mounted launch
      // surfaces keep a stale snapshot after authoring in another component.
      if (
        'defaultTuiAgent' in updates ||
        'disabledTuiAgents' in updates ||
        'customTuiAgents' in updates ||
        'deletedCustomTuiAgents' in updates ||
        'agentCatalogRevision' in updates
      ) {
        load()
      }
    })
    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [load])

  return { snapshot, loading: snapshot === null, refetch: load, applySnapshot }
}
