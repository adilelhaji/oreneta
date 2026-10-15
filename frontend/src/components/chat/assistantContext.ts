import type { Message } from '../../types'
import type { AssistantContextItem } from '../../states/assistant'

/**
 * Where the conversation's most recent message is in `messages`, or -1 when
 * there is none. The latest date wins; between equal dates (or unknown ones,
 * which are 0) the later in the list does, as a conversation is kept oldest
 * first.
 */
export function newestMessageIndex(messages: Message[]): number {
  let newest = -1
  messages.forEach((message, index) => {
    if (newest < 0 || message.date >= messages[newest].date) newest = index
  })
  return newest
}

export function contextFor(messages: Message[]): AssistantContextItem[] {
  return messages.map((message) => ({
    message_id: message.message_id || message.id,
    account_id: message.account_id,
    sender: message.from_addr,
    subject: message.subject,
    body: message.body,
    attachments: (message.attachments ?? []).map((attachment) => ({
      name: attachment.filename,
      mime: attachment.mime,
      size: attachment.size,
    })),
  }))
}
