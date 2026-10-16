// What to tell the sender after a send, about the delivery receipt they asked
// for (ADR-0048, ADR-0057): the core answers whether it was requested and,
// on Microsoft 365, why it was not.

import { t } from './i18n'
import type { SendResult } from '../states/outgoingAttempts'

export const DELIVERY_WITHHELD_TEXT: Record<string, { key: string; text: string }> = {
  needsChanges: {
    key: 'receipts.deliveryWithheld.needsChanges',
    text: 'Message sent without a delivery receipt: on Microsoft 365 it needs changes allowed for this account, in its settings.',
  },
  bcc: {
    key: 'receipts.deliveryWithheld.bcc',
    text: 'Message sent without a delivery receipt: on Microsoft 365 it is not requested yet for messages with Bcc recipients.',
  },
  protected: {
    key: 'receipts.deliveryWithheld.protected',
    text: 'Message sent without a delivery receipt: on Microsoft 365 it is not requested yet for signed or encrypted messages.',
  },
}

export function deliveryReceiptToast(sent: SendResult): string {
  if (sent?.delivery_receipt !== 'unsupported') return t('chat.messageSent')
  const withheld = sent.delivery_receipt_reason ? DELIVERY_WITHHELD_TEXT[sent.delivery_receipt_reason] : undefined
  if (withheld) return t(withheld.key, { defaultValue: withheld.text })
  return t('receipts.deliveryUnsupported', {
    defaultValue: 'Message sent. The server does not offer delivery receipts, so none was requested.',
  })
}
