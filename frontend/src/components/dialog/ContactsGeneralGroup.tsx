import { useValue } from '@legendapp/state/react'
import { ArrowDownAZ, IdCard } from 'lucide-react'
import i18n, { useTranslation } from '../../lib/i18n'
import { formatName, localeNameDefaults, type NameDisplay, type NameSort } from '../../lib/contactNames'
import { settings$ } from '../../states/settings'
import { SelectInput } from '../field/Field'
import { SettingRow, SettingsGroup } from './AccountSettingsRows'

// Who the examples are: a name in the reader's script would be better, but a
// fixed pair keeps the three orders easy to tell apart in every language.
const EXAMPLE = { name: 'Ada Lovelace', given: 'Ada', family: 'Lovelace' }

/**
 * Contacts → General (SET-19, ADR-0052): how a contact's name is written and
 * which part lists are ordered by. Both apply to names the address book keeps
 * in parts — the contacts list and card, recipient suggestions, and the mail
 * list where a message gave no name of its own. A name from a message header
 * is always shown as it was written.
 */
export function ContactsGeneralGroup() {
  const { t } = useTranslation()
  const display = useValue(settings$.contactNameDisplay)
  const sort = useValue(settings$.contactNameSort)
  const language = useValue(settings$.language) ?? i18n.language
  const defaults = localeNameDefaults(language || 'en')
  const icon = { size: 16, strokeWidth: 1.75 }
  const selectClass = 'w-48 rounded-control py-1.5 pl-3 font-semibold'

  const displayLabel = (choice: Exclude<NameDisplay, 'auto'>) => formatName(EXAMPLE, choice)
  const sortLabel = (choice: Exclude<NameSort, 'auto'>) =>
    choice === 'first'
      ? t('settings.contacts.sortFirst', { defaultValue: 'First name' })
      : t('settings.contacts.sortLast', { defaultValue: 'Last name' })
  const displayTitle = t('settings.contacts.displayAs', { defaultValue: 'Display names as' })
  const sortTitle = t('settings.contacts.sortBy', { defaultValue: 'Sort contacts by' })

  return (
    <SettingsGroup
      section="contactsGeneral"
      title={t('settings.sections.contactsGeneral', { defaultValue: 'Contacts' })}
    >
      <SettingRow
        icon={<IdCard {...icon} />}
        title={displayTitle}
        hint={t('settings.contacts.displayAsHint', {
          defaultValue:
            'For names your address book keeps as first and last name. Names written in a message are shown as they came.',
        })}
        control={
          <SelectInput
            aria-label={displayTitle}
            value={display}
            onChange={(e) => settings$.contactNameDisplay.set(e.target.value as NameDisplay)}
            className={selectClass}
          >
            <option value="auto" className="bg-chats text-primary">
              {t('settings.contacts.languageDefault', {
                example: displayLabel(defaults.display),
                defaultValue: 'As the language does ({example})',
              })}
            </option>
            {(['first_last', 'last_comma_first', 'last_first'] as const).map((choice) => (
              <option key={choice} value={choice} className="bg-chats text-primary">
                {displayLabel(choice)}
              </option>
            ))}
          </SelectInput>
        }
      />
      <SettingRow
        icon={<ArrowDownAZ {...icon} />}
        title={sortTitle}
        control={
          <SelectInput
            aria-label={sortTitle}
            value={sort}
            onChange={(e) => settings$.contactNameSort.set(e.target.value as NameSort)}
            className={selectClass}
          >
            <option value="auto" className="bg-chats text-primary">
              {t('settings.contacts.languageDefault', {
                example: sortLabel(defaults.sort),
                defaultValue: 'As the language does ({example})',
              })}
            </option>
            {(['first', 'last'] as const).map((choice) => (
              <option key={choice} value={choice} className="bg-chats text-primary">
                {sortLabel(choice)}
              </option>
            ))}
          </SelectInput>
        }
      />
    </SettingsGroup>
  )
}
