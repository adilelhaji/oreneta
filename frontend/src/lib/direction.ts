// Writing direction of the interface (ADR-0055). The UI language decides the
// document direction; user content (subjects, names, bodies) keeps its own via
// dir="auto". Layout uses logical utilities (ms/me, ps/pe, start/end,
// border-s/e, rounded-s/e, text-start/end), so only the few places that work in
// physical pixels (pointer drags, arrow keys, menus placed from a rect) need to
// ask which way the document runs.

export type TextDirection = 'ltr' | 'rtl'

// Scripts written right to left, by primary language subtag. Used when the
// engine has no Intl.Locale text info (older WebKitGTK / Bun).
const RTL_LANGUAGES = new Set(['ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'iw', 'ks', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi'])

type LocaleWithTextInfo = Intl.Locale & {
  textInfo?: { direction?: string }
  getTextInfo?: () => { direction?: string }
}

/** Direction of a language code ("ar", "he-IL", "pt_BR", "zh_Hant"). */
export function languageDirection(language?: string | null): TextDirection {
  if (!language) return 'ltr'
  const tag = language.replace(/_/g, '-')
  try {
    const locale = new Intl.Locale(tag) as LocaleWithTextInfo
    const info = typeof locale.getTextInfo === 'function' ? locale.getTextInfo() : locale.textInfo
    if (info?.direction === 'rtl' || info?.direction === 'ltr') return info.direction
  } catch {
    // Not a valid BCP-47 tag: fall back to the list below.
  }
  return RTL_LANGUAGES.has(tag.split('-')[0].toLowerCase()) ? 'rtl' : 'ltr'
}

export const isRtlLanguage = (language?: string | null) => languageDirection(language) === 'rtl'

/** Direction the document currently runs in (from <html dir>). */
export function documentDirection(): TextDirection {
  if (typeof document === 'undefined') return 'ltr'
  return document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr'
}

export const isDocumentRtl = () => documentDirection() === 'rtl'

/**
 * Map a physical horizontal arrow key to a logical step in reading order:
 * +1 = next (towards the end edge), -1 = previous. In RTL the right arrow
 * goes back. Returns 0 for any other key.
 */
export function inlineArrowStep(key: string, direction: TextDirection = documentDirection()): -1 | 0 | 1 {
  const sign = direction === 'rtl' ? -1 : 1
  if (key === 'ArrowRight') return sign as -1 | 1
  if (key === 'ArrowLeft') return -sign as -1 | 1
  return 0
}

// Menus and popovers are positioned from an anchor x: the point where the
// menu's inline-start edge goes. In LTR the menu extends rightwards from it, in
// RTL leftwards (FloatingContextMenu, QuickSettingsMenu). A right click passes
// the pointer; a button passes one of the points below.

type HorizontalRect = { left: number; right: number }

/** Anchor for a dropdown that starts at the button's start edge. */
export function startEdgeX(rect: HorizontalRect, direction: TextDirection = documentDirection()): number {
  return direction === 'rtl' ? rect.right : rect.left
}

/**
 * Anchor for a dropdown of `width` whose end edge lines up with the button's
 * end edge (toolbar overflow menus): its right edge in LTR, left edge in RTL.
 */
export function endAlignedX(
  rect: HorizontalRect,
  width: number,
  direction: TextDirection = documentDirection(),
): number {
  return direction === 'rtl' ? rect.left + width : rect.right - width
}

/** Anchor for a popover opening beside the button on its end side. */
export function besideEndX(rect: HorizontalRect, gap: number, direction: TextDirection = documentDirection()): number {
  return direction === 'rtl' ? rect.left - gap : rect.right + gap
}

/**
 * Anchor for a submenu flyout of `width` beside its row: on the end side when
 * it fits in the viewport, otherwise on the start side.
 */
export function flyoutX(
  rect: HorizontalRect,
  width: number,
  gap: number,
  viewportWidth: number,
  direction: TextDirection = documentDirection(),
): number {
  if (direction === 'rtl') {
    return rect.left - gap - width < 0 ? rect.right + gap + width : rect.left - gap
  }
  return rect.right + gap + width > viewportWidth ? rect.left - width - gap : rect.right + gap
}

/**
 * Left coordinate for a menu of `width` anchored at `x` (its inline-start
 * edge), kept `margin` px inside a viewport `viewportWidth` wide.
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
 * An email shown in a sandboxed frame keeps its own direction: a message that
 * declares `dir` on <html> or <body> is left alone (an LTR email is never forced
 * to RTL, nor the reverse); one that declares nothing gets `dir="auto"` on its
 * body, so an Arabic or Hebrew message reads right to left in any interface.
 */
export function applyContentDirection(doc: Document) {
  const body = doc.body
  if (!body) return
  if (doc.documentElement.hasAttribute('dir') || body.hasAttribute('dir')) return
  body.setAttribute('dir', 'auto')
}
