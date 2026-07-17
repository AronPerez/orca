// Host-private durable persistence for the session record store (U5). Records
// carry the immutable launch snapshot (resolved argv + admitted agent env) and,
// for legacy handoffs, the opaque replay config — both secret-bearing — plus the
// launch token, so the whole record set is encrypted at rest via Electron
// safeStorage (the secret-settings standard), with a permission-hardened plaintext
// fallback only when OS-backed encryption is unavailable. Written with the same
// atomic tmp+rename discipline as the launch-operation store. The encode/decode
// core takes an injected cipher so the envelope round-trip is testable without
// Electron. This file is never client-synced.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
import type {
  AgentSessionRecordStore,
  AgentSessionRecordStoreDurableState,
  HostSessionLaunchRecord
} from './agent-session-record-store'
import { getHostAgentSessionRecordStore } from './agent-session-record-store-host'

const STORE_FILENAME = 'agent-session-records.json'

export function agentSessionRecordStorePath(userDataPath: string): string {
  return join(userDataPath, STORE_FILENAME)
}

/** Crypto boundary for the encrypted records section. Injected so the envelope
 *  round-trip is unit-testable without an Electron/OS keychain. */
export type AgentSessionRecordCipher = {
  available: () => boolean
  encrypt: (plaintext: string) => Buffer
  decrypt: (ciphertext: Buffer) => string
}

export function electronSafeStorageCipher(): AgentSessionRecordCipher {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext)
  }
}

type PersistedRecordsSection =
  | { format: 'electron-safe-storage-v1'; ciphertext: string }
  | { format: 'plaintext-v1'; records: HostSessionLaunchRecord[] }

type PersistedFile = {
  version: 1
  records: PersistedRecordsSection
}

export function encodeAgentSessionRecordStore(
  state: AgentSessionRecordStoreDurableState,
  cipher: AgentSessionRecordCipher
): PersistedFile {
  const records = [...state.records]
  const section: PersistedRecordsSection = cipher.available()
    ? {
        format: 'electron-safe-storage-v1',
        ciphertext: cipher.encrypt(JSON.stringify(records)).toString('base64')
      }
    : { format: 'plaintext-v1', records }
  return { version: 1, records: section }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Load/decode outcome. `decryptionUnavailable` marks an encrypted section the OS
 *  cipher could not read at load (locked/late keychain): the persisted records
 *  are intact on disk, just unreadable NOW, so write-back must be skipped —
 *  otherwise the next durable mutation would overwrite them with the empty set. */
export type AgentSessionRecordStoreLoadResult = {
  records: HostSessionLaunchRecord[]
  decryptionUnavailable: boolean
}

function decodeRecords(
  section: unknown,
  cipher: AgentSessionRecordCipher
): AgentSessionRecordStoreLoadResult {
  if (!isRecord(section)) {
    return { records: [], decryptionUnavailable: false }
  }
  if (section.format === 'plaintext-v1' && Array.isArray(section.records)) {
    return {
      records: section.records as HostSessionLaunchRecord[],
      decryptionUnavailable: false
    }
  }
  if (section.format === 'electron-safe-storage-v1' && typeof section.ciphertext === 'string') {
    if (!cipher.available()) {
      // Transient: a locked/late keychain at boot. The ciphertext is still
      // valid, so flag it rather than treating the store as empty.
      return { records: [], decryptionUnavailable: true }
    }
    // A decrypt failure with an AVAILABLE cipher (keychain reset) is permanent:
    // it drops only the records, never blocks boot — those sessions then require
    // an explicit current-settings relaunch rather than a mis-attributed replay.
    const parsed = JSON.parse(cipher.decrypt(Buffer.from(section.ciphertext, 'base64')))
    return {
      records: Array.isArray(parsed) ? (parsed as HostSessionLaunchRecord[]) : [],
      decryptionUnavailable: false
    }
  }
  return { records: [], decryptionUnavailable: false }
}

export function decodeAgentSessionRecordStore(
  raw: unknown,
  cipher: AgentSessionRecordCipher
): AgentSessionRecordStoreLoadResult {
  if (!isRecord(raw) || raw.version !== 1) {
    return { records: [], decryptionUnavailable: false }
  }
  try {
    return decodeRecords(raw.records, cipher)
  } catch {
    return { records: [], decryptionUnavailable: false }
  }
}

export function loadAgentSessionRecordStoreState(
  path: string,
  cipher: AgentSessionRecordCipher
): AgentSessionRecordStoreLoadResult {
  if (!existsSync(path)) {
    return { records: [], decryptionUnavailable: false }
  }
  try {
    hardenExistingSecureFile(path)
    return decodeAgentSessionRecordStore(JSON.parse(readFileSync(path, 'utf-8')), cipher)
  } catch {
    // A corrupt store must never block boot; start empty and let live sessions
    // rebind on their next hook.
    return { records: [], decryptionUnavailable: false }
  }
}

export function writeAgentSessionRecordStoreState(
  path: string,
  state: AgentSessionRecordStoreDurableState,
  cipher: AgentSessionRecordCipher
): void {
  writeSecureJsonFile(path, encodeAgentSessionRecordStore(state, cipher))
}

/** Boot-time wiring: rehydrate durable records, then attach the write-back sink so
 *  every later bind/ingest/forget is persisted. Called once from main-process
 *  startup after the user data dir is stable. */
export function initHostAgentSessionRecordStorePersistence(userDataPath: string): void {
  const path = agentSessionRecordStorePath(userDataPath)
  const cipher = electronSafeStorageCipher()
  initAgentSessionRecordStorePersistence(getHostAgentSessionRecordStore(), path, cipher)
}

/** Cipher-injected core of the boot wiring, split out so the locked-keychain
 *  recovery path is unit-testable without Electron. */
export function initAgentSessionRecordStorePersistence(
  store: AgentSessionRecordStore,
  path: string,
  cipher: AgentSessionRecordCipher
): void {
  const state = loadAgentSessionRecordStoreState(path, cipher)
  store.rebuildRecordsFrom(state.records)
  const attachWriteBackSink = (): void => {
    store.setDurablePersistence((next) => {
      try {
        writeAgentSessionRecordStoreState(path, next, cipher)
      } catch {
        // A failed persist must not break an in-flight bind; the in-memory store
        // stays authoritative and the next mutation retries the write.
      }
    })
  }
  if (!state.decryptionUnavailable) {
    attachWriteBackSink()
    return
  }
  // Locked/late keychain at boot: the ciphertext on disk is intact but
  // unreadable NOW. A plain write-back sink would overwrite it with the empty
  // in-memory set on the first mutation, so instead attach a recovery sink that
  // re-probes the cipher on each durable mutation. Once decryption works, the
  // on-disk records are merged UNDER the in-memory ones (fresh binds win their
  // ownership keys), the write-back sink takes over, and later forgets stick
  // instead of resurrecting from ciphertext next boot.
  store.setDurablePersistence(() => {
    if (!cipher.available()) {
      return
    }
    try {
      const onDisk = loadAgentSessionRecordStoreState(path, cipher)
      store.mergeRehydratedRecords(onDisk.records)
      attachWriteBackSink()
      writeAgentSessionRecordStoreState(path, store.durableState(), cipher)
    } catch {
      // Keep the recovery sink armed; the next mutation retries.
    }
  })
}
