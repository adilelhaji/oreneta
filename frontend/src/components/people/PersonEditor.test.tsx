import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { PeopleView } from './PeopleView'
import { people$ } from '../../states/people'
import type { Person } from '../../types'

const local: Person = {
  id: 'local::local:u1',
  source: 'local',
  account: '',
  book: 'local',
  name: 'Ann Lee',
  organisation: '',
  note: '',
  photo: '',
  emails: [{ addr: 'ann@example.com', label: '' }],
  phones: [],
  version: '3',
  editable: true,
}

const synced: Person = { ...local, id: 'carddav::b:u2', source: 'carddav', name: 'Bo Ray', editable: false }

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
  people$.set({ people: [local, synced], loaded: true, loading: false, query: '', selectedId: '', editing: null })
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

describe('the local address book', () => {
  it('creates a contact from the list header', async () => {
    const calls = stubBridge({ 'people.save': () => ({ ok: true, id: 'local::local:new', version: '1' }) })
    const view = render(<PeopleView />)
    fireEvent.click(view.getByText('New contact'))
    fireEvent.change(view.getByLabelText('Name'), { target: { value: 'Cy Dao' } })
    fireEvent.change(view.getByLabelText('Email 1'), { target: { value: 'cy@example.com' } })
    fireEvent.click(view.getByText('Save'))
    await waitFor(() => expect(people$.editing.get()).toBeNull())
    const save = calls.find((c) => c.command === 'people.save')!
    expect(save.payload.id).toBeUndefined()
    expect(save.payload.person).toMatchObject({ name: 'Cy Dao', emails: [{ addr: 'cy@example.com' }] })
  })

  it('offers edit and delete only on contacts it can write', () => {
    people$.selectedId.set(synced.id)
    const view = render(<PeopleView />)
    expect(view.queryByLabelText('Edit')).toBeNull()
    people$.selectedId.set(local.id)
    view.rerender(<PeopleView />)
    expect(view.getByLabelText('Edit')).toBeTruthy()
  })

  it('edits from the version it read and, on a conflict, saves nothing until the reader chooses', async () => {
    let saves = 0
    const calls = stubBridge({
      'people.save': (payload) => {
        saves += 1
        if (saves === 1) {
          return {
            ok: false,
            conflict: true,
            current: {
              id: local.id,
              version: '4',
              name: 'Ann Lee-Smith',
              organisation: '',
              note: '',
              emails: [],
              phones: [],
            },
          }
        }
        return { ok: true, id: payload.id, version: '5' }
      },
    })
    people$.selectedId.set(local.id)
    const view = render(<PeopleView />)
    fireEvent.click(view.getByLabelText('Edit'))
    fireEvent.change(view.getByLabelText('Name'), { target: { value: 'Ann L.' } })
    fireEvent.click(view.getByText('Save'))

    await waitFor(() => expect(view.getByText('Changed in another window')).toBeTruthy())
    expect(calls[0].payload).toMatchObject({ id: local.id, version: '3' })
    expect(view.container.ownerDocument.body.textContent).toContain('Ann Lee-Smith')
    expect(view.container.ownerDocument.body.textContent).toContain('Ann L.')

    fireEvent.click(view.getByText('Keep mine'))
    await waitFor(() => expect(people$.editing.get()).toBeNull())
    const second = calls.filter((c) => c.command === 'people.save')[1]
    expect(second.payload).toMatchObject({ id: local.id, version: '4', person: { name: 'Ann L.' } })
  })

  it('keeping the saved copy writes nothing', async () => {
    const calls = stubBridge({
      'people.save': () => ({ ok: false, conflict: true, current: null }),
    })
    people$.selectedId.set(local.id)
    const view = render(<PeopleView />)
    fireEvent.click(view.getByLabelText('Edit'))
    fireEvent.click(view.getByText('Save'))
    await waitFor(() => expect(view.getByText('Discard my changes')).toBeTruthy())
    fireEvent.click(view.getByText('Discard my changes'))
    await waitFor(() => expect(people$.editing.get()).toBeNull())
    expect(calls.filter((c) => c.command === 'people.save').length).toBe(1)
  })
})
