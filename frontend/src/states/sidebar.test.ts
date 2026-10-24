import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { compose$ } from './compose'
import { settings$, type AppSidebarState } from './settings'
import {
  closeSidebarOverlay,
  minimizeSidebar,
  openSidebarPanel,
  resolveSidebarPanel,
  selectSidebarPanel,
  shownSidebar,
  sidebar$,
  sidebarDrawn,
  sidebarExpanded,
  toggleAppSidebar,
  toggleConversationPanel,
  type SidebarPanelId,
  type SidebarShown,
} from './sidebar'
import { openThreadSearch, thread$ } from './thread'
import { focusQuickReply, parseSidebarSection, restoreUiSession, ui$, UI_SESSION_KEYS, type SidebarSection } from './ui'

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

  // Owner decisions D4 and D7 on #360: the band button shows and hides the
  // whole sidebar, and hiding the strip where the sidebar does not fit beside
  // is undone by the same button. Each row: the saved state, whether it fits
  // beside, whether the strip can be drawn, and whether an overlay is open;
  // what is drawn, then what one press draws and saves. Before the press, its
  // `aria-expanded` and the action its description and the command name.
  const BAND_BUTTON: [AppSidebarState, boolean, boolean, boolean, SidebarShown, SidebarShown, AppSidebarState][] = [
    // Where it fits beside (1100 px and up, with room for the module).
    ['expanded', true, true, false, 'beside', 'none', 'hidden'],
    ['minimized', true, true, false, 'strip', 'none', 'hidden'],
    ['hidden', true, true, false, 'none', 'beside', 'expanded'],
    // Where only the strip fits (769 px and up): the strip comes back (D7).
    ['expanded', false, true, false, 'strip', 'none', 'hidden'],
    ['minimized', false, true, false, 'strip', 'none', 'hidden'],
    ['hidden', false, true, false, 'none', 'strip', 'minimized'],
    ['minimized', false, true, true, 'overlay', 'strip', 'minimized'],
    // With no strip (below 769 px): the overlay, never saved.
    ['expanded', false, false, false, 'none', 'overlay', 'expanded'],
    ['minimized', false, false, false, 'none', 'overlay', 'minimized'],
    ['hidden', false, false, false, 'none', 'overlay', 'hidden'],
    ['hidden', false, false, true, 'overlay', 'none', 'hidden'],
  ]
  it('the band button: what one press does in each state and room, and what it saves', () => {
    for (const [state, fits, strip, overlay, before, after, saved] of BAND_BUTTON) {
      const row = `${state}, ${fits ? 'fits' : 'does not fit'}, ${strip ? 'strip' : 'no strip'}${overlay ? ', overlay' : ''}`
      sidebar$.set({ fits, strip, conversationOpen: true, overlay })
      settings$.appSidebarState.set(state)
      expect(drawn(), row).toBe(before)
      // `aria-expanded` only beside or as an overlay; the action says a press.
      expect(sidebarExpanded(before), row).toBe(before === 'beside' || before === 'overlay')
      expect(sidebarDrawn(before), row).toBe(before !== 'none')
      toggleAppSidebar()
      expect(drawn(), row).toBe(after)
      expect(settings$.appSidebarState.get(), row).toBe(saved)
    }
  })

  it('hiding the strip where the sidebar does not fit beside is undone by the band button, saved (D7)', async () => {
    room(false)
    settings$.appSidebarState.set('minimized')
    await Promise.resolve()
    writes = []
    toggleAppSidebar()
    expect(drawn()).toBe('none')
    toggleAppSidebar()
    expect(drawn()).toBe('strip')
    expect(sidebar$.overlay.get()).toBe(false)
    await Promise.resolve()
    expect(written('app_sidebar_state')).toEqual(['hidden', 'minimized'])
    // From the strip, its icon still opens the overlay, which is not saved.
    openSidebarPanel('agenda')
    expect(drawn()).toBe('overlay')
    toggleAppSidebar()
    expect(drawn()).toBe('strip')
    await Promise.resolve()
    expect(written('app_sidebar_state')).toEqual(['hidden', 'minimized'])
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

  // D7 is the band button's and the command's (owner decision on #360): `i`
  // opens the Conversa panel, as ADR-0069 §2 says, from `hidden` too.
  it('`i` hidden where it does not fit: the Conversa overlay, not saved, and the band button brings the strip back', () => {
    room(false)
    settings$.appSidebarState.set('hidden')
    ui$.sidebarSection.set('agenda')
    toggleConversationPanel()
    expect(drawn()).toBe('overlay')
    expect(ui$.sidebarSection.get()).toBe('overview')
    expect(settings$.appSidebarState.get()).toBe('hidden')
    toggleConversationPanel()
    expect(drawn()).toBe('none')
    expect(settings$.appSidebarState.get()).toBe('hidden')
    toggleAppSidebar()
    expect(drawn()).toBe('strip')
    expect(settings$.appSidebarState.get()).toBe('minimized')
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

  // Review finding 2 of round 3: what a command opens or focuses in the
  // module is under the overlay, whose module is inert; the overlay goes.
  it('closes the overlay for a command aimed at the module: the reply, the conversation search, a tab', async () => {
    const opens: [string, () => void][] = [
      ['the quick reply', focusQuickReply],
      ['the conversation search', openThreadSearch],
      ['a tab of the conversation pane', () => compose$.activeTab.set('compose-1')],
    ]
    for (const [what, open] of opens) {
      room(false)
      openSidebarPanel('agenda')
      expect(sidebar$.overlay.get(), what).toBe(true)
      open()
      expect(sidebar$.overlay.get(), what).toBe(false)
      expect(settings$.appSidebarState.get(), what).toBe('minimized')
    }
    compose$.activeTab.set('')
    thread$.searchOpen.set(false)
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
