import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { besideEndX, elementDirection, endAlignedX, groupIndexForKey, menuLeft } from '../../lib/direction'
import { clsx } from '../../lib/utils'
import { accounts$ } from '../../states/accounts'
import { mail$, unifiedInboxUnread } from '../../states/mail'
import { chatUnread, messaging$ } from '../../states/messaging'
import { settings$ } from '../../states/settings'
import { toggleModule, ui$, type AppModule } from '../../states/ui'
import { MenuList } from '../menu/Menu'
import { MenuItem } from '../menu/MenuItem'
import { useDismissOnOutside } from '../menu/useDismissOnOutside'
import { UnreadCountBadge } from '../sidenav/UnreadCountBadge'
import { fitModules, MODULE_BUTTONS, slotsAlong } from './moduleLayout'

/**
 * `strip`: from 1025 px, along the foot of the folder pane, 2.5 rem tall, in
 * the pane's colour. `bar`: from 769 to 1024 px, where the pane is not drawn, a
 * vertical bar 3 rem wide at the start of the row, in the module bar colour
 * (`--me-bg-sidenav`, owner decision 4 on #352).
 */
export type ModuleSwitcherVariant = 'strip' | 'bar'

/** The narrow bar's width, in rem so it grows with the app's zoom; the app's sidebar counts it too. */
export const MODULE_BAR_REM = 3

/** Marks each place of the switcher: a module's key, or `more`. */
const SLOT = 'data-module-slot'
const MORE = 'more'
const MENU_WIDTH_REM = 14
const MARGIN = 8

/** Where «Més» opens from, in the visual px of `getBoundingClientRect`. */
type Anchor = { left: number; right: number; top: number; bottom: number }

// The place a switcher drawn next puts the focus on: a module's key, or
// «Més». Set when a module is opened from a switcher while the focus is in
// it (the strip is part of each module's own folder pane, so the switcher of
// the module that opens is a new one, and the focus would fall to the page
// with the old; the narrow bar stays, and does the same), and when a switcher
// is drawn in place of one that had the focus (the window crossing 1025 px:
// the strip and the bar are different elements). Forgotten once that is
// drawn, so a switcher drawn later never takes the focus.
let refocus: string | null = null

function askRefocus(key: string) {
  refocus = key
  setTimeout(() => {
    if (refocus === key) refocus = null
  }, 0)
}

function slotOf(element: Element | null): string | null {
  return element?.closest(`[${SLOT}]`)?.getAttribute(SLOT) ?? null
}

/** The place of a switcher `target` is in («Més» for its menu), or null when it is not in one. */
function placeInSwitcher(target: EventTarget | null): string | null {
  if (!(target instanceof Element) || !target.closest('[data-module-switcher]')) return null
  return slotOf(target) ?? MORE
}

// Where the focus is in the switchers, followed while one is drawn: it cannot
// be read when the window crosses 1025 px, as a browser may already have
// dropped it (the folder pane, and the strip with it, is hidden by CSS the
// moment the query stops matching). As the folder pane's own controls do
// (folderPaneFocus.ts), it is kept as it moves (`focusin`), and read again
// after each press of the pointer, which may move it with no focusin.
let held: string | null = null
// What `held` was when the last switcher went, for one drawn in its place in
// the same task; the media queries of a crossing report in one task, though
// React may draw what each changes apart.
let leaving: string | null = null
let watchers = 0
let afterPress: ReturnType<typeof setTimeout> | undefined
const PRESSES = ['pointerdown', 'pointerup', 'pointercancel', 'mousedown'] as const

function onFocusIn(event: FocusEvent) {
  held = placeInSwitcher(event.target)
}

function onPress() {
  clearTimeout(afterPress)
  afterPress = setTimeout(() => {
    held = focusFell() ? null : placeInSwitcher(document.activeElement)
  })
}

