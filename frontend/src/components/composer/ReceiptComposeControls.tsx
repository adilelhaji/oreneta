import { MailCheck, PackageCheck } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'

/**
 * Read and delivery receipts, asked for where sending happens (ADR-0048).
 *
 * Two toggles because they ask different parties: a read receipt asks the
 * recipient, who may well say no or never be asked by their own app; a
 * delivery receipt asks the mail servers, and only when the sending server
 * offers it, which is said after sending when it does not. Both start from
 * the defaults in settings.
 */
export function ReceiptComposeControls({
  read,
  delivery,
  onReadChange,
  onDeliveryChange,
}: {
  read: boolean
  delivery: boolean
  onReadChange: (value: boolean) => void
  onDeliveryChange: (value: boolean) => void
}) {
  const { t } = useTranslation()
  const readLabel = t('receipts.requestRead', { defaultValue: 'Request read receipt' })
  const deliveryLabel = t('receipts.requestDelivery', { defaultValue: 'Request delivery receipt' })
  const toggle = (on: boolean) =>
    `flex h-8 w-8 items-center justify-center rounded-control transition-colors cursor-pointer ${
      on ? 'bg-active text-accent' : 'text-secondary hover:bg-hover'
    }`

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        title={readLabel}
        aria-label={readLabel}
        aria-pressed={read}
        onClick={() => onReadChange(!read)}
        className={toggle(read)}
      >
        <MailCheck size={16} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        title={t('receipts.requestDeliveryHint', {
          defaultValue: 'Request delivery receipt (only where your server offers them)',
        })}
        aria-label={deliveryLabel}
        aria-pressed={delivery}
        onClick={() => onDeliveryChange(!delivery)}
        className={toggle(delivery)}
      >
        <PackageCheck size={16} strokeWidth={1.75} />
      </button>
    </div>
  )
}
