// Writing direction of the interface (ADR-0061). The interface language sets
// the document direction; user content (subjects, names, addresses, bodies)
// keeps its own through dir="auto". Layout uses logical utilities and CSS
// logical properties, so only the code that works in physical pixels or keys
// (pointer drags, arrow keys, menus placed from a rect) asks which way the
// line runs.

export type TextDirection = 'ltr' | 'rtl'

// Languages written right to left, by primary subtag. A fixed list rather than
// Intl.Locale text info: WebKitGTK and Bun do not all expose it, and the same
// answer everywhere is worth more than a lookup.
const RTL_LANGUAGES = new Set(['ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'iw', 'ks', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi'])

/** Direction of a language code ("ar", "he-IL", "pt_BR", "zh_Hant"). */
export function languageDirection(language?: string | null): TextDirection {
  if (!language) return 'ltr'
  const primary = language.replace(/_/g, '-').split('-')[0].toLowerCase()
  return RTL_LANGUAGES.has(primary) ? 'rtl' : 'ltr'
}

/** Direction the document runs in, from `<html dir>`. */
export function documentDirection(): TextDirection {
  if (typeof document === 'undefined') return 'ltr'
  return document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr'
}

/**
 * Direction an element is laid out in: its computed `direction`, or the
 * nearest explicit `dir` above it (environments without a full style engine
 * do not derive `direction` from the attribute).
 */
export function elementDirection(element: Element | null | undefined): TextDirection {
  if (!element) return documentDirection()
  if (getComputedStyle(element).direction === 'rtl') return 'rtl'
  return element.closest('[dir="rtl"], [dir="ltr"]')?.getAttribute('dir') === 'rtl' ? 'rtl' : 'ltr'
}

/**
 * A horizontal arrow key as a step in reading order: +1 towards the end of
 * the line (next), -1 towards its start (previous). In right-to-left the
 * right arrow goes back. Any other key is 0.
 */
export function inlineArrowStep(key: string, direction: TextDirection): -1 | 0 | 1 {
  if (key !== 'ArrowRight' && key !== 'ArrowLeft') return 0
  const towardsRight = key === 'ArrowRight'
  return towardsRight === (direction === 'ltr') ? 1 : -1
}

/**
 * The index a key moves to in a group of `count` items (tabs, radio-style
 * pickers): horizontal arrows in reading order, vertical arrows top to
 * bottom, Home and End to the ends, wrapping at both. Null for other keys.
 */
export function groupIndexForKey(
  key: string,
  index: number,
  count: number,
  direction: TextDirection,
  orientation: 'horizontal' | 'vertical' | 'both' = 'both',
): number | null {
  if (count <= 0) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  let step = 0
  if (orientation !== 'vertical') step = inlineArrowStep(key, direction)
  if (step === 0 && orientation !== 'horizontal') {
    if (key === 'ArrowDown') step = 1
    else if (key === 'ArrowUp') step = -1
  }
  if (step === 0) return null
  const from = index < 0 ? (step > 0 ? -1 : count) : index
  return (from + step + count) % count
}

/**
 * Keyboard for a group whose items are found by `selector` inside the element
 * the handler sits on: arrows (in reading order), Home and End move focus and
 * pick the item, the way a tab list or a radio group behaves.
 */
export function handleGroupArrowKeys(
  event: {
    key: string
    currentTarget: HTMLElement
    target: EventTarget | null
    altKey?: boolean
    ctrlKey?: boolean
    metaKey?: boolean
    preventDefault: () => void
  },
  selector: string,
  orientation: 'horizontal' | 'vertical' | 'both' = 'both',
): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(selector)].filter(
    (item) => !(item as HTMLButtonElement).disabled,
  )
  const current = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null
  const next = groupIndexForKey(
    event.key,
    current ? items.indexOf(current) : -1,
    items.length,
    elementDirection(event.currentTarget),
    orientation,
  )
  if (next === null) return false
  event.preventDefault()
  const item = items[next]
  item.focus()
  item.click()
  return true
}

// Menus and popovers are placed from an anchor x: the point their inline-start
// edge goes to. In left-to-right they extend rightwards from it, in
// right-to-left leftwards (FloatingContextMenu). A right click passes the
// pointer; a button passes one of the points below.

type HorizontalRect = { left: number; right: number }

/** Anchor for a dropdown that starts at the button's start edge. */
export function startEdgeX(rect: HorizontalRect, direction: TextDirection = documentDirection()): number {
  return direction === 'rtl' ? rect.right : rect.left
}

/**
 * Anchor for a dropdown `width` wide whose end edge lines up with the
 * button's end edge (toolbar overflow menus).
 */
export function endAlignedX(rect: HorizontalRect, width: number, direction: TextDirection = documentDirection()): number {
  return direction === 'rtl' ? rect.left + width : rect.right - width
}

/** Anchor for a popover that opens beside the button, past its end edge. */
export function besideEndX(rect: HorizontalRect, gap: number, direction: TextDirection = documentDirection()): number {
  return direction === 'rtl' ? rect.left - gap : rect.right + gap
}

/**
 * Anchor for a submenu `width` wide beside its row: past the row's end edge
 * when it fits in the viewport, otherwise past its start edge.
 */
export function flyoutX(
  rect: HorizontalRect,
  width: number,
  gap: number,
  viewportWidth: number,
  direction: TextDirection = documentDirection(),
): number {
  if (direction === 'rtl') {
    // The anchor is the menu's start (right) edge: past the row's left edge,
    // or, without room there, a whole menu width past its right edge.
    return rect.left - gap - width < 0 ? rect.right + gap + width : rect.left - gap
  }
  return rect.right + gap + width > viewportWidth ? rect.left - width - gap : rect.right + gap
}

/**
 * The CSS `left` of a menu `width` wide whose inline-start edge goes to `x`,
 * kept `margin` px inside a viewport `viewportWidth` wide.
 */
export function menuLeft(
  x: number,
  width: number,
  viewportWidth: number,
  margin: number,
  direction: TextDirection = documentDirection(),
): number {
  const desired = direction === 'rtl' ? x - width : x
  return Math.max(margin, Math.min(desired, viewportWidth - width - margin))
}

/**
 * A message shown in its own frame keeps its own direction. One that declares
 * `dir` on <html> or <body> is left alone (a left-to-right message is never
 * turned around, nor the reverse); one that declares nothing gets
 * `dir="auto"` on its body, so an Arabic message reads right to left and a
 * Latin one left to right whatever the interface language.
 */
export function applyContentDirection(doc: Document) {
  const body = doc.body
  if (!body) return
  if (doc.documentElement.hasAttribute('dir') || body.hasAttribute('dir')) return
  body.setAttribute('dir', 'auto')
}
