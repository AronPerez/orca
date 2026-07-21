import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { RecoveryPointDto } from '../../../../shared/data-recovery'

export type DataRecoveryDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function pointTitle(point: RecoveryPointDto): string {
  switch (point.id) {
    case 'agent-catalog-pre-v1':
      return translate(
        'auto.components.dataRecovery.pointAgentCatalogPreV1Title',
        'Before the custom-agents update (agent catalog v1)'
      )
  }
}

function pointLossSummary(point: RecoveryPointDto): string {
  switch (point.id) {
    case 'agent-catalog-pre-v1':
      return translate(
        'auto.components.dataRecovery.pointAgentCatalogPreV1Loss',
        'Restoring discards all settings and workspace metadata saved after this point, including any custom agents.'
      )
  }
}

/** Main-owned restore flow (runbook: General Data recovery UI). Lists recovery
 *  points by metadata only; the pinned pre-v1 point restores via Prepare
 *  downgrade — Orca restores atomically and quits without relaunching. */
export function DataRecoveryDialog({ open, onOpenChange }: DataRecoveryDialogProps) {
  const [points, setPoints] = useState<RecoveryPointDto[] | null>(null)
  const [confirming, setConfirming] = useState<RecoveryPointDto | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setConfirming(null)
      setError(null)
      return
    }
    let cancelled = false
    void window.api.dataRecovery
      ?.listPoints()
      .then((list) => {
        if (!cancelled) {
          setPoints(list)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPoints([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const handleRestore = async (point: RecoveryPointDto): Promise<void> => {
    setRestoring(true)
    setError(null)
    try {
      const result = await window.api.dataRecovery?.restore({
        id: point.id,
        mode: 'prepare-downgrade'
      })
      // On success Orca quits; only failures come back to this dialog.
      if (result && !result.ok) {
        setError(result.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.dataRecovery.title', 'Data recovery')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.dataRecovery.description',
              'Restore this profile from a recovery point created before a data migration. Restoring never deletes the recovery point.'
            )}
          </DialogDescription>
        </DialogHeader>

        {points === null ? (
          <p className="text-sm text-muted-foreground">
            {translate('auto.components.dataRecovery.loading', 'Looking for recovery points…')}
          </p>
        ) : points.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.dataRecovery.empty',
              'No recovery points exist for this profile.'
            )}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {points.map((point) => (
              <li key={point.id} className="rounded-md border border-border p-3 text-sm">
                <p className="font-medium">{pointTitle(point)}</p>
                <p className="text-muted-foreground">
                  {point.createdAtMs
                    ? translate('auto.components.dataRecovery.createdAt', 'Created {{date}}', {
                        date: new Date(point.createdAtMs).toLocaleString()
                      })
                    : translate(
                        'auto.components.dataRecovery.createdUnknown',
                        'Creation time unknown'
                      )}
                </p>
                {point.compatibility === 'previous-binary' ? (
                  <p className="text-muted-foreground">
                    {translate(
                      'auto.components.dataRecovery.previousBinary',
                      'After restoring, Orca quits. Install the previous Orca version before opening it again.'
                    )}
                  </p>
                ) : null}
                <p className="mt-1 text-muted-foreground">{pointLossSummary(point)}</p>
                {confirming?.id === point.id ? (
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="xs"
                      disabled={restoring}
                      onClick={() => void handleRestore(point)}
                    >
                      {restoring
                        ? translate('auto.components.dataRecovery.restoring', 'Restoring…')
                        : translate(
                            'auto.components.dataRecovery.confirmRestore',
                            'Restore and quit'
                          )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={restoring}
                      onClick={() => setConfirming(null)}
                    >
                      {translate('auto.components.dataRecovery.cancel', 'Cancel')}
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="mt-2"
                    onClick={() => setConfirming(point)}
                  >
                    {translate(
                      'auto.components.dataRecovery.prepareDowngrade',
                      'Prepare downgrade…'
                    )}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <p role="alert" className="break-words text-sm text-destructive">
            {translate(
              'auto.components.dataRecovery.restoreFailed',
              'Restore failed and no changes were made: {{error}}',
              { error }
            )}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.dataRecovery.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
