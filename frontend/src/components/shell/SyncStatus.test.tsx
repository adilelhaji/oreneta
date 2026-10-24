import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import i18n from '../../lib/i18n'
import { messages, supportedI18nLanguages } from '../../generated/locales'
import { DEFAULT_NOTIFICATION_PREFS } from '../../lib/quietHours'
import { isMac } from '../../lib/shortcuts'
import { accounts$ } from '../../states/accounts'
import { connectivity$, dismissSyncError, setSyncError, type SyncObservation } from '../../states/connectivity'
import { notificationClock } from '../../states/notifications'
import { settings$ } from '../../states/settings'
import { ui$ } from '../../states/ui'
import type { Account } from '../../types'
import { ConnectivityBanner } from '../banner/ConnectivityBanner'
import { AppHeader } from './AppHeader'
import { SYNC_SUMMARY_MIN_WINDOW } from './SyncStatus'

// The sync status and do-not-disturb at the end of the top band (ADR-0068 §2, #345).

const work: Account = {
  id: 'work',
  email: 'work@example.test',
  display_name: 'Work',
  provider: 'imap',
  auth_type: 'password',
  paused: false,
} as Account
const home: Account = { ...work, id: 'home', email: 'home@example.test', display_name: 'Home' }

const realNow = notificationClock.now
const setWidth = (width: number) => (window as any).happyDOM.setViewport({ width, height: 900 })
const UNKNOWN = 'Complete sync status unknown'

function observation(patch: Partial<SyncObservation>): SyncObservation {
  return { failure: false, dismissed: false, lastActivityAt: null, request: 'idle', revision: 1, proxy: null, ...patch }
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  setWidth(1440)
  document.documentElement.style.fontSize = '16px'
  ;(window as any).go = { main: { App: { Invoke: async () => ({ ok: true, online: true }) } } }
  notificationClock.now = () => new Date(2026, 9, 23, 12)
  settings$.notifications.set(structuredClone(DEFAULT_NOTIFICATION_PREFS))
  accounts$.set([work, home])
  connectivity$.set({ byAccount: {}, unattributed: null })
  ui$.module.set('mail')
  ui$.selectedAccount.set(work.id)
  ui$.settingsOpen.set(false)
  ui$.accountSettingsId.set('')
  ui$.settingsFocus.set({ section: '', request: 0 })
})

afterEach(async () => {
  cleanup()
  setWidth(1024)
  document.documentElement.dir = ''
  document.documentElement.style.fontSize = ''
  notificationClock.now = realNow
  settings$.notifications.set(structuredClone(DEFAULT_NOTIFICATION_PREFS))
  accounts$.set([])
  connectivity$.set({ byAccount: {}, unattributed: null })
  ui$.settingsOpen.set(false)
  delete (window as any).go
  await i18n.changeLanguage('en')
})

/** The window as App.tsx lays it out: the header with the band, then the bar under it. */
function renderWindow() {
  const view = render(
    <>
      <AppHeader />
      <ConnectivityBanner />
    </>,
  )
  const end = () => view.container.querySelector<HTMLElement>('[data-band-end]')!
  const button = () => end().querySelector<HTMLButtonElement>('[data-sync-status-button]')
  const bar = () => view.queryByRole('region', { name: 'Account sync' })
  const popover = () => view.queryByRole('dialog', { name: 'Account sync' })
  return { view, end, button, bar, popover }
}

/** Every element a screen reader would announce from: live regions and statuses. */
function liveTexts(root: ParentNode = document.body) {
  return [...root.querySelectorAll('[role="status"], [aria-live]:not([aria-live="off"])')].map(
    (element) => element.textContent?.trim() ?? '',
  )
}

const placeButton = (button: HTMLElement, left: number, right: number) => {
  button.getBoundingClientRect = () => ({
    left,
    right,
    top: 2,
    bottom: 34,
    width: right - left,
    height: 32,
    x: left,
    y: 2,
    toJSON: () => ({}),
  })
}

