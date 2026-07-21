// Recovery-point inventory and atomic restore for migration backups (runbook:
// "General Data recovery UI"). Only metadata crosses to the renderer — never a
// filesystem path or raw backup contents; restore/retry are main-owned.

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { pinnedPreV1BackupPath } from '../agent-launch/agent-catalog-schema-migration'
import type { RecoveryPointDto, RecoveryPointId } from '../../shared/data-recovery'

export type { RecoveryPointDto, RecoveryPointId } from '../../shared/data-recovery'

export const PRE_RESTORE_SAFETY_SUFFIX = '.pre-restore-safety.backup'

type RestoreStore = {
  getDataFilePath(): string
  freezeWrites(): void
  unfreezeWrites(): void
  waitForPendingWrite(): Promise<void>
}

function recoveryPointPath(dataFile: string, id: RecoveryPointId): string {
  switch (id) {
    case 'agent-catalog-pre-v1':
      return pinnedPreV1BackupPath(dataFile)
  }
}

export function listRecoveryPoints(dataFile: string): RecoveryPointDto[] {
  const points: RecoveryPointDto[] = []
  const pinned = pinnedPreV1BackupPath(dataFile)
  if (existsSync(pinned)) {
    let createdAtMs: number | null = null
    let sizeBytes: number | null = null
    try {
      const stat = statSync(pinned)
      createdAtMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
      sizeBytes = stat.size
    } catch {
      // Metadata is best-effort; the point is still restorable.
    }
    points.push({
      id: 'agent-catalog-pre-v1',
      compatibility: 'previous-binary',
      createdAtMs,
      sizeBytes
    })
  }
  return points
}

function writeFileAtomicSync(targetPath: string, contents: string, mode: number): void {
  const tmpPath = `${targetPath}.tmp`
  const fd = openSync(tmpPath, 'w', mode)
  try {
    writeSync(fd, contents)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmpPath, targetPath)
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // Best-effort tmp cleanup; surface the rename error instead.
    }
    throw error
  }
}

export type RestoreRecoveryPointResult = { ok: true } | { ok: false; error: string }

/** Validates the selected backup, suspends writes, keeps a pre-restore safety
 *  copy, and atomically replaces the live data file. Failure or invalid input
 *  leaves the current file and the recovery point intact and re-enables writes;
 *  the caller owns the post-success app action (restart or quit). */
export async function restoreRecoveryPoint(
  store: RestoreStore,
  id: RecoveryPointId
): Promise<RestoreRecoveryPointResult> {
  const dataFile = store.getDataFilePath()
  const backupPath = recoveryPointPath(dataFile, id)
  if (!existsSync(backupPath)) {
    return { ok: false, error: 'The selected recovery point no longer exists.' }
  }
  let backupContents: string
  try {
    backupContents = readFileSync(backupPath, 'utf-8')
    const parsed: unknown = JSON.parse(backupContents)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'The recovery point is not a valid Orca data file.' }
    }
  } catch (error) {
    return {
      ok: false,
      error: `The recovery point could not be validated: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  // Why freeze before the safety copy: an in-flight or quit-time save landing
  // after the copy would make the safety copy stale and could clobber the
  // restored file between rename and process exit.
  store.freezeWrites()
  try {
    await store.waitForPendingWrite()
    const mode = existsSync(dataFile) ? statSync(dataFile).mode & 0o777 : 0o600
    if (existsSync(dataFile)) {
      writeFileAtomicSync(
        `${dataFile}${PRE_RESTORE_SAFETY_SUFFIX}`,
        readFileSync(dataFile, 'utf-8'),
        mode
      )
    }
    writeFileAtomicSync(dataFile, backupContents, mode)
    return { ok: true }
  } catch (error) {
    store.unfreezeWrites()
    return {
      ok: false,
      error: `Restore failed and no changes were made: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
