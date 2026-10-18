import { createContext, useContext, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react'
import { elementDirection } from '../../lib/direction'
import {
  MENU_ITEM_SELECTOR,
  TYPEAHEAD_RESET_MS,
  focusInMenu,
  focusMenuEdge,
  focusMenuItem,
  menuItemsOf,
  menuKeyAction,
  movedIndex,
  typeaheadIndex,
  typeaheadLabel,
} from '../../lib/menuKeyboard'

/**
 * What a submenu needs from the menu it opened from: how to close the whole
 * menu (Tab closes every level, not just the innermost).
 */
export const MenuTreeContext = createContext<{ closeAll?: () => void }>({})

/**
 * Focus lifecycle of a menu surface (#289). On open, focus moves to the first
 * item, unless something inside (a filter field) already took it. On close,
 * focus goes back to the element that had it before, when the menu still held
 * it — never stolen from a surface that took it since, and never put on an
 * opener that is gone, disabled or hidden. Same rules as `useDialogFocus`.
 */
export function useMenuFocus(
  surfaceRef: RefObject<HTMLElement | null>,
  { autoFocus = true, restoreFocus = true }: { autoFocus?: boolean; restoreFocus?: boolean } = {},
) {
  const openerRef = useRef(typeof document === 'undefined' ? null : document.activeElement)
  // Read once, at open: whether this menu takes focus is decided by how it was
  // opened, not by later renders.
  const autoFocusRef = useRef(autoFocus)
  const restoreFocusRef = useRef(restoreFocus)
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    if (autoFocusRef.current && !surface.contains(document.activeElement)) {
      if (!focusMenuEdge(surface, 'first')) surface.focus({ preventScroll: true })
    }
    if (!restoreFocusRef.current) return
    return () => {
      const active = document.activeElement
      const owned =
        !active || active === document.body || !active.isConnected || surface.contains(active) || focusInMenu(active)
      const opener = openerRef.current
      queueMicrotask(() => {
        if (surface.isConnected || !owned) return
        // Focus that another surface took meanwhile stays where it is; only
        // focus that fell with the removed menu goes back.
        const now = document.activeElement
        if (now && now !== document.body && now.isConnected) return
        if (!(opener instanceof HTMLElement) || !opener.isConnected || opener.matches(':disabled')) return
        if (opener.closest('[hidden], [inert], [aria-hidden="true"]')) return
        opener.focus({ preventScroll: true })
      })
    }
  }, [surfaceRef])
}

/**
 * Keyboard handler for an element with `role="menu"`: arrows, Home/End,
 * typeahead, submenu open/close (mirrored in right-to-left) and Tab. Keys it
 * handles stop there, so neither an enclosing list's arrow navigation nor the
 * app's single-key shortcuts act on them. Escape is left to the shared Escape
 * stack (`useEscapeKey`), which closes only the innermost menu.
 */
export function useMenuKeys({
  submenu = false,
  onCloseSubmenu,
  closeMenu,
  orientation = 'vertical',
}: {
  /** This menu was opened from an item of another one. */
  submenu?: boolean
  /** Closes this submenu (the arrow towards the start of the line). */
  onCloseSubmenu?: () => void
  /** Closes the whole menu (Tab). */
  closeMenu?: () => void
  /** A row of items (swatches) moves with the horizontal arrows. */
  orientation?: 'vertical' | 'horizontal'
}) {
  const typeahead = useRef({ query: '', at: 0 })
  return (event: KeyboardEvent<HTMLElement>) => {
    const menu = event.currentTarget
    const target = event.target
    // Keys from a submenu bubble here through the React tree (it is portaled
    // elsewhere in the DOM); that menu has already handled its own.
    if (!(target instanceof Element) || target.closest('[role="menu"]') !== menu) return
    const now = Date.now()
    const typing = typeahead.current.query !== '' && now - typeahead.current.at < TYPEAHEAD_RESET_MS
    const action = menuKeyAction(event, { direction: elementDirection(menu), submenu, typing, orientation })
    if (!action) return
    const items = menuItemsOf(menu)
    const current = target.closest<HTMLElement>(MENU_ITEM_SELECTOR)
    const index = current ? items.indexOf(current) : -1
    event.stopPropagation()
    // Any key but a typed character ends a typeahead search: Space after an
    // arrow activates the item again.
    if (action.kind !== 'typeahead') typeahead.current = { query: '', at: 0 }
    switch (action.kind) {
      case 'swallow':
        // Enter and Space still activate the focused item natively.
        if (event.key.startsWith('Arrow')) event.preventDefault()
        return
      case 'close':
        // Tab keeps its default: focus returns to the opener as the menu
        // closes, and moves on from there.
        closeMenu?.()
        return
      case 'move': {
        event.preventDefault()
        const next = movedIndex(action.to, index, items.length)
        if (next !== null) focusMenuItem(items[next])
        return
      }
      case 'open-submenu': {
        event.preventDefault()
        if (!current || current.getAttribute('aria-haspopup') !== 'menu') return
        if (current.getAttribute('aria-disabled') === 'true') return
        const panelId = current.getAttribute('aria-controls')
        const panel = panelId ? document.getElementById(panelId) : null
        // Already open from a hover: go into it. Otherwise open it the way
        // Enter does (a click with no pointer behind it focuses its first item).
        if (current.getAttribute('aria-expanded') === 'true' && panel) focusMenuEdge(panel, 'first')
        else current.click()
        return
      }
      case 'close-submenu':
        event.preventDefault()
        onCloseSubmenu?.()
        return
      case 'typeahead': {
        event.preventDefault()
        // Space only reaches here inside a search under way, so a query
        // never starts with one.
        const query = (typing ? typeahead.current.query : '') + action.char.toLocaleLowerCase()
        typeahead.current = { query, at: now }
        const labels = items.map((item) => typeaheadLabel(item.textContent))
        const found = typeaheadIndex(labels, index, query)
        if (found >= 0) focusMenuItem(items[found])
        return
      }
    }
  }
}

/** Tab closes every level: a submenu reaches the root's close through context. */
export function useCloseAll(onClose: (() => void) | undefined, submenu: boolean) {
  const tree = useContext(MenuTreeContext)
  return submenu ? tree.closeAll : onClose
}
