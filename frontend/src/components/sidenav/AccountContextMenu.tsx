import { useValue } from '@legendapp/state/react'
import { Bell, BellOff, CheckCheck, EyeOff, Pause, Play, SlidersHorizontal } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { setAccountMuted, setAccountPaused } from '../../states/accounts'
import { inboxUnread, mail$, markAccountInboxRead } from '../../states/mail'
import { setAccountSideNavHidden } from '../../states/settings'
import { ui$ } from '../../states/ui'
import type { Account } from '../../types'
import { NavContextMenu, NavMenuItem } from './NavContextMenu'

const secondary = 'text-secondary'

// The menu of an account in «Comptes i carpetes» (right click, Shift+F10 and
// the context menu key), the one the rail had: settings, notifications,
// checking, and visibility.
export function AccountContextMenu({
  account,
  x,
  y,
  onHidden,
  onClose,
}: {
  account: Account
  x: number
  y: number
  /** Told after the account was hidden, before the menu closes. */
  onHidden?: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const folders = useValue(mail$.foldersByAccount[account.id])
  const hasUnread = inboxUnread(folders) > 0
  return (
    <NavContextMenu x={x} y={y} label={account.display_name || account.email || account.id} onClose={onClose}>
      <NavMenuItem
        icon={<SlidersHorizontal size={14} className={secondary} strokeWidth={1.75} />}
        label={t('settings.account.accountSettings')}
        onClick={() => {
          ui$.accountSettingsId.set(account.id)
          ui$.settingsOpen.set(true)
          onClose()
        }}
      />
      <NavMenuItem
        disabled={!hasUnread || account.auth_type === 'graph_oauth'}
        icon={<CheckCheck size={14} className={secondary} strokeWidth={1.75} />}
        label={t('threads.actions.markAllAsRead')}
        onClick={() => {
          void markAccountInboxRead(account.id)
          onClose()
        }}
      />
      <NavMenuItem
        icon={
          account.muted ? (
            <Bell size={14} className={secondary} strokeWidth={1.75} />
          ) : (
            <BellOff size={14} className={secondary} strokeWidth={1.75} />
          )
        }
        label={account.muted ? t('settings.account.unmuteNotifications') : t('settings.account.muteNotifications')}
        onClick={() => {
          void setAccountMuted(account.id, !(account.muted ?? false))
          onClose()
        }}
      />
      <NavMenuItem
        icon={
          account.paused ? (
            <Play size={14} className={secondary} strokeWidth={1.75} />
          ) : (
            <Pause size={14} className={secondary} strokeWidth={1.75} />
          )
        }
        label={account.paused ? t('settings.account.resumeChecking') : t('settings.account.pauseAccount')}
        onClick={() => {
          void setAccountPaused(account.id, !(account.paused ?? false))
          onClose()
        }}
      />
      <NavMenuItem
        icon={<EyeOff size={14} className={secondary} strokeWidth={1.75} />}
        label={t('mailNavigation.actions.hideAccount')}
        onClick={() => {
          setAccountSideNavHidden(account.id, true)
          onHidden?.()
          onClose()
        }}
      />
    </NavContextMenu>
  )
}