/** Follows the focus while a switcher is drawn; the place it had when the last goes, for its successor. */
function watchFocus(): () => void {
  if (watchers++ === 0) {
    document.addEventListener('focusin', onFocusIn, true)
    for (const name of PRESSES) document.addEventListener(name, onPress, true)
  }
  return () => {
    if (--watchers > 0) return
    document.removeEventListener('focusin', onFocusIn, true)
    for (const name of PRESSES) document.removeEventListener(name, onPress, true)
    clearTimeout(afterPress)
    const last = held
    held = null
    leaving = last
    setTimeout(() => {
      if (leaving === last) leaving = null
    }, 0)
  }
}

/** Whether the focus fell to the page, or is in another switcher, one about to go. */
function focusLeftFor(me: Element | null): boolean {
  if (focusFell()) return true
  const other = document.activeElement?.closest('[data-module-switcher]')
  return !!other && other !== me
}

function buttonIn(list: HTMLElement, key: string): HTMLButtonElement | null {
  return list.querySelector<HTMLButtonElement>(`[${SLOT}="${key}"] > button`)
}

/** Whether the focus fell to the page (its element went), rather than moving somewhere. */
function focusFell(): boolean {
  const active = document.activeElement
  return !active || active === document.body || !active.isConnected
}

/**
 * The counts the Mail and Chat buttons show (owner decision 2 on #352): the
 * unified inbox's, as the rail's unified button showed it and only while the
 * unread badges are on; and Chat's own.
 */
export function useModuleCounts(): Partial<Record<AppModule, number>> {
  const accounts = useValue(accounts$)
  const foldersByAccount = useValue(mail$.foldersByAccount)
  const badges = useValue(settings$.showUnreadAccountBadge)
  const conversations = useValue(messaging$.conversations)
  const rooms = useValue(messaging$.rooms)
  return {
    mail: badges ? unifiedInboxUnread(accounts, foldersByAccount) : 0,
    chat: chatUnread(conversations, rooms),
  }
}

/**
 * The module switcher (ADR-0068 §5): a `<nav>` «Mòduls», the F6 region
 * `modules`, with a button for each module in the strip's order: Correu,
 * Calendari, Persones, Tasques, Notes, Xat and Adjunts. Each is an icon, with
 * the module's name as its tooltip and accessible name; the active one is
 * `aria-current="page"`, on the selection background with an accent bar (on
 * the top edge in the strip, the start edge in the bar). Mail and Chat show
 * their unread count, said in words as the button's description.
 *
 * What does not fit goes into «Més», in the strip's order: a `ResizeObserver`
 * measures how many places there are along the switcher, «Més» taking one.
 * The active module is never in «Més». Each button is a Tab stop, as tabs are
 * (ADR-0061), and the arrows go round them in reading order, with Home and
 * End: along the line in the strip, and also up and down in the bar.
 *
 * Only one is drawn at a time, so the landmark's name stays unique: the strip
 * by the folder pane from 1025 px, the bar by the app from 769 to 1024 px.
 */
