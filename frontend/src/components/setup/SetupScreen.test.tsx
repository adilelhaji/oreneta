import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import i18n from '../../lib/i18n'
import { isMac } from '../../lib/shortcuts'
import { accounts$ } from '../../states/accounts'
import { awaiting$ } from '../../states/awaiting'
import { certTrust$ } from '../../states/certificateTrust'
import { compose$ } from '../../states/compose'
import { merge$ } from '../../states/merge'
import { quickRun$ } from '../../states/quickActions'
import { ui$ } from '../../states/ui'
import { SetupScreen } from './SetupScreen'

// The first-account setup screen shows the top band too, with the app menu
// (#343, owner decision 2). happy-dom draws nothing, so every element counts
// as drawn here, as in AppHotkeys.test.tsx.
const proto = HTMLElement.prototype as unknown as Record<string, unknown>
const originalCheck = Object.getOwnPropertyDescriptor(proto, 'checkVisibility')

beforeEach(async () => {
  await i18n.changeLanguage('en')
  Object.defineProperty(proto, 'checkVisibility', { configurable: true, writable: true, value: () => true })
  ;(window as any).go = { main: { App: { Invoke: async () => ({}) } } }
  accounts$.set([])
  ui$.setupMode.set('custom')
  ui$.reconnectAccountId.set('')
  // No dialog of the window's left open by an earlier file: the screen draws
  // them all, and a modal one keeps F6 out.
  ui$.assign({
    setupOpen: false,
    settingsOpen: false,
    paletteOpen: false,
    shortcutsOpen: false,
    aboutOpen: false,
    changelogOpen: false,
    catalogueOpen: false,
    scheduledSendsOpen: false,
    ruleLogOpen: false,
    addFeedAccount: '',
    editFeed: null,
    confirm: null,
    taskEditor: null,
    sweep: null,
  })
  quickRun$.assign({ pending: null, report: null })
  awaiting$.open.set(false)
  merge$.open.set(false)
  certTrust$.prompt.set(null)
  compose$.tabs.set([])
  compose$.activeTab.set('')
})

afterEach(() => {
  cleanup()
  ui$.settingsOpen.set(false)
  ui$.paletteOpen.set(false)
  ui$.shortcutsOpen.set(false)
  compose$.tabs.set([])
  compose$.activeTab.set('')
  if (originalCheck) Object.defineProperty(proto, 'checkVisibility', originalCheck)
  else delete proto.checkVisibility
  delete (window as any).go
})

// Focus is compared as a boolean: a failed toBe between two elements hangs
// Bun's diff.
const region = () => (document.activeElement?.closest('[data-region]') as HTMLElement | null)?.dataset.region

describe('the setup screen (#343)', () => {
  it('has the band with the app menu above the setup, which is the content', () => {
    const view = render(<SetupScreen />)
    const banner = view.getByRole('banner', { name: 'Oreneta' })
    const band = banner.firstElementChild as HTMLElement
    expect(band.dataset.region).toBe('search')
    expect(within(band).getByRole('button', { name: 'App menu' }).getAttribute('aria-haspopup')).toBe('menu')
    const main = view.getByRole('main')
    expect(main.dataset.region).toBe('content')
    expect(within(main).getByRole('heading', { name: 'Connect a Mail Account' })).toBeTruthy()
    // The header comes first, outside <main>. (The setup's own <header> sits
    // in a <section>, so it is no banner; the browser test counts them.)
    expect(banner.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(main.contains(banner)).toBe(false)
  })

  it('goes from the band to the setup and back with F6 and Shift+F6', () => {
    const view = render(<SetupScreen />)
    const button = view.getByRole('button', { name: 'App menu' })
    const email = view.getByRole('textbox', { name: 'Email Address' })
    email.focus()
    expect(fireEvent.keyDown(email, { key: 'F6' })).toBe(false)
    expect(document.activeElement === button).toBe(true)
    expect(region()).toBe('search')
    fireEvent.keyDown(button, { key: 'F6' })
    expect(region()).toBe('content')
    expect(document.activeElement === email).toBe(true)
    fireEvent.keyDown(email, { key: 'F6', shiftKey: true })
    expect(document.activeElement === button).toBe(true)
  })

  it("opens Settings and the palette from the menu and the keyboard, and leaves mail's keys alone", async () => {
    const view = render(<SetupScreen />)
    const button = view.getByRole('button', { name: 'App menu' })
    fireEvent.click(button)
    fireEvent.click(view.getByRole('menuitem', { name: 'Open settings' }))
    expect(ui$.settingsOpen.peek()).toBe(true)
    expect(view.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    await act(async () => ui$.settingsOpen.set(false))
    const email = view.getByRole('textbox', { name: 'Email Address' })
    email.focus()
    const mod = { ctrlKey: !isMac, metaKey: isMac }
    await act(async () => {
      fireEvent.keyDown(email, { key: 'k', ...mod })
    })
    expect(ui$.paletteOpen.peek()).toBe(true)
    expect(view.getByRole('dialog', { name: 'Command palette' })).toBeTruthy()
    await act(async () => ui$.paletteOpen.set(false))
    // Mail's shortcuts do nothing here, and the arrows stay the page's.
    fireEvent.keyDown(email, { key: 'n', ...mod })
    expect(compose$.tabs.peek()).toHaveLength(0)
    expect(fireEvent.keyDown(document.body, { key: 'ArrowDown' })).toBe(true)
  })
})
