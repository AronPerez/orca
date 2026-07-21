import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { DataRecoveryDialog } from './DataRecoveryDialog'

/** App-level persistent notice for a blocked agent-catalog migration (runbook:
 *  Migration user experience). Shown at profile load — not only in Settings —
 *  and stays until Retry succeeds or a recovery point is restored. Renders
 *  nothing on paired web (no dataRecovery preload surface) or when healthy. */
export function DataRecoveryMigrationNotice() {
  const [migrationError, setMigrationError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [recoveryOpen, setRecoveryOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const status = await window.api.dataRecovery?.migrationStatus()
      setMigrationError(status?.agentCatalogMigrationError ?? null)
    } catch {
      setMigrationError(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (migrationError === null) {
    return null
  }

  const handleRetry = async (): Promise<void> => {
    setRetrying(true)
    try {
      const result = await window.api.dataRecovery?.retryAgentCatalogMigration()
      if (result?.ok) {
        setMigrationError(null)
      } else {
        await refresh()
      }
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div
      role="alert"
      className="flex flex-wrap items-start gap-2 border-b border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-destructive">
          {translate(
            'auto.components.dataRecovery.noticeTitle',
            'Orca could not back up your data before a required update'
          )}
        </p>
        <p className="text-muted-foreground">
          {translate(
            'auto.components.dataRecovery.noticeBody',
            'Your existing data is unchanged and built-in agents keep working, but custom-agent settings are read-only until this is resolved.'
          )}
        </p>
        <p className="break-words font-mono text-xs text-muted-foreground">{migrationError}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" size="xs" disabled={retrying} onClick={() => void handleRetry()}>
          {retrying
            ? translate('auto.components.dataRecovery.retrying', 'Retrying…')
            : translate('auto.components.dataRecovery.retryMigration', 'Retry migration')}
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={() => setRecoveryOpen(true)}>
          {translate('auto.components.dataRecovery.openDataRecovery', 'Open Data recovery')}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => void navigator.clipboard.writeText(migrationError)}
        >
          {translate('auto.components.dataRecovery.copyDetails', 'Copy details')}
        </Button>
      </div>
      <DataRecoveryDialog open={recoveryOpen} onOpenChange={setRecoveryOpen} />
    </div>
  )
}
