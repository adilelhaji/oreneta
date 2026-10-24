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
import { thread$ } from '../../states/thread'
import { APP_MODULES, ui$, type AppModule } from '../../states/ui'
import type { Message } from '../../types'
import { AppHotkeys } from '../dialog/AppHotkeys'
import { CalendarDays } from 'lucide-react'
import { AppSidebar, SIDEBAR_PANELS, type SidebarPanelDef } from './AppSidebar'
import { BandSearch } from './BandSearch'
import { SidebarToggle } from './SidebarToggle'
import { useSidebarShown } from './useSidebarShown'
import { isMac } from '../../lib/shortcuts'

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
  if (module !== 'mail') return module
  if (!kanban$.activeBoardId.peek()) return 'mail'
  return kanban$.paneThreadId.peek() ? 'board-pane' : 'board'
}

// <main> as App.tsx draws it: inert under the sidebar's overlay.
function ModuleMain() {
  return (
    <main aria-label="Module" inert={useSidebarShown() === 'overlay'}>
      <button type="button">In the module</button>
    </main>
  )
}

// The frame row: <main>, then the sidebar; the band's search and button above it.
function Frame({
  hotkeys = false,
  search = false,
  panels,
}: {
  hotkeys?: boolean
  search?: boolean
  panels?: readonly SidebarPanelDef[]
}) {
  const row = useRef<HTMLDivElement | null>(null)
  return (
    <>
      <header>
        {search && <BandSearch onCover={() => {}} />}
        <SidebarToggle />
      </header>
      <div ref={row} data-frame-row>
        <ModuleMain />
        <AppSidebar row={row} content={contentOf(ui$.module.peek())} panels={panels} />
      </div>
      {hotkeys && <AppHotkeys />}
    </>
  )
}

