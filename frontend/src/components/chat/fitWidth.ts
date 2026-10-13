// "Fit to window" for fixed-width HTML mail (ADR-0046, S01-07). A message laid
// out for a 1200px column is scaled down — with the same body `zoom` the message
// text size uses, multiplied in — until it fits the pane, instead of being
// clipped or given a sideways scroller. Text that reflows is unaffected by the
// width check; only content that cannot shrink drives the factor.

/** Never scale below this share of the reader's chosen text size. */
export const MIN_FIT_FACTOR = 0.4
/** Slack for sub-pixel rounding, so a fitted message is not shrunk again. */
const FIT_EPSILON = 2

/**
 * The next fit factor, given how wide the content renders at the current one.
 * Shrinks only: a message that already fits keeps its factor (the frame resets
 * it when the pane itself changes width).
 */
export function nextFitFactor(current: number, extent: number, limit: number): number {
  if (limit <= 0 || extent <= limit + FIT_EPSILON) return current
  const next = Math.max(MIN_FIT_FACTOR, (current * limit) / extent)
  return Math.abs(next - current) < 0.005 ? current : next
}

const EXTENT_SELECTOR = 'table, img, video, div, p, td, th, center, section, article, pre, blockquote, hr, span'
const MAX_SCANNED = 4000

/**
 * How far right the message's content reaches, in the frame's own coordinates
 * (rects include the body zoom). Content that already scrolls on its own — a
 * code block, a table we gave a scroller — counts at its box, not its content.
 */
export function contentExtent(doc: Document): number {
  const root = doc.documentElement
  const scrollX = doc.defaultView?.scrollX ?? 0
  let extent = 0
  const elements = doc.body?.querySelectorAll<HTMLElement>(EXTENT_SELECTOR) ?? []
  let scanned = 0
  for (const el of elements) {
    if (++scanned > MAX_SCANNED) break
    if (el.parentElement?.closest('pre, .oreneta-table-scroll')) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    extent = Math.max(extent, rect.right + scrollX)
  }
  return Math.max(extent, root?.scrollWidth ?? 0)
}

export interface WidthFitter {
  /** Re-measure and apply; returns whether the zoom changed. */
  update(): boolean
  /** Drop the fit (the option was turned off, or the text size changed). */
  reset(baseZoom?: number): void
  readonly factor: number
}

/**
 * Keeps one frame document fitted to its width. The zoom lands inline on the
 * body, so it outranks the stylesheet zoom the text size sets; `baseZoom` is
 * that text-size zoom, so the two compound rather than fight.
 */
export function createWidthFitter(doc: Document, baseZoom: number): WidthFitter {
  let factor = 1
  let base = baseZoom
  let seenWidth = 0

  const apply = () => {
    const body = doc.body
    if (!body) return
    if (factor === 1) body.style.removeProperty('zoom')
    else body.style.setProperty('zoom', String(+(base * factor).toFixed(4)))
  }

  return {
    get factor() {
      return factor
    },
    update() {
      const limit = doc.documentElement?.clientWidth ?? 0
      if (!limit || !doc.body) return false
      let changed = false
      // A wider (or narrower) pane is a fresh start: measure at full size again.
      if (seenWidth && limit !== seenWidth && factor !== 1) {
        factor = 1
        apply()
        changed = true
      }
      seenWidth = limit
      const next = nextFitFactor(factor, contentExtent(doc), limit)
      if (next !== factor) {
        factor = next
        apply()
        changed = true
      }
      return changed
    },
    reset(nextBase = base) {
      base = nextBase
      seenWidth = 0
      if (factor !== 1) {
        factor = 1
        apply()
      }
    },
  }
}
