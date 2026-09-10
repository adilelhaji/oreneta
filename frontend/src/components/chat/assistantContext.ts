import type { Message } from '../../types'
import type { AssistantContextItem } from '../../states/assistant'

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
