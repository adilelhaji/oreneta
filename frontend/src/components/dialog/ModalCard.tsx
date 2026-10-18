import { useRef, type MouseEventHandler, type ReactNode } from 'react'
import { useDialogFocus } from '../../lib/useDialogFocus'

/**
 * The card of a modal overlay that draws its own backdrop (the event editor and
 * details, the assistant review, the image gallery): a named modal dialog that
 * takes the focus when it opens, unless a control inside already has it, and
 * gives it back to its opener when it closes — the focus lifecycle the shared
 * `Dialog` has. Being `aria-modal`, it also keeps F6 out (ADR-0068 §6).
 */
export function ModalCard({
  label,
  className,
  onClick,
  children,
}: {
  label: string
  className?: string
  onClick?: MouseEventHandler<HTMLDivElement>
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDialogFocus(ref)
  return (
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label} className={className} onClick={onClick}>
      {children}
    </div>
  )
}
