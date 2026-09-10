import { describe, expect, it } from 'bun:test'
import type { Message } from '../../types'
import { contextFor } from './AssistantReviewDialog'

describe('assistant context review', () => {
  it('maps only the selected message content and attachment metadata', () => {
    const message = {
      id: 'local-1',
      message_id: '<stable@example.test>',
      account_id: 'account-a',
      from_addr: 'sender@example.test',
      from_name: 'Sender',
      subject: 'Hello',
      body: 'Untrusted message body',
      attachments: [{ filename: 'brief.pdf', mime: 'application/pdf', size: 42, key: null }],
    } as Message
    expect(contextFor([message])).toEqual([
      {
        message_id: '<stable@example.test>',
        account_id: 'account-a',
        sender: 'sender@example.test',
        subject: 'Hello',
        body: 'Untrusted message body',
        attachments: [{ name: 'brief.pdf', mime: 'application/pdf', size: 42 }],
      },
    ])
  })
})

