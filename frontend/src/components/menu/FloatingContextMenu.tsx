import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '../../lib/useEscapeKey'
import { documentDirection, menuLeft } from '../../lib/direction'

const noop = () => {}

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
  onClick,
  onContextMenu,
}: {
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
  onClick?: (event: MouseEvent<HTMLDivElement>) => void
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void
}) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const dataProps = dataAttribute ? { [dataAttribute]: '' } : undefined

  useEscapeKey(onClose ?? noop, Boolean(onClose))

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return

    const { width, height } = el.getBoundingClientRect()
    // `x` is where the menu's inline-start edge goes: it extends rightwards
    // from it in left-to-right and leftwards in right-to-left (ADR-0061).
    const direction = documentDirection()
    const left = menuLeft(direction === 'rtl' ? x - offset : x + offset, width, window.innerWidth, margin, direction)
    const desiredTop = y + offset
    const top = Math.max(margin, Math.min(desiredTop, window.innerHeight - height - margin))

    el.style.left = `${left}px`
    el.style.top = `${top}px`
  })

  const content = (
    <>
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
        className={className}
        style={{ left: x + offset, top: y + offset }}
        onClick={onClick}
        onContextMenu={onContextMenu}
        {...dataProps}
      >
        {children}
      </div>
    </>
  )

  if (typeof document === 'undefined') return content
  return createPortal(content, document.body)
}
