import { observable } from '@legendapp/state'
import { settings$, type AppSidebarState } from './settings'
import { thread$ } from './thread'
import { isConversationSection, ui$, type ConversationSection, type SidebarSection } from './ui'

// The app's sidebar (ADR-0069): one `<aside>` at the end of the frame row, in
// every module, expanded, minimised to its strip, or hidden. What is saved is
// `settings$.appSidebarState`; what is here is how it is on screen now.

/**
 * The panels of the app's sidebar (ADR-0069 §1). The ones this version shows
 * are listed by AppSidebar; Dia and Persona arrive with their pieces (12b and
 * 12c), and until then a stored `day` or `person` shows the Agenda.
 */
export type SidebarPanelId = 'agenda' | 'day' | 'person' | 'conversation'

/** How the sidebar is drawn now. */
export type SidebarShown = 'beside' | 'overlay' | 'strip' | 'none'

export const sidebar$ = observable({
  /** Whether, expanded, the sidebar goes beside the content (AppSidebar measures the row). */
  fits: false,
  /** Whether the minimised strip is drawn where the sidebar is not expanded beside. */
  strip: false,
  /**
   * Whether a conversation is open on screen, so that the Conversa panel is
   * there (AppSidebar reads it): without one, `i` and the conversation
   * header's details buttons have nothing to show.
   */
  conversationOpen: false,
  /**
   * An overlay opened where the sidebar does not fit beside the content. It is
   * a way of showing the sidebar, not a preference: opening and closing it
   * leave the saved state alone (ADR-0069 §2).
   */
  overlay: false,
})

/** The panel a stored section belongs to: each Conversa subsection is the Conversa panel. */
export function panelOfSection(section: SidebarSection): SidebarPanelId {
  return isConversationSection(section) ? 'conversation' : section
}

/**
 * The panel shown for the stored section (ADR-0069 §2): the Conversa panel,
 * on its subsection, only with a conversation open, and otherwise the Agenda;
 * a panel `panels` does not have (Dia and Persona, for now) is the Agenda too.
 */
export function resolveSidebarPanel(
  section: SidebarSection,
  conversationOpen: boolean,
  panels: readonly SidebarPanelId[],
): SidebarPanelId {
  const panel = panelOfSection(section)
  if (panel === 'conversation' && !conversationOpen) return 'agenda'
  return panels.includes(panel) ? panel : 'agenda'
}

/**
 * How the sidebar is drawn (ADR-0069 §2). An overlay only where it does not
 * fit beside, and only once something opened it; expanded beside where it
 * fits; otherwise the strip, which is how `expanded` is drawn where it does
 * not fit (never an overlay by itself), from 769 px; and nothing when hidden
 * or below 769 px.
 */
export function shownSidebar(state: AppSidebarState, fits: boolean, strip: boolean, overlay: boolean): SidebarShown {
  if (overlay && !fits) return 'overlay'
  if (state === 'expanded' && fits) return 'beside'
  if (state !== 'hidden' && strip) return 'strip'
  return 'none'
}

export function currentSidebarShown(): SidebarShown {
  return shownSidebar(
    settings$.appSidebarState.peek(),
    sidebar$.fits.peek(),
    sidebar$.strip.peek(),
    sidebar$.overlay.peek(),
  )
}

// The Conversa subsection last shown in this session, so that its tab and its
// strip icon go back to it.
let conversationSection: ConversationSection = isConversationSection(ui$.sidebarSection.peek())
  ? (ui$.sidebarSection.peek() as ConversationSection)
  : 'overview'
ui$.sidebarSection.onChange(({ value }) => {
  if (isConversationSection(value)) conversationSection = value
})

/** Shows `panel` in the sidebar, as its tab does: the Conversa panel on the subsection last shown. */
export function selectSidebarPanel(panel: SidebarPanelId) {
  ui$.sidebarSection.set(panel === 'conversation' ? conversationSection : panel)
}

// Where the focus goes once the sidebar is drawn again, when it was in the
// sidebar as it changed shape: the strip's icon gives way to the expanded
// sidebar and its minimise button to the strip, so the focused control goes.
let refocus: 'tab' | 'strip' | null = null
// What had the focus when an overlay opened, for it to go back to.
let overlayOpener: Element | null = null

function focusInSidebar(): boolean {
  return !!document.activeElement?.closest('[data-app-sidebar]')
}

// Asked for the drawing that follows, and forgotten after it, so a later one
// never takes the focus.
function askRefocus(target: 'tab' | 'strip') {
  refocus = target
  setTimeout(() => {
    if (refocus === target) refocus = null
  }, 0)
}

/** For AppSidebar, once drawn: where the focus should go, once. */
export function takeSidebarRefocus(): 'tab' | 'strip' | null {
  const target = refocus
  refocus = null
  return target
}

