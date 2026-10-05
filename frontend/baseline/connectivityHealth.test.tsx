import { afterEach, beforeEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { ConnectivityBanner } from '../src/components/banner/ConnectivityBanner'
import { accounts$ } from '../src/states/accounts'
import { connectivity$, setSyncError } from '../src/states/connectivity'
import { ui$ } from '../src/states/ui'
import { createFixture } from './fixtures'
import i18n from '../src/lib/i18n'

const account = { ...createFixture().account, paused: false, display_name: 'First' }
beforeEach(() => {
  i18n.changeLanguage('en')
  accounts$.set([account, { ...account, id: 'second', display_name: 'Second', needs_reconnect: true }])
  connectivity$.set({ byAccount: {}, unattributed: null })
  ui$.settingsOpen.set(false)
})
afterEach(() => {
  cleanup()
  ui$.settingsOpen.set(false)
})

it('keeps dismissed failures discoverable and navigates the exact account without changing mailbox', () => {
  setSyncError(account.id, 'private diagnostic')
  ui$.selectedAccount.set(account.id)
  const view = render(<ConnectivityBanner />)
  const toggle = view.getByRole('button', { name: 'Account sync' })
  toggle.focus()
  fireEvent.click(toggle)
  const first = within(view.getByRole('listitem', { name: 'First' }))
  fireEvent.click(first.getByRole('button', { name: 'Dismiss' }))
  expect(first.getByText('Unresolved sync issue — recovery not verified')).toBeTruthy()
  expect(view.container.textContent).not.toContain('private diagnostic')
  fireEvent.click(toggle)
  fireEvent.click(toggle)
  expect(view.getByRole('listitem', { name: 'First' }).textContent).toContain('Unresolved sync issue')
  const second = within(view.getByRole('listitem', { name: 'Second' }))
  expect(second.queryByRole('button', { name: 'Retry' })).toBeNull()
  fireEvent.click(second.getByRole('button', { name: 'Account settings' }))
  expect(ui$.accountSettingsId.peek()).toBe('second')
  expect(ui$.selectedAccount.peek()).toBe(account.id)
})

it('announces failures without moving focus and does not offer untargeted or paused retries', () => {
  accounts$.set([{ ...account, paused: true }])
  const view = render(<ConnectivityBanner />)
  const toggle = view.getByRole('button', { name: 'Account sync' })
  toggle.focus()
  act(() => setSyncError(null, 'credential'))
  expect(document.activeElement).toBe(toggle)
  expect(view.getByRole('status').textContent).toContain('1 need attention')
  fireEvent.click(toggle)
  expect(view.getByText('Mail checks paused')).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Retry' })).toBeNull()
})
