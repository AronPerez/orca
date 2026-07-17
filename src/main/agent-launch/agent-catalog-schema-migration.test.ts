import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPinnedPreV1Backup,
  migrateAgentCatalogSchema,
  pinnedPreV1BackupPath
} from './agent-catalog-schema-migration'

const tempDirs: string[] = []

function makeDataFile(contents: string, mode?: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-agent-catalog-migration-'))
  tempDirs.push(dir)
  const dataFile = join(dir, 'orca-data.json')
  writeFileSync(dataFile, contents, mode !== undefined ? { mode } : undefined)
  return dataFile
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('createPinnedPreV1Backup', () => {
  it('writes the exact raw bytes with matching permissions', () => {
    const raw = '{"settings":{"defaultTuiAgent":null}}'
    const dataFile = makeDataFile(raw, 0o600)
    const result = createPinnedPreV1Backup(dataFile, raw)
    expect(result).toEqual({ ok: true, created: true })
    const backupFile = pinnedPreV1BackupPath(dataFile)
    expect(readFileSync(backupFile, 'utf-8')).toBe(raw)
    expect(statSync(backupFile).mode & 0o777).toBe(statSync(dataFile).mode & 0o777)
  })

  it('keeps an existing pinned backup instead of overwriting it', () => {
    const original = '{"original":true}'
    const dataFile = makeDataFile(original)
    expect(createPinnedPreV1Backup(dataFile, original)).toEqual({ ok: true, created: true })
    const second = createPinnedPreV1Backup(dataFile, '{"newer":true}')
    expect(second).toEqual({ ok: true, created: false })
    expect(readFileSync(pinnedPreV1BackupPath(dataFile), 'utf-8')).toBe(original)
  })

  it('fails without leaving a partial backup when the data file is unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-agent-catalog-migration-'))
    tempDirs.push(dir)
    const missing = join(dir, 'missing.json')
    const result = createPinnedPreV1Backup(missing, '{}')
    expect(result.ok).toBe(false)
    expect(existsSync(pinnedPreV1BackupPath(missing))).toBe(false)
    expect(existsSync(`${pinnedPreV1BackupPath(missing)}.tmp`)).toBe(false)
  })
})

