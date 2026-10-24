import { PanelRight } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { sidebarExpanded, toggleAppSidebar } from '../../states/sidebar'
import { IconButton } from '../button/IconButton'
import { useSidebarShown } from './useSidebarShown'

/**
 * The «Barra lateral» button at the end of the top band (ADR-0069 §2, owner
 * decision 2 on #360), in every module, until the main toolbar exists: it
 * expands the app's sidebar, beside the content where it fits (saved) or as
 * an overlay (not saved), and hides it again, or closes the overlay.
 * `aria-expanded` says whether the sidebar is expanded, either way.
 *
 * `inert` (the band's search covering the band below 769 px) makes it inert,
 * as the band's other controls.
 */
export function SidebarToggle({ inert = false }: { inert?: boolean }) {
  const { t } = useTranslation()
  const expanded = sidebarExpanded(useSidebarShown())
  return (
    <IconButton
      icon={PanelRight}
      size="md"
      radius="lg"
      label={t('sidebar.label')}
      aria-expanded={expanded}
      active={expanded}
      inert={inert}
      data-sidebar-toggle
      // The panel is on the end side: in right to left, on the left.
      className="rtl:[&>svg]:-scale-x-100"
      onClick={toggleAppSidebar}
    />
  )
}
