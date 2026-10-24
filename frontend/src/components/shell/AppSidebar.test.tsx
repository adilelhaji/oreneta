import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import i18n from '../../lib/i18n'
import type { SidebarContent } from '../../lib/paneResize'
import { accounts$ } from '../../states/accounts'
import { compose$ } from '../../states/compose'
import { kanban$ } from '../../states/kanban'
import { mail$ } from '../../states/mail'
import { hydrateSettings, settings$ } from '../../states/settings'
import { sidebar$ } from '../../states/sidebar'
import { APP_MODULES, ui$, type AppModule } from '../../states/ui'
import type { Message } from '../../types'
import { AppHotkeys } from '../dialog/AppHotkeys'
import { CalendarDays } from 'lucide-react'
import { AppSidebar, SIDEBAR_PANELS, type SidebarPanelDef } from './AppSidebar'
import { SidebarToggle } from './SidebarToggle'

// The app's sidebar (ADR-0069 §1 and §2, #361): one <aside> «Barra lateral»
// after <main>, in every module, expanded, minimised or hidden; the band's
// button; what changes the saved state; and its panel selector.

let writes: { key: string; value: unknown }[] = []
const written = (key: string) => writes.filter((write) => write.key === key).map((write) => write.value)
const setWidth = (width: number) => (window as any).happyDOM.setViewport({ width, height: 900 })

const thread: Message = {
  id: 'work#INBOX#budget#1',
  account_id: 'work',
  folder_id: 'INBOX',
  thread_id: 'work#INBOX#budget',
  from_name: 'Ana',
  from_addr: 'ana@x.test',
  to: 'me@work.test',
  subject: 'Budget',
  preview: '',
  body: '',
  date: 1,
  unread: false,
  starred: false,
  has_attachments: false,
}

function openConversation() {
  mail$.threads.set([thread])
  mail$.messages.set([thread])
  ui$.selectedThread.set(thread.thread_id)
}

// What the module keeps beside the sidebar, as App.tsx says it.
function contentOf(module: AppModule): SidebarContent {
  if (module !== 'mail') return 'module'
  if (!kanban$.activeBoardId.peek()) return 'mail'
  return kanban$.paneThreadId.peek() ? 'board-pane' : 'board'
}

// The frame row: <main>, then the sidebar; the band's button above it.
function Frame({ hotkeys = false, panels }: { hotkeys?: boolean; panels?: readonly SidebarPanelDef[] }) {
  const row = useRef<HTMLDivElement | null>(null)
  return (
    <>
      <header>
        <SidebarToggle />
      </header>
      <div ref={row} data-frame-row>
        <main aria-label="Module">
          <button type="button">In the module</button>
        </main>
        <AppSidebar row={row} content={contentOf(ui$.module.peek())} panels={panels} />
      </div>
      {hotkeys && <AppHotkeys />}
    </>
  )
}

const aside = (screen: ReturnType<typeof render>) => screen.container.querySelector<HTMLElement>('[data-app-sidebar]')
const bandButton = (screen: ReturnType<typeof render>) => screen.getByRole('button', { name: 'Sidebar' })

beforeEach(async () => {
  await i18n.changeLanguage('en')
  setWidth(1440)
  accounts$.set([{ id: 'work', email: 'me@work.test' } as any])
  ui$.module.set('mail')
  kanban$.activeBoardId.set('')
  kanban$.paneThreadId.set('')
  compose$.tabs.set([])
  compose$.activeTab.set('')
  mail$.threadLoading.set(false)
  mail$.threads.set([])
  mail$.messages.set([])
  ui$.selectedThread.set('')
  ui$.sidebarSection.set('overview')
  ui$.sidebarSection.set('agenda')
  settings$.appSidebarState.set('minimized')
  writes = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          if (command === 'app.prefsSet') writes.push(payload)
          if (command === 'calendar.events') return { events: [] }
          if (command === 'tasks.list') return { tasks: [] }
          return {}
        },
      },
    },
  }
})

