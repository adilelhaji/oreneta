import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { useValue } from '@legendapp/state/react'
import { DEFAULT_FONT_SCALE } from '../../lib/fonts'
import i18n from '../../lib/i18n'
import { isMac } from '../../lib/shortcuts'
import { accounts$ } from '../../states/accounts'
import { awaiting$ } from '../../states/awaiting'
import { certTrust$ } from '../../states/certificateTrust'
import { compose$ } from '../../states/compose'
import { merge$ } from '../../states/merge'
import { quickRun$ } from '../../states/quickActions'
import { settings$ } from '../../states/settings'
import { ui$ } from '../../states/ui'
import type { Account } from '../../types'
import { AppFrame } from '../shell/AppFrame'
import { SetupScreen } from './SetupScreen'

// The first-account setup screen shows the top band too, with the app menu
// (#343, owner decision 2). happy-dom draws nothing, so every element counts
// as drawn here, as in AppHotkeys.test.tsx.
const proto = HTMLElement.prototype as unknown as Record<string, unknown>
const originalCheck = Object.getOwnPropertyDescriptor(proto, 'checkVisibility')

beforeEach(async () => {
  await i18n.changeLanguage('en')
  Object.defineProperty(proto, 'checkVisibility', { configurable: true, writable: true, value: () => true })
  // The core never answers: Settings' panels stay in their loading state
  // rather than read made-up replies.
  ;(window as any).go = { main: { App: { Invoke: () => new Promise(() => {}) } } }
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
  accounts$.set([])
  settings$.fontScale.set(DEFAULT_FONT_SCALE)
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
// Focus goes back in a microtask after a dialog or a menu is gone.
const settle = () => act(async () => await Promise.resolve())
const mod = { ctrlKey: !isMac, metaKey: isMac }

const account: Account = {
  id: 'synthetic-account',
  email: 'alex@example.test',
  display_name: 'Alex · Demo',
  provider: 'imap',
  auth_type: 'password',
  imap_host: 'imap.example.test',
  imap_port: 993,
  smtp_host: 'smtp.example.test',
  smtp_port: 465,
  tls: true,
  paused: true,
  conversation_html: false,
  load_remote_images: false,
}

// The window as App puts it together: one frame, with the setup in it while
// there is no account, and the window's own content once there is one.
function Window() {
  const setup = useValue(accounts$).length === 0
  return (
    <AppFrame setup={setup}>
      {setup ? (
        <SetupScreen />
      ) : (
        <main data-region="content" aria-label="Mail">
          <button type="button">Inbox</button>
        </main>
      )}
    </AppFrame>
  )
}

function openSettings(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole('button', { name: 'App menu' }))
  fireEvent.click(view.getByRole('menuitem', { name: 'Open settings' }))
  return view.getByRole('dialog', { name: 'Settings' })
}

describe('the setup screen (#343)', () => {
  it('has the band with the app menu above the setup, which is the content', () => {
    const view = render(<Window />)
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
    const view = render(<Window />)
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
    const view = render(<Window />)
    openSettings(view)
    expect(ui$.settingsOpen.peek()).toBe(true)
    await act(async () => ui$.settingsOpen.set(false))
    const email = view.getByRole('textbox', { name: 'Email Address' })
    email.focus()
    await act(async () => {
      fireEvent.keyDown(email, { key: 'k', ...mod })
    })
    expect(ui$.paletteOpen.peek()).toBe(true)
    expect(view.getByRole('dialog', { name: 'Command palette' })).toBeTruthy()
    await act(async () => ui$.paletteOpen.set(false))
    // Mail's shortcuts do nothing here, not even take the key (Ctrl/⌘+N would
    // open a message to no account), and the arrows stay the page's.
    expect(fireEvent.keyDown(email, { key: 'n', ...mod })).toBe(true)
    expect(compose$.tabs.peek()).toHaveLength(0)
    expect(fireEvent.keyDown(document.body, { key: 'ArrowDown' })).toBe(true)
  })

  it('zooms with the keyboard there too', () => {
    const view = render(<Window />)
    const email = view.getByRole('textbox', { name: 'Email Address' })
    email.focus()
    const start = settings$.fontScale.peek()
    expect(fireEvent.keyDown(email, { key: '=', ...mod })).toBe(false)
    expect(settings$.fontScale.peek()).toBeGreaterThan(start)
    expect(fireEvent.keyDown(email, { key: '-', ...mod })).toBe(false)
    expect(settings$.fontScale.peek()).toBe(start)
    fireEvent.keyDown(email, { key: '=', ...mod })
    expect(fireEvent.keyDown(email, { key: '0', ...mod })).toBe(false)
    expect(settings$.fontScale.peek()).toBe(DEFAULT_FONT_SCALE)
  })

  it("takes Settings' «+» back to the setup, which keeps its provider and what was typed", async () => {
    const view = render(<Window />)
    const email = view.getByRole('textbox', { name: 'Email Address' }) as HTMLInputElement
    fireEvent.change(email, { target: { value: 'alex@example.test' } })
    // The «+» of the mail accounts, then of the feeds.
    for (const index of [0, 1]) {
      const settings = openSettings(view)
      const add = within(settings).getAllByTitle('Add account')[index]
      await act(async () => {
        fireEvent.click(add)
      })
      await settle()
      expect(ui$.settingsOpen.peek(), `«+» ${index}`).toBe(false)
      // No second add-account dialog over the setup, and its provider as it was.
      expect(ui$.setupOpen.peek(), `«+» ${index}`).toBe(false)
      expect(ui$.setupMode.peek(), `«+» ${index}`).toBe('custom')
      expect(view.queryAllByRole('dialog'), `«+» ${index}`).toHaveLength(0)
      expect(document.activeElement === email, `«+» ${index}`).toBe(true)
      expect(email.value).toBe('alex@example.test')
    }
  })

  it('keeps Settings open, with its focus, when the first account arrives, then gives the focus to the band', async () => {
    const view = render(<Window />)
    const button = view.getByRole('button', { name: 'App menu' })
    const settings = openSettings(view)
    // The header's (an earlier file can leave a notice with its own «Close»).
    const close = within(settings).getAllByRole('button', { name: 'Close' })[0]
    close.focus()
    // A backup restored from Settings brings the first account: the window
    // replaces the setup behind Settings.
    await act(async () => accounts$.set([account]))
    expect(view.getByRole('main', { name: 'Mail' })).toBeTruthy()
    expect(view.queryByRole('heading', { name: 'Connect a Mail Account' })).toBeNull()
    expect(settings.isConnected).toBe(true)
    expect(document.activeElement === close).toBe(true)
    expect(view.getByRole('button', { name: 'App menu' }) === button).toBe(true)
    // Closed, it gives the focus back to its opener, the app menu button.
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    await settle()
    expect(ui$.settingsOpen.peek()).toBe(false)
    expect(document.activeElement === button).toBe(true)
  })
})