export function ModuleSwitcher({ variant }: { variant: ModuleSwitcherVariant }) {
  const { t } = useTranslation()
  const active = useValue(ui$.module)
  const counts = useModuleCounts()
  const nav = useRef<HTMLElement | null>(null)
  const list = useRef<HTMLUListElement | null>(null)
  const [slots, setSlots] = useState<number | null>(null)
  const slotsRef = useRef<number | null>(null)
  // The place that had the focus when the places last changed.
  const focusedAtChange = useRef<string | null>(null)
  const [menu, setMenu] = useState<Anchor | null>(null)
  const menuId = useId()
  const { shown, more } = fitModules(active, slots)
  const strip = variant === 'strip'
  const label = t('shell.region.modules')

  // Drawn in place of a switcher that had the focus (the window crossing
  // 1025 px, or a module opened by a shortcut): the focus goes on to the same
  // place here. Where it was is read before this switcher starts following it.
  useLayoutEffect(() => {
    const before = watchers > 0 ? held : leaving
    leaving = null
    if (refocus === null && before !== null && focusLeftFor(nav.current)) askRefocus(before)
    return watchFocus()
  }, [])

  // How many places there are along it. The places are the same size (in rem,
  // so they grow with the app's zoom), and the list does not size itself to
  // them: it is as long as the pane is wide or the row is tall.
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const measure = () => {
      const slot = element.querySelector<HTMLElement>(`[${SLOT}]`)
      const box = element.getBoundingClientRect()
      const one = slot?.getBoundingClientRect()
      const next = one ? slotsAlong(strip ? box.width : box.height, strip ? one.width : one.height) : null
      if (next === slotsRef.current) return
      slotsRef.current = next
      focusedAtChange.current = element.contains(document.activeElement) ? slotOf(document.activeElement) : null
      setSlots(next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [strip])

  const shownKey = shown.join(' ')
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    // A module opened from a switcher, or a switcher drawn in place of one:
    // the button that had the focus takes it here, or «Més» if that is where
    // it went, or else the active one. Not before the places are measured: a
    // switcher is first drawn with all of them, and the one wanted may be
    // about to go into «Més» (back to mail from a module that was there).
    if (refocus) {
      if (slots !== slotsRef.current) return
      const wanted = refocus
      refocus = null
      // Unless something else took the focus meanwhile: a command that opens
      // mail and puts it in the band's search, once mail is drawn.
      if (!focusLeftFor(nav.current) && !nav.current?.contains(document.activeElement)) return
      const target = buttonIn(element, wanted) ?? (more.includes(wanted as AppModule) ? buttonIn(element, MORE) : null)
      ;(target ?? buttonIn(element, active))?.focus()
      return
    }
    // The focused button went into «Més» as the places changed: the focus
    // follows it there instead of falling to the page.
    const lost = focusedAtChange.current
    focusedAtChange.current = null
    if (lost && lost !== MORE && !shown.includes(lost as AppModule) && focusFell()) buttonIn(element, MORE)?.focus()
    // `more` follows from `shown`.
  }, [active, shownKey, slots])

  // A menu with nothing left in it closes. With the focus in it (the place
  // grew while it was open), the focus goes to the switcher's last button
  // rather than to the page: «Més» went with its last module.
  useLayoutEffect(() => {
    if (!menu || more.length > 0) return
    const element = list.current
    const inMenu = focusFell() || !!document.getElementById(menuId)?.contains(document.activeElement)
    setMenu(null)
    if (inMenu && element) [...element.querySelectorAll<HTMLButtonElement>(`[${SLOT}] > button`)].at(-1)?.focus()
  }, [menu, more.length, menuId])

  const opener = useCallback(() => (list.current ? buttonIn(list.current, MORE) : null), [])
  const closeMenu = useCallback(() => setMenu(null), [])

  const open = (key: AppModule) => {
    if (nav.current?.contains(document.activeElement)) askRefocus(key)
    setMenu(null)
    // Opens it, or goes back to mail if it is already open, as the rail did.
    toggleModule(key)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const element = list.current
    if (!element) return
    const buttons = [...element.querySelectorAll<HTMLButtonElement>(`[${SLOT}] > button`)]
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    if (index === -1) return
    const next = groupIndexForKey(
      event.key,
      index,
      buttons.length,
      elementDirection(element),
      strip ? 'horizontal' : 'both',
    )
    if (next === null) return
    // The keys it answers end here: the arrows would also step the
    // conversation list behind it (AppHotkeys).
    event.preventDefault()
    event.stopPropagation()
    buttons[next].focus()
  }

  const slotClass = strip ? 'flex w-8 shrink-0' : 'flex h-12 shrink-0 items-center justify-center'

  return (
    <nav
      ref={nav}
      aria-label={label}
      data-region="modules"
      data-module-switcher={variant}
      className={clsx(
        'flex shrink-0 select-none',
        // Two px each side: in the narrowest pane, 200 px less its 1 px border,
        // five 2 rem places and «Més» still fit (196 px for 192).
        strip ? 'h-10 border-t border-border px-0.5' : 'flex-col border-e border-border bg-sidenav py-1',
      )}
      style={strip ? undefined : { width: `${MODULE_BAR_REM}rem` }}
    >
      <ul
        ref={list}
        className={clsx('flex min-h-0 min-w-0 flex-1 overflow-hidden', strip ? 'justify-between' : 'flex-col')}
        onKeyDown={onKeyDown}
      >
        {shown.map((key) => (
          <li key={key} {...{ [SLOT]: key }} className={slotClass}>
            <ModuleButton
              module={key}
              variant={variant}
              current={key === active}
              count={counts[key] ?? 0}
              onOpen={() => open(key)}
            />
          </li>
        ))}
        {more.length > 0 && (
          <li {...{ [SLOT]: MORE }} className={slotClass}>
            <button
              type="button"
              title={t('common.more')}
              aria-label={t('common.more')}
              aria-haspopup="menu"
              aria-expanded={menu !== null}
              aria-controls={menu ? menuId : undefined}
              onClick={(event) => {
                if (menu) return setMenu(null)
                const button = event.currentTarget
                // The menu gives the focus back to what had it: make that the
                // button, also where a click does not focus one (WebKit).
                button.focus({ preventScroll: true })
                // Beside the bar, not over it: its edges, at the height of «Més».
                const at = button.getBoundingClientRect()
                const across = strip ? at : (nav.current?.getBoundingClientRect() ?? at)
                setMenu({ left: across.left, right: across.right, top: at.top, bottom: at.bottom })
              }}
              className={buttonClass(variant, false, menu !== null)}
            >
              <MoreHorizontal size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </li>
        )}
      </ul>
      {menu && (
        <MoreModules
          id={menuId}
          variant={variant}
          anchor={menu}
          modules={more}
          counts={counts}
          opener={opener}
          onOpen={open}
          onClose={closeMenu}
        />
      )}
    </nav>
  )
}

