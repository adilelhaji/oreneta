import { useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { useValue } from '@legendapp/state/react'
import { CalendarDays, MessagesSquare, PanelRightClose, X, type LucideIcon } from 'lucide-react'
import { handleGroupArrowKeys } from '../../lib/direction'
import { useTranslation, type t as translate } from '../../lib/i18n'
import {
  appSidebarLayout,
  DETAILS_PANEL_WIDTH,
  SIDEBAR_STRIP_MIN_WINDOW,
  SIDEBAR_STRIP_REM,
  type SidebarContent,
} from '../../lib/paneResize'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { clsx } from '../../lib/utils'
import { settings$ } from '../../states/settings'
import {
  closeSidebarOverlay,
  minimizeSidebar,
  openSidebarPanel,
  resolveSidebarPanel,
  selectSidebarPanel,
  shownSidebar,
  sidebar$,
  takeOverlayOpener,
  takeSidebarRefocus,
  type SidebarPanelId,
  type SidebarShown,
} from '../../states/sidebar'
import { ui$ } from '../../states/ui'
import { IconButton } from '../button/IconButton'
import { useConversationOpen } from '../chat/activeConversation'
import { ConversationPanel } from '../chat/ConversationDetailsPanel'
import { SidebarAgenda } from '../chat/SidebarAgenda'
import { PaneResizer } from '../resizer/PaneResizer'
import { useElementWidth, useWideWindow, useWindowWidth } from '../resizer/useElementWidth'
import { FOLDER_PANE_MIN_WINDOW } from './FolderPane'

/** The narrow module bar of 769–1024 px, 3 rem wide (ModuleSwitcher's `bar`). */
const NARROW_BAR_REM = 3

export type SidebarPanelDef = {
  id: SidebarPanelId
  icon: LucideIcon
  /** The panel's name: its tab, the heading of the sidebar, and in its strip icon's name. */
  label: (t: typeof translate) => string
  /** A line under the heading. */
  caption?: (t: typeof translate) => string
  /** Whether the panel is there now; one that is not has no tab at all, not a disabled one. */
  available: (conversationOpen: boolean) => boolean
  content: () => ReactNode
}

/**
 * The panels of the sidebar, in the order of its tabs (ADR-0069 §1). Adding
 * one is one entry here: Dia and Persona come with 12b and 12c, before
 * Conversa, which is there only with a conversation open (in mail, or in a
 * board with its conversation pane).
 */
export const SIDEBAR_PANELS: readonly SidebarPanelDef[] = [
  {
    id: 'agenda',
    icon: CalendarDays,
    label: (t) => t('sidebar.agenda'),
    caption: (t) => t('sidebar.agendaRange'),
    available: () => true,
    // Not about any conversation, so it never waits for one to load (ADR-0059).
    content: () => (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarAgenda />
      </div>
    ),
  },
  {
    id: 'conversation',
    icon: MessagesSquare,
    label: (t) => t('sidebar.conversation'),
    available: (conversationOpen) => conversationOpen,
    content: () => <ConversationPanel />,
  },
]

/** The root font size in px: what a rem is at the app's zoom. */
function rootRem(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
}

interface AppSidebarProps {
  /** The frame row the sidebar ends: measured as drawn without the sidebar. */
  row: RefObject<HTMLElement | null>
  /** What the module on screen keeps beside the sidebar. */
  content: SidebarContent
  /** The panels offered, in tab order: {@link SIDEBAR_PANELS} unless a test adds one. */
  panels?: readonly SidebarPanelDef[]
}

/**
 * The app's sidebar (ADR-0069): the `<aside>` «Barra lateral» at the end of
 * the frame row, after `<main>`, in every module, and the F6 region
 * `sidebar`.
 *
 * - **Expanded** beside the content where the row leaves it room (from
 *   1100 px; in mail from 1120 px): `details_panel_width`, 280–560 px, with
 *   the separator of ADR-0059, at most what the folder pane and the list,
 *   giving way in that order, leave it. Its minimise button minimises it.
 * - **As an overlay** where it does not fit: at most 85 % of the window, over
 *   the module and its header, with a backdrop; only an action opens it, and
 *   Escape, the backdrop or its close button close it, leaving the saved
 *   state as it was.
 * - **Minimised:** a 2.5 rem strip of the panels' icons, always beside, from
 *   769 px; an icon expands the sidebar on that panel. It is also how a saved
 *   `expanded` is drawn where the sidebar does not fit: an overlay never
 *   opens by itself.
 * - **Hidden:** nothing, as below 769 px whenever no overlay is open.
 *
 * At its foot, the panel selector: a tab list whose arrows go round in
 * reading order, each tab a Tab stop (ADR-0061).
 */
export function AppSidebar({ row, content, panels: offered = SIDEBAR_PANELS }: AppSidebarProps) {
  const { t } = useTranslation()
  const saved = useValue(settings$.appSidebarState)
  const overlay = useValue(sidebar$.overlay)
  const storedWidth = useValue(settings$.detailsPanelWidth)
  const section = useValue(ui$.sidebarSection)
  // Read so the strip and the narrow bar follow the app's zoom: they are in rem.
  useValue(settings$.fontScale)
  const conversationOpen = useConversationOpen()
  const windowWidth = useWindowWidth()
  const rowWidth = useElementWidth(row)
  const folders = useWideWindow(FOLDER_PANE_MIN_WINDOW)
  const narrowBar = useWideWindow(SIDEBAR_STRIP_MIN_WINDOW) && !folders
  const rem = rootRem()
  const layout = appSidebarLayout({
    window: windowWidth,
    row: rowWidth,
    content,
    folders,
    bar: narrowBar ? NARROW_BAR_REM * rem : 0,
    strip: SIDEBAR_STRIP_REM * rem,
  })
  const shown = shownSidebar(saved, layout.beside, layout.strip, overlay)

  const panels = offered.filter((panel) => panel.available(conversationOpen))
  const panelId = resolveSidebarPanel(
    section,
    conversationOpen,
    panels.map((panel) => panel.id),
  )
  const panel = panels.find((candidate) => candidate.id === panelId) ?? panels[0]
  const ids = useId()
  const tabId = (id: SidebarPanelId) => `${ids}-tab-${id}`
  const panelElementId = `${ids}-panel`

  const asideRef = useRef<HTMLElement | null>(null)

  // What the band button, the palette and `i` read to decide what they do.
  useLayoutEffect(() => {
    sidebar$.fits.set(layout.beside)
    sidebar$.strip.set(layout.strip)
  }, [layout.beside, layout.strip])
  useEffect(
    () => () => {
      sidebar$.fits.set(false)
      sidebar$.strip.set(false)
      closeSidebarOverlay()
    },
    [],
  )
  // Where it fits beside again, an overlay is no longer how it is shown; it
  // must not come back by itself when the window narrows again.
  useEffect(() => {
    if (layout.beside) closeSidebarOverlay()
  }, [layout.beside])

  useEscapeKey(closeSidebarOverlay, shown === 'overlay')

  // The focus, as the sidebar changes shape. An overlay takes it, on its
  // selected tab, and gives it back to what had it when it closes (the strip's
  // icon, if that went). From the strip to beside the content and back, the
  // control that had it goes, and the focus goes to its counterpart.
  const previous = useRef<SidebarShown>(shown)
  useLayoutEffect(() => {
    const before = previous.current
    previous.current = shown
    if (before === shown) return
    const refocus = takeSidebarRefocus()
    const aside = asideRef.current
    const selectedTab = () => aside?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    const stripIcon = () =>
      aside?.querySelector<HTMLElement>(`[data-sidebar-panel="${panelId}"]`) ??
      aside?.querySelector<HTMLElement>('[data-sidebar-panel]')
    if (shown === 'overlay') {
      selectedTab()?.focus({ preventScroll: true })
      return
    }
    if (before === 'overlay') {
      const opener = takeOverlayOpener()
      // Only a focus that went with the overlay: one another surface took (a
      // dialog opened from the agenda, the band button) stays there.
      const active = document.activeElement
      if (active && active !== document.body && active.isConnected) return
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        !opener.matches(':disabled') &&
        !opener.closest('[hidden], [inert], [aria-hidden="true"]')
      ) {
        opener.focus({ preventScroll: true })
      } else if (shown === 'strip') stripIcon()?.focus({ preventScroll: true })
      return
    }
    if (refocus === 'tab' && shown === 'beside') selectedTab()?.focus({ preventScroll: true })
    else if (refocus === 'strip' && shown === 'strip') stripIcon()?.focus({ preventScroll: true })
  }, [shown])

  if (shown === 'none') return null
  const label = t('sidebar.label')

  if (shown === 'strip') {
    return (
      <aside
        ref={asideRef}
        aria-label={label}
        data-region="sidebar"
        data-app-sidebar
        data-layout="strip"
        className="flex w-10 shrink-0 flex-col items-center gap-1 border-s border-border bg-header py-1"
      >
        {panels.map((entry) => (
          <IconButton
            key={entry.id}
            icon={entry.icon}
            size="md"
            radius="lg"
            // Not the panel's bare name, which a module may use for something
            // else (the Calendar's «Agenda» view).
            label={t('sidebar.openPanel', { panel: entry.label(t) })}
            data-sidebar-panel={entry.id}
            onClick={() => openSidebarPanel(entry.id)}
          />
        ))}
      </aside>
    )
  }

  const beside = shown === 'beside'
  const width = beside ? Math.min(storedWidth, layout.max) : storedWidth
  return (
    <>
      {!beside && (
        <>
          {/* The strip keeps its room under the overlay, so the module does not move. */}
          {saved !== 'hidden' && layout.strip && (
            <div aria-hidden="true" className="w-10 shrink-0 border-s border-border bg-header" />
          )}
          <div className="absolute inset-0 z-[44] bg-black/40 animate-fade-in" onClick={closeSidebarOverlay} />
        </>
      )}
      {/* As an overlay it sits above the module and its header (z-40), whose
          dialogs and the gallery (z-50) stay above it. */}
      <aside
        ref={asideRef}
        aria-label={label}
        data-region="sidebar"
        data-app-sidebar
        data-layout={beside ? 'beside' : 'overlay'}
        style={{ '--details-panel-width': `${width}px` } as CSSProperties}
        className={clsx(
          'flex w-[var(--details-panel-width)] shrink-0 flex-col border-s border-border bg-header animate-slide-in-end',
          beside ? 'relative' : 'absolute inset-y-0 end-0 z-[45] max-w-[85vw] shadow-overlay',
        )}
      >
        {/* Resizable beside the content only; as an overlay it is capped to the window. */}
        {beside && (
          <PaneResizer
            label={t('layout.resizeSidebar')}
            value={width}
            limits={{ min: DETAILS_PANEL_WIDTH.min, max: layout.max }}
            edge="start"
            sizeAt={(clientX, rtl) => {
              const rect = asideRef.current?.getBoundingClientRect()
              if (!rect) return width
              return rtl ? clientX - rect.left : rect.right - clientX
            }}
            onResize={(size) => settings$.detailsPanelWidth.set(size)}
            className="absolute start-0 top-0 h-full -translate-x-1 rtl:translate-x-1"
          />
        )}
        <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border py-1.5 ps-4 pe-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-primary">{panel.label(t)}</h2>
            {panel.caption && (
              <p className="mt-0.5 truncate text-caption font-medium text-secondary">{panel.caption(t)}</p>
            )}
          </div>
          {beside ? (
            <IconButton
              icon={PanelRightClose}
              iconSize={18}
              label={t('sidebar.minimize')}
              className="rtl:[&>svg]:-scale-x-100"
              onClick={minimizeSidebar}
            />
          ) : (
            <IconButton icon={X} iconSize={20} label={t('chat.closeEsc')} onClick={closeSidebarOverlay} />
          )}
        </div>
        <div
          role="tabpanel"
          id={panelElementId}
          aria-labelledby={tabId(panel.id)}
          className="flex min-h-0 flex-1 flex-col"
        >
          {panel.content()}
        </div>
        {/* The panel selector (ADR-0069 §1): 2.5 rem, the arrows in reading
            order and round, every tab a Tab stop (ADR-0061). */}
        <div
          role="tablist"
          aria-label={t('sidebar.panels')}
          className="flex h-10 shrink-0 border-t border-border"
          onKeyDown={(event) => handleGroupArrowKeys(event, '[role="tab"]', 'horizontal')}
        >
          {panels.map((entry) => {
            const selected = entry.id === panel.id
            const name = entry.label(t)
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={tabId(entry.id)}
                aria-selected={selected}
                aria-controls={panelElementId}
                title={name}
                onClick={() => selectSidebarPanel(entry.id)}
                className={clsx(
                  'flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 px-2 text-caption font-semibold transition-colors duration-(--duration-fast)',
                  selected ? 'bg-active text-accent-fg' : 'text-secondary hover:bg-hover hover:text-primary',
                )}
              >
                <entry.icon size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
                <span className="truncate">{name}</span>
              </button>
            )
          })}
        </div>
      </aside>
    </>
  )
}
