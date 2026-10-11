import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { RestoreStatusRow } = await import('./RestoreStatusRow')
const { profileArchive$, undoRestore } = await import('../../states/profileArchive')

function bridge(state: string) {
  const calls: string[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string) => (calls.push(command), command.endsWith('Status') ? { state } : { ok: true }),
      },
    },
  }
  return calls
}

beforeEach(() => profileArchive$.restoreState.set('none'))
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('says nothing when no restore is waiting', async () => {
  bridge('none')
  const view = render(<RestoreStatusRow />)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(view.queryByRole('status')).toBeNull()
})

it('offers to go back or keep while the previous profile is kept aside', async () => {
  const calls = bridge('activated')
  const view = render(<RestoreStatusRow />)
  await waitFor(() => expect(view.getByRole('status')).toBeTruthy())
  expect(view.getByRole('button', { name: 'Go back' })).toBeTruthy()
  let reloaded = 0
  await act(async () => undoRestore(() => reloaded++))
  expect(calls).toContain('backup.profileRestoreUndo')
  expect(reloaded).toBe(1)
  await waitFor(() => expect(view.queryByRole('status')).toBeNull())
})
