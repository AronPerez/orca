/**
 * Runs an async task with single-flight semantics: the first request starts the task
 * immediately, and any requests that arrive while a run is in flight collapse into
 * exactly one trailing re-run once the current run settles.
 *
 * Why: staggered runtime reconnects on wake each triggered the sidebar worktree refresh
 * (#8539), piling up K synchronous full-sidebar remounts and freezing the UI. Bounding
 * work to at most one in-flight run plus one queued rerun removes the pile-up for any K,
 * without delaying an isolated refresh (a request that arrives while idle runs at once).
 */
export type SingleFlightCoalescer = {
  /** Ask the task to run; coalesces into the in-flight run if one is active. */
  request: () => void
}

export function createSingleFlightCoalescer(task: () => Promise<unknown>): SingleFlightCoalescer {
  let inFlight = false
  let pending = false

  const run = (): void => {
    inFlight = true
    // Defer into a microtask so a synchronous throw in `task` can't escape and leave
    // `inFlight` stuck true (which would wedge every future request).
    Promise.resolve()
      .then(task)
      .catch(() => {})
      .finally(() => {
        inFlight = false
        if (!pending) {
          return
        }
        pending = false
        run()
      })
  }

  return {
    request: () => {
      if (inFlight) {
        pending = true
        return
      }
      run()
    }
  }
}
