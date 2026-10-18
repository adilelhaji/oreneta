import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { documentDirection, menuLeft } from '../../lib/direction'
import { MENU_SURFACE_ATTRIBUTE } from '../../lib/menuKeyboard'
import type { MenuName } from './Menu'
import { MenuTreeContext, useCloseAll, useMenuFocus, useMenuKeys } from './useMenuSurface'

const noop = () => {}

type BaseProps = {
  x: number
  y: number
  onClose?: () => void
  children: ReactNode
  className: string
  offset?: number
  margin?: number
  overlay?: boolean
  overlayClassName?: string
  dataAttribute?: string
  id?: string
  /** Moves focus to the first item on open (and back on close). Submenus
   * opened by hovering pass false, so the pointer does not move focus. */
  autoFocus?: boolean
  /** Opened from an item of another menu: the arrow towards the start of the
   * line closes it, and Tab closes the menu it came from too. */
  submenu?: boolean
  onClick?: (event: MouseEvent<HTMLDivElement>) => void
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void
}

/**
 * `surface: 'menu'` (the default): the floating card is the `role="menu"`
 * itself, named by `label` or `labelledBy`. `surface: 'popover'`: the card
 * holds a field and a `MenuList` (the folder switcher's filter); the list
 * carries the menu role and name.
 */
type SurfaceProps = ({ surface?: 'menu' } & MenuName) | { surface: 'popover'; label?: undefined; labelledBy?: undefined }

/**
 * A menu placed at a point (the pointer, a button's corner), in a portal
 * (#289): role and name, the menu keyboard, focus into it on open and back on
 * close, Escape through the shared stack (only the innermost menu closes).
 */
export function FloatingContextMenu({
  x,
  y,
  onClose,
  children,
  className,
  offset = 0,
  margin = 8,
  overlay = false,
  overlayClassName = 'fixed inset-0 z-40',
  dataAttribute,
  id,
  autoFocus = true,
  submenu = false,
  onClick,
  onContextMenu,
  ...surfaceProps
}: BaseProps & SurfaceProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const dataProps = dataAttribute ? { [dataAttribute]: '' } : undefined
  const closeAll = useCloseAll(onClose, submenu)
  const onKeyDown = useMenuKeys({ submenu, onCloseSubmenu: submenu ? onClose : undefined, closeMenu: closeAll })
  const isMenu = surfaceProps.surface !== 'popover'

  useEscapeKey(onClose ?? noop, Boolean(onClose))
  useMenuFocus(menuRef, { autoFocus })

  // Placed from the latest props, also when only the menu's content changes
  // size (a row that loads later re-renders that row, not this component).
  const place = useRef<() => void>(() => {})
  place.current = () => {
    const el = menuRef.current
    if (!el) return

    // Measured at the window's left edge first: a menu shrinks to fit the
    // room right of its `left`, so measured near the right edge (where a
    // right-to-left menu is normally opened) its labels would wrap.
    el.style.left = '0px'
    const { width, height } = el.getBoundingClientRect()
    // `x` is where the menu's inline-start edge goes: it extends rightwards
    // from it in left-to-right and leftwards in right-to-left (ADR-0061).
    const direction = documentDirection()
    const left = menuLeft(direction === 'rtl' ? x - offset : x + offset, width, window.innerWidth, margin, direction)
    const desiredTop = y + offset
    const top = Math.max(margin, Math.min(desiredTop, window.innerHeight - height - margin))

    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }

  useLayoutEffect(() => place.current())

  // A menu anchored by its end edge (right to left) must move when it grows.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let last = el.offsetWidth
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth === last) return
      last = el.offsetWidth
      place.current()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const menuProps = isMenu
    ? {
        role: 'menu',
        'aria-orientation': 'vertical' as const,
        'aria-label': surfaceProps.label,
        'aria-labelledby': surfaceProps.labelledBy,
        onKeyDown,
      }
    : undefined

  const content = (
    <MenuTreeContext.Provider value={{ closeAll }}>
      {overlay && onClose && (
        <div
          className={overlayClassName}
          onClick={onClose}
          onContextMenu={(event) => {
            event.preventDefault()
            onClose()
          }}
        />
      )}
      <div
        ref={menuRef}
        id={id}
        tabIndex={-1}
        className={`outline-none ${className}`}
        style={{ left: 0, top: y + offset }}
        onClick={onClick}
        onContextMenu={onContextMenu}
        {...menuProps}
        {...{ [MENU_SURFACE_ATTRIBUTE]: '' }}
        {...dataProps}
      >
        {children}
      </div>
    </MenuTreeContext.Provider>
  )

  if (typeof document === 'undefined') return content
  return createPortal(content, document.body)
}
