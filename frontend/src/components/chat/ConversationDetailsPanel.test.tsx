import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { accounts$ } from '../../states/accounts'
import { compose$ } from '../../states/compose'
import { kanban$ } from '../../states/kanban'
import { mail$ } from '../../states/mail'
import { hydrateSettings, settings$ } from '../../states/settings'
import { sidebar$ } from '../../states/sidebar'
import { restoreUiSession, ui$, UI_SESSION_KEYS } from '../../states/ui'
import type { Message } from '../../types'
import { AppSidebar } from '../shell/AppSidebar'

// The conversation's details (#86, #212) as the Conversa panel of the app's
// sidebar (ADR-0069): the expectations of the details sidebar, in the
// container that replaced it. A conversation is open in mail, the sidebar
// expanded beside it at 1440 px.

let writes: { key: string; value: unknown }[] = []

const message = (thread: string, subject: string): Message => ({
  id: `${thread}#1`,
  account_id: 'work',
  folder_id: 'INBOX',
  thread_id: thread,
  from_name: 'Ana',
  from_addr: 'ana@x.test',
  to: 'me@work.test',
  subject,
  preview: '',
  body: '',
  date: 1,
  unread: false,
  starred: false,
  has_attachments: false,
})
const budget = message('work#INBOX#budget', 'Budget')
const other = message('work#INBOX#other', 'Other thread')
// Someone else's conversation: Bea's, not Ana's.
const third = { ...message('work#INBOX#third', 'Third thread'), from_name: 'Bea', from_addr: 'bea@x.test' }

function openConversation(thread: Message) {
  mail$.messages.set([thread])
  ui$.selectedThread.set(thread.thread_id)
}

function Frame() {
  const row = useRef<HTMLDivElement | null>(null)
  return (
    <div ref={row}>
      <main aria-label="Mail" />
      <AppSidebar row={row} content="mail" />
    </div>
  )
}

beforeEach(() => {
  ;(window as any).happyDOM.setViewport({ width: 1440, height: 900 })
  accounts$.set([{ id: 'work', email: 'me@work.test' } as any])
  ui$.module.set('mail')
  kanban$.activeBoardId.set('')
  kanban$.paneThreadId.set('')
  compose$.tabs.set([])
  compose$.activeTab.set('')
  mail$.threadLoading.set(false)
  mail$.threads.set([budget, other, third])
  openConversation(budget)
  ui$.sidebarSection.set('overview')
  settings$.appSidebarState.set('expanded')
  writes = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          if (command === 'app.prefsSet') writes.push(payload)
          if (command === 'calendar.events') return { events: [] }
          if (command === 'tasks.list') return { tasks: [] }
          if (command === 'context.person') return null
          return {}
        },
      },
    },
  }
})

afterEach(() => {
  cleanup()
  delete (window as any).go
  ui$.sidebarSection.set('agenda')
  ui$.selectedThread.set('')
  mail$.threads.set([])
  mail$.messages.set([])
  settings$.detailsPanelWidth.set(340)
  settings$.appSidebarState.set('minimized')
  sidebar$.set({ fits: false, strip: false, conversationOpen: false, overlay: false })
  ;(window as any).happyDOM.setViewport({ width: 1024, height: 768 })
})

const written = (key: string) => writes.filter((w) => w.key === key).map((w) => w.value)

