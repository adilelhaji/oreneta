import { MailCheck, MailWarning } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import type { Message, ReportOutcome, ReportRecipient } from '../../types'

/** i18n key and English text for what a report says about one recipient. */
export const REPORT_OUTCOME_TEXT: Record<ReportOutcome, { key: string; text: string }> = {
  delivered: { key: 'receipts.reports.delivered', text: 'Delivered to {recipient}' },
  relayed: { key: 'receipts.reports.relayed', text: 'Passed on for {recipient}; no further report will come' },
  delayed: { key: 'receipts.reports.delayed', text: 'Delayed for {recipient}; the server is still trying' },
  failed: { key: 'receipts.reports.failed', text: 'Not delivered to {recipient}' },
  displayed: { key: 'receipts.reports.displayed', text: 'Displayed to {recipient}' },
  notDisplayed: { key: 'receipts.reports.notDisplayed', text: 'Handled for {recipient} without being displayed' },
}

/** The failure reason a report gave: its status code, then the server's words. */
export function reportReason(item: ReportRecipient): string {
  return [item.status, item.diagnostic].filter(Boolean).join(' · ')
}

/**
 * Delivery and read reports (ADR-0057), described only.
 *
 * On a message this account sent: what the reports received about it say,
 * one line per recipient. On a report itself: what it says. The core reads
 * both from the report's machine-readable part and links them by Message-ID;
 * nothing here is sent or answered.
 */
export function ReportNotice({ message, outgoing }: { message: Message; outgoing: boolean }) {
  const { t } = useTranslation()
  const items: ReportRecipient[] = outgoing ? (message.delivery ?? []) : (message.report?.recipients ?? [])
  if (!items.length) return null
  const heading = outgoing
    ? ''
    : message.report?.kind === 'disposition'
      ? t('receipts.reports.isDisposition', { defaultValue: 'Read report about a message you sent' })
      : t('receipts.reports.isDelivery', { defaultValue: 'Delivery report about a message you sent' })
  return (
    <div
      role="group"
      aria-label={t('receipts.reports.label', { defaultValue: 'Delivery and read reports' })}
      className="mb-2 flex flex-col gap-0.5 rounded-control-sm border border-border/60 bg-black/[0.02] px-3 py-2 text-caption text-secondary dark:bg-white/[0.02]"
    >
      {heading && <span className="font-semibold">{heading}</span>}
      <ul className="flex flex-col gap-0.5">
        {items.map((item, idx) => {
          const text = REPORT_OUTCOME_TEXT[item.outcome]
          if (!text) return null
          const failed = item.outcome === 'failed'
          const Icon = failed || item.outcome === 'delayed' ? MailWarning : MailCheck
          const reason = failed ? reportReason(item) : ''
          return (
            <li key={`${item.recipient}-${idx}`} className="flex items-start gap-1.5">
              <Icon
                size={14}
                strokeWidth={1.75}
                aria-hidden="true"
                className={failed ? 'mt-px shrink-0 text-danger' : 'mt-px shrink-0'}
              />
              <span className="min-w-0 break-words">
                {t(text.key, { defaultValue: text.text, recipient: item.recipient })}
                {reason && (
                  <span className="block">
                    {t('receipts.reports.reason', { defaultValue: 'Reason: {reason}', reason })}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
