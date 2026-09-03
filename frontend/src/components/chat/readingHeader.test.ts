import { describe, expect, it } from 'bun:test'
import { isConversation, summariseThread } from './readingHeader'
import type { Message } from '../../types'

function message(over: Partial<Message>): Message {
  return {
    id: over.id ?? 'm1',
    account_id: 'a',
    folder_id: 'INBOX',
    thread_id: 'T',
    from_name: '',
    from_addr: 'someone@example.com',
    to: '',
    subject: 'Re: the roof',
    preview: '',
    body: '',
    date: 1_000,
    unread: false,
    starred: false,
    has_attachments: false,
    ...over,
  } as Message
}

describe('what the header says about an open conversation', () => {
  it('names everyone who wrote, most recent first', () => {
    const summary = summariseThread(
      message({ message_count: 3 }),
      [
        message({ id: '1', from_name: 'Ana', from_addr: 'ana@example.com', date: 100 }),
        message({ id: '2', from_name: 'Marc', from_addr: 'marc@example.com', date: 300 }),
        message({ id: '3', from_name: 'Ana', from_addr: 'ANA@example.com', date: 200 }),
      ],
      false,
    )
    expect(summary.participants.map((p) => p.name)).toEqual(['Marc', 'Ana'])
    expect(summary.participants[1].address).toBe('ana@example.com')
  })

  it('ignores messages belonging to another thread', () => {
    const summary = summariseThread(
      message({}),
      [
        message({ id: '1', from_addr: 'ana@example.com', date: 100 }),
        message({ id: '2', thread_id: 'OTHER', from_addr: 'stranger@example.com', date: 900 }),
      ],
      false,
    )
    expect(summary.participants.map((p) => p.address)).toEqual(['ana@example.com'])
  })

  it('marks the reader among the participants', () => {
    const summary = summariseThread(
      message({}),
      [
        message({ id: '1', from_addr: 'me@example.com', date: 200 }),
        message({ id: '2', from_addr: 'ana@example.com', date: 100 }),
      ],
      false,
      ['Me@Example.com'],
    )
    expect(summary.participants.map((p) => p.self)).toEqual([true, false])
  })

  it('trusts an outgoing flag even for an address we do not hold', () => {
    const summary = summariseThread(
      message({}),
      [message({ id: '1', from_addr: 'alias@example.com', outgoing: true, date: 200 })],
      false,
    )
    expect(summary.participants[0].self).toBe(true)
  })

  it('counts the thread, not the page of it that happens to be loaded', () => {
    const summary = summariseThread(
      message({ message_count: 30, unread_count: 2 }),
      [message({ id: '1', date: 100 }), message({ id: '2', date: 200 })],
      true,
    )
    expect(summary.messageCount).toBe(30)
    expect(summary.unreadCount).toBe(2)
  })

  it('says the cast may be short while older messages are unfetched', () => {
    const withOlder = summariseThread(message({}), [message({ id: '1' })], true)
    const complete = summariseThread(message({}), [message({ id: '1' })], false)
    expect(withOlder.partial).toBe(true)
    expect(complete.partial).toBe(false)
  })

  it('reports an absent count as unknown rather than as none', () => {
    const summary = summariseThread(message({}), [], false)
    expect(summary.messageCount).toBeNull()
    expect(summary.unreadCount).toBeNull()
  })

  it('keeps a real zero apart from an unknown', () => {
    const summary = summariseThread(message({ unread_count: 0 }), [], false)
    expect(summary.unreadCount).toBe(0)
  })

  it('falls back to the thread card when nothing is loaded yet', () => {
    const summary = summariseThread(
      message({ from_name: 'Ana', from_addr: 'ana@example.com' }),
      [],
      false,
    )
    expect(summary.participants.map((p) => p.name)).toEqual(['Ana'])
  })

  it('takes the latest date from the messages, not from the card alone', () => {
    const summary = summariseThread(
      message({ date: 100 }),
      [message({ id: '1', date: 900 }), message({ id: '2', date: 400 })],
      false,
    )
    expect(summary.lastDate).toBe(900)
  })

  it('reports no date rather than the epoch when nothing has one', () => {
    const summary = summariseThread(message({ date: 0 }), [message({ id: '1', date: 0 })], false)
    expect(summary.lastDate).toBeNull()
  })

  it('treats one message from one person as a message, not a conversation', () => {
    const alone = summariseThread(message({ message_count: 1 }), [message({ id: '1' })], false)
    expect(isConversation(alone)).toBe(false)
  })

  it('treats a thread the core counted as long as a conversation, even unloaded', () => {
    const long = summariseThread(message({ message_count: 9 }), [], true)
    expect(isConversation(long)).toBe(true)
  })

  it('treats two people as a conversation even with no count', () => {
    const two = summariseThread(
      message({}),
      [message({ id: '1', from_addr: 'a@x.com' }), message({ id: '2', from_addr: 'b@x.com' })],
      false,
    )
    expect(isConversation(two)).toBe(true)
  })
})
