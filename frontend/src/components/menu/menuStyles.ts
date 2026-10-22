/**
 * Shared class strings for menu rows (#289). Keep typography and layout
 * (13px, normal weight, 28 px rows, padding, hover and keyboard focus) defined
 * here only — rows are `MenuItem`s, which compose these; a row with its own
 * look passes one of the `appearance` strings below.
 *
 * Rows are 28 px (owner decision D9), above the 24 px pointer target of WCAG
 * 2.5.8. Menu items stay focusable when disabled (`aria-disabled`, not the
 * native attribute) so arrow keys still reach and announce them; the colours
 * for that state come from {@link menuItemStateClass}.
 */
const menuItemBase =
  // leading-normal, not leading-none: labels that truncate clip their own
  // descenders when the line box is only as tall as the font size. The row
  // height is pinned by min-h-7 + items-center, so the taller line box costs nothing.
  // The focus ring sits inside the row (index.css, `[role^='menuitem']`).
  'flex min-h-7 w-full items-center gap-2 rounded-control-sm px-2 py-1 text-start text-ui font-normal leading-normal transition-colors duration-(--duration-fast)'

/** Colours and cursor of a row in its state: enabled, disabled, destructive. */
export function menuItemStateClass({ danger = false, disabled = false } = {}): string {
  if (disabled) return `cursor-not-allowed opacity-50 ${danger ? 'text-danger' : 'text-primary'}`
  return danger
    ? 'cursor-pointer text-danger hover:bg-danger-soft focus-visible:bg-danger-soft'
    : 'cursor-pointer text-primary hover:bg-hover focus-visible:bg-hover'
}

/** Base layout/typography of a row; `MenuItem` adds the state colours. */
export { menuItemBase }

/** `appearance` of the checked row of a choice shown in accent text (the reader's view mode, the current folder). */
export const menuItemCurrentClass = 'cursor-pointer font-semibold text-accent-fg hover:bg-hover focus-visible:bg-hover'

/** `appearance` of the checked row of a filter choice: an accent tint behind it. */
export const menuItemSelectedClass = 'cursor-pointer bg-accent/10 text-accent-fg dark:bg-accent/15'
