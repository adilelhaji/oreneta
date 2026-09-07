import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { ThreadListItem } from './ThreadListItem'
import { ThreadTable } from './ThreadTable'
import type { Message } from '../../types'

afterEach(cleanup)

// A mailbox scrolled for a while. Threads arrive fifty at a time and stay, so
// this is an ordinary afternoon rather than a stress test.
const ROWS = 200

function threads(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    account_id: 'acc',
    folder_id: 'INBOX',
    thread_id: `t${i}`,
    from_name: `Person ${i}`,
    from_addr: `p${i}@example.com`,
    to: '',
    subject: `Subject number ${i}`,
    preview: 'A preview line of about the length these usually are',
    body: '',
    date: 1_700_000_000 - i * 60,
    unread: i % 3 === 0,
    starred: i % 7 === 0,
    has_attachments: i % 5 === 0,
    message_count: 1,
  })) as Message[]
}

/**
 * What one row of a list costs in DOM nodes.
 *
 * Not a stopwatch. A millisecond budget measured on a CI runner is a coin
 * toss, and a flaky performance gate is a gate everyone learns to ignore.
 * The node count is deterministic, and it is the thing that actually
 * multiplies: a wrapper div added to a row is one node in review and two
 * hundred in a scrolled mailbox.
 *
 * The numbers are a ceiling with room in it, not a target. Raising one is
 * allowed and is exactly the moment to notice you are doing it.
 */
describe('what a row of the thread list costs', () => {
  it('keeps a table row under its node budget', () => {
    const view = render(
      <ThreadTable
        threads={threads(ROWS)}
        accounts={[]}
        selectedThread=""
        showAccount={false}
        onSelect={() => undefined}
        onContextMenu={() => undefined}
      />,
    )
    const perRow = view.container.querySelectorAll('*').length / ROWS
    // Measured at 9.0 when this was written.
    expect(perRow).toBeLessThan(12)
  })

  it('keeps a card under its node budget', () => {
    const [thread] = threads(1)
    const view = render(
      <ThreadListItem
        thread={thread}
        accounts={[]}
        selectedAccount=""
        selectedThread=""
        onSelect={() => undefined}
      />,
    )
    // Measured at 19 when this was written.
    expect(view.container.querySelectorAll('*').length).toBeLessThan(26)
  })
})
