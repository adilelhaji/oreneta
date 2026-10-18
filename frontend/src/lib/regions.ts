// The regions of the window and the keyboard path between them (ADR-0068 §6).
//
// An element marked `data-region="<kind>"` is a region. F6 goes to the next
// region on screen and Shift+F6 to the previous one, in the order below, which
// is the same in right to left: it is the order of the frame, not a side of the
// window. A region can sit inside another (a module's own left column inside
// the module): the focus belongs to the innermost one.

/** The kinds of region, in F6 order. The band search and the toolbar arrive with their steps. */
export const REGION_ORDER = ['search', 'toolbar', 'folders', 'modules', 'content', 'reader', 'sidebar'] as const

export type RegionKind = (typeof REGION_ORDER)[number]

const REGION_SELECTOR = '[data-region]'

// What Tab can reach, before visibility and inertness are checked. Also where
// a menu closed by Tab moves on from its opener (lib/menuKeyboard.ts, #289).
export const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]',
].join(', ')

/** Whether an element is drawn. The browser answers; a test can say it itself. */
export type VisibilityCheck = (element: HTMLElement) => boolean

export function isShown(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  // `visibility` is inherited, so the element's own computed value says it.
  if (getComputedStyle(element).visibility === 'hidden') return false
  if (typeof element.checkVisibility === 'function') return element.checkVisibility()
  return element.getClientRects().length > 0
}

/** The kind a region declares. An unknown one is a programming error, not a region to skip. */
export function regionKind(region: HTMLElement): RegionKind {
  const kind = region.dataset.region as RegionKind
  if (!REGION_ORDER.includes(kind)) throw new Error(`Unknown region kind "${region.dataset.region}"`)
  return kind
}

/** The innermost region an element is in, or null outside every region. */
export function regionOf(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>(REGION_SELECTOR) ?? null
}

/** The regions on screen, in F6 order; regions of one kind keep the order of the document. */
export function visibleRegions(root: ParentNode = document, shown: VisibilityCheck = isShown): HTMLElement[] {
  const regions = [...root.querySelectorAll<HTMLElement>(REGION_SELECTOR)]
  return regions
    .map((region, index) => ({ region, index, rank: REGION_ORDER.indexOf(regionKind(region)) }))
    .filter(({ region }) => shown(region))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ region }) => region)
}

// The element that last had the focus in each region. Weak, so a region that
// leaves the page takes its entry with it.
const lastFocused = new WeakMap<HTMLElement, HTMLElement>()

function rememberFocus(event: FocusEvent) {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const region = regionOf(target)
  if (region) lastFocused.set(region, target)
}

/** Remembers, per region, where the focus was. Returns the function that stops it. */
export function trackRegionFocus(target: Document = document): () => void {
  target.addEventListener('focusin', rememberFocus)
  return () => target.removeEventListener('focusin', rememberFocus)
}

function canTakeFocus(element: HTMLElement, region: HTMLElement, shown: VisibilityCheck): boolean {
  if (!element.isConnected || regionOf(element) !== region) return false
  if (element.matches(':disabled')) return false
  return shown(element)
}

/**
 * Where the focus goes in a region: the element that last had it there, if it
 * still can, or else the first one Tab reaches. Elements of a region nested in
 * this one belong to that one. Null when nothing in it can take the focus.
 */
export function focusTargetIn(region: HTMLElement, shown: VisibilityCheck = isShown): HTMLElement | null {
  const remembered = lastFocused.get(region)
  if (remembered && canTakeFocus(remembered, region, shown)) return remembered
  for (const element of region.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (element.getAttribute('tabindex') === '-1') continue
    if (canTakeFocus(element, region, shown)) return element
  }
  return null
}

/**
 * Moves the focus to the next region on screen (`1`) or the previous one
 * (`-1`), wrapping round, and skipping regions where nothing can take the
 * focus. From outside every region, F6 goes to the first one and Shift+F6 to
 * the last. Returns the region reached, or null when there is none.
 */
export function focusAdjacentRegion(
  step: 1 | -1,
  root: Document = document,
  shown: VisibilityCheck = isShown,
): HTMLElement | null {
  const regions = visibleRegions(root, shown)
  if (regions.length === 0) return null
  const current = regionOf(root.activeElement)
  const at = current ? regions.indexOf(current) : -1
  const start = at === -1 ? (step === 1 ? -1 : regions.length) : at
  for (let moved = 1; moved <= regions.length; moved++) {
    const region = regions[(((start + step * moved) % regions.length) + regions.length) % regions.length]
    const target = focusTargetIn(region, shown)
    if (!target) continue
    target.focus()
    // A focus the browser refused (an element it does not draw) is no stop.
    if (root.activeElement === target) return region
  }
  return null
}

/** Whether a modal dialog is open: it keeps the focus, so F6 does nothing (ADR-0068 §6). */
export function modalDialogOpen(root: ParentNode = document): boolean {
  return !!root.querySelector('[aria-modal="true"]')
}