function buttonClass(variant: ModuleSwitcherVariant, current: boolean, pressed = false): string {
  return clsx(
    'relative flex items-center justify-center transition-colors duration-(--duration-fast) cursor-pointer',
    variant === 'strip' ? 'size-full' : 'size-10 rounded-control',
    current
      ? 'bg-active text-accent-fg'
      : variant === 'strip'
        ? clsx('hover:bg-hover hover:text-primary', pressed ? 'bg-hover text-primary' : 'text-secondary')
        : // The light end of the palette on the module bar (index.css), whatever the theme.
          clsx('text-(--module-bar-fg) hover:bg-(--module-bar-fg)/15', pressed && 'bg-(--module-bar-fg)/15'),
  )
}

function ModuleButton({
  module,
  variant,
  current,
  count,
  onOpen,
}: {
  module: AppModule
  variant: ModuleSwitcherVariant
  current: boolean
  count: number
  onOpen: () => void
}) {
  const { t } = useTranslation()
  const countId = useId()
  const { icon: Icon, name: nameKey } = MODULE_BUTTONS[module]
  const name = t(nameKey)
  return (
    <button
      type="button"
      title={name}
      aria-label={name}
      aria-current={current ? 'page' : undefined}
      aria-describedby={count > 0 ? countId : undefined}
      onClick={onOpen}
      className={buttonClass(variant, current)}
    >
      {current && (
        <span
          aria-hidden="true"
          className={clsx(
            'absolute rounded-full bg-accent-fg',
            variant === 'strip' ? 'inset-x-1.5 top-0 h-0.5' : 'inset-y-2 start-0.5 w-0.5',
          )}
        />
      )}
      <span className="relative flex">
        <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
        <UnreadCountBadge count={count} surface={variant === 'strip' ? 'app' : 'sidenav'} className="-top-1.5 -end-2" />
      </span>
      {count > 0 && (
        <span id={countId} className="sr-only">
          {t('reading.unread', { count })}
        </span>
      )}
    </button>
  )
}

