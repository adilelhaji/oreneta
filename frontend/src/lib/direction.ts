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
  const index = current ? items.indexOf(current) : -1
  const next = groupIndexForKey(event.key, index, items.length, elementDirection(event.currentTarget), orientation)
  if (next === null) return false
  event.preventDefault()
  const item = items[next]
  item.focus()
  // Focus that was not on an item yet only arrives; it picks nothing.
  if (index >= 0) item.click()
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

// Characters whose bidi class is strong right to left (R or AL): the letters
// of the scripts written right to left (Hebrew, Arabic, Syriac, Thaana, NKo,
// Samaritan, Mandaic, and the historic and modern right-to-left scripts of
// the supplementary planes such as Adlam). Letters only: Arabic-Indic
// digits (AN), combining marks (NSM), Arabic punctuation and the byte order
// mark are weak or neutral and skipped, as dir="auto" skips them. Indic,
// Thai and other scripts between them in the code charts are left to right.
const RTL_SCRIPT =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u
const LETTER = /\p{L}/u
// The explicit marks: RIGHT-TO-LEFT MARK and ARABIC LETTER MARK are strong
// right to left, LEFT-TO-RIGHT MARK strong left to right.
const RTL_MARK = /[\u{200F}\u{061C}]/u
const LTR_MARK = /\u{200E}/u

/**
 * The direction of a text's first strong character, as `dir="auto"` decides
 * it: a right-to-left letter makes it 'rtl', any other letter 'ltr'. Digits,
 * punctuation and spaces are not strong; text with none of either is null.
 */
export function firstStrongDirection(text: string): TextDirection | null {
  for (const char of text) {
    if (RTL_MARK.test(char)) return 'rtl'
    if (LTR_MARK.test(char)) return 'ltr'
    if (!LETTER.test(char)) continue
    return RTL_SCRIPT.test(char) ? 'rtl' : 'ltr'
  }
  return null
}

/** The text an element shows itself, without what sits in nested elements. */
function ownText(element: Element): string {
  let text = ''
  for (const node of Array.from(element.childNodes)) if (node.nodeType === 3) text += node.textContent ?? ''
  return text
}

/**
 * The text `dir="auto"` would read in an element: nested elements that set
 * their own direction (a `dir`, a `<bdi>`) do not count.
 */
export function directionalText(element: Element): string {
  let text = ''
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3) text += node.textContent ?? ''
    else if (node.nodeType === 1) {
      const child = node as Element
      if (!child.hasAttribute('dir') && child.tagName !== 'BDI') text += directionalText(child)
    }
  }
  return text
}

// Blocks that carry running text in a message.
const TEXT_BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption'
// Containers that only count when text sits directly in them.
const TEXT_CONTAINERS = 'td, th, div'

/**
 * A message shown in its own frame keeps its own direction. One that declares
 * `dir` on <html> or <body> is left alone (a left-to-right message is never
 * turned around, nor the reverse). In one that declares nothing, each block
 * of text takes the direction of its own first letters (`dir="auto"`), never
 * the body as a whole: a left-to-right newsletter whose first words (often a
 * hidden preheader) are Arabic keeps its layout tables left to right, and a
 * message that mixes paragraphs reads each one in its own direction. Blocks
 * inside an element that already declares `dir` are left as they are.
 */
export function applyContentDirection(doc: Document) {
  const body = doc.body
  if (!body) return
  if (doc.documentElement.hasAttribute('dir') || body.hasAttribute('dir')) return
  // Decided before anything is marked: only the sender's own `dir` counts.
  const candidates = [
    ...Array.from(body.querySelectorAll(TEXT_BLOCKS)),
    ...Array.from(body.querySelectorAll(TEXT_CONTAINERS)).filter((element) => ownText(element).trim() !== ''),
  ].filter((element) => !element.closest('[dir]'))
  for (const element of candidates) element.setAttribute('dir', 'auto')
  // Text written straight into the body, outside any block, has nothing
  // else to carry its direction.
  if (ownText(body).trim() !== '' && !body.querySelector('table')) body.setAttribute('dir', 'auto')
}

/**
 * Outgoing mail declares the direction of its right-to-left blocks (ADR-0061):
 * a paragraph, heading, list or quote whose first strong character is
 * right to left gets `dir="rtl"`, so the receiving client lays it out and
 * punctuates it correctly. Left-to-right blocks get nothing, so mail written
 * in a left-to-right language leaves byte for byte as before. Blocks inside an
 * element that already declares `dir` (a quoted original) are left alone.
 */
export function markRightToLeftBlocks(root: ParentNode) {
  // Only blocks outside a direction the content already declares; decided
  // before anything is marked, so every `dir` met below is one set here.
  const blocks = Array.from(root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, ul, ol, blockquote')).filter(
    (element) => !element.closest('[dir]'),
  )
  for (const element of blocks) {
    const own = firstStrongDirection(directionalText(element))
    const around = element.parentElement?.closest('[dir]')?.getAttribute('dir') === 'rtl' ? 'rtl' : 'ltr'
    // A left-to-right paragraph inside a list or quote marked right to left
    // says so; anywhere else left to right is what a client assumes.
    if (own && own !== around) element.setAttribute('dir', own)
  }
}

/** An arrow pointing forward along the line ("from … to …", "then"). */
export function forwardArrow(direction: TextDirection = documentDirection()): string {
  return direction === 'rtl' ? '←' : '→'
}

/** An arrow pointing back along the line ("back to …"). */
export function backArrow(direction: TextDirection = documentDirection()): string {
  return direction === 'rtl' ? '→' : '←'
}

/** Separator between names in a list, in the interface language's punctuation. */
export function nameSeparator(language?: string | null): string {
  return languageDirection(language) === 'rtl' ? '\u060C ' : ', '
}

/**
 * A list of names as one string for a translated sentence ("to {recipients}").
 * Each name that could reorder its neighbours (a right-to-left name, or any
 * name in a right-to-left interface) is wrapped in FIRST STRONG ISOLATE …
 * POP DIRECTIONAL ISOLATE; a left-to-right list in a left-to-right interface
 * is returned exactly as before.
 */
export function formatNameList(names: string[], language?: string | null): string {
  const rtlInterface = languageDirection(language) === 'rtl'
  return names
    .map((name) => (rtlInterface || firstStrongDirection(name) === 'rtl' ? `\u2068${name}\u2069` : name))
    .join(nameSeparator(language))
}