/** For AppSidebar, once an overlay closed: what had the focus when it opened. */
export function takeOverlayOpener(): Element | null {
  const opener = overlayOpener
  overlayOpener = null
  return opener
}

/**
 * Expands the sidebar: beside the content where it fits, which is saved, and
 * otherwise as an overlay, which is not (ADR-0069 §2).
 */
export function expandSidebar() {
  if (sidebar$.fits.peek()) {
    if (focusInSidebar()) askRefocus('tab')
    settings$.appSidebarState.set('expanded')
    return
  }
  if (sidebar$.overlay.peek()) return
  overlayOpener = document.activeElement
  sidebar$.overlay.set(true)
}

/** Closes the overlay (Escape, the backdrop, its close button, `i`); the saved state does not change. */
export function closeSidebarOverlay() {
  if (sidebar$.overlay.peek()) sidebar$.overlay.set(false)
}

/** The sidebar's minimise button (and `i` on its Conversa panel): from beside the content to the strip, saved. */
export function minimizeSidebar() {
  if (focusInSidebar()) askRefocus('strip')
  settings$.appSidebarState.set('minimized')
}

/**
 * Whether showing the sidebar from nothing drawn brings its strip back (owner
 * decision D7 on #360): it is hidden where it does not fit beside the content
 * but its strip does, from 769 px. Hiding the strip is then undone by showing
 * it again, saved as `minimized`, rather than by an overlay.
 */
function stripComesBack(): boolean {
  return settings$.appSidebarState.peek() === 'hidden' && !sidebar$.fits.peek() && sidebar$.strip.peek()
}

/**
 * The band's «Barra lateral» button, the palette and the app menu (owner
 * decisions D4 and D7 on #360): a show-and-hide of the whole sidebar.
 * Whatever is drawn of it goes: expanded beside the content or minimised to
 * its strip, it is hidden (saved); as an overlay, the overlay closes (not
 * saved). With nothing drawn it is shown: expanded beside the content where it
 * fits (saved); where it does not, its strip again (saved `minimized`), whose
 * icons open the overlay; and with no strip either (below 769 px), as an
 * overlay (not saved).
 */
export function toggleAppSidebar() {
  const shown = currentSidebarShown()
  if (shown === 'overlay') closeSidebarOverlay()
  else if (shown === 'beside' || shown === 'strip') settings$.appSidebarState.set('hidden')
  else if (stripComesBack()) settings$.appSidebarState.set('minimized')
  else expandSidebar()
}

/** Whether the sidebar is expanded, beside the content or as an overlay: the band button's `aria-expanded`. */
export function sidebarExpanded(shown: SidebarShown): boolean {
  return shown === 'beside' || shown === 'overlay'
}

/** Whether any of the sidebar is drawn, the strip included: what the band button would hide. */
export function sidebarDrawn(shown: SidebarShown): boolean {
  return shown !== 'none'
}

/** A strip icon: expands the sidebar on its panel. */
export function openSidebarPanel(panel: SidebarPanelId) {
  selectSidebarPanel(panel)
  expandSidebar()
}

/**
 * `i` (`thread.details`) in mail, and the conversation header's details
 * buttons (ADR-0069 §2): with the sidebar expanded on the Conversa panel, it
 * minimises it, or closes it as Escape does where it is an overlay; otherwise
 * it expands it on the Conversa panel. Hidden where it does not fit beside,
 * it brings the strip back on the Conversa panel (saved `minimized`, owner
 * decision D7 on #360), from which `i` again opens the overlay.
 */
export function toggleConversationPanel() {
  // No conversation on screen (a reader or compose tab over it, the list in
  // its place below 769 px): there is no Conversa panel to show or hide.
  if (!sidebar$.conversationOpen.peek()) return
  const shown = currentSidebarShown()
  const onConversation = isConversationSection(ui$.sidebarSection.peek())
  if (onConversation && shown === 'overlay') closeSidebarOverlay()
  else if (onConversation && shown === 'beside') minimizeSidebar()
  else if (stripComesBack()) {
    selectSidebarPanel('conversation')
    settings$.appSidebarState.set('minimized')
  } else openSidebarPanel('conversation')
}

// The overlay covers the module it was opened over, which is inert under it.
// What brings the module forward closes it: another module (the calendar, for
// an event opened from the agenda), and a command that focuses a field of the
// module (`r` and the palette's «Reply», the conversation's search). A tab of
// the conversation pane coming forward (a new message, a reply in the full
// editor) closes it from states/compose.ts, which this module cannot import.
ui$.module.onChange(() => closeSidebarOverlay())
ui$.replyFocus.onChange(() => closeSidebarOverlay())
thread$.searchFocus.onChange(() => closeSidebarOverlay())
