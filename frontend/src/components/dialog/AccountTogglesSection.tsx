import { useEffect, useState } from 'react'
import { BellOff, Clock, Code, Eye, Image as ImageIcon, Inbox, Pause, Send } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import {
  setAccountImages,
  setAccountConversationHtml,
  setAccountUnified,
  setAccountMuted,
  setAccountPaused,
  setAccountSaveSentCopy,
  setRSSSyncInterval,
  setMailCheckInterval,
} from '../../states/accounts'
import { settings$, setAccountSideNavHidden } from '../../states/settings'
import { ARCHIVE_ACCOUNT } from '../../states/archive'
import type { Account } from '../../types'
import { NumberRow, SegmentedRow, SelectRow, SettingsGroup, ToggleRow } from './AccountSettingsRows'

// The intervals offered for the periodic mail check (#270), in minutes; 0 is
// "manual only". A value set elsewhere (a restored backup) is offered too.
export const MAIL_CHECK_CHOICES = [0, 5, 10, 15, 30, 60, 120]
/** What an account with no choice of its own does: accounts from before #270 stay manual (ADR-0071, 1B). */
export const DEFAULT_MAIL_CHECK_MINUTES = 0

export function mailCheckChoices(current: number): number[] {
  return MAIL_CHECK_CHOICES.includes(current)
    ? MAIL_CHECK_CHOICES
    : [...MAIL_CHECK_CHOICES, current].sort((a, b) => a - b)
}

// What the periodic check covers depends on how the account gets its mail.
function mailCheckHintKey(account: Account): string {
  if (account.auth_type === 'pop3') return 'settings.account.mailCheckHintPop3'
  if (account.auth_type === 'graph_oauth' || account.ews_url) return 'settings.account.mailCheckHintNoPush'
  return 'settings.account.mailCheckHintImap'
}

function sentCopyDefault(account: Account): boolean {
  const host = account.smtp_host.trim().replace(/\.$/, '').toLowerCase()
  const providerSavesSent =
    account.auth_type === 'gmail_oauth' ||
    account.auth_type === 'outlook_oauth' ||
    [
      'smtp.gmail.com',
      'smtp.googlemail.com',
      'smtp-mail.outlook.com',
      'smtp.office365.com',
      'smtp.live.com',
      'smtp.hotmail.com',
    ].includes(host)
  return !providerSavesSent
}

// The grouped toggle sections of the account panel: visibility,
// notifications/sync (incl. the RSS interval), and content rendering.
export function AccountTogglesSection({ account, isRSS }: { account: Account; isRSS: boolean }) {
  const { t } = useTranslation()
  const hiddenSideNavAccounts = useValue(settings$.hiddenSideNavAccounts)
  const [rssIntervalVal, setRssIntervalVal] = useState('60')

  useEffect(() => {
    setRssIntervalVal(String(account.rss_sync_interval_minutes ?? 60))
  }, [account.id, account.rss_sync_interval_minutes])

  const inUnified = account.included_in_unified !== false
  const inSideNav = !hiddenSideNavAccounts.includes(account.id)
  const muted = account.muted ?? false
  const paused = account.paused ?? false
  const loadImages = account.load_remote_images ?? isRSS
  const conversationHtml = account.conversation_html ?? true
  const saveSentCopy = account.save_sent_copy ?? sentCopyDefault(account)
  const mailCheck = account.mail_check_interval_minutes ?? DEFAULT_MAIL_CHECK_MINUTES

  const updateRSSInterval = (value: string) => {
    setRssIntervalVal(value)
    if (!value.trim()) return
    const minutes = Number(value)
    if (!Number.isFinite(minutes)) return
    void setRSSSyncInterval(account.id, minutes)
  }

  return (
    <>
      <SettingsGroup title={t('settings.account.visibility')}>
        <ToggleRow
          icon={<Inbox size={16} strokeWidth={1.75} />}
          title={t('settings.account.showInUnifiedInbox')}
          hint={t('settings.account.showInUnifiedInboxHint')}
          checked={inUnified}
          onChange={() => setAccountUnified(account.id, !inUnified)}
        />
        <ToggleRow
          icon={<Eye size={16} strokeWidth={1.75} />}
          title={t('settings.account.showInMailNavigation')}
          hint={t('settings.account.showInSideNavHint')}
          checked={inSideNav}
          onChange={() => setAccountSideNavHidden(account.id, inSideNav)}
        />
      </SettingsGroup>

      <SettingsGroup title={t('settings.account.notificationsSync')}>
        <ToggleRow
          icon={<BellOff size={16} strokeWidth={1.75} />}
          title={t('settings.account.muteNotifications')}
          hint={t('settings.account.muteNotificationsHint')}
          checked={muted}
          onChange={() => setAccountMuted(account.id, !muted)}
        />
        <ToggleRow
          icon={<Pause size={16} strokeWidth={1.75} />}
          title={t('settings.account.pauseAccount')}
          hint={t('settings.account.pauseAccountHint')}
          checked={paused}
          onChange={() => setAccountPaused(account.id, !paused)}
        />
        {isRSS && (
          <NumberRow
            icon={<Clock size={16} strokeWidth={1.75} />}
            title={t('settings.account.syncInterval')}
            value={rssIntervalVal}
            min={5}
            max={1440}
            step={5}
            suffix="min"
            onChange={updateRSSInterval}
          />
        )}
        {!isRSS && account.auth_type !== 'local_archive' && account.id !== ARCHIVE_ACCOUNT && (
          <SelectRow
            icon={<Clock size={16} strokeWidth={1.75} />}
            title={t('settings.account.mailCheckInterval')}
            hint={t(mailCheckHintKey(account))}
            value={String(mailCheck)}
            options={mailCheckChoices(mailCheck).map((minutes) => ({
              value: String(minutes),
              label:
                minutes === 0
                  ? t('settings.account.mailCheckManual')
                  : t('settings.account.mailCheckEvery', { minutes }),
            }))}
            onChange={(value) => void setMailCheckInterval(account.id, Number(value))}
          />
        )}
      </SettingsGroup>

      <SettingsGroup title={t('settings.account.content')}>
        <ToggleRow
          icon={<ImageIcon size={16} strokeWidth={1.75} />}
          title={t('settings.account.loadRemoteImages')}
          hint={t('settings.account.loadRemoteImagesHint')}
          checked={loadImages}
          onChange={() => setAccountImages(account.id, !loadImages)}
        />
        <SegmentedRow
          icon={<Code size={16} strokeWidth={1.75} />}
          title={t('settings.account.conversationView')}
          value={conversationHtml ? 'html' : 'plain'}
          options={[
            { value: 'plain', label: t('settings.account.conversationPlain') },
            { value: 'html', label: 'HTML' },
          ]}
          onChange={(mode) => setAccountConversationHtml(account.id, mode === 'html')}
        />
        {!isRSS && (
          <ToggleRow
            icon={<Send size={16} strokeWidth={1.75} />}
            title={t('settings.account.saveSentCopies')}
            hint={t('settings.account.saveSentCopiesHint')}
            checked={saveSentCopy}
            onChange={() => setAccountSaveSentCopy(account.id, !saveSentCopy)}
          />
        )}
      </SettingsGroup>
    </>
  )
}
