import { afterEach, beforeEach, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ThunderbirdImportDialog } from './ThunderbirdImportDialog'
import { ui$ } from '../../states/ui'

const calls: { command: string; payload: any }[] = []
const folders = [
  { id: 'Mail/Local Folders/Inbox', account: 'Local Folders', path: ['Inbox'], bytes: 2048, imap_copy: false },
  { id: 'ImapMail/imap.x/INBOX', account: 'imap.x', path: ['INBOX'], bytes: 4096, imap_copy: true },
]

beforeEach(() => {
  calls.length = 0
  ui$.toast.set('')
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          switch (command) {
            case 'thunderbird.profiles':
              return { profiles: [{ name: 'default-release', path: '/home/ana/.thunderbird/abc.default-release' }] }
            case 'thunderbird.scan':
              return { folders }
            case 'thunderbird.preview':
            case 'thunderbird.import':
              return {
                folders: payload.folders.map((id: string) => ({
                  id,
                  target: `Thunderbird/${id}`,
                  summary: { imported: 3, duplicates: 1, skipped: 0 },
                  deleted: 2,
                })),
              }
          }
          throw new Error(`unexpected ${command}`)
        },
      },
    },
  }
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('lists the profile, leaves IMAP copies unchosen, previews, then imports exactly the chosen folders', async () => {
  let closed = false
  const view = render(<ThunderbirdImportDialog onClose={() => (closed = true)} />)
  fireEvent.click(await waitFor(() => view.getByText('default-release')))
  await waitFor(() => view.getByText('Local Folders / Inbox'))
  const boxes = view.getAllByRole('checkbox') as HTMLInputElement[]
  expect(boxes.map((b) => b.checked)).toEqual([true, false])
  expect(view.getByText(/copies Thunderbird keeps/)).toBeTruthy()

  fireEvent.click(view.getByRole('button', { name: 'Check what would be imported' }))
  await waitFor(() => view.getByRole('status'))
  expect(view.getByRole('status').textContent).toContain('3 messages to import. 1 already in the archive and 2 deleted')
  expect(calls.some((c) => c.command === 'thunderbird.import')).toBe(false)

  fireEvent.click(view.getByRole('button', { name: 'Import 3 messages' }))
  await waitFor(() => expect(closed).toBe(true))
  expect(calls.find((c) => c.command === 'thunderbird.import')!.payload.folders).toEqual(['Mail/Local Folders/Inbox'])
  expect(ui$.toast.get()).toContain('3 messages imported')
})

it('changing the selection asks for a new check before importing', async () => {
  const view = render(<ThunderbirdImportDialog onClose={() => {}} />)
  fireEvent.click(await waitFor(() => view.getByText('default-release')))
  await waitFor(() => view.getByText('Local Folders / Inbox'))
  fireEvent.click(view.getByRole('button', { name: 'Check what would be imported' }))
  await waitFor(() => view.getByRole('status'))
  fireEvent.click(view.getAllByRole('checkbox')[1])
  expect(view.queryByRole('status')).toBeNull()
  expect(view.getByRole('button', { name: 'Check what would be imported' })).toBeTruthy()
})
