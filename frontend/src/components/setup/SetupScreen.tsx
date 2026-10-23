import { AccountDialog } from '../dialog/AccountDialog'

/**
 * What the window shows before the first account (#343, owner decision 2):
 * the account setup, in <main> as the `content` region, under the band of
 * the frame (`AppFrame` with `setup`). F6 goes from the band to the setup and
 * back. The app menu holds what needs no account (the settings, the themes,
 * the palette, the shortcuts and About), and the dialogs those open are the
 * window's own.
 */
export function SetupScreen() {
  return (
    <div className="min-h-0 flex-1">
      <main
        data-region="content"
        className="flex h-full w-full justify-center overflow-y-auto bg-app px-6 py-10 text-primary"
      >
        <AccountDialog variant="setup" />
      </main>
    </div>
  )
}
