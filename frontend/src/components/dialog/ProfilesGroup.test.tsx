import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

mock.module('../../boot', () => ({ boot: async () => {} }))

const { ProfilesGroup } = await import('./ProfilesGroup')
const { profiles$ } = await import('../../states/profiles')
const { ui$, settleConfirm } = await import('../../states/ui')

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
              if (payload.id === 'broken' && !payload.force) return { ok: false, purgeFailed: 'no keychain' }
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
  // The default profile and this window's cannot be renamed or deleted.
  expect(view.queryByRole('button', { name: 'Rename Main profile' })).toBeNull()
  expect(view.queryByRole('button', { name: 'Delete Main profile' })).toBeNull()
  expect(view.getByRole('button', { name: 'Delete Work' })).toBeTruthy()
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

it('deletes a profile with data only once its name is typed exactly', async () => {
  const calls = fakeBridge(rows())
  const view = render(<ProfilesGroup />)
  await waitFor(() => expect(view.getByText('Work')).toBeTruthy())
  fireEvent.click(view.getByRole('button', { name: 'Delete Work' }))
  expect(view.getByText(/Mail and data on servers are not touched/)).toBeTruthy()
  const confirm = view.getByRole('button', { name: 'Delete with everything in it' }) as HTMLButtonElement
  const typed = view.getByLabelText('Profile name to confirm')
  for (const wrong of ['work', 'Wor', '']) {
    fireEvent.change(typed, { target: { value: wrong } })
    expect(confirm.disabled).toBe(true)
  }
  fireEvent.change(typed, { target: { value: 'Work' } })
  fireEvent.click(confirm)
  await waitFor(() => expect(calls.some((call) => call.command === 'profiles.delete')).toBe(true))
  await waitFor(() => expect(view.queryByLabelText('Profile name to confirm')).toBeNull())
  expect(view.queryByRole('button', { name: 'Delete Work' })).toBeNull()
  expect(calls.find((call) => call.command === 'profiles.delete')!.payload).toEqual({ id: 'work', confirmName: 'Work' })
})

it('asks again when its saved passwords could not be removed, and deletes nothing if declined', async () => {
  const list = [...rows(), { id: 'broken', name: 'Broken', created_at: 3, active: false, has_data: true }]
  const calls = fakeBridge(list)
  const view = render(<ProfilesGroup />)
  await waitFor(() => expect(view.getByText('Broken')).toBeTruthy())
  fireEvent.click(view.getByRole('button', { name: 'Delete Broken' }))
  fireEvent.change(view.getByLabelText('Profile name to confirm'), { target: { value: 'Broken' } })
  fireEvent.click(view.getByRole('button', { name: 'Delete with everything in it' }))
  await waitFor(() => expect(ui$.confirm.get()?.message).toContain('no keychain'))
  settleConfirm(false)
  await waitFor(() => expect(ui$.confirm.get()).toBeNull())
  expect(view.getByText('Broken')).toBeTruthy()
  expect(calls.filter((call) => call.command === 'profiles.delete')).toHaveLength(1)

  fireEvent.click(view.getByRole('button', { name: 'Delete with everything in it' }))
  await waitFor(() => expect(ui$.confirm.get()).not.toBeNull())
  settleConfirm(true)
  await waitFor(() => expect(view.queryByText('Broken')).toBeNull())
  expect(calls.filter((call) => call.command === 'profiles.delete').at(-1)!.payload).toEqual({
    id: 'broken',
    confirmName: 'Broken',
    force: true,
  })
})
