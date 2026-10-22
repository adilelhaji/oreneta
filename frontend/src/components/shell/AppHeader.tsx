import { useTranslation } from '../../lib/i18n'
import { AppMenuButton } from './AppMenu'

/**
 * The window's header (ADR-0068 §1 and §2): the `banner` landmark «Oreneta»,
 * inside the window, under the native title bar (and `MacTitleBar` on macOS)
 * and above the notices.
 *
 * Its first row is the top band, 2.25 rem tall so it grows with the app's
 * zoom, in today's frame tone (`--me-bg-header`) until #287 adds the «marc»
 * one. The app menu sits at its start; the centre and the end are laid out
 * for the search (13b, #344) and for the sync status and do-not-disturb
 * (13c, #345). The band is the first region F6 reaches: `search`, the kind
 * its field will give it. The main toolbar (§3) becomes the second row once
 * the piece 8 primitive exists.
 */
export function AppHeader() {
  const { t } = useTranslation()
  return (
    <header aria-label={t('shell.region.banner')} className="shrink-0">
      <div
        data-region="search"
        data-top-band
        className="flex h-9 items-center gap-2 border-b border-border bg-header px-1 text-primary"
      >
        <div data-band-start className="flex shrink-0 items-center">
          <AppMenuButton />
        </div>
        <div data-band-centre className="flex min-w-0 flex-1 items-center justify-center" />
        <div data-band-end className="flex shrink-0 items-center gap-1" />
      </div>
    </header>
  )
}
