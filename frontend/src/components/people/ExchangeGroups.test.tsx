import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { PeopleView } from './PeopleView'
import { ContactSourcesSettingsSection } from '../dialog/ContactSourcesSettingsSection'
import { people$ } from '../../states/people'
import { contactSources$, groupBooks, type ContactSource } from '../../states/contactSources'
import { accounts$ } from '../../states/accounts'
import type { Account, ContactGroup, Person } from '../../types'

// Exchange distribution lists as contact groups (ADR-0058).

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

const ana: Person = {
  id: 'exchange:acc:exchange-acc:C1',
  source: 'exchange',
  account: 'acc',
  book: 'exchange-acc',
  name: 'Ana Puig',
  given: 'Ana',
  family: 'Puig',
  organisation: '',
  note: '',
  photo: '',
  emails: [{ addr: 'ana@corp.example', label: '' }],
  phones: [],
  version: 'ck-c1',
  editable: false,
}

// A list holding Pere (a contact) and Joan, an address typed in that is no
// contact here.
const team: ContactGroup = {
  id: 'group:exchange:acc:exchange-acc:D1',
  source: 'exchange',
  account: 'acc',
  book: 'exchange-acc',
  name: 'Team',
  version: 'ck-d1',
  editable: true,
  members: [
    { id: 'exchange:acc:exchange-acc:C2', name: 'Pere Clavé', addr: 'pere@corp.example' },
    { id: 'exchange:acc:exchange-acc:mailto:joan@example.net', name: 'Joan Vila', addr: 'joan@example.net' },
  ],
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

beforeEach(() => {
  contactSources$.set({ sources: [book], loaded: true })
  people$.set({
    people: [ana],
    loaded: true,
    loading: false,
    query: '',
    selectedId: '',
    editing: null,
    importing: null,
    duplicates: [],
    duplicatesOpen: false,
    groups: [team],
    groupsLoaded: true,
    groupFilter: '',
    groupEditing: null,
  })
})
// Whatever a test started settles before the next file runs.
const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

afterEach(() => {
  cleanup()
  delete (window as any).go
  accounts$.set([])
  contactSources$.set({ sources: [], loaded: false })
  people$.set({
    people: [],
    loaded: false,
    loading: false,
    query: '',
    selectedId: '',
    editing: null,
    importing: null,
    duplicates: [],
    duplicatesOpen: false,
    groups: [],
    groupsLoaded: false,
    groupFilter: '',
    groupEditing: null,
  })
})

describe('Exchange distribution lists (ADR-0058)', () => {
  it('offers an Exchange book as a place for a new group', async () => {
    expect(groupBooks([book, { ...book, id: 'g', kind: 'google' }]).map((source) => source.id)).toEqual([
      'exchange-acc',
    ])
    const calls = stubBridge({
      'people.groupSave': () => ({ ok: true, id: 'group:exchange:acc:exchange-acc:D2', version: 'ck-n' }),
      'people.groups': () => ({ groups: [team] }),
    })
    const view = render(<PeopleView />)
    fireEvent.click(view.getByLabelText('New group'))
    fireEvent.change(view.getByLabelText('Group name'), { target: { value: 'Board' } })
    fireEvent.change(view.getByDisplayValue('This computer'), { target: { value: 'exchange-acc' } })
    fireEvent.click(view.getByText('Save'))
    await waitFor(() => expect(people$.groupEditing.get()).toBeNull())
    expect(calls.find((c) => c.command === 'people.groupSave')!.payload).toEqual({
      book: 'exchange-acc',
      name: 'Board',
      members: [],
    })
    await settled()
  })

  it('keeps a member who is no contact when adding somebody, from the version read', async () => {
    const calls = stubBridge({
      'people.groupSave': () => ({ ok: true, id: team.id, version: 'ck-d2' }),
      'people.groups': () => ({ groups: [team] }),
    })
    people$.selectedId.set(ana.id)
    const view = render(<PeopleView />)
    fireEvent.change(view.getByLabelText('Add to group'), { target: { value: team.id } })
    await waitFor(() => expect(calls.some((c) => c.command === 'people.groupSave')).toBe(true))
    expect(calls.find((c) => c.command === 'people.groupSave')!.payload).toEqual({
      id: team.id,
      version: 'ck-d1',
      name: 'Team',
      members: [team.members[0].id, team.members[1].id, ana.id],
    })
    await waitFor(() => expect(calls.some((c) => c.command === 'people.groups')).toBe(true))
    await settled()
  })

  it('offers to read the contacts of an Exchange account that has no book yet', async () => {
    contactSources$.set({ sources: [], loaded: true })
    accounts$.set([
      { id: 'acc', email: 'me@corp.example', provider: 'exchange', ews_url: 'https://mail.corp.example/EWS/Exchange.asmx' } as Account,
    ])
    const calls = stubBridge({
      'exchange.contacts.sync': () => ({ ok: true, error: null }),
      'carddav.list': () => ({ sources: [book] }),
    })
    const view = render(<ContactSourcesSettingsSection />)
    fireEvent.click(view.getByText('Read Exchange contacts'))
    await waitFor(() => expect(calls.some((c) => c.command === 'exchange.contacts.sync')).toBe(true))
    expect(calls.find((c) => c.command === 'exchange.contacts.sync')!.payload).toEqual({
      account: 'acc',
      name: 'me@corp.example',
    })
    await waitFor(() => expect(calls.some((c) => c.command === 'carddav.list')).toBe(true))
    await settled()
  })
})
