import { describe, expect, it } from 'bun:test'
import { buildReplyRecipients, detectAliasFrom } from './compose'
import { parseRecipients } from '../lib/recipients'
import { formatContact } from '../lib/contacts'
import { commitPending } from '../lib/recipientField'
import type { Account, Message } from '../types'

const message = (over: Partial<Message>): Message =>
  ({
    id: 'm1',
    account_id: 'acc',
    folder_id: 'INBOX',
    thread_id: 't1',
    subject: 'Hi',
    from_name: '',
    from_addr: 'x@example.com',
    to: '',
    cc: '',
    reply_to: '',
    ...over,
  }) as Message

// Names written "Last, First" are common in directories and in Outlook. Each
// path that turns a header or a contact into a recipient field must keep such
// a person whole, or a reply goes to "Doe" and "John <j@example.com>".
describe('recipients whose names contain a comma (#39)', () => {
  it('reply-all keeps a quoted name in Cc as one person', () => {
    const { cc } = buildReplyRecipients(
      message({ to: 'me@example.com', cc: '"Doe, John" <j@example.com>, b@example.com' }),
      new Set(['me@example.com']),
    )
    expect(parseRecipients(cc).map((r) => r.address)).toEqual(['j@example.com', 'b@example.com'])
  })

  it('reply-all drops the reader’s own quoted entry whole, leaving no fragment', () => {
    const { cc } = buildReplyRecipients(
      message({ to: 'x@example.com', cc: '"Me, Myself" <me@example.com>, b@example.com' }),
      new Set(['me@example.com']),
    )
    const parsed = parseRecipients(cc)
    expect(parsed.map((r) => r.address)).toEqual(['b@example.com'])
    expect(parsed.every((r) => r.status === 'ok')).toBe(true)
  })

  it('a reply to a sender named "Last, First" addresses one valid recipient', () => {
    const { to } = buildReplyRecipients(
      message({ from_name: 'Doe, John', from_addr: 'j@example.com' }),
      new Set(['me@example.com']),
    )
    const parsed = parseRecipients(to)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ name: 'Doe, John', address: 'j@example.com', status: 'ok' })
  })

  it('a Reply-To list with a quoted name is not split inside the quotes', () => {
    const { to } = buildReplyRecipients(
      message({ reply_to: '"Team, Support" <s@example.com>' }),
      new Set(['me@example.com']),
    )
    expect(parseRecipients(to).map((r) => r.address)).toEqual(['s@example.com'])
  })

  it('the alias a message reached is found behind a quoted name', () => {
    const account = {
      id: 'acc',
      email: 'me@example.com',
      aliases: [{ email: 'sales@example.com', name: 'Sales' }],
    } as unknown as Account
    expect(detectAliasFrom(message({ to: '"Sales, EU" <sales@example.com>' }), account)).toBe('sales@example.com')
  })

  it('a suggested contact named "Last, First" becomes one chip', () => {
    const field = commitPending('', formatContact({ name: 'Doe, John', addr: 'j@example.com' } as any))
    const parsed = parseRecipients(field)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ name: 'Doe, John', address: 'j@example.com' })
  })
})
