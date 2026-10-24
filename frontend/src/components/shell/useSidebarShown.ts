import { useValue } from '@legendapp/state/react'
import { settings$ } from '../../states/settings'
import { shownSidebar, sidebar$, type SidebarShown } from '../../states/sidebar'
import { isConversationSection, ui$ } from '../../states/ui'

/** How the app's sidebar is drawn now, followed as it changes (ADR-0069 §2). */
export function useSidebarShown(): SidebarShown {
  const state = useValue(settings$.appSidebarState)
  const fits = useValue(sidebar$.fits)
  const strip = useValue(sidebar$.strip)
  const overlay = useValue(sidebar$.overlay)
  return shownSidebar(state, fits, strip, overlay)
}

/**
 * Whether the sidebar is expanded on its Conversa panel, beside the content or
 * as an overlay: what `i` and the conversation header's details buttons would
 * minimise or close.
 */
export function useConversationPanelExpanded(): boolean {
  const shown = useSidebarShown()
  const section = useValue(ui$.sidebarSection)
  return (shown === 'beside' || shown === 'overlay') && isConversationSection(section)
}