describe('migrateAgentCatalogSchema', () => {
  it('maps shipped legacy null (and missing) defaults to auto exactly once', () => {
    for (const legacyDefault of [null, undefined]) {
      const outcome = migrateAgentCatalogSchema({
        settings: legacyDefault === undefined ? {} : { defaultTuiAgent: legacyDefault },
        preV1RawContents: '{}',
        createBackup: () => ({ ok: true, created: true })
      })
      expect(outcome.didMigrate).toBe(true)
      expect(outcome.settingsPatch.defaultTuiAgent).toBe('auto')
      expect(outcome.settingsPatch.agentCatalogSchemaVersion).toBe(1)
      expect(outcome.settingsPatch.agentCatalogRevision).toBe(1)
      expect(outcome.settingsPatch.agentReferenceRevision).toBe(1)
    }
  })

  it('preserves explicit blank and concrete-id defaults', () => {
    for (const explicit of ['blank', 'codex'] as const) {
      const outcome = migrateAgentCatalogSchema({
        settings: { defaultTuiAgent: explicit },
        preV1RawContents: '{}',
        createBackup: () => ({ ok: true, created: true })
      })
      expect(outcome.didMigrate).toBe(true)
      expect('defaultTuiAgent' in outcome.settingsPatch).toBe(false)
    }
  })

  it('is idempotent: a second load with v1 stamped is a no-op', () => {
    const outcome = migrateAgentCatalogSchema({
      settings: {
        agentCatalogSchemaVersion: 1,
        agentCatalogRevision: 7,
        agentReferenceRevision: 3,
        defaultTuiAgent: null
      },
      preV1RawContents: '{}',
      createBackup: () => {
        throw new Error('backup must not run for a v1 profile')
      }
    })
    expect(outcome.didMigrate).toBe(false)
    expect(outcome.settingsPatch).toEqual({})
    // Post-v1 null stays null: repair-needed defaults never become Auto again.
  })

  it('performs no v1 write when backup creation fails and forces pre-v1 shape', () => {
    const outcome = migrateAgentCatalogSchema({
      settings: { defaultTuiAgent: null },
      preV1RawContents: '{"settings":{"defaultTuiAgent":null}}',
      createBackup: () => ({ ok: false, error: 'disk full' })
    })
    expect(outcome.didMigrate).toBe(false)
    expect(outcome.backupError).toBe('disk full')
    expect(outcome.settingsPatch.agentCatalogSchemaVersion).toBeUndefined()
    expect(outcome.settingsPatch.agentCatalogRevision).toBeUndefined()
    expect(outcome.settingsPatch.agentReferenceRevision).toBeUndefined()
    expect(outcome.settingsPatch.defaultTuiAgent).toBeNull()
    // The forced patch must explicitly carry the pre-v1 keys so fresh-install
    // defaults cannot leak through the settings spread.
    expect('agentCatalogSchemaVersion' in outcome.settingsPatch).toBe(true)
    expect('customTuiAgents' in outcome.settingsPatch).toBe(true)
    expect('deletedCustomTuiAgents' in outcome.settingsPatch).toBe(true)
  })

  it('skips the backup for a fresh install with no persisted file', () => {
    const outcome = migrateAgentCatalogSchema({
      settings: undefined,
      preV1RawContents: null,
      createBackup: () => {
        throw new Error('backup must not run for a fresh install')
      }
    })
    expect(outcome.didMigrate).toBe(true)
    expect(outcome.settingsPatch.defaultTuiAgent).toBe('auto')
    expect(outcome.settingsPatch.agentCatalogSchemaVersion).toBe(1)
  })

  it('normalizes hand-edited negative or non-integer revisions on v1 profiles', () => {
    const outcome = migrateAgentCatalogSchema({
      settings: {
        agentCatalogSchemaVersion: 1,
        agentCatalogRevision: -5 as number,
        agentReferenceRevision: 1.5 as number
      },
      preV1RawContents: '{}',
      createBackup: () => ({ ok: true, created: true })
    })
    expect(outcome.didMigrate).toBe(true)
    expect(outcome.settingsPatch.agentCatalogRevision).toBe(1)
    expect(outcome.settingsPatch.agentReferenceRevision).toBe(1)
  })
})

describe('corrupted schema-version stamp (L1-#8)', () => {
  it('repairs a malformed stamp without re-running the null->auto default remap', () => {
    for (const corruptedStamp of [1.5, 'one', Number.NaN, -1, true]) {
      const outcome = migrateAgentCatalogSchema({
        settings: {
          agentCatalogSchemaVersion: corruptedStamp as never,
          // A repair-generated null default written after v1 must stay null.
          defaultTuiAgent: null,
          agentCatalogRevision: 7,
          agentReferenceRevision: 3
        },
        preV1RawContents: '{}',
        createBackup: () => {
          throw new Error('a corrupted post-v1 stamp must not re-run the pre-v1 backup step')
        }
      })
      expect(outcome.settingsPatch.defaultTuiAgent).toBeUndefined()
      expect('defaultTuiAgent' in outcome.settingsPatch).toBe(false)
      expect(outcome.settingsPatch.agentCatalogSchemaVersion).toBe(1)
      expect(outcome.didMigrate).toBe(true)
      expect(outcome.backupError).toBeUndefined()
    }
  })

  it('still treats an explicit integer 0 stamp as pre-v1', () => {
    const outcome = migrateAgentCatalogSchema({
      settings: { agentCatalogSchemaVersion: 0, defaultTuiAgent: null },
      preV1RawContents: '{}',
      createBackup: () => ({ ok: true, created: true })
    })
    expect(outcome.settingsPatch.defaultTuiAgent).toBe('auto')
    expect(outcome.settingsPatch.agentCatalogSchemaVersion).toBe(1)
  })
})
