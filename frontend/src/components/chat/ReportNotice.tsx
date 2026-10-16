import { MailCheck, MailWarning } from 'lucide-react'
import { useTranslation } from '../../lib/i18n'
import { formatThreadDate } from '../../lib/date'
import type { DeliveryOutcome, Message, ReportOutcome, ReportRecipient } from '../../types'

/**
 * i18n key and English text for what a report says about one recipient.
 * Worded as what the report claims: whoever sent it says so, nobody here
 * checked it (ADR-0057).
 */
export const REPORT_OUTCOME_TEXT: Record<ReportOutcome, { key: string; text: string }> = {
  delivered: { key: 'receipts.reports.delivered', text: 'The report says it was delivered to {recipient}' },
  relayed: {
    key: 'receipts.reports.relayed',
    text: 'The report says it was passed on for {recipient}; no further report will come',
  },
  delayed: {
    key: 'receipts.reports.delayed',
    text: 'As of {date}, the report says delivery to {recipient} is delayed; the server is still trying',
  },
  failed: { key: 'receipts.reports.failed', text: 'The report says it was not delivered to {recipient}' },
  displayed: { key: 'receipts.reports.displayed', text: '{recipient}’s mail program says it was displayed' },
  notDisplayed: {
    key: 'receipts.reports.notDisplayed',
    text: '{recipient}’s mail program says it handled the message without displaying it',
  },
}

/** What an enhanced status code (RFC 3463) commonly means, when it is one of those. */
export const STATUS_PHRASES = {
  noAddress: { key: 'receipts.reports.code.noAddress', text: 'The address does not exist' },
  mailboxFull: { key: 'receipts.reports.code.mailboxFull', text: 'The mailbox is full' },
  policy: { key: 'receipts.reports.code.policy', text: 'Refused by the receiving server’s policy' },
  temporary: { key: 'receipts.reports.code.temporary', text: 'A temporary problem' },
} as const

export function statusPhrase(status: string | undefined): keyof typeof STATUS_PHRASES | null {
  if (!status) return null
  if (/^[45]\.1\.(1|10)$/.test(status)) return 'noAddress'
  if (/^[45]\.2\.2$/.test(status)) return 'mailboxFull'
  if (/^[45]\.7\.\d{1,3}$/.test(status)) return 'policy'
  if (/^4\.\d{1,3}\.\d{1,3}$/.test(status)) return 'temporary'
  return null
}

/** The server's own words, without the reply and status codes said already. */
export function serverWords(item: ReportRecipient): string {
  let words = (item.diagnostic ?? '').trim()
  words = words.replace(/^\d{3}[ -]+/, '')
  if (item.status && words.startsWith(item.status)) words = words.slice(item.status.length)
  return words.replace(/^[\s:;,.-]+/, '').trim()
}

/** Failures first, then what is still pending, then what went through. */
const ORDER: ReportOutcome[] = ['failed', 'delayed', 'notDisplayed', 'relayed', 'delivered', 'displayed']

/** Text from a report is kept apart from the sentence around it, so a
 * right-to-left address or reason cannot reorder the words next to it. */
export function isolate(text: string): string {
  return `⁨${text}⁩`
}

/**
 * Delivery and read reports (ADR-0057), described only.
 *
 * On a message this account sent: what the reports received about it say,
 * one line per recipient, failures first, each with when it was reported and
 * marked when it names someone the message was not addressed to. On a report
 * itself: what it says, and what it is about only when the core matched it
 * to a message of this account. Nothing here is sent or answered.
 */
export function ReportNotice({ message, outgoing }: { message: Message; outgoing: boolean }) {
  const { t } = useTranslation()
  const items: (ReportRecipient & Partial<DeliveryOutcome>)[] = outgoing
    ? [...(message.delivery ?? [])]
    : [...(message.report?.recipients ?? [])]
  if (!items.length) return null
  items.sort((a, b) => ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome))
  const read = message.report?.kind === 'disposition'
  const heading = outgoing
    ? ''
    : message.report_linked
      ? read
        ? t('receipts.reports.isDisposition', { defaultValue: 'Read report about a message you sent' })
        : t('receipts.reports.isDelivery', { defaultValue: 'Delivery report about a message you sent' })
      : read
        ? t('receipts.reports.disposition', { defaultValue: 'Read report' })
        : t('receipts.reports.delivery', { defaultValue: 'Delivery report' })
  return (
    <div
      role="group"
      aria-label={t('receipts.reports.label', { defaultValue: 'Delivery and read reports' })}
      className="mb-2 flex flex-col gap-0.5 rounded-control-sm border border-border/60 bg-black/[0.02] px-3 py-2 text-caption text-secondary dark:bg-white/[0.02]"
    >
      {heading && <span className="font-semibold">{heading}</span>}
      <ul className="flex flex-col gap-1">
        {items.map((item, idx) => {
          const text = REPORT_OUTCOME_TEXT[item.outcome]
          if (!text) return null
          const failed = item.outcome === 'failed'
          const Icon = failed || item.outcome === 'delayed' ? MailWarning : MailCheck
          const date = item.reported_at ? formatThreadDate(item.reported_at) : ''
          const phrase = failed ? statusPhrase(item.status) : null
          const words = failed ? serverWords(item) : ''
          const reason = phrase
            ? t(STATUS_PHRASES[phrase].key, { defaultValue: STATUS_PHRASES[phrase].text })
            : failed
              ? (item.status ?? '')
              : ''
          return (
            <li key={`${item.kind ?? ''}-${item.recipient}-${idx}`} className="flex items-start gap-1.5">
              <Icon
                size={14}
                strokeWidth={1.75}
                aria-hidden="true"
                className={failed ? 'mt-px shrink-0 text-danger' : 'mt-px shrink-0'}
              />
              <span className="min-w-0 break-words">
                {t(text.key, { defaultValue: text.text, recipient: isolate(item.recipient), date: isolate(date) })}
                {reason && (
                  <span className="block">{t('receipts.reports.reason', { defaultValue: 'Reason: {reason}', reason })}</span>
                )}
                {words && (
                  <span className="block opacity-80" dir="auto">
                    {words}
                  </span>
                )}
                {item.listed === false && (
                  <span className="block">
                    {t('receipts.reports.notListed', { defaultValue: 'Not a recipient of this message' })}
                  </span>
                )}
                {date && item.outcome !== 'delayed' && (
                  <span className="block opacity-80">
                    {t('receipts.reports.reported', { defaultValue: 'Reported {date}', date: isolate(date) })}
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
