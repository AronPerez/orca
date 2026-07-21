// Data-recovery DTOs shared by main, preload, and renderer. Metadata only:
// no filesystem paths and no backup contents ever cross this boundary.

export type RecoveryPointId = 'agent-catalog-pre-v1'

export type RecoveryPointDto = {
  id: RecoveryPointId
  /** 'previous-binary' points require installing the prior Orca release after
   *  restore (Prepare downgrade); 'current-build' points restart in place. */
  compatibility: 'previous-binary' | 'current-build'
  createdAtMs: number | null
  sizeBytes: number | null
}

export type RestoreRecoveryPointMode = 'prepare-downgrade' | 'restore-and-restart'

export type DataRecoveryOperationResult = { ok: true } | { ok: false; error: string }

export type DataRecoveryMigrationStatus = {
  /** Non-null while the agent-catalog v1 migration is blocked by a failed
   *  pinned backup; catalog/reference writes are fail-closed until it clears. */
  agentCatalogMigrationError: string | null
}
