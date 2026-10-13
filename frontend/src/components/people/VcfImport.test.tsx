import { afterEach, beforeEach, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { PeopleView } from './PeopleView'
import { people$ } from '../../states/people'
import { contactSources$ } from '../../states/contactSources'
import { ui$ } from '../../states/ui'

function stubBridge(answers: Record<string, (payload: any) => unknown>) {
  const calls: { command: string; payload: any }[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          return answers[command]?.(payload) ?? {}
        },
      },
    },
  }
  return calls
}

beforeEach(() => {
  contactSources$.set({ sources: [], loaded: true })
  people$.set({
    people: [],
    loaded: true,
    loading: false,
    query: '',
    selectedId: '',
    editing: null,
    importing: null,
    duplicates: [],
    duplicatesOpen: false,
    groups: [],
    groupsLoaded: true,
    groupFilter: '',
    groupEditing: null,
  })
  ui$.toast.set('')
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

it('previews a vCard file and imports only after the reader confirms', async () => {
  const calls = stubBridge({
    'people.importVcf': (payload) =>
      payload.confirm
        ? { imported: 1, duplicates: 1, skipped: 0, stopped: null }
        : {
            path: '/tmp/c.vcf',
            skipped: 1,
            people: [
              { name: 'Ana Prat', organisation: '', emails: [{ addr: 'ana@x.cat', label: '' }] },
              { name: 'Bo Ray', organisation: '', emails: [] },
            ],
          },
    'people.list': () => ({ people: [] }),
  })
  const view = render(<PeopleView />)
  fireEvent.click(view.getByLabelText('Import contacts'))
  await waitFor(() => expect(view.getByText('Import 2 contacts')).toBeTruthy())
  const body = view.container.ownerDocument.body.textContent ?? ''
  expect(body).toContain('Ana Prat')
  expect(body).toContain('1 card has no name or address')
  expect(calls.filter((c) => c.command === 'people.importVcf').length).toBe(1)

  fireEvent.click(view.getByText('Import 2 contacts'))
  await waitFor(() => expect(people$.importing.get()).toBeNull())
  expect(calls.filter((c) => c.command === 'people.importVcf')[1].payload).toMatchObject({
    path: '/tmp/c.vcf',
    confirm: true,
    book: '',
  })
  expect(ui$.toast.get()).toBe('1 contact imported; 1 already there.')
})

it('exports the people a search found, or everybody without one', async () => {
  const calls = stubBridge({ 'people.exportVcf': () => ({ saved: true, count: 1 }), 'people.list': () => ({}) })
  people$.people.set([
    {
      id: 'local::local:a',
      source: 'local',
      account: '',
      book: 'local',
      name: 'Ana',
      organisation: '',
      note: '',
      photo: '',
      emails: [],
      phones: [],
    },
  ])
  const view = render(<PeopleView />)
  fireEvent.click(view.getByLabelText('Export contacts'))
  await waitFor(() => expect(calls.some((c) => c.command === 'people.exportVcf')).toBe(true))
  expect(calls.find((c) => c.command === 'people.exportVcf')!.payload).toEqual({})
})

it('suggests people who share an address, links them as one and can undo it', async () => {
  const ana = {
    id: 'carddav::work:a',
    source: 'carddav',
    account: '',
    book: 'work',
    name: 'Ana Prat',
    organisation: '',
    note: '',
    photo: '',
    emails: [{ addr: 'ana@x.cat', label: '' }],
    phones: [],
  }
  const ana2 = { ...ana, id: 'google::g:a2', source: 'google', book: 'g', name: 'Ana P.' }
  let linked = false
  const calls = stubBridge({
    'people.duplicates': () => ({ groups: linked ? [] : [[ana, ana2]] }),
    'people.link': () => {
      linked = true
      return { ok: true, link: 'link:1' }
    },
    'people.list': () => ({
      people: linked
        ? [
            { ...ana, link: 'link:1' },
            { ...ana2, link: 'link:1' },
          ]
        : [ana, ana2],
    }),
  })
  people$.people.set([ana, ana2])
  const view = render(<PeopleView />)
  await waitFor(() => expect(view.getByText('1 possible duplicate')).toBeTruthy())
  fireEvent.click(view.getByText('1 possible duplicate'))
  fireEvent.click(view.getByText('Same person: link'))
  await waitFor(() => expect(calls.some((c) => c.command === 'people.link')).toBe(true))
  expect(calls.find((c) => c.command === 'people.link')!.payload).toEqual({ ids: [ana.id, ana2.id] })
  await waitFor(() => expect(view.getAllByRole('option').length).toBe(1))
  people$.duplicatesOpen.set(false)
  fireEvent.click(view.getAllByRole('option')[0])
  await waitFor(() => expect(view.getByText('Linked copies')).toBeTruthy())
  expect(view.getAllByText('Unlink').length).toBe(2)
})
