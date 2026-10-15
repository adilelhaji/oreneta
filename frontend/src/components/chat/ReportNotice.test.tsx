import { afterEach, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { ReportNotice, REPORT_OUTCOME_TEXT, isolate, serverWords, statusPhrase } from './ReportNotice'
import { MessageContent } from './MessageContent'
import { formatThreadDate } from '../../lib/date'
import { deliveryReceiptToast } from '../../lib/deliveryReceipt'

afterEach(() => cleanup())

const message = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'acct#Sent#7',
    folder_id: 'Sent',
    thread_id: 'acct#Sent#t',
    account_id: 'acct',
    message_id: 'plan-1@example.test',
    body: 'Hello',
    ...overrides,
  }) as any

const view = (outgoing: boolean) =>
  ({
    outgoing,
    isDraft: false,
    attachmentImages: [],
    bubbleAttachmentImages: [],
    videos: [],
    files: [],
    hiddenRemoteCount: 0,
    useHtmlBody: false,
    normalizedSearchQuery: '',
    activeSearchMatch: false,
  }) as any

const at = 1_760_000_000
const text = (node: { container: HTMLElement }) => node.container.textContent ?? ''

it('shows on a sent message what each report claims, failures first, with when and why', () => {
  const sent = message({
    delivery: [
      { kind: 'delivery', recipient: 'bob@example.test', outcome: 'delivered', reported_at: at, listed: true },
      { kind: 'disposition', recipient: 'bob@example.test', outcome: 'displayed', reported_at: at, listed: true },
      { kind: 'delivery', recipient: 'slow@example.test', outcome: 'delayed', reported_at: at, listed: true },
      {
        kind: 'delivery',
        recipient: 'nobody@example.test',
        outcome: 'failed',
        status: '5.1.1',
        diagnostic: '550 5.1.1 <nobody@example.test>: Recipient address rejected',
        reported_at: at,
        listed: true,
      },
    ],
  })
  const shown = render(<ReportNotice message={sent} outgoing />)
  expect(shown.getByRole('group', { name: 'Delivery and read reports' })).toBeTruthy()
  const lines = shown.getAllByRole('listitem').map((item) => item.textContent ?? '')
  const date = isolate(formatThreadDate(at))
  // Failures first, then the delay, then what went through.
  expect(lines[0]).toContain(`The report says it was not delivered to ${isolate('nobody@example.test')}`)
  expect(lines[0]).toContain('Reason: The address does not exist')
  // The server's own words, without the codes already said.
  expect(lines[0]).toContain('<nobody@example.test>: Recipient address rejected')
  expect(lines[0]).not.toContain('550 5.1.1')
  expect(lines[1]).toContain(`As of ${date}, the report says delivery to ${isolate('slow@example.test')} is delayed`)
  expect(lines[2]).toContain(`The report says it was delivered to ${isolate('bob@example.test')}`)
  expect(lines[2]).toContain(`Reported ${date}`)
  expect(lines[3]).toContain(`${isolate('bob@example.test')}’s mail program says it was displayed`)
  expect(text(shown)).not.toContain('Not a recipient of this message')
})

it('marks a report about somebody the message was not addressed to', () => {
  const sent = message({
    delivery: [{ kind: 'delivery', recipient: 'stranger@example.test', outcome: 'delivered', reported_at: at, listed: false }],
  })
  expect(text(render(<ReportNotice message={sent} outgoing />))).toContain('Not a recipient of this message')
})

it('heads a report about a message of this account as such, and any other neutrally', () => {
  const report = {
    kind: 'disposition',
    original_message_id: 'plan-1@example.test',
    recipients: [{ recipient: 'bob@example.test', outcome: 'notDisplayed' }],
  }
  const linked = render(<ReportNotice message={message({ folder_id: 'INBOX', report, report_linked: true })} outgoing={false} />)
  expect(text(linked)).toContain('Read report about a message you sent')
  expect(text(linked)).toContain('mail program says it handled the message without displaying it')
  cleanup()
  const stranger = render(<ReportNotice message={message({ folder_id: 'INBOX', report })} outgoing={false} />)
  expect(text(stranger)).toContain('Read report')
  expect(text(stranger)).not.toContain('a message you sent')
  cleanup()
  const bounce = { ...report, kind: 'delivery', recipients: [{ recipient: 'x@example.test', outcome: 'failed', status: '5.2.2' }] }
  const delivery = render(<ReportNotice message={message({ folder_id: 'INBOX', report: bounce })} outgoing={false} />)
  expect(text(delivery)).toContain('Delivery report')
  expect(text(delivery)).toContain('Reason: The mailbox is full')
})

it('shows nothing where there is nothing to show', () => {
  const report = { kind: 'delivery', original_message_id: 'x', recipients: [{ recipient: 'a', outcome: 'failed' }] }
  expect(text(render(<ReportNotice message={message()} outgoing />))).toBe('')
  expect(text(render(<ReportNotice message={message({ report })} outgoing />))).toBe('')
  expect(text(render(<ReportNotice message={message({ delivery: [] })} outgoing={false} />))).toBe('')
})

it('is part of the reader, above the body', () => {
  const sent = message({ delivery: [{ kind: 'delivery', recipient: 'bob@example.test', outcome: 'relayed', reported_at: at }] })
  const shown = render(<MessageContent message={sent} view={view(true)} galleryOffset={0} />)
  expect(text(shown)).toContain('no further report will come')
})

it('names every outcome, reads common status codes and keeps only the server words', () => {
  expect(Object.keys(REPORT_OUTCOME_TEXT).sort()).toEqual(
    ['delayed', 'delivered', 'displayed', 'failed', 'notDisplayed', 'relayed'].sort(),
  )
  expect(statusPhrase('5.1.1')).toBe('noAddress')
  expect(statusPhrase('5.1.10')).toBe('noAddress')
  expect(statusPhrase('4.2.2')).toBe('mailboxFull')
  expect(statusPhrase('5.7.1')).toBe('policy')
  expect(statusPhrase('4.4.1')).toBe('temporary')
  expect(statusPhrase('5.3.0')).toBeNull()
  expect(statusPhrase(undefined)).toBeNull()
  expect(serverWords({ recipient: 'a', outcome: 'failed', status: '5.2.2', diagnostic: '552 5.2.2 Mailbox full' })).toBe('Mailbox full')
  expect(serverWords({ recipient: 'a', outcome: 'failed', diagnostic: 'Host unreachable' })).toBe('Host unreachable')
  expect(isolate('בוב@example.test')).toBe('⁨בוב@example.test⁩')
})

it('tells the sender why a delivery receipt was not requested on Microsoft 365', () => {
  expect(deliveryReceiptToast({ delivery_receipt: 'requested' })).toBe('Sent')
  expect(deliveryReceiptToast({ delivery_receipt: 'unsupported' })).toContain('does not offer delivery receipts')
  expect(deliveryReceiptToast({ delivery_receipt: 'unsupported', delivery_receipt_reason: 'needsChanges' })).toContain(
    'needs changes allowed',
  )
  expect(deliveryReceiptToast({ delivery_receipt: 'unsupported', delivery_receipt_reason: 'bcc' })).toContain('Bcc')
  expect(deliveryReceiptToast({ delivery_receipt: 'unsupported', delivery_receipt_reason: 'protected' })).toContain(
    'signed or encrypted',
  )
  expect(deliveryReceiptToast({ delivery_receipt: 'unsupported', delivery_receipt_reason: 'other' })).toContain(
    'does not offer delivery receipts',
  )
})
