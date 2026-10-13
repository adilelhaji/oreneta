import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { PeopleView } from './PeopleView'
import { people$ } from '../../states/people'
import { contactSources$ } from '../../states/contactSources'
import { settings$ } from '../../states/settings'
import type { ContactGroup, Person } from '../../types'

const person = (id: string, given: string, family: string, addr: string): Person => ({
  id,
  source: 'local',
  account: '',
  book: 'local',
  name: `${given} ${family}`,
  given,
  family,
  organisation: '',
  note: '',
  photo: '',
  emails: [{ addr, label: '' }],
  phones: [],
  version: '1',
  editable: true,
})

const zoe = person('local::local:z', 'Zoe', 'Adams', 'zoe@example.com')
const bob = person('local::local:b', 'Bob', 'Young', 'bob@example.com')
const climbing: ContactGroup = {
  id: 'group:local::local:g1',
  source: 'local',
  account: '',
  book: 'local',
  name: 'Climbing',
  version: '4',
  editable: true,
  members: [{ id: bob.id, name: bob.name, given: 'Bob', family: 'Young', addr: 'bob@example.com' }],
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
  contactSources$.set({ sources: [], loaded: true })
  settings$.contactNameDisplay.set('auto')
  settings$.contactNameSort.set('auto')
  people$.set({
    people: [zoe, bob],
    loaded: true,
    loading: false,
    query: '',
    selectedId: '',
    editing: null,
    importing: null,
    duplicates: [],
    duplicatesOpen: false,
    groups: [climbing],
    groupsLoaded: true,
    groupFilter: '',
    groupEditing: null,
  })
})
afterEach(() => {
  cleanup()
  delete (window as any).go
  settings$.contactNameDisplay.set('auto')
  settings$.contactNameSort.set('auto')
})

const rowNames = (view: ReturnType<typeof render>) =>
  within(view.getByRole('listbox'))
    .getAllByRole('option')
    .map((option) => option.querySelector('span span')?.textContent)

describe('names as the reader chose (ADR-0052)', () => {
  it('orders and writes names by the preference', () => {
    stubBridge({ 'people.groups': () => ({ groups: [climbing] }) })
    const view = render(<PeopleView />)
    expect(rowNames(view)).toEqual(['Bob Young', 'Zoe Adams'])
    settings$.contactNameSort.set('last')
    settings$.contactNameDisplay.set('last_comma_first')
    view.rerender(<PeopleView />)
    expect(rowNames(view)).toEqual(['Adams, Zoe', 'Young, Bob'])
    people$.selectedId.set(zoe.id)
    view.rerender(<PeopleView />)
    expect(view.getByRole('heading', { name: 'Adams, Zoe' })).toBeTruthy()
  })
})

describe('contact groups (ADR-0052)', () => {
  it('shows only a group when one is chosen, with how many it holds', () => {
    stubBridge({ 'people.groups': () => ({ groups: [climbing] }) })
    const view = render(<PeopleView />)
    const filter = view.getByLabelText('Show group') as HTMLSelectElement
    expect(view.getByText('Climbing (1)')).toBeTruthy()
    fireEvent.change(filter, { target: { value: climbing.id } })
    view.rerender(<PeopleView />)
    expect(rowNames(view)).toEqual(['Bob Young'])
  })

  it('creates a group on this computer', async () => {
    const calls = stubBridge({
      'people.groupSave': () => ({ ok: true, id: 'group:local::local:new', version: '1' }),
      'people.groups': () => ({ groups: [climbing] }),
    })
    const view = render(<PeopleView />)
    fireEvent.click(view.getByLabelText('New group'))
    fireEvent.change(view.getByLabelText('Group name'), { target: { value: ' Book club ' } })
    fireEvent.click(view.getByText('Save'))
    await waitFor(() => expect(people$.groupEditing.get()).toBeNull())
    const save = calls.find((c) => c.command === 'people.groupSave')!
    expect(save.payload).toEqual({ name: 'Book club', members: [] })
  })

  it('adds somebody to a group from their card, from the version it was read at', async () => {
    const calls = stubBridge({
      'people.groupSave': () => ({ ok: true, id: climbing.id, version: '5' }),
      'people.groups': () => ({ groups: [climbing] }),
    })
    people$.selectedId.set(zoe.id)
    const view = render(<PeopleView />)
    fireEvent.change(view.getByLabelText('Add to group'), { target: { value: climbing.id } })
    await waitFor(() => expect(calls.some((c) => c.command === 'people.groupSave')).toBe(true))
    const save = calls.find((c) => c.command === 'people.groupSave')!
    expect(save.payload).toEqual({ id: climbing.id, version: '4', name: 'Climbing', members: [bob.id, zoe.id] })
  })

  it('takes somebody out of a group and says when the group changed elsewhere', async () => {
    const calls = stubBridge({
      'people.groupSave': () => ({ ok: false, conflict: true, current: null }),
      'people.groups': () => ({ groups: [climbing] }),
    })
    people$.selectedId.set(bob.id)
    const view = render(<PeopleView />)
    fireEvent.click(view.getByLabelText('Remove from Climbing'))
    await waitFor(() => expect(calls.some((c) => c.command === 'people.groupSave')).toBe(true))
    expect(calls.find((c) => c.command === 'people.groupSave')!.payload.members).toEqual([])
  })

  it('offers no changes to a group it cannot write', () => {
    stubBridge({})
    people$.groups.set([{ ...climbing, source: 'google', book: 'google-a', editable: false }])
    people$.groupFilter.set(climbing.id)
    people$.selectedId.set(bob.id)
    const view = render(<PeopleView />)
    expect(view.queryByLabelText('Rename group')).toBeNull()
    expect(view.queryByLabelText('Delete group')).toBeNull()
    expect(view.queryByLabelText('Remove from Climbing')).toBeNull()
  })
})
