import { afterEach, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { ReportNotice, REPORT_OUTCOME_TEXT, reportReason } from './ReportNotice'
import { MessageContent } from './MessageContent'

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

it('shows on a sent message what each report said, with the reason for a failure', () => {
  const sent = message({
    delivery: [
      { kind: 'delivery', recipient: 'bob@example.test', outcome: 'delivered', reported_at: 1 },
      {
        kind: 'delivery',
        recipient: 'nobody@example.test',
        outcome: 'failed',
        status: '5.1.1',
        diagnostic: 'User unknown',
        reported_at: 1,
      },
      { kind: 'delivery', recipient: 'slow@example.test', outcome: 'delayed', reported_at: 1 },
      { kind: 'disposition', recipient: 'bob@example.test', outcome: 'displayed', reported_at: 2 },
    ],
  })
  const shown = render(<ReportNotice message={sent} outgoing />)
  expect(shown.getByRole('group', { name: 'Delivery and read reports' })).toBeTruthy()
  expect(shown.getByText('Delivered to bob@example.test')).toBeTruthy()
  expect(shown.getByText('Not delivered to nobody@example.test')).toBeTruthy()
  expect(shown.getByText('Reason: 5.1.1 · User unknown')).toBeTruthy()
  expect(shown.getByText('Delayed for slow@example.test; the server is still trying')).toBeTruthy()
  expect(shown.getByText('Displayed to bob@example.test')).toBeTruthy()
})

it('shows on a report what it says, and nothing on a message without reports', () => {
  const bounce = message({
    folder_id: 'INBOX',
    report: {
      kind: 'disposition',
      original_message_id: 'plan-1@example.test',
      recipients: [{ recipient: 'bob@example.test', outcome: 'notDisplayed' }],
    },
  })
  const shown = render(<ReportNotice message={bounce} outgoing={false} />)
  expect(shown.getByText('Read report about a message you sent')).toBeTruthy()
  expect(shown.getByText('Handled for bob@example.test without being displayed')).toBeTruthy()
  cleanup()

  // Reports about a message are only shown on one this account sent, and a
  // report only on a received one.
  expect(render(<ReportNotice message={message()} outgoing />).container.textContent).toBe('')
  expect(render(<ReportNotice message={bounce} outgoing />).container.textContent).toBe('')
  expect(render(<ReportNotice message={message({ delivery: [] })} outgoing={false} />).container.textContent).toBe('')
})

it('is part of the reader, above the body', () => {
  const sent = message({ delivery: [{ kind: 'delivery', recipient: 'bob@example.test', outcome: 'relayed', reported_at: 1 }] })
  const shown = render(<MessageContent message={sent} view={view(true)} galleryOffset={0} />)
  expect(shown.getByText('Passed on for bob@example.test; no further report will come')).toBeTruthy()
})

it('names every outcome the core can report, and builds the reason from what is there', () => {
  expect(Object.keys(REPORT_OUTCOME_TEXT).sort()).toEqual(
    ['delayed', 'delivered', 'displayed', 'failed', 'notDisplayed', 'relayed'].sort(),
  )
  expect(reportReason({ recipient: 'a', outcome: 'failed', status: '5.2.2' })).toBe('5.2.2')
  expect(reportReason({ recipient: 'a', outcome: 'failed', diagnostic: 'Mailbox full' })).toBe('Mailbox full')
  expect(reportReason({ recipient: 'a', outcome: 'failed' })).toBe('')
})
