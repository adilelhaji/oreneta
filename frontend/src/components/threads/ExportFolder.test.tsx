import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { ThreadActionsMenuItems } = await import('./ThreadActionsMenu')
const { exportFolderMbox } = await import('../../states/mail')
const { ui$ } = await import('../../states/ui')

function stubBridge(answer: (command: string, payload: any) => unknown) {
  const calls: { command: string; payload: any }[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => (calls.push({ command, payload }), answer(command, payload)),
      },
    },
  }
  return calls
}

beforeEach(() => ui$.toast.set(''))
afterEach(() => {
  cleanup()
  delete (window as any).go
})

const base = {
  filterMode: 'all' as const,
  onFilterChange: () => {},
  hasUnread: false,
  onMarkAllRead: () => {},
  closeMenu: () => {},
}

it('offers the export only where it is wired', () => {
  const without = render(<ThreadActionsMenuItems {...base} />)
  expect(without.queryByText('Export folder as .mbox')).toBeNull()
  cleanup()
  let asked = 0
  const view = render(<ThreadActionsMenuItems {...base} onExportFolder={() => asked++} />)
  fireEvent.click(view.getByText('Export folder as .mbox'))
  expect(asked).toBe(1)
})

it('asks the bridge for the folder and says how many messages were written', async () => {
  const calls = stubBridge(() => ({ saved: true, exported: 12 }))
  await exportFolderMbox('a@example.test', 'a@example.test#Work', 'Work')
  expect(calls[0]).toEqual({
    command: 'mail.exportMbox',
    payload: { account: 'a@example.test', folder: 'a@example.test#Work', name: 'Work' },
  })
  expect(ui$.toast.get()).toContain('12')
})

it('says nothing when the save dialog is cancelled and reports a failure', async () => {
  stubBridge(() => ({ saved: false }))
  await exportFolderMbox('a@example.test', 'INBOX', 'Inbox')
  expect(ui$.toast.get()).toBe('')
  stubBridge(() => {
    throw new Error('offline')
  })
  await exportFolderMbox('a@example.test', 'INBOX', 'Inbox', [3, 4])
  expect(ui$.toast.get()).toBe('Could not export the folder')
})
