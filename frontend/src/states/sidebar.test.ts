import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { settings$ } from './settings'
import {
  closeSidebarOverlay,
  minimizeSidebar,
  openSidebarPanel,
  resolveSidebarPanel,
  selectSidebarPanel,
  shownSidebar,
  sidebar$,
  toggleAppSidebar,
  toggleConversationPanel,
  type SidebarPanelId,
} from './sidebar'
import { parseSidebarSection, restoreUiSession, ui$, UI_SESSION_KEYS, type SidebarSection } from './ui'

// The app's sidebar (ADR-0069 §2, #361): its remembered panel, how it is
// drawn, and which actions change the saved state.

let writes: { key: string; value: unknown }[] = []
const written = (key: string) => writes.filter((write) => write.key === key).map((write) => write.value)

beforeEach(() => {
  writes = []
  ;(window as any).go = {
    main: {
      App: {
        Invoke: async (command: string, payload: any) => {
          if (command === 'app.prefsSet') writes.push(payload)
          return { ok: true }
        },
      },
    },
  }
})

afterEach(() => {
  sidebar$.set({ fits: false, strip: false, conversationOpen: false, overlay: false })
  settings$.appSidebarState.set('minimized')
  // The Conversa subsection last shown goes back to the summary too.
  ui$.sidebarSection.set('overview')
  ui$.sidebarSection.set('agenda')
  ui$.module.set('mail')
  delete (window as any).go
})

const SHIPPED: SidebarPanelId[] = ['agenda', 'conversation']

describe('the remembered panel (session_sidebar_section_main)', () => {
  it('keeps the panel type, Dia and Persona included, and reads anything else as the Agenda', () => {
    expect(UI_SESSION_KEYS).toContain('session_sidebar_section_main')
    for (const section of ['overview', 'media', 'files', 'agenda', 'day', 'person'] as const) {
      expect(parseSidebarSection(section)).toBe(section)
    }
    for (const raw of ['widgets', '', undefined, null, 3, 'Overview', ['agenda']]) {
      expect(parseSidebarSection(raw)).toBe('agenda')
    }
  })

  it('restores what was kept, and an unknown or empty value as the Agenda', () => {
    restoreUiSession({ session_sidebar_section_main: 'media' }, [])
    expect(ui$.sidebarSection.get()).toBe('media')
    restoreUiSession({ session_sidebar_section_main: 'person' }, [])
    expect(ui$.sidebarSection.get()).toBe('person')
    restoreUiSession({ session_sidebar_section_main: 'widgets' }, [])
    expect(ui$.sidebarSection.get()).toBe('agenda')
    ui$.sidebarSection.set('files')
    restoreUiSession({ session_sidebar_section_main: '' }, [])
    expect(ui$.sidebarSection.get()).toBe('agenda')
    // Restoring is not a choice to write back.
    expect(written('session_sidebar_section_main')).toEqual(['files'])
  })

  // ADR-0069 §2's table.
  it('shows the Conversa panel on its subsection with a conversation open, and the Agenda without one', () => {
    for (const section of ['overview', 'media', 'files'] as const) {
      expect(resolveSidebarPanel(section, true, SHIPPED)).toBe('conversation')
      expect(resolveSidebarPanel(section, false, SHIPPED)).toBe('agenda')
    }
    expect(resolveSidebarPanel('agenda', true, SHIPPED)).toBe('agenda')
    expect(resolveSidebarPanel('agenda', false, SHIPPED)).toBe('agenda')
  })

  it('shows Dia and Persona as themselves once they are there, and as the Agenda until then', () => {
    for (const section of ['day', 'person'] as const) {
      expect(resolveSidebarPanel(section, true, SHIPPED)).toBe('agenda')
      expect(resolveSidebarPanel(section, false, SHIPPED)).toBe('agenda')
    }
    const later: SidebarPanelId[] = ['agenda', 'day', 'person', 'conversation']
    expect(resolveSidebarPanel('day', false, later)).toBe('day')
    expect(resolveSidebarPanel('person', true, later)).toBe('person')
    // Unknown or empty was read as the Agenda already.
    expect(resolveSidebarPanel(parseSidebarSection('?') as SidebarSection, true, later)).toBe('agenda')
  })

  it('goes back to the Conversa subsection last shown', () => {
    ui$.sidebarSection.set('files')
    selectSidebarPanel('agenda')
    expect(ui$.sidebarSection.get()).toBe('agenda')
    selectSidebarPanel('conversation')
    expect(ui$.sidebarSection.get()).toBe('files')
  })
})

