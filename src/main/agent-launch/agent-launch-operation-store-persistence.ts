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
  AgentLaunchOperationStore,
  AgentLaunchOperationStoreDurableState,
  PendingAgentLaunchSnapshot,
  SettledAgentLaunchOperation
} from './agent-launch-operation-store'
import type { AdmittedLaunchRecord } from './agent-launch-admission-store'
import { getHostAgentLaunchOperationStore } from './agent-launch-operation-store-host'
import { getHostAgentLaunchBoundary } from './agent-launch-boundary-host'
import { getHostBackgroundAgentLaunchStore } from './background-agent-launch-store-host'
import { initHostBackgroundAgentLaunchStorePersistence } from './background-agent-launch-store-persistence'

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

/** Per-entry shape guard for rehydrated pending snapshots: reconciliation
 *  dereferences snapshot.target.executionHostId (and joins on the ids) with no
 *  per-entry try/catch, so one malformed entry must be skipped at load rather
 *  than throwing inside every reconcile pass. */
function isPendingAgentLaunchSnapshotShape(value: unknown): value is PendingAgentLaunchSnapshot {
  if (!isRecord(value)) {
    return false
  }
  const snapshot = value.snapshot
  return (
    typeof value.operationId === 'string' &&
    typeof value.idempotencyKey === 'string' &&
    typeof value.scope === 'string' &&
    (value.clientMutationId === null || typeof value.clientMutationId === 'string') &&
    typeof value.payloadDigest === 'string' &&
    typeof value.launchToken === 'string' &&
    typeof value.intent === 'string' &&
    isRecord(snapshot) &&
    Array.isArray(snapshot.argv) &&
    isRecord(snapshot.target) &&
    typeof snapshot.target.executionHostId === 'string'
  )
}

function isAdmissionPrincipalShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  return value.kind === 'local' || (value.kind === 'remote' && typeof value.id === 'string')
}

function validPendingSnapshots(entries: unknown[]): PendingAgentLaunchSnapshot[] {
  // A malformed principal is stripped rather than dropping the whole snapshot:
  // crash-recovery attribution matters more than the capacity bucket, and a
  // missing principal rebuilds as local.
  return entries.filter(isPendingAgentLaunchSnapshotShape).map((entry) => {
    if (entry.principal === undefined || isAdmissionPrincipalShape(entry.principal)) {
      return entry
    }
    const { principal: _dropped, ...rest } = entry
    return rest
  })
}

/** Load/decode outcome. `decryptionUnavailable` marks an encrypted pending
 *  section the OS cipher could not read at load (locked/late keychain): the
 *  snapshots are intact on disk, just unreadable NOW, so the write-back sink
 *  must not attach — otherwise the first mutation after boot would overwrite
 *  the crash-recovery snapshots with the empty in-memory set. */
export type AgentLaunchOperationStoreLoadResult = AgentLaunchOperationStoreDurableState & {
  decryptionUnavailable: boolean
}

function decodePending(
  pending: unknown,
  cipher: AgentLaunchOperationCipher
): { snapshots: PendingAgentLaunchSnapshot[]; decryptionUnavailable: boolean } {
  if (!isRecord(pending)) {
    return { snapshots: [], decryptionUnavailable: false }
  }
  if (pending.format === 'plaintext-v1' && Array.isArray(pending.snapshots)) {
    return { snapshots: validPendingSnapshots(pending.snapshots), decryptionUnavailable: false }
  }
  if (pending.format === 'electron-safe-storage-v1' && typeof pending.ciphertext === 'string') {
    if (!cipher.available()) {
      // Transient: a locked/late keychain at boot. The ciphertext is still
      // valid, so flag it rather than treating the store as empty.
      return { snapshots: [], decryptionUnavailable: true }
    }
    // A decrypt failure with an AVAILABLE cipher (keychain reset) drops only the
    // pending map, never the whole file: reconciliation then treats those
    // launches conservatively rather than mis-attributing, and the settled
    // ledger stays intact.
    const decrypted = cipher.decrypt(Buffer.from(pending.ciphertext, 'base64'))
    const parsed = JSON.parse(decrypted)
    return {
      snapshots: Array.isArray(parsed) ? validPendingSnapshots(parsed) : [],
      decryptionUnavailable: false
    }
  }
  return { snapshots: [], decryptionUnavailable: false }
}

export function decodeAgentLaunchOperationStore(
  raw: unknown,
  cipher: AgentLaunchOperationCipher
): AgentLaunchOperationStoreLoadResult {
  if (!isRecord(raw) || raw.version !== 1) {
    return { pending: [], settled: [], decryptionUnavailable: false }
  }
  const settled = Array.isArray(raw.settled) ? (raw.settled as SettledAgentLaunchOperation[]) : []
  try {
    const pending = decodePending(raw.pending, cipher)
    return {
      pending: pending.snapshots,
      settled,
      decryptionUnavailable: pending.decryptionUnavailable
    }
  } catch {
    return { pending: [], settled, decryptionUnavailable: false }
  }
}

export function loadAgentLaunchOperationStoreState(
  path: string,
  cipher: AgentLaunchOperationCipher
): AgentLaunchOperationStoreLoadResult {
  if (!existsSync(path)) {
    return { pending: [], settled: [], decryptionUnavailable: false }
  }
  try {
    hardenExistingSecureFile(path)
    return decodeAgentLaunchOperationStore(JSON.parse(readFileSync(path, 'utf-8')), cipher)
  } catch {
    // A corrupt ledger must never block boot; start empty and let the create/
    // retry path rebuild idempotency state from scratch.
    return { pending: [], settled: [], decryptionUnavailable: false }
  }
}

