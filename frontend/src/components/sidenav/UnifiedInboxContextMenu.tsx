import { useValue } from '@legendapp/state/react'
import { EyeOff, Layers } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { accountGroups$ } from '../../states/accountGroups'
import { setUnifiedInboxSideNavVisible } from '../../states/settings'
import { NavContextMenu, NavMenuItem } from './NavContextMenu'

// The unified inbox's menu (right click, or Shift+F10 and the context menu key
// in the folder pane): one row per account group, to show it together, and one
// to hide the unified inbox, which the preference
// `show_unified_inbox_in_sidenav` keeps.
export function UnifiedInboxContextMenu({
  x,
  y,
  label,
  onShowGroup,
  onHidden,
  onClose,
}: {
  x: number
  y: number
  /** The menu's accessible name: what it is for. */
  label: string
  onShowGroup: (groupId: string) => void
  /** Told after the unified inbox was hidden, before the menu closes. */
  onHidden?: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const groups = useValue(accountGroups$.groups)
  return (
    <NavContextMenu x={x} y={y} label={label} onClose={onClose}>
      {groups.map((group) => (
        <NavMenuItem
          key={group.id}
          icon={<Layers size={14} className="text-secondary" strokeWidth={1.75} />}
          label={t('accountGroups.showGroup', { name: group.name, defaultValue: 'Show {name} together' })}
          onClick={() => {
            onShowGroup(group.id)
            onClose()
          }}
        />
      ))}
      <NavMenuItem
        icon={<EyeOff size={14} className="text-secondary" strokeWidth={1.75} />}
        label={t('mailNavigation.actions.hideUnified')}
        onClick={() => {
          setUnifiedInboxSideNavVisible(false)
          onHidden?.()
          onClose()
        }}
      />
    </NavContextMenu>
  )
}
