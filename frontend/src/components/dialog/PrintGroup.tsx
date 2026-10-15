import { useValue } from '@legendapp/state/react'
import { ArrowDownUp, AtSign, Calendar, EyeOff, Heading, Layers, Paperclip, User, Users } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import type { PrintHeaders, PrintOptions } from '../../lib/printOptions'
import { settings$ } from '../../states/settings'
import { SegmentedRow, SettingRow, SettingsGroup, ToggleRow } from './AccountSettingsRows'

/**
 * General → Print (SET-05, ADR-0060): which header fields go on paper, one
 * message or the whole conversation and in which order, and whether the
 * attachments are listed. Every control writes `settings$.print`, which the
 * settings store persists as one row; the print entry points read it.
 */
export function PrintGroup() {
  const { t } = useTranslation()
  const options = useValue(settings$.print)
  const set = (partial: Partial<PrintOptions>) => settings$.print.set({ ...options, ...partial })
  const toggleHeader = (field: keyof PrintHeaders) =>
    set({ headers: { ...options.headers, [field]: !options.headers[field] } })
  const icon = { size: 16, strokeWidth: 1.75 }
  return (
    <SettingsGroup section="print" title={t('settings.sections.print')}>
      {/* Not a choice: on paper nothing else says who wrote a message. */}
      <SettingRow
        icon={<User {...icon} />}
        title={t('print.settings.sender')}
        hint={t('print.settings.senderHint')}
        control={<span className="text-xs text-secondary">{t('print.settings.senderAlways')}</span>}
      />
      <ToggleRow
        icon={<Heading {...icon} />}
        title={t('print.settings.subject')}
        checked={options.headers.subject}
        onChange={() => toggleHeader('subject')}
      />
      <ToggleRow
        icon={<Calendar {...icon} />}
        title={t('print.settings.date')}
        checked={options.headers.date}
        onChange={() => toggleHeader('date')}
      />
      <ToggleRow
        icon={<AtSign {...icon} />}
        title={t('print.settings.to')}
        checked={options.headers.to}
        onChange={() => toggleHeader('to')}
      />
      <ToggleRow
        icon={<Users {...icon} />}
        title={t('print.settings.cc')}
        checked={options.headers.cc}
        onChange={() => toggleHeader('cc')}
      />
      <ToggleRow
        icon={<EyeOff {...icon} />}
        title={t('print.settings.bcc')}
        hint={t('print.settings.bccHint')}
        checked={options.headers.bcc}
        onChange={() => toggleHeader('bcc')}
      />
      <SegmentedRow
        icon={<Layers {...icon} />}
        title={t('print.settings.scope')}
        hint={t('print.settings.scopeHint')}
        value={options.scope}
        options={[
          { value: 'conversation', label: t('print.settings.scopeConversation') },
          { value: 'message', label: t('print.settings.scopeMessage') },
        ]}
        onChange={(scope) => set({ scope })}
      />
      {/* Order only means something when more than one message prints. */}
      {options.scope === 'conversation' && (
        <SegmentedRow
          icon={<ArrowDownUp {...icon} />}
          title={t('print.settings.order')}
          value={options.order}
          options={[
            { value: 'oldest', label: t('print.settings.orderOldest') },
            { value: 'newest', label: t('print.settings.orderNewest') },
          ]}
          onChange={(order) => set({ order })}
        />
      )}
      <ToggleRow
        icon={<Paperclip {...icon} />}
        title={t('print.settings.attachments')}
        hint={t('print.settings.attachmentsHint')}
        checked={options.attachments}
        onChange={() => set({ attachments: !options.attachments })}
      />
    </SettingsGroup>
  )
}
