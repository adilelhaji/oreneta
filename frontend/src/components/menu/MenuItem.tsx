import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { clsx } from '../../lib/utils'
import { menuItemBase, menuItemStateClass } from './menuStyles'

export type MenuItemRole = 'menuitem' | 'menuitemcheckbox' | 'menuitemradio'

/**
 * A row in a popup / context menu (#289): leading icon, label, optional
 * trailing slot (chevron, spinner, shortcut). Owns the shared typography,
 * the 28 px row and the menu semantics:
 *
 * - `role` is `menuitem`, or `menuitemcheckbox` / `menuitemradio` with
 *   `checked` for rows that show a state (a filter in force, a chosen
 *   identity). Checkable rows need `checked`; the type insists.
 * - A disabled row stays focusable (`aria-disabled`) so the arrow keys reach
 *   and announce it, and its click does nothing.
 * - `tabIndex` is -1: the menu moves focus between rows itself, and Tab
 *   leaves (and closes) the menu.
 *
 * It must sit inside a `role="menu"` element — `FloatingContextMenu` or
 * `MenuList` — or a group in one.
 */
export function MenuItem({
  icon,
  label,
  onClick,
  danger,
  disabled,
  trailing,
  className,
  title,
  style,
  id,
  describedBy,
  submenu,
  appearance,
  ...semantics
}: {
  icon?: ReactNode
  label: ReactNode
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  danger?: boolean
  disabled?: boolean
  /** Inline-end slot (e.g. a chevron or shortcut hint). */
  trailing?: ReactNode
  /** Extra classes appended to the shared item class. */
  className?: string
  /** Tooltip, e.g. why a disabled row is disabled. */
  title?: string
  style?: CSSProperties
  id?: string
  /** Id of an element that adds context to the name (`aria-describedby`). */
  describedBy?: string
  /** Set on the row that opens a submenu (see `SubmenuItem`). */
  submenu?: { expanded: boolean; controls?: string }
  /** Replaces the state colours and cursor, for rows with their own look (the
   * current folder, a structural tree segment). Layout stays shared. */
  appearance?: string
} & ({ role?: 'menuitem'; checked?: undefined } | { role: 'menuitemcheckbox' | 'menuitemradio'; checked: boolean })) {
  const role: MenuItemRole = semantics.role ?? 'menuitem'
  return (
    <button
      type="button"
      role={role}
      tabIndex={-1}
      id={id}
      aria-checked={role === 'menuitem' ? undefined : semantics.checked}
      aria-disabled={disabled || undefined}
      aria-describedby={describedBy}
      aria-haspopup={submenu ? 'menu' : undefined}
      aria-expanded={submenu ? submenu.expanded : undefined}
      aria-controls={submenu?.expanded ? submenu.controls : undefined}
      onClick={(event) => {
        // Inert like a disabled button: nothing above it hears the click either.
        if (disabled) {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        onClick?.(event)
      }}
      title={title}
      style={style}
      className={clsx(menuItemBase, appearance ?? menuItemStateClass({ danger, disabled }), className)}
    >
      {icon}
      <span className="min-w-0 flex-1 wrap-anywhere text-start">{label}</span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </button>
  )
}
