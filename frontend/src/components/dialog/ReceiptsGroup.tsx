import { MailCheck, PackageCheck, Reply } from 'lucide-react'
import { useValue } from '@legendapp/state/react'
import { useTranslation } from '../../lib/i18n'
import { settings$, type ReadReceiptPolicy } from '../../states/settings'
import { SegmentedRow, SettingsGroup, ToggleRow } from './AccountSettingsRows'

/**
 * Read and delivery receipts (ADR-0048): what to ask for on new messages,
 * and what to do when a message asks to be told it was read. A receipt says
 * that you opened the message and when, so the answer starts at "ask".
 */
export function ReceiptsGroup() {
  const { t } = useTranslation()
  const policy = useValue(settings$.readReceiptPolicy)
  const requestRead = useValue(settings$.requestReadReceipt)
  const requestDelivery = useValue(settings$.requestDeliveryReceipt)

  return (
    <SettingsGroup section="receipts" title={t('settings.receipts.title', { defaultValue: 'Receipts' })}>
      <SegmentedRow<ReadReceiptPolicy>
        icon={<Reply size={16} strokeWidth={1.75} />}
        title={t('settings.receipts.policy', { defaultValue: 'When a message asks for a read receipt' })}
        hint={t('settings.receipts.policyHint', {
          defaultValue:
            'A receipt tells the sender you opened the message, and when. Even with “Always”, mail from a list or asking for the receipt to go somewhere else is asked about first, and mail in Junk is never answered.',
        })}
        value={policy}
        options={[
          { value: 'ask', label: t('settings.receipts.ask', { defaultValue: 'Ask each time' }) },
          { value: 'always', label: t('settings.receipts.always', { defaultValue: 'Always send' }) },
          { value: 'never', label: t('settings.receipts.never', { defaultValue: 'Never send' }) },
        ]}
        onChange={(value) => settings$.readReceiptPolicy.set(value)}
      />
      <ToggleRow
        icon={<MailCheck size={16} strokeWidth={1.75} />}
        title={t('settings.receipts.requestRead', { defaultValue: 'Request a read receipt on new messages' })}
        hint={t('settings.receipts.requestReadHint', {
          defaultValue: 'Each message can still change it. The recipient decides whether to answer.',
        })}
        checked={requestRead}
        onChange={() => settings$.requestReadReceipt.set(!requestRead)}
      />
      <ToggleRow
        icon={<PackageCheck size={16} strokeWidth={1.75} />}
        title={t('settings.receipts.requestDelivery', { defaultValue: 'Request a delivery receipt on new messages' })}
        hint={t('settings.receipts.requestDeliveryHint', {
          defaultValue:
            'Asked of your outgoing server, only when it offers delivery notices; you are told when it does not. Exchange accounts ask it of Exchange with each message. Not available for Microsoft 365 accounts.',
        })}
        checked={requestDelivery}
        onChange={() => settings$.requestDeliveryReceipt.set(!requestDelivery)}
      />
    </SettingsGroup>
  )
}
