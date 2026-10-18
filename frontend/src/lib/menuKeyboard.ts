// Keyboard model of a popup menu (WAI-ARIA menu pattern, #289). Pure logic
// and DOM lookups only; components/menu/useMenuSurface.ts wires it to a menu.
//
// Up and Down move through the items and wrap, Home and End go to the ends,
// a printable character jumps to the next item whose label starts with what
// was typed, and the horizontal arrow towards the end of the line opens a
// submenu while the one towards its start closes it: Right and Left in
// left-to-right, the other way round in right-to-left (ADR-0061).

import { inlineArrowStep, type TextDirection } from './direction'

/** The roles a menu's actionable rows carry. */
export const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'

/** Marks every menu surface, so focus inside any open menu is recognised. */
export const MENU_SURFACE_ATTRIBUTE = 'data-menu-surface'

/** How long typed characters keep adding to one typeahead search. */
export const TYPEAHEAD_RESET_MS = 500

export type MenuKeyAction =
  | { kind: 'move'; to: 'next' | 'previous' | 'first' | 'last' }
  | { kind: 'open-submenu' }
  | { kind: 'close-submenu' }
  | { kind: 'close' }
  | { kind: 'typeahead'; char: string }
  /** A key the menu swallows without acting (a stray letter, Enter or Space
   * left to the button), so the app's single-key shortcuts never see it. */
  | { kind: 'swallow' }

export type MenuKeyInput = {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

function isPrintable(key: string): boolean {
  return Array.from(key).length === 1
}

/**
 * What a key does in a menu. `typing` is true while a typeahead search is
 * under way: Space then adds to it instead of activating the item. Null for
 * keys the menu leaves alone (chords, function keys, Escape — which the
 * shared Escape stack handles so only the innermost layer closes).
 *
 * A horizontal menu (a row of colour swatches) moves with the horizontal
 * arrows in reading order instead, and has no submenus.
 */
export function menuKeyAction(
  event: MenuKeyInput,
  {
    direction,
    submenu,
    typing,
    orientation = 'vertical',
  }: { direction: TextDirection; submenu: boolean; typing: boolean; orientation?: 'vertical' | 'horizontal' },
): MenuKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  if (orientation === 'horizontal') {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') return { kind: 'swallow' }
    const step = inlineArrowStep(event.key, direction)
    if (step !== 0) return { kind: 'move', to: step > 0 ? 'next' : 'previous' }
  }
  switch (event.key) {
    case 'ArrowDown':
      return { kind: 'move', to: 'next' }
    case 'ArrowUp':
      return { kind: 'move', to: 'previous' }
    case 'Home':
      return { kind: 'move', to: 'first' }
    case 'End':
      return { kind: 'move', to: 'last' }
    case 'Tab':
      return { kind: 'close' }
    case 'Enter':
      return { kind: 'swallow' }
    case 'ArrowRight':
    case 'ArrowLeft': {
      const step = inlineArrowStep(event.key, direction)
      if (step > 0) return { kind: 'open-submenu' }
      return submenu ? { kind: 'close-submenu' } : { kind: 'swallow' }
    }
  }
  if (event.key === ' ') return typing ? { kind: 'typeahead', char: ' ' } : { kind: 'swallow' }
  if (isPrintable(event.key)) return { kind: 'typeahead', char: event.key }
  return null
}

/** The index a move goes to among `count` items, wrapping at both ends. */
export function movedIndex(to: 'next' | 'previous' | 'first' | 'last', index: number, count: number): number | null {
  if (count <= 0) return null
  if (to === 'first') return 0
  if (to === 'last') return count - 1
  if (index < 0) return to === 'next' ? 0 : count - 1
  return (index + (to === 'next' ? 1 : -1) + count) % count
}

/** Lower-cased, trimmed text a typeahead search compares against. */
export function typeaheadLabel(text: string | null | undefined): string {
  return (text ?? '').trim().toLocaleLowerCase()
}

/**
 * The item a typeahead `query` lands on, or -1. One character, or the same
 * character typed again and again, moves to the next item starting with it
 * and cycles through them; a longer query keeps the current item while it
 * still matches. `labels` are already {@link typeaheadLabel}-normalised.
 */
