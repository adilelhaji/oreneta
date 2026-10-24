import { PanelRight } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { sidebarDrawn, sidebarExpanded, toggleAppSidebar } from '../../states/sidebar'
import { IconButton } from '../button/IconButton'
import { useSidebarShown } from './useSidebarShown'

/**
 * The «Barra lateral» button at the end of the top band (ADR-0069 §2, owner
 * decision 2 on #360), in every module, until the main toolbar exists. It
 * shows and hides the whole sidebar (owner decision D4): whatever is drawn of
 * it goes — expanded beside the content or minimised to its strip, it is
 * hidden (saved), and an overlay closes (not saved) — and with nothing drawn
 * it expands it, beside the content where it fits (saved) or as an overlay
 * (not saved). The strip's own icons are what expand it from the strip.
 *
 * `aria-expanded` is true only while the sidebar is expanded, beside the
 * content or as an overlay. Its tooltip, which is also its description, says
 * what a press does: «Amaga la barra lateral» while any of it is drawn, the
 * strip too, and «Mostra la barra lateral» otherwise, as the palette's and the
 * app menu's command reads.
 *
 * `inert` (the band's search covering the band below 769 px) makes it inert,
 * as the band's other controls.
 */
export function SidebarToggle({ inert = false }: { inert?: boolean }) {
  const { t } = useTranslation()
  const shown = useSidebarShown()
  const expanded = sidebarExpanded(shown)
  return (
    <IconButton
      icon={PanelRight}
      size="md"
      radius="lg"
      label={t('sidebar.label')}
      title={sidebarDrawn(shown) ? t('commands.sidebar.hide') : t('commands.sidebar.show')}
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
