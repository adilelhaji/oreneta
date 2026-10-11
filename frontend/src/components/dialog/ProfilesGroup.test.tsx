import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { ProfilesGroup } = await import('./ProfilesGroup')
const { profiles$ } = await import('../../states/profiles')
const { ui$ } = await import('../../states/ui')

type Row = { id: string; name: string; created_at: number; active: boolean; has_data: boolean }

function fakeBridge(rows: Row[]) {
  const calls: { command: string; payload: any }[] = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          calls.push({ command, payload })
          switch (command) {
            case 'profiles.list':
              return { profiles: rows, active: rows.find((row) => row.active)?.id }
            case 'profiles.create':
              if (rows.some((row) => row.name.toLowerCase() === payload.name.toLowerCase()))
                throw new Error('there is already a profile with that name')
              rows.push({
                id: payload.name.toLowerCase(),
                name: payload.name,
                created_at: 1,
                active: false,
                has_data: false,
              })
              return { id: payload.name.toLowerCase() }
            case 'profiles.open':
              return { ok: true }
            case 'profiles.delete':
              rows.splice(
                rows.findIndex((row) => row.id === payload.id),
                1,
              )
              return { ok: true }
          }
          throw new Error(`unexpected ${command}`)
        },
      },
    },
  }
  return calls
}

beforeEach(() => {
  profiles$.assign({ items: [], loaded: false })
  ui$.toast.set('')
})
afterEach(() => {
  cleanup()
  delete (window as any).go
})

const rows = (): Row[] => [
  { id: 'default', name: '', created_at: 0, active: true, has_data: true },
  { id: 'work', name: 'Work', created_at: 1, active: false, has_data: true },
  { id: 'spare', name: 'Spare', created_at: 2, active: false, has_data: false },
]

it('lists the profiles, marks this window and opens another in its own window', async () => {
  const calls = fakeBridge(rows())
  const view = render(<ProfilesGroup />)
  await waitFor(() => expect(view.getByText('Main profile')).toBeTruthy())
  expect(view.getByText('This window')).toBeTruthy()
  // The default profile cannot be renamed or deleted; one with data cannot be deleted from here.
  expect(view.queryByRole('button', { name: 'Rename Main profile' })).toBeNull()
  expect(view.queryByRole('button', { name: 'Delete Work' })).toBeNull()
  expect(view.getByRole('button', { name: 'Delete Spare' })).toBeTruthy()

  const openButtons = view.getAllByRole('button', { name: 'Open' })
  expect(openButtons).toHaveLength(2)
  fireEvent.click(openButtons[0])
  await waitFor(() => expect(calls.some((call) => call.command === 'profiles.open')).toBe(true))
  expect(calls.find((call) => call.command === 'profiles.open')!.payload).toEqual({ id: 'work' })
  expect(ui$.toast.get()).toBe('Opening in its own window')
})

it('creates a profile and says why a duplicate name is refused', async () => {
  const calls = fakeBridge(rows())
  const view = render(<ProfilesGroup />)
  await waitFor(() => expect(view.getByText('Work')).toBeTruthy())
  fireEvent.click(view.getByRole('button', { name: 'New profile' }))
  const input = view.getByLabelText('New profile name')
  fireEvent.change(input, { target: { value: 'work' } })
  fireEvent.click(view.getByRole('button', { name: 'Create' }))
  await waitFor(() => expect(ui$.toast.get()).toBe('there is already a profile with that name'))
  expect(view.getByLabelText('New profile name')).toBeTruthy()

  fireEvent.change(input, { target: { value: 'Home' } })
  fireEvent.click(view.getByRole('button', { name: 'Create' }))
  await waitFor(() => expect(view.getByText('Home')).toBeTruthy())
  expect(view.queryByLabelText('New profile name')).toBeNull()
  expect(calls.filter((call) => call.command === 'profiles.create')).toHaveLength(2)
})