describe('the sidebar panels (#212, ADR-0069)', () => {
  it('opens the agenda from its tab and remembers it for this window', async () => {
    const screen = render(<Frame />)
    fireEvent.click(screen.getByRole('tab', { name: 'Agenda' }))
    expect(screen.getByRole('heading', { name: 'Agenda' })).toBeTruthy()
    expect(screen.getByText('Next 7 days')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Nothing scheduled or due in the next 7 days.')).toBeTruthy())
    expect(written('session_sidebar_section_main')).toEqual(['agenda'])
    // Back to the conversation's summary, from its own tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Conversation' }))
    expect(written('session_sidebar_section_main')).toEqual(['agenda', 'overview'])
  })

  it('reopens on the section last used after a restart', async () => {
    expect(UI_SESSION_KEYS).toContain('session_sidebar_section_main')
    // What boot does with the stored preferences.
    restoreUiSession({ session_sidebar_section_main: 'agenda' }, [])
    const screen = render(<Frame />)
    expect(screen.getByRole('heading', { name: 'Agenda' })).toBeTruthy()
    // Seeding the stored value is not a fresh choice to write back.
    expect(written('session_sidebar_section_main')).toEqual([])
    await waitFor(() => expect(screen.getByText('Nothing scheduled or due in the next 7 days.')).toBeTruthy())
  })

  it('reads a stored section this version does not know as the Agenda, and `person` as its panel (ADR-0069 §2)', () => {
    ui$.sidebarSection.set('files')
    restoreUiSession({ session_sidebar_section_main: 'widgets' }, [])
    expect(ui$.sidebarSection.get()).toBe('agenda')
    // Dia is kept as it is, and shown as the Agenda until it arrives (12b).
    restoreUiSession({ session_sidebar_section_main: 'day' }, [])
    expect(ui$.sidebarSection.get()).toBe('day')
    let screen = render(<Frame />)
    expect(screen.getByRole('heading', { name: 'Agenda' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Agenda' }).getAttribute('aria-selected')).toBe('true')
    cleanup()
    // Persona is a panel since #363: a stored `person` is that panel.
    restoreUiSession({ session_sidebar_section_main: 'person' }, [])
    expect(ui$.sidebarSection.get()).toBe('person')
    screen = render(<Frame />)
    expect(screen.getByRole('heading', { name: 'Person' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Person' }).getAttribute('aria-selected')).toBe('true')
  })

  it("keeps the section when the conversation changes, and never carries one person's history to another", async () => {
    ui$.sidebarSection.set('files')
    const screen = render(<Frame />)
    expect(screen.getByRole('heading', { name: 'Files' })).toBeTruthy()
    act(() => openConversation(other))
    expect(screen.getByRole('heading', { name: 'Files' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    const person = screen.getByText('ana@x.test').closest('div')!.parentElement!
    fireEvent.contextMenu(person, { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByText('History with Ana'))
    // Since #363 it is the sidebar's Persona panel, with Ana in it.
    expect(screen.getByRole('tab', { name: 'Person' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('heading', { name: 'With Ana' })).toBeTruthy()
    // What is remembered is the panel, never the person (ADR-0069 §2).
    expect(ui$.sidebarSection.get()).toBe('person')
    expect(written('session_sidebar_section_main')).toEqual(['files', 'overview', 'person'])
    expect(JSON.stringify(writes)).not.toContain('ana@x.test')
    // Another conversation, someone else's: their history, never Ana's.
    act(() => openConversation(third))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'With Ana' })).toBeNull())
    expect(screen.getByRole('heading', { name: 'With Bea' })).toBeTruthy()
  })
})

describe('the sidebar width (#212)', () => {
  it('resizes from the keyboard within its limits and keeps the width', () => {
    const screen = render(<Frame />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    expect(handle.getAttribute('aria-valuenow')).toBe('340')
    expect(handle.getAttribute('aria-valuemin')).toBe('280')
    expect(handle.getAttribute('aria-valuemax')).toBe('560')
    // On the sidebar's left edge: moving the separator left widens it.
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle.getAttribute('aria-valuenow')).toBe('356')
    expect(settings$.detailsPanelWidth.get()).toBe(356)
    fireEvent.keyDown(handle, { key: 'End' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(settings$.detailsPanelWidth.get()).toBe(560)
    const aside = handle.closest('aside')!
    expect(aside.style.getPropertyValue('--details-panel-width')).toBe('560px')
    expect(written('details_panel_width')).toEqual([356, 560])
  })

  it('restores the stored width at boot, clamped to the limits', () => {
    hydrateSettings({ details_panel_width: 420 })
    const screen = render(<Frame />)
    expect(screen.getByRole('separator', { name: 'Resize sidebar' }).getAttribute('aria-valuenow')).toBe('420')
    cleanup()
    hydrateSettings({ details_panel_width: 5000 })
    expect(settings$.detailsPanelWidth.get()).toBe(560)
    hydrateSettings({ details_panel_width: 12 })
    expect(settings$.detailsPanelWidth.get()).toBe(280)
    hydrateSettings({ details_panel_width: 'wide' })
    expect(settings$.detailsPanelWidth.get()).toBe(280)
  })
})
