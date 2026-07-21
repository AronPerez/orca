// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DataRecoveryMigrationNotice } from './DataRecoveryMigrationNotice'

type ApiStub = {
  migrationStatus: ReturnType<typeof vi.fn>
  retryAgentCatalogMigration: ReturnType<typeof vi.fn>
  listPoints: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
}

function installApi(overrides: Partial<ApiStub> = {}): ApiStub {
  const api: ApiStub = {
    migrationStatus: vi.fn().mockResolvedValue({ agentCatalogMigrationError: 'disk full' }),
    retryAgentCatalogMigration: vi.fn().mockResolvedValue({ ok: true }),
    listPoints: vi.fn().mockResolvedValue([
      {
        id: 'agent-catalog-pre-v1',
        compatibility: 'previous-binary',
        createdAtMs: 1_752_000_000_000,
        sizeBytes: 1024
      }
    ]),
    restore: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides
  }
  ;(window as unknown as { api: unknown }).api = { dataRecovery: api }
  return api
}

describe('DataRecoveryMigrationNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders nothing when the migration is healthy', async () => {
    installApi({
      migrationStatus: vi.fn().mockResolvedValue({ agentCatalogMigrationError: null })
    })
    render(<DataRecoveryMigrationNotice />)
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('renders nothing on paired web where the dataRecovery surface is absent', async () => {
    ;(window as unknown as { api: unknown }).api = {}
    render(<DataRecoveryMigrationNotice />)
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('shows the blocked state at load with error details and both actions', async () => {
    installApi()
    render(<DataRecoveryMigrationNotice />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('disk full')).toBeTruthy()
    expect(screen.getByText('Retry migration')).toBeTruthy()
    expect(screen.getByText('Open Data recovery')).toBeTruthy()
  })

  it('clears the notice when retry succeeds and keeps it when retry fails', async () => {
    const api = installApi({
      retryAgentCatalogMigration: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: 'still failing' })
        .mockResolvedValueOnce({ ok: true })
    })
    api.migrationStatus
      .mockResolvedValueOnce({ agentCatalogMigrationError: 'disk full' })
      .mockResolvedValue({ agentCatalogMigrationError: 'still failing' })
    render(<DataRecoveryMigrationNotice />)
    const retry = await screen.findByText('Retry migration')

    fireEvent.click(retry)
    await vi.waitFor(() => expect(screen.getByText('still failing')).toBeTruthy())

    fireEvent.click(screen.getByText('Retry migration'))
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('opens Data recovery listing the pinned point with Prepare downgrade', async () => {
    const api = installApi()
    render(<DataRecoveryMigrationNotice />)
    fireEvent.click(await screen.findByText('Open Data recovery'))
    expect(
      await screen.findByText('Before the custom-agents update (agent catalog v1)')
    ).toBeTruthy()
    fireEvent.click(screen.getByText('Prepare downgrade…'))
    fireEvent.click(screen.getByText('Restore and quit'))
    await vi.waitFor(() =>
      expect(api.restore).toHaveBeenCalledWith({
        id: 'agent-catalog-pre-v1',
        mode: 'prepare-downgrade'
      })
    )
  })
})
