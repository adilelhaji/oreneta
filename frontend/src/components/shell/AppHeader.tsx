import { useState } from 'react'
import { useTranslation } from '../../lib/i18n'
import { QuietIndicator } from '../sidenav/QuietIndicator'
import { AppMenuButton } from './AppMenu'
import { BandSearch } from './BandSearch'
import { SyncStatus } from './SyncStatus'

/**
 * The window's header (ADR-0068 §1 and §2): the `banner` landmark «Oreneta»,
 * inside the window, under the native title bar (and `MacTitleBar` on macOS)
 * and above the notices.
 *
 * Its first row is the top band, 2.25 rem tall so it grows with the app's
 * zoom, in today's frame tone (`--me-bg-header`) until #287 adds the «marc»
 * one. The app menu sits at its start and the search field, scoped to the
 * module on screen, at its centre (#344); its end holds the do-not-disturb
 * indicator and the sync status (#345). The band is the first region F6
 * reaches, `search`, and Tab goes through it from start to end. The main
 * toolbar (§3) becomes the second row once the piece 8 primitive exists.
 *
 * On the first-account setup screen (`setup`) there is no module to search
 * and no account to sync or be notified about, so the band has neither the
 * search field nor its end: as in the app menu, what needs an account is
 * left out rather than shown disabled (#343, #344, #345).
 */
export function AppHeader({ setup = false }: { setup?: boolean }) {
  const { t } = useTranslation()
  // Below 769 px the search opens over the band and covers the rest of it,
  // which then takes neither the focus nor the pointer. At the end only the
  // controls go inert: the live regions there keep announcing (#345).
  const [covered, setCovered] = useState(false)
  const inert = covered && !setup
  return (
    <header aria-label={t('shell.region.banner')} className="shrink-0">
      <div
        data-region="search"
        data-top-band
        className="relative flex h-9 items-center gap-2 border-b border-border bg-header px-1 text-primary"
      >
        <div data-band-start inert={inert} className="flex shrink-0 items-center">
          <AppMenuButton />
        </div>
        <div data-band-centre className="flex min-w-0 flex-1 items-center justify-center">
          {!setup && <BandSearch onCover={setCovered} />}
        </div>
        {/* At most 35 % of the band, so the search keeps its room: the
            summary is cut short with «…», its whole text still the button's
            name and tooltip. Nothing on the setup screen. */}
        <div data-band-end className="flex min-w-0 max-w-[35%] shrink-0 items-center gap-1">
          {!setup && (
            <>
              <QuietIndicator inert={inert} />
              <SyncStatus inert={inert} />
            </>
          )}
        </div>
      </div>
    </header>
  )
}