describe('the sync status button at the end of the band (#345)', () => {
  it("shows nothing with no account, as today's region did, and appears with the first", () => {
    accounts$.set([])
    const { end, button, bar } = renderWindow()
    expect(button()).toBeNull()
    expect(end().querySelector('[role="status"]')).toBeNull()
    expect(bar()).toBeNull()
    act(() => accounts$.set([work]))
    expect(button()!.textContent).toBe(UNKNOWN)
    expect(within(end()).getByRole('status').textContent).toBe(UNKNOWN)
    expect(bar()).toBeNull()
  })

  it('says the full sync status is unknown, with no bar under the header, when nothing needs attention', () => {
    const { view, end, button, bar } = renderWindow()
    expect(button()!.textContent).toBe(UNKNOWN)
    expect(view.getByRole('button', { name: UNKNOWN })).toBe(button()!)
    expect(button()!.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button()!.getAttribute('aria-expanded')).toBe('false')
    expect(button()!.title).toBe(UNKNOWN)
    // The live region stays, polite and atomic, with the same words.
    const status = within(end()).getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.getAttribute('aria-atomic')).toBe('true')
    expect(status.textContent).toBe(UNKNOWN)
    // The band carries it: no bar under the header.
    expect(bar()).toBeNull()
  })

  it('counts what needs attention, as today, without the bar when nothing is prominent', () => {
    // A request that was not confirmed, and a failure already dismissed.
    connectivity$.byAccount.set({
      work: observation({ request: 'unconfirmed' }),
      home: observation({ failure: true, dismissed: true }),
    })
    const { end, button, bar } = renderWindow()
    expect(button()!.textContent).toBe('2 need attention')
    expect(within(end()).getByRole('status').textContent).toBe('2 need attention')
    expect(bar()).toBeNull()
  })

  it('keeps a pending request out of the summary, as today, and says it in the detail', () => {
    connectivity$.byAccount.set({ work: observation({ request: 'pending' }) })
    const { view, button } = renderWindow()
    expect(button()!.textContent).toBe(UNKNOWN)
    fireEvent.click(button()!)
    const entry = within(view.getByRole('listitem', { name: 'Work' }))
    expect(entry.getByRole('status').textContent).toBe('Requesting a mail check…')
    expect(entry.getByRole('button', { name: 'Retry' }).hasAttribute('disabled')).toBe(true)
  })

  it('changes its words in place, so a failure is announced once, without moving the focus', () => {
    const { end, button, bar } = renderWindow()
    const trigger = button()!
    trigger.focus()
    act(() => setSyncError('work', 'private diagnostic'))
    expect(document.activeElement).toBe(trigger)
    expect(button()).toBe(trigger)
    expect(trigger.textContent).toBe('1 need attention')
    // The bar appears, but the live region is the band's, the one that was
    // there before the change: one announcement.
    expect(bar()).not.toBeNull()
    expect(liveTexts()).toEqual(['1 need attention'])
    expect(liveTexts(end())).toEqual(['1 need attention'])
    expect(document.body.textContent).not.toContain('private diagnostic')
  })

  it('never says «Synced»: in every state and every catalog, only the summary today had', () => {
    const states: Array<() => void> = [
      () => {},
      () => connectivity$.byAccount.set({ work: observation({ request: 'pending' }) }),
      () => connectivity$.byAccount.set({ work: observation({ request: 'requested', lastActivityAt: 1 }) }),
      () => connectivity$.byAccount.set({ work: observation({ request: 'unconfirmed' }) }),
      () => setSyncError('home', 'x'),
      () => accounts$.set([{ ...work, needs_reconnect: true }, home]),
      () => setSyncError(null, 'x'),
    ]
    for (const language of supportedI18nLanguages) {
      const catalog = messages[language]
      const unknown = catalog['connectivity.health.unknown']
      const attention = (count: number) => catalog['connectivity.health.attention'].replace('{count}', String(count))
      for (const [index, state] of states.entries()) {
        act(() => {
          void i18n.changeLanguage(language)
          accounts$.set([work, home])
          connectivity$.set({ byAccount: {}, unattributed: null })
          state()
        })
        const { button, end } = renderWindow()
        const said = button()!.textContent!
        expect([unknown, attention(1)], `${language}, state ${index}`).toContain(said)
        expect(within(end()).getByRole('status').textContent).toBe(said)
        // Neither summary is a claim that everything is in sync.
        expect(said).not.toMatch(/^(Synced|Sincronitzat|Sincronizado)$/i)
        cleanup()
      }
    }
  })
})

