import { useId, useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { MENU_SURFACE_ATTRIBUTE } from '../../lib/menuKeyboard'
import { clsx } from '../../lib/utils'
import { MenuTreeContext, useMenuFocus, useMenuKeys } from './useMenuSurface'

/** A menu is named by a string or by the element that labels it. */
export type MenuName = { label: string; labelledBy?: undefined } | { label?: undefined; labelledBy: string }

/**
 * A `role="menu"` list for a dropdown that positions itself (#289): the
 * send-later, template, label, saved-search and toolbar overflow menus. It
 * brings the menu keyboard, and with `autoFocus` the focus lifecycle (first
 * item on open, back to the trigger on close).
 *
 * Context menus at the pointer use `FloatingContextMenu`, which is a menu
 * itself. A popup that also holds a field (a filter box) puts the field
 * beside a `MenuList`, never inside it: a menu holds only items, groups and
 * separators.
 */
export function MenuList({
  children,
  className,
  style,
  id,
  autoFocus = false,
  restoreFocus = autoFocus,
  onClose,
  describedBy,
  onClick,
  onContextMenu,
  orientation = 'vertical',
  ...name
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
  id?: string
  /** Popup menus take focus when they open; a static one (the design
   * catalogue) leaves focus alone. */
  autoFocus?: boolean
  /** Gives focus back to the element that had it when the menu closes; on by
   * default for menus that take focus. A popup whose filter field takes focus
   * instead sets it without `autoFocus`. */
  restoreFocus?: boolean
  /** Closes the menu (Tab, and the whole tree for its submenus). */
  onClose?: () => void
  describedBy?: string
  onClick?: (event: MouseEvent<HTMLDivElement>) => void
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void
  /** A row of items (colour swatches): the horizontal arrows move, in reading order. */
  orientation?: 'vertical' | 'horizontal'
} & MenuName) {
  const ref = useRef<HTMLDivElement | null>(null)
  const onKeyDown = useMenuKeys({ closeMenu: onClose, orientation })
  useMenuFocus(ref, { autoFocus, restoreFocus })
  return (
    <MenuTreeContext.Provider value={{ closeAll: onClose }}>
      <div
        ref={ref}
        id={id}
        role="menu"
        aria-orientation={orientation}
        aria-label={name.label}
        aria-labelledby={name.labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={clsx('outline-none', className)}
        style={style}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        {...{ [MENU_SURFACE_ATTRIBUTE]: '' }}
      >
        {children}
      </div>
    </MenuTreeContext.Provider>
  )
}

/**
 * Spread on a popup that holds a field beside its `MenuList`: focus in the
 * field counts as focus in the menu, so it goes back to the trigger when the
 * popup closes.
 */
export const menuSurfaceProps = { [MENU_SURFACE_ATTRIBUTE]: '' }

/** A line between groups of items. */
export function MenuSeparator() {
  return <div role="separator" className="my-1 border-t border-border" />
}

/**
 * Items that belong together under a caption: the caption names the group
 * for assistive technology (`aria-labelledby`) instead of being loose text a
 * menu may not hold, and an optional `description` (why a conversation is in
 * a category, say) is read with the group.
 */
export function MenuGroup({
  label,
  description,
  labelClassName = 'px-2 pb-0.5 pt-1.5 text-2xs font-bold uppercase tracking-wide text-secondary',
  descriptionClassName = 'px-2 pb-1 text-2xs leading-snug text-secondary',
  separated = false,
  className,
  children,
}: {
  label: ReactNode
  description?: ReactNode
  labelClassName?: string
  descriptionClassName?: string
  /** Draws a separator above the group. */
  separated?: boolean
  className?: string
  children: ReactNode
}) {
  const labelId = useId()
  const descriptionId = useId()
  return (
    <>
      {separated && <MenuSeparator />}
      <div
        role="group"
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        className={className}
      >
        <div role="none" id={labelId} className={labelClassName}>
          {label}
        </div>
        {description && (
          <div role="none" id={descriptionId} className={descriptionClassName}>
            {description}
          </div>
        )}
        {children}
      </div>
    </>
  )
}
