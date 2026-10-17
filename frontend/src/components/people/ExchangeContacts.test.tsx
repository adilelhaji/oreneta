import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { PeopleView } from './PeopleView'
import { ContactSourcesSettingsSection } from '../dialog/ContactSourcesSettingsSection'
import { keepMine, people$ } from '../../states/people'
import { contactSources$, isExchangeFolderBook, writableBooks, type ContactSource } from '../../states/contactSources'
import { settleConfirm, ui$ } from '../../states/ui'
import type { Person } from '../../types'

// Exchange contacts edited, and the contact folders under Contacts as books
// of their own (ADR-0066).

const book: ContactSource = {
  id: 'exchange-acc',
  kind: 'exchange',
  account: 'acc',
  url: '',
  username: '',
  name: 'me@corp.example',
  enabled: true,
  lastSyncAt: 1,
  lastError: '',
  writable: null,
}

const feina: ContactSource = { ...book, id: 'exchange-acc/F1', url: 'F1', name: 'me@corp.example / Feina' }

const ana: Person = {
  id: 'exchange:acc:exchange-acc/F1:C1',
  source: 'exchange',
  account: 'acc',
  book: 'exchange-acc/F1',
  name: 'Ana Puig',
  given: 'Ana',
  family: 'Puig',
  organisation: 'Consorci',
  note: '',
  photo: '',
  emails: [{ addr: 'ana@corp.example', label: '' }],
  phones: [],
  version: 'ck-c1',
  editable: true,
}

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

function resetPeople(people: Person[]) {
  people$.set({
    people,
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
}

beforeEach(() => {
  contactSources$.set({ sources: [book, feina], loaded: true })
  resetPeople([ana])
})
// Whatever a test started settles before the next file runs.
const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

afterEach(() => {
  cleanup()
  delete (window as any).go
  contactSources$.set({ sources: [], loaded: false })
  resetPeople([])
  people$.loaded.set(false)
  people$.groupsLoaded.set(false)
})

describe('Exchange contacts (ADR-0066)', () => {
  it('offers every Exchange folder as a place for a new contact', () => {
    const others: ContactSource[] = [
      { ...book, id: 'g', kind: 'google' },
      { ...book, id: 'off', enabled: false },
      { ...book, id: 'ro', kind: 'carddav', url: 'https://dav.example/', writable: false },
      { ...book, id: 'rw', kind: 'carddav', url: 'https://dav.example/rw/', writable: true },
    ]
    expect(writableBooks([book, feina, ...others]).map((source) => source.id)).toEqual(['exchange-acc', 'exchange-acc/F1', 'rw'])
    expect([book, feina].map(isExchangeFolderBook)).toEqual([false, true])
  })

  it('edits an Exchange contact from the version it read and says where it is kept', async () => {
    const calls = stubBridge({
      'people.save': (payload) => ({ ok: true, id: payload.id, version: 'ck-c2' }),
      'people.list': () => ({ people: [ana] }),
    })
    people$.selectedId.set(ana.id)
    const view = render(<PeopleView />)
    fireEvent.click(view.getByLabelText('Edit'))
    expect(view.container.ownerDocument.body.textContent).toContain('Saved in me@corp.example / Feina, on its server.')
    fireEvent.change(view.getByLabelText('Organisation'), { target: { value: 'Consorci nou' } })
    fireEvent.click(view.getByText('Save'))
    await waitFor(() => expect(people$.editing.get()).toBeNull())
    const save = calls.find((c) => c.command === 'people.save')!
    expect(save.payload).toMatchObject({ id: ana.id, version: 'ck-c1', person: { organisation: 'Consorci nou' } })
    expect(save.payload.book).toBeUndefined()
    await settled()
  })

  it('creates a contact in the Exchange folder the reader picks', async () => {
    const calls = stubBridge({
      'people.save': () => ({ ok: true, id: 'exchange:acc:exchange-acc/F1:C9', version: 'ck-9' }),
      'people.list': () => ({ people: [ana] }),
    })
    const view = render(<PeopleView />)
    fireEvent.click(view.getByText('New contact'))
    const select = view.getByLabelText('Save to') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.text)).toEqual([
      'This computer',
      'me@corp.example',
      'me@corp.example / Feina',
    ])
    fireEvent.change(select, { target: { value: 'exchange-acc/F1' } })
    fireEvent.change(view.getByLabelText('Name'), { target: { value: 'Pau Roca' } })
    fireEvent.click(view.getByText('Save'))
    await waitFor(() => expect(people$.editing.get()).toBeNull())
    expect(calls.find((c) => c.command === 'people.save')!.payload).toMatchObject({ book: 'exchange-acc/F1' })
    await settled()
  })

  it('creates a contact deleted elsewhere again in the book it was in', async () => {
    const calls = stubBridge({ 'people.save': () => ({ ok: true, id: 'exchange:acc:exchange-acc/F1:C10', version: 'ck' }) })
    await keepMine({
      id: ana.id,
      version: ana.version,
      serverBook: ana.book,
      draft: { name: 'Ana Puig', given: 'Ana', family: 'Puig', organisation: '', note: '', emails: [], phones: [] },
      conflict: { current: null },
    })
    const save = calls.find((c) => c.command === 'people.save')!
    expect(save.payload.book).toBe('exchange-acc/F1')
    expect(save.payload.id).toBeUndefined()
    await settled()
  })

  it('says an Exchange contact is deleted on its server', async () => {
    stubBridge({})
    people$.selectedId.set(ana.id)
    const view = render(<PeopleView />)
    fireEvent.click(view.getByLabelText('Delete'))
    await waitFor(() => expect(ui$.confirm.get()?.message).toContain('on its server'))
    settleConfirm(false)
    await settled()
  })

  it('sends one id for a new contact on every try while the editor is open', async () => {
    const calls = stubBridge({ 'people.save': () => Promise.reject(new Error('Exchange did not answer')) })
    const view = render(<PeopleView />)
    fireEvent.click(view.getByText('New contact'))
    fireEvent.change(view.getByLabelText('Save to') as HTMLSelectElement, { target: { value: 'exchange-acc/F1' } })
    fireEvent.change(view.getByLabelText('Name'), { target: { value: 'Pau Roca' } })
    fireEvent.click(view.getByText('Save'))
    await waitFor(() => expect(calls.filter((c) => c.command === 'people.save')).toHaveLength(1))
    await waitFor(() => expect(view.getByText('Save')).toBeTruthy())
    fireEvent.click(view.getByText('Save'))
    await waitFor(() => expect(calls.filter((c) => c.command === 'people.save')).toHaveLength(2))
    const [first, second] = calls.filter((c) => c.command === 'people.save')
    expect(typeof first.payload.marker).toBe('string')
    expect(second.payload.marker).toBe(first.payload.marker)
    await settled()
  })

  it('lets the account book be removed, but not one of its folders alone', () => {
    const view = render(<ContactSourcesSettingsSection />)
    expect(view.getAllByLabelText('Remove')).toHaveLength(1)
    expect(view.getByText('me@corp.example / Feina')).toBeTruthy()
  })
})
