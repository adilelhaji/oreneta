import type { Account } from '../types'
import type { t as translate } from './i18n'

export type SettingsSection =
  | 'appearance'
  | 'typography'
  | 'reading'
  | 'signature'
  | 'repliesForwards'
  | 'calendarGeneral'
  | 'contactsGeneral'
  | 'notifications'
  | 'privacy'
  | 'updates'
  | 'backup'
  | 'account'
  | 'accountSignature'
  | 'autoArchive'
  // Opened from the account sync panel for a refused proxy (#201); not offered by search.
  | 'network'
  | 'accountNetwork'
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
    {
      id: 'settings.section.repliesForwards',
      section: 'repliesForwards' as const,
      accountId: '',
      label: t('settings.sections.repliesForwards', { defaultValue: 'Replies and forwards' }),
      keywords: `reply replies forward forwarding quote quoting header re fwd attachment eml ${t(
        'settingsSearch.aliases.repliesForwards',
        { defaultValue: '' },
      )}`,
    },
    {
      id: 'settings.section.notifications',
      section: 'notifications' as const,
      accountId: '',
      label: t('settings.sections.notifications', { defaultValue: 'Notifications' }),
      keywords: `notifications notification sound sounds volume chime do not disturb dnd quiet hours pause mute reminder ${t(
        'settingsSearch.aliases.notifications',
        { defaultValue: '' },
      )}`,
    },
    {
      id: 'settings.section.calendarGeneral',
      section: 'calendarGeneral' as const,
      accountId: '',
      label: t('settings.sections.calendarGeneral', { defaultValue: 'Calendar' }),
      keywords: `calendar week start first day sunday monday saturday week numbers work hours working days work week duration reminder ${t(
        'settingsSearch.aliases.calendarGeneral',
        { defaultValue: '' },
      )}`,
    },
    {
      id: 'settings.section.contactsGeneral',
      section: 'contactsGeneral' as const,
      accountId: '',
      label: t('settings.sections.contactsGeneral', { defaultValue: 'Contacts' }),
      keywords: `contacts contact people names name order display first last surname family given sort sorting ${t(
        'settingsSearch.aliases.contactsGeneral',
        { defaultValue: '' },
      )}`,
    },
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
            // Automatic archiving by age (ADR-0054), where the account has a server.
            ...(account.auth_type === 'pop3' || account.auth_type === 'local_archive' || account.id === 'local-archive'
              ? []
              : [
                  {
                    id: `settings.autoArchive.${account.id}`,
                    section: 'autoArchive' as const,
                    accountId: account.id,
                    label: t('settingsSearch.autoArchive', {
                      name,
                      defaultValue: 'Automatic archiving: {name}',
                    }),
                    keywords: `${account.email} archive archiving automatic auto old age older days months cleanup ${t(
                      'settingsSearch.aliases.autoArchive',
                      { defaultValue: '' },
                    )}`,
                  },
                ]),
          ]
    }),
  ]
}
