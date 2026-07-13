// @vitest-environment happy-dom

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  ConfirmationDialogProvider,
  useConfirmationDialog
} from './confirmation-dialog'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { setContextualToursBlockingSurfaceVisible: () => void }) => unknown) =>
    selector({ setContextualToursBlockingSurfaceVisible: () => {} })
}))

type Options = Parameters<ReturnType<typeof useConfirmationDialog>>[0]

function Harness({
  options,
  onResult
}: {
  options: Options
  onResult: (confirmed: boolean) => void
}): React.JSX.Element {
  const confirm = useConfirmationDialog()
  return (
    <button type="button" onClick={() => void confirm(options).then(onResult)}>
      open
    </button>
  )
}

function renderHarness(options: Options): { onResult: ReturnType<typeof vi.fn> } {
  const onResult = vi.fn()
  render(
    <ConfirmationDialogProvider>
      <Harness options={options} onResult={onResult} />
    </ConfirmationDialogProvider>
  )
  fireEvent.click(screen.getByText('open'))
  return { onResult }
}

afterEach(() => cleanup())

describe('ConfirmationDialog opt-in', () => {
  it('reports the opt-in as checked when the user ticks it and confirms', async () => {
    const onConfirm = vi.fn()
    const { onResult } = renderHarness({
      title: 'Forget this launch?',
      confirmLabel: 'Forget launch',
      optIn: { label: 'Also forget 3 other stranded launches on devbox.', onConfirm }
    })

    const checkbox = await screen.findByRole('checkbox')
    expect(screen.getByText('Also forget 3 other stranded launches on devbox.')).toBeTruthy()
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: 'Forget launch' }))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(true))
    expect(onResult).toHaveBeenCalledWith(true)
  })

  it('reports the opt-in as unchecked when confirmed without ticking it', async () => {
    const onConfirm = vi.fn()
    renderHarness({
      title: 't',
      confirmLabel: 'Forget launch',
      optIn: { label: 'x', onConfirm }
    })

    await screen.findByRole('checkbox')
    fireEvent.click(screen.getByRole('button', { name: 'Forget launch' }))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(false))
  })

  it('honors defaultChecked so a pre-ticked opt-in confirms as checked', async () => {
    const onConfirm = vi.fn()
    renderHarness({
      title: 't',
      confirmLabel: 'Forget launch',
      optIn: { label: 'x', defaultChecked: true, onConfirm }
    })

    await screen.findByRole('checkbox')
    fireEvent.click(screen.getByRole('button', { name: 'Forget launch' }))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(true))
  })

  it('does not fire the opt-in callback when the confirmation is cancelled', async () => {
    const onConfirm = vi.fn()
    const { onResult } = renderHarness({
      title: 't',
      confirmLabel: 'Forget launch',
      optIn: { label: 'x', onConfirm }
    })

    await screen.findByRole('checkbox')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('renders no checkbox for a plain confirmation', async () => {
    renderHarness({ title: 't', confirmLabel: 'OK' })

    await screen.findByRole('button', { name: 'OK' })
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})
