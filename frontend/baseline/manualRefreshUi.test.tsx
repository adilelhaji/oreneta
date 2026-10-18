import { afterEach, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { QuickSettingsMenu } from '../src/components/sidenav/QuickSettingsMenu'
import { ui$ } from '../src/states/ui'
import i18n from '../src/lib/i18n'

afterEach(() => { cleanup(); ui$.busy.set(false) })

it('describes an in-flight manual request and prevents another menu activation', () => {
  i18n.changeLanguage('en')
  ui$.busy.set(true)
  const view = render(<QuickSettingsMenu anchor={{ x: 0, y: 0, placement: 'down' }} onClose={() => {}} />)
  // A menu item: disabled through aria-disabled, still reached by the arrows (#289).
  const pending = view.getByRole('menuitem', { name: /Requesting a mail check/ })
  expect(pending.getAttribute('aria-disabled')).toBe('true')
  act(() => ui$.busy.set(false))
  expect(view.getByRole('menuitem', { name: /Sync mailbox/ }).hasAttribute('aria-disabled')).toBe(false)
})