describe('below 1025 px the icon alone (#345)', () => {
  for (const width of [SYNC_SUMMARY_MIN_WINDOW - 1, 768]) {
    it(`keeps the summary as its name and tooltip, and the live region, at ${width}px`, () => {
      setSyncError('work', 'x')
      setWidth(width)
      const { view, end, button } = renderWindow()
      const trigger = button()!
      // On screen, only the icon; the words stay its name.
      const words = trigger.querySelector('span')!
      expect(words.className.split(' ')).toContain('sr-only')
      expect(trigger.className.split(' ')).toContain('w-8')
      expect(trigger.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
      expect(view.getByRole('button', { name: '1 need attention' })).toBe(trigger)
      expect(trigger.title).toBe('1 need attention')
      const status = within(end()).getByRole('status')
      expect(status.textContent).toBe('1 need attention')
      expect(status.className.split(' ')).toContain('sr-only')
    })
  }

  it('shows the words beside the icon from 1025 px, and follows the window across it', async () => {
    setWidth(SYNC_SUMMARY_MIN_WINDOW)
    const { button } = renderWindow()
    const words = () => button()!.querySelector('span')!
    expect(words().className.split(' ')).not.toContain('sr-only')
    expect(words().className.split(' ')).toContain('truncate')
    // happy-dom tells a media query's listeners about a change only once the
    // query has matched, so the window is resized wide once before it narrows.
    await act(async () => setWidth(1500))
    await act(async () => setWidth(SYNC_SUMMARY_MIN_WINDOW - 1))
    expect(words().className.split(' ')).toContain('sr-only')
    await act(async () => setWidth(1440))
    expect(words().className.split(' ')).not.toContain('sr-only')
  })
})

describe('the popover with the detail (#345)', () => {
  it("opens today's detail, each account with its observation and actions, and takes the focus", () => {
    setSyncError('work', 'x')
    connectivity$.byAccount.set({ ...connectivity$.byAccount.peek(), home: observation({ lastActivityAt: 1 }) })
    const { view, button, popover } = renderWindow()
    fireEvent.click(button()!)
    const dialog = popover()!
    expect(dialog).not.toBeNull()
    // Not modal: the page around it stays reachable.
    expect(dialog.hasAttribute('aria-modal')).toBe(false)
    expect(button()!.getAttribute('aria-expanded')).toBe('true')
    expect(button()!.getAttribute('aria-controls')).toBe(dialog.id)
    expect(document.activeElement).toBe(dialog)
    expect(dialog.textContent).toContain('Observations from this session only.')
    const first = within(within(dialog).getByRole('listitem', { name: 'Work' }))
    expect(first.getByText('Unresolved sync issue — recovery not verified')).toBeTruthy()
    expect(first.getByRole('button', { name: 'Account settings' })).toBeTruthy()
    expect(first.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(first.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
    const second = within(within(dialog).getByRole('listitem', { name: 'Home' }))
    expect(second.getByText('Partial mail activity observed')).toBeTruthy()
    expect(second.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    // Dismissing in it keeps the entry, with the focus on it.
    fireEvent.click(first.getByRole('button', { name: 'Dismiss' }))
    expect(document.activeElement).toBe(view.getByRole('listitem', { name: 'Work' }))
    expect(popover()).not.toBeNull()
  })

  it('closes with Escape and gives the focus back to the button', () => {
    const { button, popover } = renderWindow()
    button()!.focus()
    fireEvent.click(button()!)
    expect(popover()).not.toBeNull()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(button())
    expect(button()!.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes with a second click, a click outside or the focus going elsewhere', async () => {
    const { view, button, popover } = renderWindow()
    const outside = document.createElement('button')
    document.body.append(outside)
    try {
      fireEvent.click(button()!)
      fireEvent.click(button()!)
      expect(popover()).toBeNull()
      fireEvent.click(button()!)
      fireEvent.pointerDown(outside)
      expect(popover()).toBeNull()
      fireEvent.click(button()!)
      await act(async () => outside.focus())
      expect(popover()).toBeNull()
      expect(document.activeElement).toBe(outside)
      // Its own scroll is not a reason to close.
      fireEvent.click(button()!)
      fireEvent.scroll(popover()!)
      expect(popover()).not.toBeNull()
      expect(view.container.contains(popover())).toBe(true)
    } finally {
      outside.remove()
    }
  })

  it('opens Settings from the button, closed, so Settings gives the focus back to it', () => {
    setSyncError('home', 'x')
    const { view, button, popover } = renderWindow()
    fireEvent.click(button()!)
    fireEvent.click(
      within(view.getByRole('listitem', { name: 'Home' })).getByRole('button', { name: 'Account settings' }),
    )
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(button())
    expect(ui$.settingsOpen.peek()).toBe(true)
    expect(ui$.accountSettingsId.peek()).toBe('home')
  })

  it('keeps a letter or an arrow inside, and acts on a Ctrl/⌘ or function-key shortcut from the button', () => {
    const { button, popover } = renderWindow()
    const reached: string[] = []
    const listen = (event: KeyboardEvent) => reached.push(event.key)
    window.addEventListener('keydown', listen)
    try {
      fireEvent.click(button()!)
      for (const key of ['e', 'j', 'ArrowDown', 'Delete', 'Enter']) fireEvent.keyDown(popover()!, { key })
      expect(reached).toEqual([])
      expect(popover()).not.toBeNull()
      fireEvent.keyDown(popover()!, { key: 'k', code: 'KeyK', ...(isMac ? { metaKey: true } : { ctrlKey: true }) })
      expect(reached).toEqual(['k'])
      expect(popover()).toBeNull()
      expect(document.activeElement).toBe(button())
      fireEvent.click(button()!)
      fireEvent.keyDown(popover()!, { key: 'F6', code: 'F6' })
      expect(reached).toEqual(['k', 'F6'])
      expect(popover()).toBeNull()
    } finally {
      window.removeEventListener('keydown', listen)
    }
  })

  for (const direction of ['ltr', 'rtl'] as const) {
    it(`opens under the button, its end edge on the button's, towards the start of the line: ${direction}`, () => {
      document.documentElement.dir = direction
      const { button, popover } = renderWindow()
      // Towards the end of the band, with room on both sides of it, so the
      // edge it lines up with is the end one, not the window's.
      if (direction === 'ltr') placeButton(button()!, 1000, 1232)
      else placeButton(button()!, 208, 440)
      fireEvent.click(button()!)
      const dialog = popover()!
      // 24 rem wide, whole pixels, 4 px under the button.
      expect(dialog.style.width).toBe('384px')
      expect(dialog.style.top).toBe('38px')
      expect(dialog.style.left).toBe(direction === 'ltr' ? `${1232 - 384}px` : '208px')
      expect(dialog.style.maxHeight).toBe(`${900 - 38 - 8}px`)
    })
  }

  for (const width of [900, 768, 320]) {
    it(`stays inside a ${width}px window`, () => {
      setWidth(width)
      const { button, popover } = renderWindow()
      placeButton(button()!, width - 40, width - 8)
      fireEvent.click(button()!)
      const dialog = popover()!
      const left = parseFloat(dialog.style.left)
      const right = left + parseFloat(dialog.style.width)
      expect(left).toBeGreaterThanOrEqual(8)
      expect(right).toBeLessThanOrEqual(width - 8)
      if (width === 320) expect(dialog.style.width).toBe(`${320 - 16}px`)
    })
  }

  it('closes on a resize or a scroll outside, and a focus that was in it goes back to the button', async () => {
    const { view, button, popover } = renderWindow()
    fireEvent.click(button()!)
    expect(document.activeElement).toBe(popover())
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(button())
    fireEvent.click(button()!)
    expect(document.activeElement).toBe(popover())
    fireEvent.scroll(view.container.querySelector('[data-band-centre]')!)
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(button())
  })
})

describe('the bar under the header (#345)', () => {
  it('stays, prominent, while a failure is not dismissed, and goes once it is, with the focus to the band', () => {
    setSyncError('work', 'x')
    const { view, button, bar } = renderWindow()
    const region = bar()!
    expect(region).not.toBeNull()
    expect(region.className).toContain('bg-danger-soft')
    expect(region.textContent).toContain('1 need attention')
    // Its summary is not a second live region.
    expect(liveTexts(region)).toEqual([])
    const toggle = within(region).getByRole('button', { name: 'Account sync' })
    fireEvent.click(toggle)
    const entry = within(region).getByRole('listitem', { name: 'Work' })
    fireEvent.click(within(entry).getByRole('button', { name: 'Dismiss' }))
    // Dismissed: nothing is prominent, so the bar goes, and the focus it had
    // goes to the band's status, which still counts the failure.
    expect(bar()).toBeNull()
    expect(document.activeElement).toBe(button())
    expect(button()!.textContent).toBe('1 need attention')
    expect(view.getAllByRole('status').map((status) => status.textContent)).toEqual(['1 need attention'])
  })

  it('cannot be dismissed while an account must sign in again, in the bar or in the popover', () => {
    accounts$.set([{ ...work, needs_reconnect: true }, home])
    const { button, bar, popover } = renderWindow()
    const region = bar()!
    expect(region).not.toBeNull()
    fireEvent.click(within(region).getByRole('button', { name: 'Account sync' }))
    const entry = within(within(region).getByRole('listitem', { name: 'Work' }))
    expect(entry.getByText('Sign in again in account settings')).toBeTruthy()
    expect(entry.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    expect(entry.queryByRole('button', { name: 'Retry' })).toBeNull()
    fireEvent.click(button()!)
    expect(within(popover()!).queryByRole('button', { name: 'Dismiss' })).toBeNull()
    act(() => dismissSyncError('work'))
    expect(bar()).not.toBeNull()
  })

  it('stays for an unattributed problem until it is dismissed', () => {
    setSyncError(null, 'x')
    const { bar, button } = renderWindow()
    expect(bar()).not.toBeNull()
    expect(button()!.textContent).toBe('1 need attention')
    act(() => dismissSyncError(null))
    expect(bar()).toBeNull()
    expect(button()!.textContent).toBe('1 need attention')
  })

  it('folds its detail while the popover is open: one detail, one set of announcements', () => {
    setSyncError('work', 'x')
    connectivity$.byAccount.set({
      ...connectivity$.byAccount.peek(),
      home: observation({ request: 'requested' }),
    })
    const { view, button, bar, popover } = renderWindow()
    const toggle = within(bar()!).getByRole('button', { name: 'Account sync' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(button()!)
    expect(popover()).not.toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.getAllByRole('listitem', { name: 'Home' })).toHaveLength(1)
    expect(liveTexts().filter((text) => text === 'Request accepted; completion not verified')).toHaveLength(1)
    // And the popover closes when the bar's own button is used.
    fireEvent.pointerDown(toggle)
    fireEvent.click(toggle)
    expect(popover()).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('do not disturb in the band (#345)', () => {
  it('is the one indicator now that the rail is gone (#354), and the one status', async () => {
    const view = render(<AppHeader />)
    const end = view.container.querySelector<HTMLElement>('[data-band-end]')!
    expect(end.querySelector('[data-quiet-indicator]')).toBeNull()
    await act(async () => settings$.notifications.pause.set({ until: null }))
    const status = 'Do not disturb is on until you turn it off'
    // The band's is the status, named by what it says, around its button.
    const band = within(end).getByRole('status', { name: status })
    // Compared one by one: a failing comparison of DOM nodes would print the whole tree.
    const named = view.getAllByRole('status', { name: status })
    expect(named.length).toBe(1)
    expect(named[0] === band).toBe(true)
    expect(view.container.querySelectorAll('[data-quiet-indicator]')).toHaveLength(1)
    const resumes = view.getAllByRole('button', { name: 'Resume notifications' })
    expect(resumes).toHaveLength(1)
    expect(resumes[0].title).toBe(`${status} — Resume notifications`)
    expect(band.contains(resumes[0])).toBe(true)
    // It comes before the sync status, at the end of the band.
    const sync = end.querySelector('[data-sync-status]')!
    expect(band.compareDocumentPosition(sync) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Resumed from the band: it goes.
    await act(async () => fireEvent.click(within(band).getByRole('button', { name: 'Resume notifications' })))
    expect(settings$.notifications.peek().pause).toBeNull()
    expect(view.queryByRole('status', { name: status })).toBeNull()
    expect(view.container.querySelector('[data-quiet-indicator]')).toBeNull()
  })

  it('follows a pause until a time, in the words the rail used', async () => {
    const view = render(<AppHeader />)
    await act(async () => settings$.notifications.pause.set({ until: new Date(2026, 9, 23, 13).getTime() }))
    const status = view.getByRole('status', { name: /^Do not disturb until / })
    expect(status.closest('[data-band-end]')).not.toBeNull()
  })
})

describe('the band end, its keyboard and its names (#345)', () => {
  it('is reached by Tab inside the band, after the search, in the band region', async () => {
    const view = render(<AppHeader />)
    await act(async () => settings$.notifications.pause.set({ until: null }))
    const band = view.container.querySelector<HTMLElement>('[data-top-band]')!
    expect(band.dataset.region).toBe('search')
    const tabbable = [...band.querySelectorAll<HTMLElement>('button, input')].filter(
      (element) => !element.hasAttribute('disabled') && element.tabIndex >= 0,
    )
    const names = tabbable.map((element) => element.getAttribute('aria-label') ?? element.textContent)
    expect(names[0]).toBe('App menu')
    expect(names.slice(-2)).toEqual(['Resume notifications', UNKNOWN])
    expect(names.indexOf('Search messages...')).toBeGreaterThan(0)
    expect(names.indexOf('Search messages...')).toBeLessThan(names.length - 2)
  })

  it('adds no landmark: the band keeps its banner and search, and the popover is a dialog', () => {
    setSyncError('work', 'x')
    const { view, button } = renderWindow()
    fireEvent.click(button()!)
    const header = view.getByRole('banner', { name: 'Oreneta' })
    const landmarks = [
      ...header.querySelectorAll('header, nav, main, aside, section, [role="region"], [role="search"]'),
    ]
    expect(landmarks.map((element) => element.getAttribute('role') ?? element.tagName)).toEqual(['search'])
    expect(view.getByRole('dialog', { name: 'Account sync' }).closest('header')).toBe(header)
    // The bar is the one region named «Account sync».
    expect(view.getAllByRole('region', { name: 'Account sync' })).toHaveLength(1)
  })

  it('has neither on the first-account setup screen, where the window has both', async () => {
    accounts$.set([])
    setSyncError(null, 'x')
    await act(async () => settings$.notifications.pause.set({ until: null }))
    const setup = render(<AppHeader setup />)
    const end = () => setup.container.querySelector<HTMLElement>('[data-band-end]')!
    expect(end().children).toHaveLength(0)
    expect(setup.queryByRole('status')).toBeNull()
    cleanup()
    // The same state in the window: the unattributed problem and the pause show.
    const app = render(<AppHeader />)
    const statuses = within(app.container.querySelector<HTMLElement>('[data-band-end]')!).getAllByRole('status')
    expect(statuses.map((status) => status.getAttribute('aria-label') ?? status.textContent)).toEqual([
      'Do not disturb is on until you turn it off',
      '1 need attention',
    ])
  })
})

describe('review round (#345)', () => {
  it('keeps both live regions announcing below 769 px while the search covers the band: only the controls go inert', async () => {
    setWidth(768)
    const { view, end, button } = renderWindow()
    await act(async () => settings$.notifications.pause.set({ until: null }))
    fireEvent.click(
      within(view.container.querySelector<HTMLElement>('[data-top-band]')!).getByRole('button', {
        name: 'Search messages...',
      }),
    )
    const overlay = view.container.querySelector<HTMLElement>('[data-band-search-overlay]')!
    expect(overlay).not.toBeNull()
    fireEvent.change(within(overlay).getByRole('textbox'), { target: { value: 'Pilot' } })
    act(() => setSyncError('work', 'x'))
    const sync = end().querySelector<HTMLElement>('[data-sync-status] [role="status"]')!
    const quiet = end().querySelector<HTMLElement>('[data-quiet-indicator="band"]')!
    expect(sync.textContent).toBe('1 need attention')
    expect(quiet.getAttribute('role')).toBe('status')
    expect(quiet.getAttribute('aria-label')).toBe('Do not disturb is on until you turn it off')
    // Neither status is under an inert element, so both stay in the accessibility tree.
    expect(sync.closest('[inert]') === null).toBe(true)
    expect(quiet.closest('[inert]') === null).toBe(true)
    // The controls are: under the search, they take neither the focus nor the pointer.
    expect(button()!.closest('[inert]') === null).toBe(false)
    expect(within(quiet).getByRole('button', { name: 'Resume notifications' }).closest('[inert]') === null).toBe(false)
    // Closed, the controls are back.
    fireEvent.keyDown(within(overlay).getByRole('textbox'), { key: 'Escape' })
    expect(view.container.querySelector('[data-band-search-overlay]')).toBeNull()
    expect(button()!.closest('[inert]') === null).toBe(true)
  })

  it('keeps the focus in the entry when Retry turns disabled, in the popover and in the bar, so a bare key stays there', async () => {
    const pending: Array<(value: unknown) => void> = []
    ;(window as any).go = {
      main: {
        App: {
          Invoke: (command: string) =>
            command === 'mail.sync' ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve({ ok: true }),
        },
      },
    }
    setSyncError('work', 'x')
    const { view, button, bar, popover } = renderWindow()
    const reached: string[] = []
    const listen = (event: KeyboardEvent) => reached.push(event.key)
    window.addEventListener('keydown', listen)
    try {
      fireEvent.click(button()!)
      const entry = within(popover()!).getByRole('listitem', { name: 'Work' })
      const retry = within(entry).getByRole('button', { name: 'Retry' })
      retry.focus()
      fireEvent.click(retry)
      expect(retry.hasAttribute('disabled')).toBe(true)
      expect(document.activeElement === entry).toBe(true)
      fireEvent.keyDown(document.activeElement!, { key: 'j' })
      expect(reached).toEqual([])
      expect(popover()).not.toBeNull()
      // The bar's copy of the detail does the same.
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      fireEvent.click(within(bar()!).getByRole('button', { name: 'Account sync' }))
      const home = within(bar()!).getByRole('listitem', { name: 'Home' })
      const retryHome = within(home).getByRole('button', { name: 'Retry' })
      retryHome.focus()
      fireEvent.click(retryHome)
      expect(retryHome.hasAttribute('disabled')).toBe(true)
      expect(document.activeElement === home).toBe(true)
      expect(view.getAllByRole('listitem', { name: 'Home' })).toHaveLength(1)
    } finally {
      window.removeEventListener('keydown', listen)
      await act(async () => pending.forEach((resolve) => resolve({ ok: true, online: true })))
    }
  })

  it("never draws the bar's detail and the popover's in one commit", () => {
    setSyncError('work', 'x')
    const together: number[] = []
    let commits = 0
    // A commit's DOM, read when React reports it.
    const onRender = () => {
      commits++
      if (document.querySelectorAll('li[aria-label="Work"]').length > 1) together.push(commits)
    }
    const view = render(
      <Profiler id="window" onRender={onRender}>
        <AppHeader />
        <ConnectivityBanner />
      </Profiler>,
    )
    const toggle = within(view.getByRole('region', { name: 'Account sync' })).getByRole('button', {
      name: 'Account sync',
    })
    fireEvent.click(toggle)
    expect(document.querySelectorAll('li[aria-label="Work"]')).toHaveLength(1)
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-sync-status-button]')!)
    expect(view.getByRole('dialog', { name: 'Account sync' })).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(commits).toBeGreaterThan(1)
    expect(together).toEqual([])
  })
})
