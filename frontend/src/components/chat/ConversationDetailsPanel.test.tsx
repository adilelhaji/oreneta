import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { ConversationDetailsPanel, type Participant } from './ConversationDetailsPanel'
import { accounts$ } from '../../states/accounts'
import { hydrateSettings, settings$ } from '../../states/settings'
import { restoreUiSession, ui$, UI_SESSION_KEYS } from '../../states/ui'

let writes: { key: string; value: unknown }[] = []

beforeEach(() => {
  writes = []
  accounts$.set([{ id: 'work', email: 'me@work.test' } as any])
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
  ui$.sidebarSection.set('overview')
  settings$.detailsPanelWidth.set(340)
})

const ana: Participant = { name: 'Ana', email: 'ana@x.test', count: 2, isSelf: false }

function Panel({ scopeTitle = 'Budget' }: { scopeTitle?: string }) {
  return (
    <ConversationDetailsPanel
      media={[]}
      files={[]}
      participants={[ana]}
      scopeTitle={scopeTitle}
      loading={false}
      onOpenImage={() => {}}
      onShowInConversation={() => {}}
      onComposeTo={() => {}}
      onViewMessagesWith={() => {}}
      onClose={() => {}}
      accountId="work"
      onOpenConversation={() => {}}
      onOpenEvent={() => {}}
    />
  )
}

const written = (key: string) => writes.filter((w) => w.key === key).map((w) => w.value)

describe('details sidebar sections (#212)', () => {
  it('opens the agenda from the overview and remembers it for this window', async () => {
    const screen = render(<Panel />)
    fireEvent.click(screen.getByRole('button', { name: 'Agenda' }))
    expect(screen.getByRole('heading', { name: 'Agenda' })).toBeTruthy()
    expect(screen.getByText('Next 7 days')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Nothing scheduled or due in the next 7 days.')).toBeTruthy())
    expect(written('session_sidebar_section_main')).toEqual(['agenda'])
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(written('session_sidebar_section_main')).toEqual(['agenda', 'overview'])
  })

  it('reopens on the section last used after a restart', async () => {
    expect(UI_SESSION_KEYS).toContain('session_sidebar_section_main')
    // What boot does with the stored preferences.
    restoreUiSession({ session_sidebar_section_main: 'agenda' }, [])
    const screen = render(<Panel />)
    expect(screen.getByRole('heading', { name: 'Agenda' })).toBeTruthy()
    // Seeding the stored value is not a fresh choice to write back.
    expect(written('session_sidebar_section_main')).toEqual([])
    await waitFor(() => expect(screen.getByText('Nothing scheduled or due in the next 7 days.')).toBeTruthy())
  })

  it('ignores a stored section this version does not know', () => {
    ui$.sidebarSection.set('files')
    restoreUiSession({ session_sidebar_section_main: 'person' }, [])
    expect(ui$.sidebarSection.get()).toBe('files')
    restoreUiSession({ session_sidebar_section_main: 'widgets' }, [])
    expect(ui$.sidebarSection.get()).toBe('files')
  })

  it("keeps the section when the conversation changes, but not one person's history", async () => {
    ui$.sidebarSection.set('files')
    const screen = render(<Panel />)
    expect(screen.getByRole('heading', { name: 'Files' })).toBeTruthy()
    screen.rerender(<Panel scopeTitle="Other thread" />)
    expect(screen.getByRole('heading', { name: 'Files' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    const person = screen.getByText('ana@x.test').closest('div')!.parentElement!
    fireEvent.contextMenu(person, { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByText('History with Ana'))
    expect(screen.getByRole('heading', { name: 'With Ana' })).toBeTruthy()
    // A person's history is shown over the overview, not remembered as a section.
    expect(ui$.sidebarSection.get()).toBe('overview')
    screen.rerender(<Panel scopeTitle="Third thread" />)
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'With Ana' })).toBeNull())
  })
})

describe('details sidebar width (#212)', () => {
  it('resizes from the keyboard within its limits and keeps the width', () => {
    const screen = render(<Panel />)
    const handle = screen.getByRole('separator', { name: 'Resize details panel' })
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
    const screen = render(<Panel />)
    expect(screen.getByRole('separator', { name: 'Resize details panel' }).getAttribute('aria-valuenow')).toBe('420')
    cleanup()
    hydrateSettings({ details_panel_width: 5000 })
    expect(settings$.detailsPanelWidth.get()).toBe(560)
    hydrateSettings({ details_panel_width: 12 })
    expect(settings$.detailsPanelWidth.get()).toBe(280)
    hydrateSettings({ details_panel_width: 'wide' })
    expect(settings$.detailsPanelWidth.get()).toBe(280)
  })
})