const aside = (screen: ReturnType<typeof render>) => screen.container.querySelector<HTMLElement>('[data-app-sidebar]')
const bandButton = (screen: ReturnType<typeof render>) => screen.getByRole('button', { name: 'Sidebar' })
// What a press of the band button does, as its accessible description says it:
// the text it is described by (aria-describedby, which screen readers say
// whatever they make of a title; the title is the tooltip).
const bandAction = (screen: ReturnType<typeof render>) => {
  const described = document.getElementById(bandButton(screen).getAttribute('aria-describedby') ?? '')?.textContent
  const description = (['Hide sidebar', 'Show sidebar'] as const).find((action) =>
    screen.queryByRole('button', { name: 'Sidebar', description: action }),
  )
  return described === description ? description : { described, description }
}

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
          // The Persona panel's history (#86), empty unless a test says otherwise.
          if (command === 'context.person')
            return {
              address: payload.address,
              conversations: [],
              events: [],
              files: [],
              coverage: { messages: 0, downloaded: 0 },
            }
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
  sidebar$.set({ fits: false, strip: false, conversationOpen: false, overlay: false })
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
      // Minimised by default: the strip, with the icons of the Agenda and of
      // the Persona panel (#363), and no Conversa without a conversation.
      expect(sidebar.dataset.layout).toBe('strip')
      // As wide as the layout counts it (SIDEBAR_STRIP_REM).
      expect(sidebar.style.width).toBe('2.5rem')
      expect(screen.getByRole('button', { name: 'Open the Agenda panel' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Open the Person panel' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Open the Conversation panel' })).toBeNull()
      // Expanded from its icon: the Agenda panel, beside the Persona tab.
      fireEvent.click(screen.getByRole('button', { name: 'Open the Agenda panel' }))
      expect(aside(screen)!.dataset.layout).toBe('beside')
      expect(screen.getByRole('heading', { name: 'Agenda' })).toBeTruthy()
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agenda', 'Person'])
      cleanup()
      settings$.appSidebarState.set('minimized')
    }
  })

  it('has the Conversa panel in mail and in a board only with a conversation open, never disabled', () => {
    settings$.appSidebarState.set('expanded')
    openConversation()
    let screen = render(<Frame />)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agenda', 'Person', 'Conversation'])
    cleanup()

    // A board with no conversation pane open: no Conversa.
    kanban$.activeBoardId.set('board')
    screen = render(<Frame />)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agenda', 'Person'])
    cleanup()
    kanban$.paneThreadId.set(thread.thread_id)
    screen = render(<Frame />)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agenda', 'Person', 'Conversation'])
    cleanup()

    // The conversation chosen in mail is not on screen in another module.
    kanban$.activeBoardId.set('')
    kanban$.paneThreadId.set('')
    ui$.module.set('calendar')
    screen = render(<Frame />)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agenda', 'Person'])
    expect(screen.queryByRole('tab', { name: 'Conversation' })).toBeNull()
    cleanup()

    // Below 769 px, nor is it while the list shows in its place.
    ui$.module.set('mail')
    setWidth(600)
    ui$.mobilePane.set('threads')
    screen = render(<Frame />)
    fireEvent.click(bandButton(screen))
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agenda', 'Person'])
    act(() => ui$.mobilePane.set('conversation'))
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agenda', 'Person', 'Conversation'])
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
  // Owner decision D4 on #360: the band button shows and hides the whole sidebar.
  it('beside the content: the band button hides it, strip included, and the strip icons and minimise button, each saved', async () => {
    const screen = render(<Frame />)
    expect(aside(screen)!.dataset.layout).toBe('strip')
    // Not expanded, though the strip is drawn: the button says, in its
    // description and its tooltip, that a press hides it.
    expect(bandButton(screen).getAttribute('aria-expanded')).toBe('false')
    expect(bandAction(screen)).toBe('Hide sidebar')
    expect(bandButton(screen).getAttribute('title')).toBe('Hide sidebar')
    fireEvent.click(bandButton(screen))
    expect(aside(screen)).toBeNull()
    expect(bandButton(screen).getAttribute('aria-expanded')).toBe('false')
    expect(bandAction(screen)).toBe('Show sidebar')
    expect(bandButton(screen).getAttribute('title')).toBe('Show sidebar')
    fireEvent.click(bandButton(screen))
    expect(aside(screen)!.dataset.layout).toBe('beside')
    expect(bandButton(screen).getAttribute('aria-expanded')).toBe('true')
    expect(bandAction(screen)).toBe('Hide sidebar')
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
    // And the band button hides it, from beside the content.
    fireEvent.click(bandButton(screen))
    expect(aside(screen)).toBeNull()
    await waitFor(() =>
      expect(written('app_sidebar_state')).toEqual(['hidden', 'expanded', 'minimized', 'expanded', 'hidden']),
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

  // Review finding C: `i` without a Conversa panel.
  it('`i` does nothing under a compose tab, nor below 769 px with the list in place of the conversation', async () => {
    openConversation()
    compose$.tabs.set([{ id: 'compose-1', kind: 'compose' } as any])
    compose$.activeTab.set('compose-1')
    const screen = render(<Frame hotkeys />)
    expect(screen.queryByRole('button', { name: 'Open the Conversation panel' })).toBeNull()
    const key = new KeyboardEvent('keydown', { key: 'i', cancelable: true, bubbles: true })
    window.dispatchEvent(key)
    expect(key.defaultPrevented).toBe(false)
    expect(aside(screen)!.dataset.layout).toBe('strip')
    cleanup()
    compose$.tabs.set([])
    compose$.activeTab.set('')

    setWidth(600)
    ui$.mobilePane.set('threads')
    const narrow = render(<Frame hotkeys />)
    fireEvent.keyDown(window, { key: 'i' })
    expect(aside(narrow)).toBeNull()
    expect(sidebar$.overlay.get()).toBe(false)
    // With the conversation in place of the list, it opens it on Conversa.
    act(() => ui$.mobilePane.set('conversation'))
    fireEvent.keyDown(window, { key: 'i' })
    expect(aside(narrow)!.dataset.layout).toBe('overlay')
    expect(narrow.getByRole('tab', { name: 'Conversation' }).getAttribute('aria-selected')).toBe('true')
    ui$.mobilePane.set('threads')
    await Promise.resolve()
    expect(written('app_sidebar_state')).toEqual([])
    expect(ui$.sidebarSection.get()).toBe('overview')
  })

  it('where it does not fit, an overlay that Escape, the backdrop and `i` close, none of them saved', async () => {
    setWidth(1024)
    openConversation()
    const screen = render(<Frame hotkeys />)
    expect(aside(screen)!.dataset.layout).toBe('strip')

    // A strip icon: an overlay, with the focus on its tab; Escape closes it,
    // and the focus goes back to the strip's icon.
    const icon = screen.getByRole('button', { name: 'Open the Agenda panel' })
    icon.focus()
    fireEvent.click(icon)
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    expect(bandButton(screen).getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Agenda' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(aside(screen)!.dataset.layout).toBe('strip')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open the Agenda panel' }))

    // Again; a click on the backdrop closes it.
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

    // Its own close button, and the band button, which closes it too: as an
    // overlay it says so.
    fireEvent.click(screen.getByRole('button', { name: 'Open the Agenda panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }))
    expect(aside(screen)!.dataset.layout).toBe('strip')
    fireEvent.click(screen.getByRole('button', { name: 'Open the Agenda panel' }))
    expect(bandAction(screen)).toBe('Hide sidebar')
    fireEvent.click(bandButton(screen))
    expect(aside(screen)!.dataset.layout).toBe('strip')

    await Promise.resolve()
    expect(settings$.appSidebarState.get()).toBe('minimized')
    expect(written('app_sidebar_state')).toEqual([])
  })

  // Owner decision D7 on #360: hiding the strip is undone by the same button.
  it('where it does not fit, the band button hides the strip and brings it back, saved, with the focus kept', async () => {
    setWidth(1024)
    const screen = render(<Frame />)
    expect(aside(screen)!.dataset.layout).toBe('strip')
    const button = bandButton(screen)
    button.focus()
    fireEvent.click(button)
    expect(aside(screen)).toBeNull()
    expect(bandAction(screen)).toBe('Show sidebar')
    fireEvent.click(button)
    // The strip, not an overlay; not expanded, and a press would hide it again.
    expect(aside(screen)!.dataset.layout).toBe('strip')
    expect(sidebar$.overlay.get()).toBe(false)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(bandAction(screen)).toBe('Hide sidebar')
    expect(document.activeElement).toBe(button)
    await waitFor(() => expect(written('app_sidebar_state')).toEqual(['hidden', 'minimized']))
    // The overlay is the strip icon's.
    fireEvent.click(screen.getByRole('button', { name: 'Open the Agenda panel' }))
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })

  it('below 769 px there is no strip: the band button opens an overlay, not saved, and gets the focus back after Escape', async () => {
    for (const state of ['minimized', 'hidden'] as const) {
      settings$.appSidebarState.set(state)
      await Promise.resolve()
      writes = []
      setWidth(600)
      const screen = render(<Frame />)
      expect(aside(screen)).toBeNull()
      expect(bandAction(screen)).toBe('Show sidebar')
      const button = bandButton(screen)
      button.focus()
      fireEvent.click(button)
      expect(aside(screen)!.dataset.layout).toBe('overlay')
      expect(button.getAttribute('aria-expanded')).toBe('true')
      expect(bandAction(screen)).toBe('Hide sidebar')
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Agenda' }))
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      expect(aside(screen)).toBeNull()
      expect(document.activeElement).toBe(button)
      await Promise.resolve()
      expect(settings$.appSidebarState.get()).toBe(state)
      expect(written('app_sidebar_state')).toEqual([])
      cleanup()
    }
  })

  // Review finding D: «New message to» opens in the conversation pane.
  it('closes the Conversa overlay when a participant is written to, as it does to show a message', async () => {
    setWidth(1024)
    openConversation()
    const screen = render(<Frame hotkeys />)
    fireEvent.keyDown(window, { key: 'i' })
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    fireEvent.click(screen.getByTitle('New message to ana@x.test'))
    expect(aside(screen)!.dataset.layout).toBe('strip')
    expect(compose$.tabs.get().some((tab) => tab.kind === 'compose')).toBe(true)
    await Promise.resolve()
    expect(written('app_sidebar_state')).toEqual([])
  })

  it('closes the Conversa overlay for the messages with a participant, which the list under it shows', async () => {
    setWidth(1024)
    openConversation()
    const screen = render(<Frame hotkeys />)
    fireEvent.keyDown(window, { key: 'i' })
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    fireEvent.contextMenu(screen.getByText('ana@x.test'))
    fireEvent.click(screen.getByRole('menuitem', { name: /View messages with Ana/ }))
    expect(aside(screen)!.dataset.layout).toBe('strip')
    expect(ui$.query.get()).toBe('ana@x.test')
    await Promise.resolve()
    expect(written('app_sidebar_state')).toEqual([])
    ui$.query.set('')
  })

  // Review finding 5 of round 3: the other ways out of the Conversa overlay.
  it('closes the Conversa overlay before the gallery opens an image of the conversation', () => {
    setWidth(1024)
    openConversation()
    const image = { filename: 'photo.png', mime: 'image/png', size: 4, key: null, url: 'data:image/png;base64,AAAA' }
    mail$.messages.set([{ ...thread, attachments: [image] }])
    const screen = render(<Frame hotkeys />)
    fireEvent.keyDown(window, { key: 'i' })
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    fireEvent.click(screen.getByText('1 media item'))
    fireEvent.click(screen.getByTitle('photo.png'))
    expect(aside(screen)!.dataset.layout).toBe('strip')
    expect(thread$.galleryIndex.get()).toBe(0)
    thread$.galleryIndex.set(null)
  })

  it("closes the Conversa overlay for a conversation opened from a person's history", async () => {
    setWidth(1024)
    openConversation()
    const invoke = (window as any).go.main.App.Invoke
    ;(window as any).go.main.App.Invoke = async (command: string, payload: any) =>
      command === 'context.person'
        ? {
            address: 'ana@x.test',
            conversations: [
              { thread_id: 'work#INBOX#earlier', folder: 'INBOX', subject: 'Earlier budget', date: 1, from_them: true },
            ],
            events: [],
            files: [],
            coverage: { messages: 1, downloaded: 1 },
          }
        : invoke(command, payload)
    const screen = render(<Frame hotkeys />)
    fireEvent.keyDown(window, { key: 'i' })
    fireEvent.contextMenu(screen.getByText('ana@x.test'))
    fireEvent.click(screen.getByRole('menuitem', { name: /History with Ana/ }))
    await waitFor(() => expect(screen.getByText('Earlier budget')).toBeTruthy())
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    fireEvent.click(screen.getByText('Earlier budget'))
    expect(aside(screen)!.dataset.layout).toBe('strip')
    expect(ui$.selectedThread.get()).toBe('work#INBOX#earlier')
  })

  // F: the module under the overlay is inert, and the focus goes back into it.
  it('makes the module inert under the overlay, and gives the focus back into it once it is not', () => {
    setWidth(1024)
    openConversation()
    const screen = render(<Frame hotkeys />)
    const main = screen.getByRole('main')
    const inModule = screen.getByRole('button', { name: 'In the module' })
    inModule.focus()
    fireEvent.keyDown(window, { key: 'i' })
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    expect(main.hasAttribute('inert')).toBe(true)
    // The focus went to the overlay, out of the inert module.
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Conversation' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(main.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(inModule)
    // Beside the content, nothing is inert.
    setWidth(1440)
    act(() => window.dispatchEvent(new Event('resize')))
    fireEvent.click(screen.getByRole('button', { name: 'Open the Agenda panel' }))
    expect(aside(screen)!.dataset.layout).toBe('beside')
    expect(main.hasAttribute('inert')).toBe(false)
  })

  // Review finding 2 of round 3: Ctrl/⌘+N opens a new message in the module.
  it('closes the overlay when Ctrl/⌘+N opens a new message, under it', () => {
    setWidth(1024)
    const screen = render(<Frame hotkeys />)
    fireEvent.click(screen.getByRole('button', { name: 'Open the Agenda panel' }))
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(true)
    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', ...(isMac ? { metaKey: true } : { ctrlKey: true }) })
    expect(compose$.tabs.get().some((tab) => tab.kind === 'compose')).toBe(true)
    expect(aside(screen)!.dataset.layout).toBe('strip')
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false)
  })

  // Review finding E: one Escape stack for the overlay and the band's search.
  it("lets the band's search field take Escape before the overlay under it, then closes the overlay", () => {
    setWidth(1024)
    ui$.selectedAccount.set('work')
    const screen = render(<Frame search />)
    fireEvent.click(screen.getByRole('button', { name: 'Open the Agenda panel' }))
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    const field = screen.getByRole('textbox', { name: 'Search messages...' })
    field.focus()
    fireEvent.change(field, { target: { value: 'invoice' } })
    expect(ui$.query.get()).toBe('invoice')
    // Mail's field: Escape clears it and leaves it; the overlay stays.
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(ui$.query.get()).toBe('')
    expect(document.activeElement).not.toBe(field)
    expect(aside(screen)!.dataset.layout).toBe('overlay')
    // The next Escape is the overlay's.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(aside(screen)!.dataset.layout).toBe('strip')
    ui$.selectedAccount.set('')
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
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Person' }))
    expect(ui$.sidebarSection.get()).toBe('person')
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

  // Another panel, as Dia will be (12b): one entry in the list, and with
  // four tabs the arrows say which way the line runs.
  const withDay: readonly SidebarPanelDef[] = [
    SIDEBAR_PANELS[0],
    { id: 'day', icon: CalendarDays, label: () => 'Day', available: () => true, content: () => <p>One day</p> },
    ...SIDEBAR_PANELS.slice(1),
  ]

  it('adds a panel with one entry, and goes through them in reading order', () => {
    settings$.appSidebarState.set('expanded')
    openConversation()
    const screen = render(<Frame panels={withDay} />)
    expect(tabs(screen).map((tab) => tab.textContent)).toEqual(['Agenda', 'Day', 'Person', 'Conversation'])
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
    const [agenda, day, person, conversation] = tabs(screen)
    agenda.focus()
    fireEvent.keyDown(agenda, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(day)
    expect(day.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(day, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(person)
    fireEvent.keyDown(person, { key: 'ArrowLeft' })
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
