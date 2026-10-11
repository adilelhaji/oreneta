import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { MailImportDialog } = await import('./MailImportDialog')
const { archive$, startMailImport } = await import('../../states/archive')
const { ui$ } = await import('../../states/ui')
const { isSendableAccount } = await import('../../states/accounts')

function stubBridge(answer: (payload: any) => unknown) {
  const calls: any[] = []
  ;(window as any).go = {
    main: { App: { Invoke: async (_command: string, payload: any) => (calls.push(payload), answer(payload)) } },
  }
  return calls
}

beforeEach(() => {
  archive$.pending.set(null)
  ui$.toast.set('')
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('previews the files, imports into the folder chosen, and says what happened', async () => {
  const calls = stubBridge((payload) =>
    payload.confirm
      ? { summary: { imported: 2, duplicates: 1, skipped: 0 }, folder: payload.folder, created: true }
      : {
          paths: ['/tmp/old.mbox'],
          folder: payload.folder || 'INBOX',
          summary: { imported: 2, duplicates: 1, skipped: 1 },
        },
  )
  await startMailImport()
  expect(archive$.pending.get()?.summary.imported).toBe(2)
  const view = render(<MailImportDialog />)
  const body = () => view.container.ownerDocument.body.textContent ?? ''
  expect(body()).toContain('1 file: 2 messages to import.')
  expect(body()).toContain('1 already in that folder; 1 is not a message or is too large')

  fireEvent.change(view.getByPlaceholderText('INBOX'), { target: { value: '2019' } })
  fireEvent.click(view.getByText('Import 2 messages'))
  await waitFor(() => expect(archive$.pending.get()).toBeNull())
  expect(calls.map((c) => [c.folder ?? '', Boolean(c.confirm)])).toEqual([
    ['', false],
    ['2019', false],
    ['2019', true],
  ])
  expect(ui$.toast.get()).toBe('2 messages imported into the local archive; 1 already there.')
})

it('never offers the archive as a sender', () => {
  expect(isSendableAccount({ id: 'local-archive', provider: 'local', auth_type: 'local_archive' } as any)).toBe(false)
})
