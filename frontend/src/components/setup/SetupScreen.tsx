import { ErrorBoundary } from '../ErrorBoundary'
import { AccountDialog } from '../dialog/AccountDialog'
import { AppHeader } from '../shell/AppHeader'
import { AppLayers } from '../shell/AppLayers'
import { MacTitleBar } from '../titlebar/MacTitleBar'

/**
 * The window before the first account (#343, owner decision 2): the title
 * bar, the header with the top band and its app menu, then the account setup
 * as the content. F6 goes from the band to the setup and back. The menu holds
 * what needs no account (the settings, the themes, the palette, the shortcuts
 * and About), and the dialogs those open are the window's own.
 */
export function SetupScreen() {
  return (
    <div className="flex h-full w-full flex-col bg-app text-primary">
      <MacTitleBar />
      <ErrorBoundary label="top band">
        <AppHeader />
      </ErrorBoundary>
      <div className="min-h-0 flex-1">
        <main
          data-region="content"
          className="flex h-full w-full justify-center overflow-y-auto bg-app px-6 py-10 text-primary"
        >
          <AccountDialog variant="setup" />
        </main>
      </div>
      <AppLayers setup />
    </div>
  )
}
