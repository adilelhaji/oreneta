import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { flyoutX } from '../../lib/direction'
import { focusMenuEdge } from '../../lib/menuKeyboard'
import { FloatingContextMenu } from './FloatingContextMenu'
import { MenuItem } from './MenuItem'

const GAP_PX = 4

/**
 * A menu row that opens a submenu beside it (#289): "Move to", "Copy to".
 *
 * Hovering opens it without moving focus; Enter, Space or the arrow towards
 * the end of the line (Right, Left in right-to-left) open it and focus its
 * first item. The arrow back, or Escape, closes it and returns focus to this
 * row. A pointer click toggles it.
 */
export function SubmenuItem({
  icon,
  label,
  disabled,
  width = 190,
  panelClassName = 'fixed z-[51] max-h-[calc(100vh-1rem)] min-w-[190px] overflow-y-auto rounded-control border border-border bg-chats p-1 shadow-overlay animate-fade-in',
  dataAttribute,
  onOpenChange,
  children,
}: {
  icon?: ReactNode
  label: ReactNode
  disabled?: boolean
  /** Expected width of the submenu, to choose the side it opens on. */
  width?: number
  panelClassName?: string
  /** Marks the panel like its root menu, for outside-click containment. */
  dataAttribute?: string
  /** Told when it opens and closes (to load what it lists). */
  onOpenChange?: (open: boolean) => void
  /** Rendered only while open. */
  children: ReactNode
}) {
  const triggerId = useId()
  const panelId = useId()
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [focusFirst, setFocusFirst] = useState(false)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  useEffect(() => {
    onOpenChangeRef.current?.(open)
    // Closed with the menu around it (an item picked, Escape): say so too, or
    // a caller keeping the state would think it still open next time.
    return () => {
      if (open) onOpenChangeRef.current?.(false)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const anchor = anchorRef.current
    if (!anchor) return
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const x = flyoutX(rect, width, GAP_PX, window.innerWidth)
      setPosition((current) => (current?.x === x && current.y === rect.top ? current : { x, y: rect.top }))
    }
    place()
    // The menu it is a row of can scroll (a tall menu in a short window,
    // #347): the submenu follows its row.
    const menu = anchor.parentElement?.closest<HTMLElement>('[role="menu"]')
    menu?.addEventListener('scroll', place)
    return () => menu?.removeEventListener('scroll', place)
  }, [open, width])

  const show = (byKeyboard: boolean) => {
    // Already open: a pointer arriving must not reopen (and refocus) it.
    if (disabled || open) return
    setFocusFirst(byKeyboard)
    setOpen(true)
  }

  return (
    <div ref={anchorRef} role="none" onMouseEnter={() => show(false)} onMouseLeave={() => setOpen(false)}>
      <MenuItem
        id={triggerId}
        icon={icon}
        label={label}
        disabled={disabled}
        submenu={{ expanded: open, controls: panelId }}
        trailing={<ChevronRight size={14} className="text-secondary" strokeWidth={1.75} />}
        onClick={(event) => {
          // A click without a pointer behind it (Enter, Space, the arrow key)
          // opens the submenu and goes into it.
          const byKeyboard = event.detail === 0
          if (!byKeyboard) {
            if (open) setOpen(false)
            else show(false)
            return
          }
          if (open) focusMenuEdge(document.getElementById(panelId), 'first')
          else show(true)
        }}
      />
      {open && position && (
        <FloatingContextMenu
          // Remounted per opening, so how it was opened decides its focus.
          key={focusFirst ? 'keyboard' : 'pointer'}
          id={panelId}
          x={position.x}
          y={position.y}
          labelledBy={triggerId}
          submenu
          autoFocus={focusFirst}
          onClose={() => setOpen(false)}
          className={panelClassName}
          dataAttribute={dataAttribute}
        >
          {children}
        </FloatingContextMenu>
      )}
    </div>
  )
}