/**
 * «Més»: the modules that do not fit, in the strip's order, as a menu of the
 * piece 7 primitives. It opens above the strip, towards the start of the line
 * from «Més» at its end, and beside the bar, past its end edge, upwards from
 * «Més» at its foot; it stays in the window.
 */
function MoreModules({
  id,
  variant,
  anchor,
  modules,
  counts,
  opener,
  onOpen,
  onClose,
}: {
  id: string
  variant: ModuleSwitcherVariant
  anchor: Anchor
  modules: AppModule[]
  counts: Partial<Record<AppModule, number>>
  opener: () => HTMLButtonElement | null
  onOpen: (key: AppModule) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const inside = useCallback(
    (target: EventTarget | null) =>
      target instanceof Node && (!!document.getElementById(id)?.contains(target) || !!opener()?.contains(target)),
    [id, opener],
  )
  // A click or scroll outside, a resize and Escape close it.
  useDismissOnOutside(true, inside, onClose)
  // So does the focus going elsewhere (F6, a click in the page).
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      if (!inside(event.target)) closeRef.current()
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [inside])

  // Anchors are visual pixels; fixed positions use CSS pixels under a root zoom.
  const rootStyle = getComputedStyle(document.documentElement)
  const zoom = parseFloat(rootStyle.zoom) || 1
  const viewportWidth = window.innerWidth / zoom
  const viewportHeight = window.innerHeight / zoom
  const rect = {
    left: anchor.left / zoom,
    right: anchor.right / zoom,
    top: anchor.top / zoom,
    bottom: anchor.bottom / zoom,
  }
  const width = Math.floor(
    Math.max(0, Math.min(MENU_WIDTH_REM * (parseFloat(rootStyle.fontSize) || 16), viewportWidth - 2 * MARGIN)),
  )
  const strip = variant === 'strip'
  const x = strip ? endAlignedX(rect, width) : besideEndX(rect, 4)
  // Its bottom edge: just above «Més» in the strip, level with it beside the bar.
  const above = strip ? rect.top - 4 : rect.bottom
  const bottom = Math.max(MARGIN, Math.ceil(viewportHeight - above))

  return (
    <MenuList
      id={id}
      label={t('common.more')}
      autoFocus
      onClose={onClose}
      className="fixed z-[61] overflow-y-auto rounded-control border border-border bg-chats p-1 shadow-overlay animate-fade-in text-primary"
      style={{
        width,
        bottom,
        left: menuLeft(x, width, viewportWidth, MARGIN),
        maxHeight: Math.max(0, Math.floor(viewportHeight - bottom - MARGIN)),
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {modules.map((key) => (
        <MoreModuleItem key={key} module={key} count={counts[key] ?? 0} onOpen={() => onOpen(key)} />
      ))}
    </MenuList>
  )
}

function MoreModuleItem({ module, count, onOpen }: { module: AppModule; count: number; onOpen: () => void }) {
  const { t } = useTranslation()
  const countId = useId()
  const { icon: Icon, name } = MODULE_BUTTONS[module]
  return (
    <>
      <MenuItem
        icon={
          <span aria-hidden="true" className="flex w-4 shrink-0 justify-center text-secondary">
            <Icon size={15} strokeWidth={1.75} />
          </span>
        }
        label={t(name)}
        describedBy={count > 0 ? countId : undefined}
        trailing={
          count > 0 ? (
            <span
              aria-hidden="true"
              className="rounded-full bg-accent px-1.5 text-2xs font-semibold leading-4 text-on-accent"
            >
              {count > 99 ? '99+' : count}
            </span>
          ) : undefined
        }
        onClick={onOpen}
      />
      {count > 0 && (
        <span id={countId} role="none" className="sr-only">
          {t('reading.unread', { count })}
        </span>
      )}
    </>
  )
}