export function typeaheadIndex(labels: string[], current: number, query: string): number {
  const count = labels.length
  if (count === 0 || query === '') return -1
  const chars = Array.from(query)
  const repeated = chars.every((char) => char === chars[0])
  const needle = repeated ? chars[0] : query
  const start = repeated ? current + 1 : Math.max(current, 0)
  for (let offset = 0; offset < count; offset += 1) {
    const index = (((start + offset) % count) + count) % count
    if (labels[index].startsWith(needle)) return index
  }
  return -1
}

/** Shown, as far as style goes: not under `display: none` or `hidden` up to the menu. */
function shown(element: HTMLElement, menu: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node && node !== menu; node = node.parentElement) {
    if (node.hidden) return false
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

/**
 * The items of `menu` itself, in document order: not those of a menu nested
 * inside it, nor rows hidden by a responsive class (the kanban board menu
 * hides its filters on wide windows).
 */
export function menuItemsOf(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)].filter(
    (item) => item.closest('[role="menu"]') === menu && shown(item, menu),
  )
}

/** The menu in `surface`: the surface itself, or the first menu inside it. */
export function menuWithin(surface: HTMLElement): HTMLElement | null {
  if (surface.getAttribute('role') === 'menu') return surface
  return surface.querySelector<HTMLElement>('[role="menu"]')
}

/**
 * Focuses a menu item and brings it into view inside a scrolling menu (a long
 * folder list) by scrolling that menu only, never the page: a page scroll
 * would read as a scroll outside the menu, which closes it.
 */
export function focusMenuItem(item: HTMLElement) {
  item.focus({ preventScroll: true })
  const menu = item.closest<HTMLElement>('[role="menu"]')
  if (!menu || menu.scrollHeight <= menu.clientHeight) return
  const row = item.getBoundingClientRect()
  const box = menu.getBoundingClientRect()
  if (row.top < box.top) menu.scrollTop -= box.top - row.top
  else if (row.bottom > box.bottom) menu.scrollTop += row.bottom - box.bottom
}

/** Focuses the first or last item of the menu in `surface`. False when it has none. */
export function focusMenuEdge(surface: HTMLElement | null, edge: 'first' | 'last' = 'first'): boolean {
  const menu = surface && menuWithin(surface)
  if (!menu) return false
  const items = menuItemsOf(menu)
  const item = edge === 'first' ? items[0] : items[items.length - 1]
  if (!item) return false
  focusMenuItem(item)
  return true
}

const TABBABLE_SELECTOR =
  'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable=""], [contenteditable="true"]'

function tabbable(element: HTMLElement): boolean {
  if (element.tabIndex < 0 || (element as HTMLButtonElement).disabled) return false
  if (element instanceof HTMLInputElement && element.type === 'hidden') return false
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

/**
 * The element Tab (step 1) or Shift+Tab (step -1) moves to from `from`, in
 * document order, or null at either end. A menu that closes on Tab moves
 * from its opener, not from where the removed menu was (#289).
 */
export function tabNeighbour(from: HTMLElement, step: 1 | -1): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)]
  const index = all.indexOf(from)
  if (index === -1) return null
  for (let next = index + step; next >= 0 && next < all.length; next += step) {
    if (tabbable(all[next])) return all[next]
  }
  return null
}

/**
 * The name a typeahead search compares against: what assistive technology
 * announces — `aria-labelledby`, then `aria-label`, then the text — so an
 * icon-only item (a colour swatch, "Forget") is reached by typing its name.
 */
export function itemName(item: HTMLElement): string {
  const ids = item.getAttribute('aria-labelledby')
  if (ids) {
    const text = ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim()
    if (text) return text
  }
  return item.getAttribute('aria-label')?.trim() || item.textContent || ''
}

/** True when focus sits in some open menu surface (any menu, any depth). */
export function focusInMenu(active: Element | null): boolean {
  return Boolean(active?.closest?.(`[${MENU_SURFACE_ATTRIBUTE}]`))
}
