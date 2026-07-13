// Host-private durable persistence for the launch-operation store (U4). Both
// durable halves live in ONE file under the host data dir, never client-synced:
//   • the settled ledger — digests, status, terminal id, and failure id only,
//     non-sensitive by construction, so it is written in plaintext for restart
//     idempotency;
//   • the pending snapshots — they carry argv, the admitted agent env, and the
//     launch token, so they are encrypted at rest via Electron safeStorage (the
//     existing secret-settings standard). A pending snapshot that outlives a
//     main crash is what lets reconciliation re-attribute a terminal by its
//     token, so this map must be durable, not memory-only.
// The file is written with the same atomic tmp+rename + permission-hardening
// discipline as the other host credential stores (writeSecureJsonFile). The
// encode/decode core takes an injected cipher so it is testable without Electron.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
import type {
  AgentLaunchOperationStoreDurableState,
  PendingAgentLaunchSnapshot,
  SettledAgentLaunchOperation
} from './agent-launch-operation-store'
import { getHostAgentLaunchOperationStore } from './agent-launch-operation-store-host'

const STORE_FILENAME = 'agent-launch-operations.json'

export function agentLaunchOperationStorePath(userDataPath: string): string {
  return join(userDataPath, STORE_FILENAME)
}

/** Crypto boundary for the encrypted pending section. Injected so the envelope
 *  round-trip is unit-testable without an Electron/OS keychain. */
export type AgentLaunchOperationCipher = {
  available: () => boolean
  encrypt: (plaintext: string) => Buffer
  decrypt: (ciphertext: Buffer) => string
}

export function electronSafeStorageCipher(): AgentLaunchOperationCipher {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext)
  }
}

type PersistedPendingSection =
  | { format: 'electron-safe-storage-v1'; ciphertext: string }
  // Plaintext fallback only when OS-backed encryption is unavailable; the file
  // itself is still permission-hardened. Matches the secret-settings standard.
  | { format: 'plaintext-v1'; snapshots: PendingAgentLaunchSnapshot[] }

type PersistedFile = {
  version: 1
  settled: SettledAgentLaunchOperation[]
  pending: PersistedPendingSection
}

export function encodeAgentLaunchOperationStore(
  state: AgentLaunchOperationStoreDurableState,
  cipher: AgentLaunchOperationCipher
): PersistedFile {
  const snapshots = [...state.pending]
  const pending: PersistedPendingSection = cipher.available()
    ? {
        format: 'electron-safe-storage-v1',
        ciphertext: cipher.encrypt(JSON.stringify(snapshots)).toString('base64')
      }
    : { format: 'plaintext-v1', snapshots }
  return { version: 1, settled: [...state.settled], pending }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodePending(
  pending: unknown,
  cipher: AgentLaunchOperationCipher
): PendingAgentLaunchSnapshot[] {
  if (!isRecord(pending)) {
    return []
  }
  if (pending.format === 'plaintext-v1' && Array.isArray(pending.snapshots)) {
    return pending.snapshots as PendingAgentLaunchSnapshot[]
  }
  if (
    pending.format === 'electron-safe-storage-v1' &&
    typeof pending.ciphertext === 'string' &&
    cipher.available()
  ) {
    // A decrypt failure (keychain reset) drops only the pending map, never the
    // whole file: reconciliation then treats those launches conservatively
    // rather than mis-attributing, and the settled ledger stays intact.
    const decrypted = cipher.decrypt(Buffer.from(pending.ciphertext, 'base64'))
    const parsed = JSON.parse(decrypted)
    return Array.isArray(parsed) ? (parsed as PendingAgentLaunchSnapshot[]) : []
  }
  return []
}

export function decodeAgentLaunchOperationStore(
  raw: unknown,
  cipher: AgentLaunchOperationCipher
): AgentLaunchOperationStoreDurableState {
  if (!isRecord(raw) || raw.version !== 1) {
    return { pending: [], settled: [] }
  }
  const settled = Array.isArray(raw.settled) ? (raw.settled as SettledAgentLaunchOperation[]) : []
  let pending: PendingAgentLaunchSnapshot[]
  try {
    pending = decodePending(raw.pending, cipher)
  } catch {
    pending = []
  }
  return { pending, settled }
}

export function loadAgentLaunchOperationStoreState(
  path: string,
  cipher: AgentLaunchOperationCipher
): AgentLaunchOperationStoreDurableState {
  if (!existsSync(path)) {
    return { pending: [], settled: [] }
  }
  try {
    hardenExistingSecureFile(path)
    return decodeAgentLaunchOperationStore(JSON.parse(readFileSync(path, 'utf-8')), cipher)
  } catch {
    // A corrupt ledger must never block boot; start empty and let the create/
    // retry path rebuild idempotency state from scratch.
    return { pending: [], settled: [] }
  }
}

export function writeAgentLaunchOperationStoreState(
  path: string,
  state: AgentLaunchOperationStoreDurableState,
  cipher: AgentLaunchOperationCipher
): void {
  writeSecureJsonFile(path, encodeAgentLaunchOperationStore(state, cipher))
}

/** Boot-time wiring: rehydrate the durable state, then attach the write-back
 *  sink so every later mutation is persisted. Called once from the main-process
 *  startup after the user data dir is stable. The startup reconcile trigger that
 *  consumes rehydrated pending snapshots lands with its first producer; the data
 *  is made durable here regardless. */
export function initHostAgentLaunchOperationStorePersistence(userDataPath: string): void {
  const path = agentLaunchOperationStorePath(userDataPath)
  const cipher = electronSafeStorageCipher()
  const state = loadAgentLaunchOperationStoreState(path, cipher)
  const store = getHostAgentLaunchOperationStore()
  store.rebuildSettledFrom(state.settled)
  store.rebuildPendingFrom(state.pending)
  store.setDurablePersistence((next) => {
    try {
      writeAgentLaunchOperationStoreState(path, next, cipher)
    } catch {
      // A failed persist must not break the in-flight launch; the in-memory
      // store stays authoritative and the next mutation retries the write.
    }
  })
}
