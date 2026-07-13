# Custom agents: forward-rollback runbook

Operational contract for rolling back a release that ships the agent-catalog **v1**
schema (`agentCatalogSchemaVersion: 1`). Grounded in plan §1021-1028 (Rollout and
rollback contract) and acceptance oracle 39.

## Why a plain downgrade is unsafe

The v1 data file is **forward-readable but not honestly writable** by an older Orca
binary: pre-v1 code does not understand custom identities in defaults, owner
records, or resume attribution. Runtime compatibility projections protect old
*clients*; they do not make a downgraded desktop binary schema-aware.

## Rules

1. **Production rollback = a forward-rollback build.** It keeps the v1
   reader/resolver and may disable new authoring. It must never disable identity
   resolution for already-saved defaults, automations, or sessions.
2. **Never install a pre-v1 binary over a live v1 data file.** Release automation
   must not resolve a feature incident this way.
3. **Explicit user downgrade = restore the pinned backup** (below). This is the
   only supported pre-v1 binary rollback and discards settings/workspace metadata
   written after the backup point.

## The pinned pre-v1 backup

- Written once, before the first v1 write, beside the rotating backups at
  `<data-file>.pre-agent-catalog-v1.backup` (`pinnedPreV1BackupPath`).
- Same filesystem permissions as the data file; `fsync` + atomic rename.
- If it cannot be created, migration performs **no v1 write** and Settings reports a
  local migration error; launch behavior stays on the clean built-in baseline.
- Never synced, never exposed through RPC, never given weaker permissions.
- Removed only after the documented one-release rollback window (see follow-up).

## Crash safety (oracle 39)

Schema migration, backup creation, catalog/reference mutation, and snapshot
persistence are independently fault-injected. Any crash leaves **either** the
complete old file + usable backup **or** the complete v1 file + usable backup —
never a half-migrated file. The backup is created before any v1 write, so a crash
mid-migration always finds an intact v0 file to restart from.

## Explicit downgrade procedure

1. Quit Orca.
2. Copy `<data-file>.pre-agent-catalog-v1.backup` over `<data-file>`.
3. Install the pre-v1 binary and relaunch.

The restored file is byte-identical to the pre-v1 state; all post-backup metadata
is intentionally discarded.

## Verification

Rollback verification runs on a **disposable** profile, never on user data:
`src/main/agent-launch/agent-catalog-forward-rollback-fixture.test.ts` exercises
migrate → v1-reference resolve → forward-rollback resolve → pinned-backup restore →
crash-before-write restart. Unit field-mapping coverage lives in
`agent-catalog-schema-migration.test.ts`.

## Follow-up (fill before merge)

- Dated removal of the pinned backup and the end of the one-release rollback
  window: **TODO(date)** — owner to set at release cut.
