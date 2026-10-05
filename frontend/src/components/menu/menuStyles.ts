/**
 * Shared class strings for popover / context-menu item buttons. Keep typography
 * and layout (13px, normal weight, padding, hover) defined here only — individual
 * menus compose these and append their own extras (disabled states, etc.).
 */
const menuItemBase =
  // leading-normal, not leading-none: labels that truncate clip their own
  // descenders when the line box is only as tall as the font size. The row
  // height is pinned by h-8 + items-center, so the taller line box costs nothing.
  'flex min-h-8 w-full items-center gap-2 rounded-control-sm px-2 py-1 text-left text-ui font-normal leading-normal cursor-pointer transition-colors duration-(--duration-fast) disabled:cursor-not-allowed disabled:opacity-50'

/** Standard menu item. */
export const menuItemClass = `${menuItemBase} text-primary enabled:hover:bg-hover`

/** Destructive menu item (delete / trash). */
export const menuItemDangerClass = `${menuItemBase} text-danger enabled:hover:bg-danger-soft`

/** Base layout/typography only — use when an item needs custom color/active states. */
export { menuItemBase }
