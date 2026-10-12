import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AccountGroupsGroup } from './AccountGroupsGroup'
import { accountGroups$ } from '../../states/accountGroups'
import { accounts$ } from '../../states/accounts'
import { settleConfirm, ui$ } from '../../states/ui'
import type { Account } from '../../types'

const account = (id: string) =>
  ({ id, email: `${id}@x.test`, display_name: id, provider: 'imap', auth_type: 'password' }) as Account

beforeEach(() => {
  ;(window as any).go = { main: { App: { Invoke: async () => ({}) } } }
  accounts$.set([account('work'), account('home')])
  accountGroups$.groups.set([])
  accountGroups$.active.set(null)
  ui$.toast.set('')
})
afterEach(() => {
  cleanup()
  delete (window as any).go
  ui$.confirm.set(null)
})

it('creates a group with the chosen accounts, and refuses a repeated name', async () => {
  const view = render(<AccountGroupsGroup />)
  fireEvent.click(view.getByRole('button', { name: 'New group' }))
  fireEvent.change(view.getByLabelText('Group name'), { target: { value: 'Work' } })
  fireEvent.click(view.getByLabelText('work'))
  fireEvent.click(view.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(accountGroups$.groups.get()).toHaveLength(1))
  expect(accountGroups$.groups.get()[0]).toMatchObject({ name: 'Work', accounts: ['work'] })
  expect(view.getByText('work', { selector: 'span span' })).toBeTruthy()

  fireEvent.click(view.getByRole('button', { name: 'New group' }))
  fireEvent.change(view.getByLabelText('Group name'), { target: { value: 'work' } })
  fireEvent.click(view.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(ui$.toast.get()).toContain('no other group'))
  expect(accountGroups$.groups.get()).toHaveLength(1)
})

it('deleting a group asks first and leaves the accounts alone', async () => {
  accountGroups$.groups.set([{ id: 'group:w', name: 'Work', accounts: ['work'] }])
  const view = render(<AccountGroupsGroup />)
  fireEvent.click(view.getByRole('button', { name: 'Delete Work' }))
  await waitFor(() => expect(ui$.confirm.get()?.message).toContain('stay as they are'))
  await act(async () => settleConfirm(false))
  expect(accountGroups$.groups.get()).toHaveLength(1)
  fireEvent.click(view.getByRole('button', { name: 'Delete Work' }))
  await waitFor(() => expect(ui$.confirm.get()).not.toBeNull())
  await act(async () => settleConfirm(true))
  expect(accountGroups$.groups.get()).toHaveLength(0)
  expect(accounts$.get()).toHaveLength(2)
})
