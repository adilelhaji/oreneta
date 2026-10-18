import type { ReactNode } from 'react'
import { FloatingContextMenu } from '../menu/FloatingContextMenu'

// Side navigation rail menu rows are just the shared MenuItem; re-exported under the
// rail's local name so existing call sites keep importing from here.
export { MenuItem as RailMenuItem } from '../menu/MenuItem'

// Shared popover shell for the side navigation rail's right-click menus: a full-screen
// click-catcher plus a menu positioned at the cursor, named after what it acts on.
export function RailContextMenu({
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
