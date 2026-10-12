import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { NoteAttachments } from './NoteAttachments'
import { settleConfirm, ui$ } from '../../states/ui'

const calls: { command: string; payload: any }[] = []
let files: any[] = []

beforeEach(() => {
  calls.length = 0
  files = [{ id: 'na:1', note_id: 'n1', filename: 'ticket.pdf', size: 2048, created_at: 1 }]
  ui$.toast.set('')
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          switch (command) {
            case 'notes.attachments':
              return { attachments: files }
            case 'notes.pickAttachment':
              return { path: '/home/ana/plan.txt' }
            case 'notes.attach':
              files = [...files, { id: 'na:2', note_id: 'n1', filename: 'plan.txt', size: 10, created_at: 2 }]
              return {}
            case 'notes.removeAttachment':
              files = files.filter((f) => f.id !== payload.id)
              return { ok: true }
            case 'notes.saveAttachmentAs':
              return { saved: true }
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
  ui$.confirm.set(null)
})

it('lists the note’s files, attaches a picked one and saves one by its name', async () => {
  const view = render(<NoteAttachments noteId="n1" readOnly={false} />)
  await waitFor(() => view.getByText('ticket.pdf'))
  fireEvent.click(view.getByRole('button', { name: 'Attach a file…' }))
  await waitFor(() => view.getByText('plan.txt'))
  expect(calls.find((c) => c.command === 'notes.attach')!.payload).toEqual({
    note_id: 'n1',
    path: '/home/ana/plan.txt',
  })
  fireEvent.click(view.getByRole('button', { name: 'Save ticket.pdf' }))
  await waitFor(() => expect(ui$.toast.get()).toBe('ticket.pdf saved.'))
  expect(calls.find((c) => c.command === 'notes.saveAttachmentAs')!.payload).toEqual({
    id: 'na:1',
    filename: 'ticket.pdf',
  })
})

it('removing asks first; in the trash files can be saved but not changed', async () => {
  const view = render(<NoteAttachments noteId="n1" readOnly={false} />)
  await waitFor(() => view.getByText('ticket.pdf'))
  fireEvent.click(view.getByRole('button', { name: 'Remove ticket.pdf' }))
  await waitFor(() => expect(ui$.confirm.get()?.message).toContain('not touched'))
  await act(async () => settleConfirm(false))
  expect(calls.some((c) => c.command === 'notes.removeAttachment')).toBe(false)
  cleanup()

  const trashed = render(<NoteAttachments noteId="n1" readOnly />)
  await waitFor(() => trashed.getByText('ticket.pdf'))
  expect(trashed.queryByRole('button', { name: 'Attach a file…' })).toBeNull()
  expect(trashed.queryByRole('button', { name: 'Remove ticket.pdf' })).toBeNull()
  expect(trashed.getByRole('button', { name: 'Save ticket.pdf' })).toBeTruthy()
})
