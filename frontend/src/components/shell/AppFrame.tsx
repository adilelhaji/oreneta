import type { ReactNode } from 'react'
import { ErrorBoundary } from '../ErrorBoundary'
import { MacTitleBar } from '../titlebar/MacTitleBar'
import { AppHeader } from './AppHeader'
import { AppLayers } from './AppLayers'

/**
 * The window's frame (ADR-0068 §1): the title bar, the header with the top
 * band, then what the window shows, and the layers (dialogs, toasts,
 * confirmations). What it shows is the first-account setup (`setup`) or the
 * notices and the module (#343).
 *
 * The frame stays mounted when the first account arrives. A dialog open over
 * the setup, such as Settings after a backup restored an account, stays open
 * with its focus, and gives the focus back to its opener, the app menu button,
 * when it closes.
 */
export function AppFrame({ setup = false, children }: { setup?: boolean; children: ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col bg-app text-primary">
      <MacTitleBar />
      {/* Title bar, header, notices, then the rest (ADR-0068 §1): the header's
          first row is the top band with the app menu (§2). */}
      <ErrorBoundary label="top band">
        <AppHeader />
      </ErrorBoundary>
      {children}
      {/* Dialogs, toasts and confirmations are siblings of the regions, not
          part of the module in <main> (ADR-0068 §1). */}
      <AppLayers setup={setup} />
    </div>
  )
}
