import type { ReactNode } from 'react'
import { FloatingContextMenu } from '../menu/FloatingContextMenu'

// The navigation's context-menu rows are just the shared MenuItem; re-exported
// under a local name so the menus of an account, a board, the unified inbox and
// a folder import their shell and their rows from one place.
export { MenuItem as NavMenuItem } from '../menu/MenuItem'

// Shared popover shell for the right-click menus of «Comptes i carpetes»: a
// full-screen click-catcher plus a menu positioned at the cursor (or under a
// row opened from the keyboard), named after what it acts on.
export function NavContextMenu({
  x,
  y,
  label,
  onClose,
  children,
}: {
  x: number
  y: number
  /** Accessible name of the menu: the account, board or folder it is for. */
  label: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <FloatingContextMenu
      x={x}
      y={y}
      offset={4}
      label={label}
      onClose={onClose}
      overlay
      className="fixed z-50 min-w-[176px] rounded-control border border-border bg-chats p-1 shadow-overlay animate-fade-in text-primary"
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {children}
    </FloatingContextMenu>
  )
}
