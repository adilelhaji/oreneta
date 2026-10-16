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
import { isDraftFolder, mail$ } from './mail'
import { isLocalSendId } from './pendingSends'
import { settings$ } from './settings'
import { showToast } from './ui'

/**
 * What sets a message apart from mail that was sent or received: a copy still
 * in the undo window or waiting to be retried has not gone out, and a draft
 * never has. Printed on the message, so paper cannot pass either off as sent.
 */
function printMark(message: Message): string | undefined {
  if (isLocalSendId(message.id)) return t('print.notSent')
  if (isDraftFolder(message.folder_id, message.account_id)) return t('print.draft')
  return undefined
}

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
  // Before the conversation has loaded (or after it failed to) there is
  // nothing to put on paper: an empty page would look like a printout, so
  // nothing is printed and the person is told why.
  if (!messages.length) {
    showToast(t('print.notLoaded'), 'error')
    return Promise.resolve()
  }
  const marks: Record<string, string> = {}
  for (const item of messages) {
    const mark = printMark(item)
    if (mark) marks[item.id] = mark
  }
  return printConversation({
    subject: thread.subject,
    messages,
    options: message ? { ...remembered, scope: 'message' } : remembered,
    messageId: message?.id,
    marks,
    // The printout loads what the reader would (#35).
    allowRemoteImages:
      accounts$.peek().find((account) => account.id === thread.account_id)?.load_remote_images ?? false,
    // The cursor is the open conversation's: older messages are on the server.
    incompleteNotice: loaded.length > 0 && mail$.messagesCursor.peek() ? t('print.incomplete') : undefined,
    oneMessageNotice: t('print.oneMessage'),
    oneMessageUnknownNotice: t('print.oneMessageUnknown'),
    // Nothing of this conversation is loaded: whether it has other messages
    // is not known here, and the page says only that they are not printed.
    conversationUnknown: loaded.length === 0,
    printedLabel: t('print.printedOn'),
    toLabel: t('print.to'),
    ccLabel: t('print.cc'),
    bccLabel: t('print.bcc'),
    attachmentsLabel: t('print.attachments'),
  })
}