describe('how the sidebar is drawn', () => {
  it('beside where it fits, the strip where it does not, nothing when hidden or below 769 px', () => {
    expect(shownSidebar('expanded', true, true, false)).toBe('beside')
    // Saved as expanded, with no room beside: the strip, never an overlay by itself.
    expect(shownSidebar('expanded', false, true, false)).toBe('strip')
    expect(shownSidebar('expanded', false, false, false)).toBe('none')
    expect(shownSidebar('minimized', true, true, false)).toBe('strip')
    expect(shownSidebar('minimized', false, false, false)).toBe('none')
    expect(shownSidebar('hidden', true, true, false)).toBe('none')
    // An overlay someone opened, only where it does not fit.
    expect(shownSidebar('hidden', false, false, true)).toBe('overlay')
    expect(shownSidebar('minimized', false, true, true)).toBe('overlay')
    expect(shownSidebar('minimized', true, true, true)).toBe('strip')
  })
})

describe('what changes the saved state (ADR-0069 §2)', () => {
  const room = (fits: boolean, strip = true, conversationOpen = true) =>
    sidebar$.set({ fits, strip, conversationOpen, overlay: false })
  const drawn = () =>
    shownSidebar(settings$.appSidebarState.get(), sidebar$.fits.get(), sidebar$.strip.get(), sidebar$.overlay.get())

  // Owner decision D4 on #360: the band button shows and hides the whole sidebar.
  it('the band button hides whatever is drawn, the strip too, and expands it from nothing: all saved', () => {
    room(true)
    expect(drawn()).toBe('strip')
    toggleAppSidebar()
    expect(settings$.appSidebarState.get()).toBe('hidden')
    expect(drawn()).toBe('none')
    toggleAppSidebar()
    expect(settings$.appSidebarState.get()).toBe('expanded')
    expect(drawn()).toBe('beside')
    toggleAppSidebar()
    expect(settings$.appSidebarState.get()).toBe('hidden')
    expect(sidebar$.overlay.get()).toBe(false)
    // A saved `expanded` drawn as the strip, where it does not fit: hidden too.
    settings$.appSidebarState.set('expanded')
    room(false)
    expect(drawn()).toBe('strip')
    toggleAppSidebar()
    expect(settings$.appSidebarState.get()).toBe('hidden')
    expect(sidebar$.overlay.get()).toBe(false)
  })

  it('where it does not fit and nothing is drawn, the band button opens an overlay and closes it, neither saved', () => {
    room(false)
    settings$.appSidebarState.set('hidden')
    toggleAppSidebar()
    expect(drawn()).toBe('overlay')
    expect(settings$.appSidebarState.get()).toBe('hidden')
    toggleAppSidebar()
    expect(drawn()).toBe('none')
    expect(settings$.appSidebarState.get()).toBe('hidden')
    // Below 769 px there is no strip: minimised draws nothing, and the button
    // opens the overlay; once closed, nothing again.
    settings$.appSidebarState.set('minimized')
    room(false, false)
    expect(drawn()).toBe('none')
    toggleAppSidebar()
    expect(drawn()).toBe('overlay')
    closeSidebarOverlay()
    expect(drawn()).toBe('none')
    expect(settings$.appSidebarState.get()).toBe('minimized')
  })

  it('a strip icon expands it on its panel, saved; where it does not fit, as an overlay, not saved', () => {
    room(true)
    openSidebarPanel('agenda')
    expect(settings$.appSidebarState.get()).toBe('expanded')
    expect(ui$.sidebarSection.get()).toBe('agenda')
    settings$.appSidebarState.set('minimized')
    room(false)
    openSidebarPanel('conversation')
    expect(sidebar$.overlay.get()).toBe(true)
    expect(ui$.sidebarSection.get()).toBe('overview')
    expect(settings$.appSidebarState.get()).toBe('minimized')
  })

  it('the minimise button minimises it, saved', () => {
    room(true)
    settings$.appSidebarState.set('expanded')
    minimizeSidebar()
    expect(settings$.appSidebarState.get()).toBe('minimized')
  })

  it('`i` beside the content: expands it on Conversa, and minimises it from there, both saved', () => {
    room(true)
    ui$.sidebarSection.set('agenda')
    settings$.appSidebarState.set('expanded')
    // Expanded on another panel: to the Conversa panel.
    toggleConversationPanel()
    expect(ui$.sidebarSection.get()).toBe('overview')
    expect(settings$.appSidebarState.get()).toBe('expanded')
    toggleConversationPanel()
    expect(settings$.appSidebarState.get()).toBe('minimized')
    toggleConversationPanel()
    expect(settings$.appSidebarState.get()).toBe('expanded')
    // Hidden: expanded on the Conversa panel too, never only shown.
    settings$.appSidebarState.set('hidden')
    toggleConversationPanel()
    expect(settings$.appSidebarState.get()).toBe('expanded')
  })

  it('`i` as an overlay opens it on Conversa and closes it as Escape does: the saved state stays', () => {
    room(false)
    settings$.appSidebarState.set('expanded')
    toggleConversationPanel()
    expect(sidebar$.overlay.get()).toBe(true)
    expect(ui$.sidebarSection.get()).toBe('overview')
    toggleConversationPanel()
    expect(sidebar$.overlay.get()).toBe(false)
    expect(settings$.appSidebarState.get()).toBe('expanded')
    // On the Agenda overlay, `i` moves it to Conversa rather than closing it.
    openSidebarPanel('agenda')
    toggleConversationPanel()
    expect(sidebar$.overlay.get()).toBe(true)
    expect(ui$.sidebarSection.get()).toBe('overview')
  })

  // Review finding C: under a reader or compose tab, or below 769 px with the
  // list in its place, there is no Conversa panel.
  it('`i` does nothing without a conversation on screen: no panel, no overlay, nothing saved', async () => {
    for (const fits of [true, false]) {
      room(fits, true, false)
      settings$.appSidebarState.set('minimized')
      ui$.sidebarSection.set('agenda')
      await Promise.resolve()
      writes = []
      toggleConversationPanel()
      toggleConversationPanel()
      expect(sidebar$.overlay.get()).toBe(false)
      expect(settings$.appSidebarState.get()).toBe('minimized')
      expect(ui$.sidebarSection.get()).toBe('agenda')
      await Promise.resolve()
      expect(writes).toEqual([])
    }
  })

  // Owner decision D5 on #360: an overlay is a way of showing the sidebar, never a preference.
  it('never saves `expanded` from an overlay, whatever opened it', async () => {
    const opens: [string, () => void][] = [
      ['the band button', toggleAppSidebar],
      ['a strip icon', () => openSidebarPanel('agenda')],
      ['`i`', toggleConversationPanel],
    ]
    for (const state of ['minimized', 'hidden'] as const) {
      for (const [, open] of opens) {
        // Nothing drawn for the band button (below 769 px, or hidden); the
        // strip for its icons.
        room(false, state === 'minimized' && open !== toggleAppSidebar)
        settings$.appSidebarState.set(state)
        await Promise.resolve()
        writes = []
        open()
        expect(sidebar$.overlay.get()).toBe(true)
        closeSidebarOverlay()
        await Promise.resolve()
        expect(settings$.appSidebarState.get()).toBe(state)
        expect(written('app_sidebar_state')).toEqual([])
      }
    }
  })

  it('closing the overlay, or going to another module, leaves the saved state as it was', async () => {
    room(false)
    for (const state of ['expanded', 'minimized', 'hidden'] as const) {
      settings$.appSidebarState.set(state)
      await Promise.resolve()
      writes = []
      openSidebarPanel('agenda')
      closeSidebarOverlay()
      openSidebarPanel('agenda')
      ui$.module.set('calendar')
      expect(sidebar$.overlay.get()).toBe(false)
      ui$.module.set('mail')
      await Promise.resolve()
      expect(settings$.appSidebarState.get()).toBe(state)
      expect(written('app_sidebar_state')).toEqual([])
    }
  })
})
