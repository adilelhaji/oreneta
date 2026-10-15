// Printing from the reader (#35, SET-05): what the reader has loaded, as the
// remembered print options (General → Print, ADR-0060) say to put it on paper.
//
// Both print entry points come through here — the conversation's menu and a
// message's own — so the guarantees of #35 hold for each: remote images only
// where the account loads them, and what is left out said on the page.

import { t } from '../lib/i18n'
import { printConversation } from '../lib/print'
import type { Message } from '../types'
import { accounts$ } from './accounts'
import { mail$ } from './mail'
import { settings$ } from './settings'

/**
 * Prints the conversation `thread` belongs to.
 *
 * With `message` — asked from that message's own menu — only that message
 * prints, whatever the remembered scope; the other choices still apply.
 */
export function printFromReader(
  thread: Pick<Message, 'thread_id' | 'account_id' | 'subject'>,
  message?: Message,
): Promise<void> {
  const remembered = settings$.print.peek()
  const loaded = mail$.messages.peek().filter((item) => item.thread_id === thread.thread_id)
  // The message asked about prints even when it is not among the loaded ones,
  // rather than another message standing in for it.
  const messages = message && !loaded.some((item) => item.id === message.id) ? [...loaded, message] : loaded
  return printConversation({
    subject: thread.subject,
    messages,
    options: message ? { ...remembered, scope: 'message' } : remembered,
    messageId: message?.id,
    // The printout loads what the reader would (#35).
    allowRemoteImages:
      accounts$.peek().find((account) => account.id === thread.account_id)?.load_remote_images ?? false,
    // The cursor is the open conversation's: older messages are on the server.
    incompleteNotice: loaded.length > 0 && mail$.messagesCursor.peek() ? t('print.incomplete') : undefined,
    oneMessageNotice: t('print.oneMessage'),
    printedLabel: t('print.printedOn'),
    toLabel: t('print.to'),
    ccLabel: t('print.cc'),
    bccLabel: t('print.bcc'),
    attachmentsLabel: t('print.attachments'),
  })
}
