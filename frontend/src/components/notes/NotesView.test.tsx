import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { NotesView } = await import('./NotesView')
const { notes$, parseTags, noteTitle } = await import('../../states/notes')
const { ui$ } = await import('../../states/ui')

type Stored = {
  id: string
  title: string
  html: string
  text: string
  tags: string[]
  pinned: boolean
  revision: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

// A small stand-in for the core: enough of notes.* to drive the view, with
// the same revision rule.
function fakeCore(seed: Stored[] = []) {
  const notes = new Map(seed.map((note) => [note.id, { ...note }]))
  const calls: { command: string; payload: any }[] = []
  let next = 1
  const summary = (note: Stored) => ({
    id: note.id,
    title: note.title,
    preview: note.text,
    tags: note.tags,
    pinned: note.pinned,
    revision: note.revision,
    updated_at: note.updated_at,
    deleted_at: note.deleted_at,
  })
  const text = (html: string) => html.replace(/<[^>]*>/g, ' ').trim()
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          switch (command) {
            case 'notes.list':
              return {
                notes: [...notes.values()]
                  .filter((note) => (note.deleted_at !== null) === !!payload.trash)
                  .filter((note) => !payload.search || note.title.includes(payload.search))
                  .map(summary),
                tags: [],
              }
            case 'notes.get':
              return { note: notes.get(payload.id) ?? null }
            case 'notes.create': {
              const id = `note:${next++}`
              const note = {
                ...payload.note,
                id,
                text: text(payload.note.html),
                revision: 1,
                created_at: 1,
                updated_at: 1,
                deleted_at: null,
              }
              notes.set(id, note)
              return { note }
            }
            case 'notes.update': {
              const note = notes.get(payload.id)
              if (!note) return { status: 'gone' }
              if (note.revision !== payload.revision || note.deleted_at !== null)
                return { status: 'conflict', stored: note }
              Object.assign(note, payload.note, { text: text(payload.note.html), revision: note.revision + 1 })
              return { status: 'saved', note }
            }
            case 'notes.trash':
              notes.get(payload.id)!.deleted_at = 5
              return { ok: true }
            case 'notes.restore':
              notes.get(payload.id)!.deleted_at = null
              return { ok: true }
          }
          throw new Error(`unexpected ${command}`)
        },
      },
    },
  }
  return { notes, calls }
}

const note = (id: string, title: string, extra: Partial<Stored> = {}): Stored => ({
  id,
  title,
  html: `<p>${title} body</p>`,
  text: `${title} body`,
  tags: [],
  pinned: false,
  revision: 1,
  created_at: 1,
  updated_at: 1_760_000_000,
  deleted_at: null,
  ...extra,
})

beforeEach(() => {
  notes$.assign({ items: [], tags: [], loaded: false, search: '', tag: '', trash: false, selected: null })
  ui$.toast.set('')
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('reads tags typed in one box and names untitled notes by their text', () => {
  expect(parseTags('#work, ideas  Work,,home')).toEqual(['work', 'ideas', 'home'])
  expect(noteTitle({ title: '', preview: 'buy milk' })).toBe('buy milk')
  expect(noteTitle({ title: '', preview: '' })).toBe('Untitled note')
})

it('writes a new note once there is something in it, then edits it from its revision', async () => {
  const core = fakeCore()
  const view = render(<NotesView />)
  await waitFor(() => expect(view.getByText('No notes yet')).toBeTruthy())
  fireEvent.click(view.getByRole('button', { name: 'New note' }))
  const title = await view.findByLabelText('Title')
  fireEvent.change(title, { target: { value: 'Ideas' } })
  await waitFor(() => expect(core.calls.some((call) => call.command === 'notes.create')).toBe(true), { timeout: 2000 })
  expect(core.calls.find((call) => call.command === 'notes.create')!.payload.note.title).toBe('Ideas')
  await waitFor(() => expect(notes$.selected.get()).toBe('note:1'))
  await waitFor(() => expect(view.getByRole('button', { name: /Ideas/ })).toBeTruthy())

  fireEvent.change(view.getByLabelText('Tags'), { target: { value: 'work, #home' } })
  await waitFor(() => expect(core.notes.get('note:1')!.tags).toEqual(['work', 'home']), { timeout: 2000 })
  const update = core.calls.find((call) => call.command === 'notes.update')!
  expect(update.payload.revision).toBe(1)
  expect(core.calls.filter((call) => call.command === 'notes.create')).toHaveLength(1)
})

it('saves nothing over a note changed elsewhere and lets the reader pick a version', async () => {
  const core = fakeCore([note('note:a', 'Plan')])
  const view = render(<NotesView />)
  fireEvent.click(await view.findByRole('button', { name: /Plan/ }))
  const title = await view.findByLabelText('Title')
  await waitFor(() => expect((title as HTMLInputElement).value).toBe('Plan'))

  // Another window saves first.
  Object.assign(core.notes.get('note:a')!, { title: 'Plan B', text: 'their text', revision: 2 })
  fireEvent.change(title, { target: { value: 'My plan' } })
  const alert = await view.findByRole('alert', {}, { timeout: 2000 })
  expect(alert.textContent).toContain('changed elsewhere')
  expect(alert.textContent).toContain('their text')
  expect(core.notes.get('note:a')!.title).toBe('Plan B')

  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Keep mine' })))
  await waitFor(() => expect(core.notes.get('note:a')!.title).toBe('My plan'))
  expect(core.notes.get('note:a')!.revision).toBe(3)
  expect(view.queryByRole('alert')).toBeNull()
})

it('takes the saved version when asked, without writing', async () => {
  const core = fakeCore([note('note:a', 'Plan')])
  const view = render(<NotesView />)
  fireEvent.click(await view.findByRole('button', { name: /Plan/ }))
  const title = (await view.findByLabelText('Title')) as HTMLInputElement
  await waitFor(() => expect(title.value).toBe('Plan'))
  Object.assign(core.notes.get('note:a')!, { title: 'Plan B', revision: 2 })
  fireEvent.change(title, { target: { value: 'Mine' } })
  await view.findByRole('alert', {}, { timeout: 2000 })
  const writes = core.calls.filter((call) => call.command === 'notes.update').length
  fireEvent.click(view.getByRole('button', { name: 'Use the saved one' }))
  await waitFor(() => expect(title.value).toBe('Plan B'))
  expect(core.calls.filter((call) => call.command === 'notes.update').length).toBe(writes)
})

it('moves a note to the trash and back', async () => {
  const core = fakeCore([note('note:a', 'Old')])
  const view = render(<NotesView />)
  fireEvent.click(await view.findByRole('button', { name: /Old/ }))
  await view.findByLabelText('Title')
  fireEvent.click(view.getByRole('button', { name: 'Move to the trash' }))
  await waitFor(() => expect(core.notes.get('note:a')!.deleted_at).toBe(5))
  await waitFor(() => expect(view.getByText('No notes yet')).toBeTruthy())
  expect(ui$.toast.get()).toBe('Moved to the trash')

  fireEvent.click(view.getByRole('button', { name: 'Trash' }))
  fireEvent.click(await view.findByRole('button', { name: /Old/ }))
  fireEvent.click(await view.findByRole('button', { name: 'Restore' }))
  await waitFor(() => expect(core.notes.get('note:a')!.deleted_at).toBeNull())
})
