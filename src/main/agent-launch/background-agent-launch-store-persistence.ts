// Host-private durable persistence for the generic background-attempt store
// (U6). The store's contract is that an unattended failure SURVIVES RELOAD and
// keeps rendering its recovery card on the worktree, so the attempts must be on
// disk, not memory-only. Every field is client-safe by construction (ids,
// display attribution, code+hint failure — never argv/env/token; see
// shared/background-agent-launch.ts), so the file is plaintext JSON, written
// with the same atomic tmp+rename + permission-hardening discipline as the
// sibling launch stores. Each row re-validates through the strict shared schema
// on load so one corrupt entry never aborts rehydrating the rest.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
import {
  parseBackgroundAgentLaunchAttempt,
  type BackgroundAgentLaunchAttempt
} from '../../shared/background-agent-launch'
import type { BackgroundAgentLaunchStore } from './background-agent-launch-store'
import { getHostBackgroundAgentLaunchStore } from './background-agent-launch-store-host'

const STORE_FILENAME = 'background-agent-launches.json'

export function backgroundAgentLaunchStorePath(userDataPath: string): string {
  return join(userDataPath, STORE_FILENAME)
}

type PersistedFile = {
  version: 1
  attempts: BackgroundAgentLaunchAttempt[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function loadBackgroundAgentLaunchAttempts(path: string): BackgroundAgentLaunchAttempt[] {
  if (!existsSync(path)) {
    return []
  }
  try {
    hardenExistingSecureFile(path)
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.attempts)) {
      return []
    }
    return raw.attempts
      .map((entry) => parseBackgroundAgentLaunchAttempt(entry))
      .filter((attempt): attempt is BackgroundAgentLaunchAttempt => attempt !== null)
  } catch {
    // A corrupt store must never block boot; start empty and let reconciliation
    // rebuild what the live terminals still evidence.
    return []
  }
}

export function writeBackgroundAgentLaunchAttempts(
  path: string,
  attempts: readonly BackgroundAgentLaunchAttempt[]
): void {
  const file: PersistedFile = { version: 1, attempts: [...attempts] }
  writeSecureJsonFile(path, file)
}

/** Path-injected core of the boot wiring, split out so the rebuild + sink
 *  round-trip is unit-testable against a temp dir. */
export function initBackgroundAgentLaunchStorePersistence(
  store: BackgroundAgentLaunchStore,
  path: string
): void {
  store.rebuildFrom(loadBackgroundAgentLaunchAttempts(path))
  store.setDurablePersistence((next) => {
    try {
      writeBackgroundAgentLaunchAttempts(path, next.attempts)
    } catch {
      // A failed persist must not break the in-flight attempt; the in-memory
      // store stays authoritative and the next mutation retries the write.
    }
  })
}

/** Boot-time wiring: rehydrate durable attempts, then attach the write-back
 *  sink so every later create/settle/forget is persisted. Called once from the
 *  launch-bookkeeping boot seam after the user data dir is stable. */
export function initHostBackgroundAgentLaunchStorePersistence(userDataPath: string): void {
  initBackgroundAgentLaunchStorePersistence(
    getHostBackgroundAgentLaunchStore(),
    backgroundAgentLaunchStorePath(userDataPath)
  )
}