export function writeAgentLaunchOperationStoreState(
  path: string,
  state: AgentLaunchOperationStoreDurableState,
  cipher: AgentLaunchOperationCipher
): void {
  writeSecureJsonFile(path, encodeAgentLaunchOperationStore(state, cipher))
}

/** Reconstruct the admission records the rehydrated pending snapshots hold
 *  capacity for, so a restart keeps counting launch_state_unknown launches
 *  against the per-host/per-principal caps and Forget's release finds them. */
export function admittedLaunchRecordsFromPendingSnapshots(
  pending: readonly PendingAgentLaunchSnapshot[],
  deps: {
    /** Background launches scope by attempt id; the attempt names the worktree. */
    worktreeIdForBackgroundScope: (attemptId: string) => string | null
    now: () => number
  }
): AdmittedLaunchRecord[] {
  return pending.map((entry) => ({
    launchToken: entry.launchToken,
    // Entries persisted before the principal field default to local: a
    // wrong-bucket count still holds capacity and releases by token.
    principal: entry.principal ?? { kind: 'local' },
    intent: entry.intent,
    scope: entry.scope,
    worktreeId:
      entry.intent === 'interactive' || entry.intent === 'cli' || entry.intent === 'resume'
        ? entry.scope
        : entry.intent === 'background'
          ? deps.worktreeIdForBackgroundScope(entry.scope)
          : null,
    // The fingerprint only guards the admission-time recheck and is never
    // re-read after commit; admittedAt only orders capacity-recovery rows.
    // Neither is persisted, so rebuild with stand-ins.
    fingerprint: entry.payloadDigest,
    snapshot: entry.snapshot,
    admittedAt: deps.now()
  }))
}

/** Cipher-injected core of the boot wiring, split out so the locked-keychain
 *  recovery path and the admission rebuild are unit-testable without Electron. */
export function initAgentLaunchOperationStorePersistence(
  store: AgentLaunchOperationStore,
  path: string,
  cipher: AgentLaunchOperationCipher,
  deps: {
    rebuildAdmission: (records: AdmittedLaunchRecord[]) => void
    worktreeIdForBackgroundScope: (attemptId: string) => string | null
    now?: () => number
  }
): void {
  const state = loadAgentLaunchOperationStoreState(path, cipher)
  store.rebuildSettledFrom(state.settled)
  store.rebuildPendingFrom(state.pending)
  // Re-take the capacity these rehydrated launches held before the restart;
  // Forget/reconcile then release the exact slot instead of no-opping.
  deps.rebuildAdmission(
    admittedLaunchRecordsFromPendingSnapshots(state.pending, {
      worktreeIdForBackgroundScope: deps.worktreeIdForBackgroundScope,
      now: deps.now ?? Date.now
    })
  )
  const attachWriteBackSink = (): void => {
    store.setDurablePersistence((next) => {
      try {
        writeAgentLaunchOperationStoreState(path, next, cipher)
      } catch {
        // A failed persist must not break the in-flight launch; the in-memory
        // store stays authoritative and the next mutation retries the write.
      }
    })
  }
  if (!state.decryptionUnavailable) {
    attachWriteBackSink()
    return
  }
  // Locked/late keychain at boot: the encrypted pending snapshots are intact on
  // disk but unreadable NOW. A plain write-back sink would overwrite them with
  // the empty in-memory map on the first mutation, so attach a recovery sink
  // that re-probes the cipher per durable mutation and, once decryption works,
  // merges the on-disk state under the in-memory one before taking over.
  store.setDurablePersistence(() => {
    if (!cipher.available()) {
      return
    }
    try {
      const onDisk = loadAgentLaunchOperationStoreState(path, cipher)
      const live = store.durableState()
      // Maps key pendings by token and the ledger replaces by operationId in
      // settledAt order, so disk-first + live-second prefers the live state.
      const liveTokens = new Set(live.pending.map((entry) => entry.launchToken))
      store.rebuildPendingFrom([
        ...onDisk.pending.filter((entry) => !liveTokens.has(entry.launchToken)),
        ...live.pending
      ])
      store.rebuildSettledFrom([...onDisk.settled, ...live.settled])
      attachWriteBackSink()
      writeAgentLaunchOperationStoreState(path, store.durableState(), cipher)
    } catch {
      // Keep the recovery sink armed; the next mutation retries.
    }
  })
}

/** Boot-time wiring: rehydrate the durable state (operation ledger + pending
 *  snapshots, the background attempt store, and the admission capacity those
 *  pendings hold), then attach the write-back sink so every later mutation is
 *  persisted. Called once from the main-process startup after the user data dir
 *  is stable. */
export function initHostAgentLaunchOperationStorePersistence(userDataPath: string): void {
  // The background attempt store rehydrates first so the admission rebuild
  // below can resolve background scopes (attempt ids) to their worktrees.
  // Chained here because this is the one durable launch-bookkeeping boot seam.
  initHostBackgroundAgentLaunchStorePersistence(userDataPath)
  initAgentLaunchOperationStorePersistence(
    getHostAgentLaunchOperationStore(),
    agentLaunchOperationStorePath(userDataPath),
    electronSafeStorageCipher(),
    {
      rebuildAdmission: (records) => getHostAgentLaunchBoundary().rebuildAdmissionFrom(records),
      worktreeIdForBackgroundScope: (attemptId) =>
        getHostBackgroundAgentLaunchStore().get(attemptId)?.worktreeId ?? null
    }
  )
}
