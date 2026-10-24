import { afterEach, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { AppMenuButton } from '../src/components/shell/AppMenu'
import { accounts$ } from '../src/states/accounts'
import { ui$ } from '../src/states/ui'
import i18n from '../src/lib/i18n'
import { createFixture } from './fixtures'

afterEach(() => {
  cleanup()
  ui$.busy.set(false)
  accounts$.set([])
})

// The rail's More menu went with the rail (#354); the app menu, which has
// what it offered, says the same of a manual mail check in flight.
it('describes an in-flight manual request and prevents another menu activation', () => {
  i18n.changeLanguage('en')
  accounts$.set([createFixture().account])
  ui$.busy.set(true)
  const view = render(<AppMenuButton />)
  fireEvent.click(view.getByRole('button', { name: 'App menu' }))
  const menu = view.getByRole('menu', { name: 'App menu' })
  // A menu item: disabled through aria-disabled, still reached by the arrows
  // (#289), and the request in flight is why, as its description.
  const pending = within(menu).getByRole('menuitem', { name: 'Sync mailbox' })
  expect(pending.getAttribute('aria-disabled')).toBe('true')
  const description = document.getElementById(pending.getAttribute('aria-describedby') ?? '')
  expect(description?.textContent).toMatch(/Requesting a mail check/)
  act(() => ui$.busy.set(false))
  expect(within(menu).getByRole('menuitem', { name: 'Sync mailbox' }).hasAttribute('aria-disabled')).toBe(false)
})