afterEach(async () => {
  cleanup()
  delete (window as any).go
  document.documentElement.dir = ''
  ui$.module.set('mail')
  kanban$.activeBoardId.set('')
  kanban$.paneThreadId.set('')
  ui$.selectedThread.set('')
  mail$.threads.set([])
  mail$.messages.set([])
  ui$.sidebarSection.set('overview')
  ui$.sidebarSection.set('agenda')
  settings$.appSidebarState.set('minimized')
  settings$.detailsPanelWidth.set(340)
  sidebar$.set({ fits: false, strip: false, overlay: false })
  setWidth(1024)
  await i18n.changeLanguage('en')
})

describe('one sidebar, in every module (ADR-0069 §1)', () => {
  it('is the «Sidebar» complementary region after <main>, with the Agenda, in each module', () => {
    for (const module of APP_MODULES) {
      ui$.module.set(module)
      const screen = render(<Frame />)
      const regions = screen.getAllByRole('complementary', { name: 'Sidebar' })
      expect(regions).toHaveLength(1)
      const sidebar = regions[0]
      expect(sidebar.dataset.region).toBe('sidebar')
      // At the end of the frame row, after <main>, not inside it.
      expect(sidebar.previousElementSibling?.tagName).toBe('MAIN')
      expect(screen.getByRole('main').contains(sidebar)).toBe(false)
      // Minimised by default: the strip, with the Agenda's icon, and no
      // Conversa without a conversation.
      expect(sidebar.dataset.layout).toBe('strip')
      expect(screen.getByRole('button', { name: 'Open the Agenda panel' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Open the Conversation panel' })).toBeNull()
      // Expanded from its icon: the Agenda panel, its tab the only one.
      fireEvent.click(screen.getByRole('button', { name: 'Open the Agenda panel' }))
      expect(aside(screen)!.dataset.layout).toBe('beside')
      expect(screen.getByRole('heading', { name: 'Agenda' })).toBeTruthy()
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agenda'])
      cleanup()
      settings$.appSidebarState.set('minimized')
    }
  })

  it('has the Conversa panel in mail and in a board only with a conversation open, never disabled', () => {
    settings$.appSidebarState.set('expanded')
    openConversation()
    let screen = render(<Frame />)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agenda', 'Conversation'])
    cleanup()

    // A board with no conversation pane open: no Conversa.
    kanban$.activeBoardId.set('board')
    screen = render(<Frame />)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agenda'])
    cleanup()
    kanban$.paneThreadId.set(thread.thread_id)
    screen = render(<Frame />)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agenda', 'Conversation'])
    cleanup()

    // The conversation chosen in mail is not on screen in another module.
    kanban$.activeBoardId.set('')
    kanban$.paneThreadId.set('')
    ui$.module.set('calendar')
    screen = render(<Frame />)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agenda'])
    expect(screen.queryByRole('tab', { name: 'Conversation' })).toBeNull()
    cleanup()

    // Below 769 px, nor is it while the list shows in its place.
    ui$.module.set('mail')
    setWidth(600)
    ui$.mobilePane.set('threads')
    screen = render(<Frame />)
    fireEvent.click(bandButton(screen))
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agenda'])
    act(() => ui$.mobilePane.set('conversation'))
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agenda', 'Conversation'])
    ui$.mobilePane.set('threads')
  })

  it('shows the Conversa panel on the remembered subsection, and the Agenda once the conversation goes', () => {
    settings$.appSidebarState.set('expanded')
    openConversation()
    ui$.sidebarSection.set('overview')
    const screen = render(<Frame />)
    expect(screen.getByRole('heading', { name: 'Conversation' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Conversation' }).getAttribute('aria-selected')).toBe('true')
    act(() => ui$.selectedThread.set(''))
    expect(screen.getByRole('heading', { name: 'Agenda' })).toBeTruthy()
    // What is remembered is still the summary: it comes back with a conversation.
    expect(ui$.sidebarSection.get()).toBe('overview')
    act(() => ui$.selectedThread.set(thread.thread_id))
    expect(screen.getByRole('heading', { name: 'Conversation' })).toBeTruthy()
  })
})

describe('what changes the saved state, and what does not (ADR-0069 §2)', () => {
  it('beside the content: the band button, the strip icons and the minimise button, each saved', async () => {
    const screen = render(<Frame />)
    expect(bandButton(screen).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(bandButton(screen))
    expect(aside(screen)!.dataset.layout).toBe('beside')
    expect(bandButton(screen).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(bandButton(screen))
    expect(aside(screen)).toBeNull()
    expect(bandButton(screen).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(bandButton(screen))
    // The minimise button: to the strip, with the focus on its icon.
    const minimise = screen.getByRole('button', { name: 'Minimize sidebar' })
    minimise.focus()
    fireEvent.click(minimise)
    expect(aside(screen)!.dataset.layout).toBe('strip')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open the Agenda panel' }))
    // A strip icon: expanded on its panel, with the focus on its tab.
    fireEvent.click(document.activeElement!)
    expect(aside(screen)!.dataset.layout).toBe('beside')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Agenda' }))
    await waitFor(() =>
      expect(written('app_sidebar_state')).toEqual(['expanded', 'hidden', 'expanded', 'minimized', 'expanded']),
    )
  })

  it('`i` with a conversation open, beside the content: expands it on Conversa and minimises it, saved', async () => {
    openConversation()
    const screen = render(<Frame hotkeys />)
    fireEvent.keyDown(window, { key: 'i' })
    expect(aside(screen)!.dataset.layout).toBe('beside')
    expect(screen.getByRole('tab', { name: 'Conversation' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(window, { key: 'i' })
    expect(aside(screen)!.dataset.layout).toBe('strip')
    await waitFor(() => expect(written('app_sidebar_state')).toEqual(['expanded', 'minimized']))
  })

  it('where it does not fit, an overlay that Escape, the backdrop and `i` close, none of them saved', async () => {
    setWidth(1024)
    openConversation()
    const screen = render(<Frame hotkeys />)
    expect(aside(screen)!.dataset.layout).toBe('strip')

    // The band button: an overlay, with the focus on its tab, back on the button after Escape.
    const button = bandButton(screen)
    button.focus()
    fireEvent.click(button)
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Agenda' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(aside(screen)!.dataset.layout).toBe('strip')
    expect(document.activeElement).toBe(button)

    // A strip icon: an overlay too; a click on the backdrop closes it.
    fireEvent.click(screen.getByRole('button', { name: 'Open the Agenda panel' }))
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    fireEvent.click(aside(screen)!.previousElementSibling!)
    expect(aside(screen)!.dataset.layout).toBe('strip')

    // `i`: opens it on Conversa, and closes it as Escape does.
    fireEvent.keyDown(window, { key: 'i' })
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    expect(screen.getByRole('tab', { name: 'Conversation' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(document.body, { key: 'i' })
    expect(aside(screen)!.dataset.layout).toBe('strip')

    // Its own close button.
    fireEvent.click(bandButton(screen))
    fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }))
    expect(aside(screen)!.dataset.layout).toBe('strip')

    await Promise.resolve()
    expect(settings$.appSidebarState.get()).toBe('minimized')
    expect(written('app_sidebar_state')).toEqual([])
  })

  it('below 769 px there is no strip: the band button opens an overlay, hidden again once closed', () => {
    setWidth(600)
    const screen = render(<Frame />)
    expect(aside(screen)).toBeNull()
    fireEvent.click(bandButton(screen))
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(aside(screen)).toBeNull()
    expect(written('app_sidebar_state')).toEqual([])
  })
})

describe('start-up (ADR-0069 §2)', () => {
  it('never opens an overlay by itself: `expanded` in a narrow window is drawn minimised, and kept', async () => {
    hydrateSettings({ app_sidebar_state: 'expanded' })
    setWidth(1024)
    const screen = render(<Frame />)
    expect(aside(screen)!.dataset.layout).toBe('strip')
    expect(screen.queryByRole('tab')).toBeNull()
    cleanup()
    // Below 769 px, hidden.
    setWidth(700)
    const narrow = render(<Frame />)
    expect(aside(narrow)).toBeNull()
    expect(sidebar$.overlay.get()).toBe(false)
    cleanup()
    // The saved state stays: a wide window draws it expanded.
    expect(settings$.appSidebarState.get()).toBe('expanded')
    setWidth(1440)
    const wide = render(<Frame />)
    expect(aside(wide)!.dataset.layout).toBe('beside')
    await Promise.resolve()
    expect(written('app_sidebar_state')).toEqual([])
  })

  it('follows the window: beside when it widens, the strip when it narrows, no overlay either way', () => {
    settings$.appSidebarState.set('expanded')
    const screen = render(<Frame />)
    expect(aside(screen)!.dataset.layout).toBe('beside')
    act(() => setWidth(1024))
    expect(aside(screen)!.dataset.layout).toBe('strip')
    act(() => setWidth(1440))
    expect(aside(screen)!.dataset.layout).toBe('beside')
    expect(settings$.appSidebarState.get()).toBe('expanded')
  })
})

describe('the panel selector (ADR-0069 §1, ADR-0061)', () => {
  const tabs = (screen: ReturnType<typeof render>) => screen.getAllByRole('tab')

  it('is a tab list whose tabs are each a Tab stop, the arrows going round in reading order', () => {
    settings$.appSidebarState.set('expanded')
    openConversation()
    const screen = render(<Frame />)
    const list = screen.getByRole('tablist', { name: 'Sidebar panels' })
    expect(tabs(screen).every((tab) => tab.getAttribute('tabindex') !== '-1')).toBe(true)
    const panel = screen.getByRole('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe(
      tabs(screen).find((tab) => tab.getAttribute('aria-selected') === 'true')!.id,
    )
    tabs(screen)[0].focus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Conversation' }))
    expect(ui$.sidebarSection.get()).toBe('overview')
    // Round: past the last, the first.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Agenda' }))
    expect(ui$.sidebarSection.get()).toBe('agenda')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Conversation' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Agenda' }))
    expect(list.contains(document.activeElement)).toBe(true)
  })

  // A third panel, as Dia will be (12b): one entry in the list, and with
  // three tabs the arrows say which way the line runs.
  const withDay: readonly SidebarPanelDef[] = [
    SIDEBAR_PANELS[0],
    { id: 'day', icon: CalendarDays, label: () => 'Day', available: () => true, content: () => <p>One day</p> },
    ...SIDEBAR_PANELS.slice(1),
  ]

  it('adds a panel with one entry, and goes through three in reading order', () => {
    settings$.appSidebarState.set('expanded')
    openConversation()
    const screen = render(<Frame panels={withDay} />)
    expect(tabs(screen).map((tab) => tab.textContent)).toEqual(['Agenda', 'Day', 'Conversation'])
    tabs(screen)[0].focus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Day' }))
    expect(screen.getByText('One day')).toBeTruthy()
    // A stored `day` is that panel once it is there.
    expect(ui$.sidebarSection.get()).toBe('day')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Conversation' }))
  })

  it('follows the line in Arabic: the left arrow goes to the next tab', async () => {
    await i18n.changeLanguage('ar')
    document.documentElement.dir = 'rtl'
    settings$.appSidebarState.set('expanded')
    openConversation()
    const screen = render(<Frame panels={withDay} />)
    const [agenda, day, conversation] = tabs(screen)
    agenda.focus()
    fireEvent.keyDown(agenda, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(day)
    expect(day.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(day, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(conversation)
    // Round: past the last, the first.
    fireEvent.keyDown(conversation, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(agenda)
    fireEvent.keyDown(agenda, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(conversation)
    fireEvent.keyDown(conversation, { key: 'Home' })
    expect(document.activeElement).toBe(agenda)
    // Its names are the Arabic catalog's.
    expect(screen.getByRole('complementary', { name: 'الشريط الجانبي' })).toBeTruthy()
    expect(screen.getByRole('tablist', { name: 'لوحات الشريط الجانبي' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'المحادثة' })).toBeTruthy()
  })
})
