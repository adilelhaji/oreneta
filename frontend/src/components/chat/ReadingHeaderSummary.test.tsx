import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ReadingHeaderSummary } from './ReadingHeaderSummary'
import type { ReadingSummary } from './readingHeader'

afterEach(cleanup)

function summary(over: Partial<ReadingSummary> = {}): ReadingSummary {
  return {
    participants: [
      { name: 'Marc', address: 'marc@example.com', self: false },
      { name: 'Ana', address: 'ana@example.com', self: false },
    ],
    partial: false,
    messageCount: 4,
    unreadCount: 0,
    lastDate: null,
    ...over,
  }
}

describe('the line describing an open conversation', () => {
  it('names the people in it', () => {
    const view = render(
      <ReadingHeaderSummary summary={summary()} onOpenDetails={() => undefined} onSenderMenu={() => undefined} detailsOpen={false} />,
    )
    expect(view.container.textContent).toContain('Marc, Ana')
  })

  it('calls the reader "you" rather than by address', () => {
    const view = render(
      <ReadingHeaderSummary
        summary={summary({
          participants: [
            { name: 'Adil El Haji', address: 'me@example.com', self: true },
            { name: 'Ana', address: 'ana@example.com', self: false },
          ],
        })}
        onOpenDetails={() => undefined}
        onSenderMenu={() => undefined}
        detailsOpen={false}
      />,
    )
    expect(view.container.textContent).toContain('you, Ana')
    expect(view.container.textContent).not.toContain('Adil El Haji')
  })

  it('counts the rest instead of listing everyone', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      name: `P${i}`,
      address: `p${i}@example.com`,
      self: false,
    }))
    const view = render(
      <ReadingHeaderSummary summary={summary({ participants: many })} onOpenDetails={() => undefined} onSenderMenu={() => undefined} detailsOpen={false} />,
    )
    expect(view.container.textContent).toContain('P0, P1, P2')
    expect(view.container.textContent).toContain('and 3 more')
    expect(view.container.textContent).not.toContain('P4')
  })

  it('says the message count the core gave, not the one it could see', () => {
    const view = render(
      <ReadingHeaderSummary summary={summary({ messageCount: 30, partial: true })} onOpenDetails={() => undefined} onSenderMenu={() => undefined} detailsOpen={false} />,
    )
    expect(view.container.textContent).toContain('30 messages')
  })

  it('marks the cast as possibly short while older messages are unfetched', () => {
    const view = render(
      <ReadingHeaderSummary summary={summary({ partial: true })} onOpenDetails={() => undefined} onSenderMenu={() => undefined} detailsOpen={false} />,
    )
    expect(view.container.textContent).toContain('(possibly more)')
  })

  it('does not mark it when the whole conversation is in hand', () => {
    const view = render(
      <ReadingHeaderSummary summary={summary()} onOpenDetails={() => undefined} onSenderMenu={() => undefined} detailsOpen={false} />,
    )
    expect(view.container.textContent).not.toContain('possibly more')
  })

  it('shows unread only when there is some', () => {
    const none = render(
      <ReadingHeaderSummary summary={summary({ unreadCount: 0 })} onOpenDetails={() => undefined} onSenderMenu={() => undefined} detailsOpen={false} />,
    )
    expect(none.container.textContent).not.toContain('unread')
    cleanup()
    const some = render(
      <ReadingHeaderSummary summary={summary({ unreadCount: 2 })} onOpenDetails={() => undefined} onSenderMenu={() => undefined} detailsOpen={false} />,
    )
    expect(some.container.textContent).toContain('2 unread')
  })

  it('says nothing about a count nobody knows', () => {
    const view = render(
      <ReadingHeaderSummary
        summary={summary({ messageCount: null, unreadCount: null })}
        onOpenDetails={() => undefined}
        onSenderMenu={() => undefined}
        detailsOpen={false}
      />,
    )
    expect(view.container.textContent).not.toContain('message')
    expect(view.container.textContent).not.toContain('unread')
  })

  it('opens the details panel, where the full cast lives', () => {
    let opened = 0
    const view = render(
      <ReadingHeaderSummary summary={summary()} onOpenDetails={() => (opened += 1)} onSenderMenu={() => undefined} detailsOpen={false} />,
    )
    fireEvent.click(view.container.querySelector('button')!)
    expect(opened).toBe(1)
  })

  it('keeps the sender actions on the right button', () => {
    let menus = 0
    const view = render(
      <ReadingHeaderSummary summary={summary()} onOpenDetails={() => undefined} onSenderMenu={() => (menus += 1)} detailsOpen={false} />,
    )
    fireEvent.contextMenu(view.container.querySelector('button')!)
    expect(menus).toBe(1)
  })
})
