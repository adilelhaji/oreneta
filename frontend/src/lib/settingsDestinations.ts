import type { Account } from '../types'
import type { t as translate } from './i18n'

export type SettingsSection =
  | 'appearance'
  | 'typography'
  | 'reading'
  | 'signature'
  | 'privacy'
  | 'updates'
  | 'backup'
  | 'account'
  | 'accountSignature'
export type SettingsDestination = {
  id: string
  section: SettingsSection
  accountId: string
  label: string
  keywords: string
}

const GENERAL = [
  ['appearance', 'settings.pages.appearance', 'theme color colors appearance'],
  ['typography', 'settings.sections.typography', 'font size text typography'],
  ['reading', 'settings.sections.reading', 'reading list density columns'],
  ['signature', 'settings.sections.signature', 'signature sign footer'],
  ['privacy', 'settings.assistant.title', 'assistant privacy provider local remote'],
  ['updates', 'settings.sections.updates', 'updates automatic version'],
  ['backup', 'settings.sections.backup', 'backup configuration restore export'],
] as const

/** Destinations navigate to existing controls; they own no preference values. */
export function settingsDestinations(
  accounts: Account[],
  t: typeof translate,
  updatesSupported = true,
): SettingsDestination[] {
  return [
    ...GENERAL.filter(([section]) => section !== 'updates' || updatesSupported).map(([section, key, english]) => ({
      id: `settings.section.${section}`,
      section,
      accountId: '',
      label: t(key),
      keywords: `${english} ${t(`settingsSearch.aliases.${section}`)}`,
    })),
    ...accounts.flatMap((account): SettingsDestination[] => {
      const name = account.display_name || account.email
      const item = {
        id: `settings.account.${account.id}`,
        section: 'account' as const,
        accountId: account.id,
        label: t('settingsSearch.account', { name }),
        keywords: `${account.email} ${t('settingsSearch.aliases.account')} account server reconnect`,
      }
      return account.provider === 'rss' || account.auth_type === 'rss'
        ? [item]
        : [
            item,
            {
              id: `settings.accountSignature.${account.id}`,
              section: 'accountSignature',
              accountId: account.id,
              label: t('settingsSearch.accountSignature', { name }),
              keywords: `${account.email} ${t('settingsSearch.aliases.signature')} signature account`,
            },
          ]
    }),
  ]
}
