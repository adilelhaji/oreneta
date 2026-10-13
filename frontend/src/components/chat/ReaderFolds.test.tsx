import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { settings$ } from '../../states/settings'
import { isFitWidth, readerFitOverrides$, toggleFitWidth } from '../../states/readerFit'
import type { Message } from '../../types'
import { ReaderFoldingRows } from '../dialog/ReaderFoldingRows'
import { MessageBubbleBody } from './MessageBubbleBody'
import { MessageContextMenu } from './MessageContextMenu'
import { PlainFoldedText } from './ReaderFolds'
import { prepareBubbleHtml } from './bubbleHtml'
import { MIN_FIT_FACTOR, nextFitFactor } from './fitWidth'

const REPLY = 'Sounds good.\n\n-- \nAna Ruiz\n\nOn Mon, Oct 12, 2026, Ben Ode <ben@example.test> wrote:\n> Thursday?\n> Let me know.'

const message: Message = {
  id: 'm-1',
  account_id: 'acc-1',
  folder_id: 'INBOX',
  thread_id: 't-1',
  from_name: 'Ana',
  from_addr: 'ana@example.test',
  to: 'me@example.test',
  subject: 'Re: Thursday',
  preview: 'Sounds good.',
  body: REPLY,
  date: 0,
  unread: false,
  starred: false,
  has_attachments: false,
}

beforeEach(() => {
  settings$.readerFoldQuotes.set(true)
  settings$.readerFoldSignatures.set(false)
  settings$.readerFitWidth.set(false)
  readerFitOverrides$.set({})
})

afterEach(() => {
  cleanup()
})

describe('plain-text folds', () => {
  it('hides the quote behind a toggle that opens and closes it', () => {
    const view = render(<MessageBubbleBody message={message} useHtmlBody={false} normalizedSearchQuery="" activeSearchMatch={false} />)
    expect(view.queryByText(/Thursday\?/)).toBeNull()
    expect(view.getByText(/Ana Ruiz/)).toBeTruthy()
    const toggle = view.getByRole('button', { name: /Show quoted text/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(view.getByText(/Thursday\?/)).toBeTruthy()
    const hide = view.getByRole('button', { name: /Hide quoted text/ })
    expect(hide.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(hide)
    expect(view.queryByText(/Thursday\?/)).toBeNull()
  })

  it('folds the signature only when the setting asks for it', () => {
    settings$.readerFoldSignatures.set(true)
    const view = render(<PlainFoldedText text={REPLY} render={(text) => text} />)
    expect(view.queryByText(/Ana Ruiz/)).toBeNull()
    fireEvent.click(view.getByRole('button', { name: /Show signature/ }))
    expect(view.getByText(/Ana Ruiz/)).toBeTruthy()
  })

  it('shows everything when folding is off', () => {
    settings$.readerFoldQuotes.set(false)
    const view = render(<PlainFoldedText text={REPLY} render={(text) => text} />)
    expect(view.queryByRole('button')).toBeNull()
    expect(view.getByText(/Thursday\?/)).toBeTruthy()
  })

  it('opens a fold that holds a search hit', () => {
    const view = render(<PlainFoldedText text={REPLY} render={(text) => text} searchQuery="let me" />)
    expect(view.getByText(/Let me know/)).toBeTruthy()
    expect(view.getByRole('button', { name: /Hide quoted text/ })).toBeTruthy()
  })
})

describe('HTML folds in the bubble document', () => {
  const gmail =
    '<div dir="ltr">Yes.</div><div class="gmail_quote"><div class="gmail_attr">On Mon, Ben wrote:<br></div><blockquote class="gmail_quote"><div>Lunch?</div></blockquote></div>'

  it('wraps quoted history in a closed details toggle under the frame CSP', () => {
    const prepared = prepareBubbleHtml(gmail, undefined, { fold: { quotes: true, signatures: false } })
    const doc = new DOMParser().parseFromString(prepared, 'text/html')
    const details = doc.querySelector('details.oreneta-fold-quote') as HTMLDetailsElement
    expect(details).not.toBeNull()
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')!.textContent).toContain('Show quoted text')
    expect(doc.getElementById('oreneta-fold-style')).not.toBeNull()
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')).toContain(
      "script-src 'none'",
    )
    expect(doc.querySelector('script')).toBeNull()
  })

  it('leaves the document alone without fold options, and marks a fitted one', () => {
    const prepared = prepareBubbleHtml(gmail)
    expect(prepared).not.toContain('<details')
    expect(prepareBubbleHtml(gmail, undefined, { fitWidth: true })).toContain('data-oreneta-fit')
  })
})

describe('fit to width', () => {
  it('shrinks by the overflow ratio, never below the floor, and never grows', () => {
    expect(nextFitFactor(1, 1200, 600)).toBeCloseTo(0.5)
    expect(nextFitFactor(1, 600, 600)).toBe(1)
    expect(nextFitFactor(0.5, 601, 600)).toBe(0.5)
    expect(nextFitFactor(1, 10_000, 600)).toBe(MIN_FIT_FACTOR)
    expect(nextFitFactor(0.5, 300, 600)).toBe(0.5)
  })

  it('follows the setting until a message is switched from its menu', () => {
    expect(isFitWidth('m-1')).toBe(false)
    settings$.readerFitWidth.set(true)
    expect(isFitWidth('m-1')).toBe(true)
    toggleFitWidth('m-1')
    expect(isFitWidth('m-1')).toBe(false)
    expect(isFitWidth('m-2')).toBe(true)
  })

  it('offers the per-message action for HTML messages only', () => {
    const html = { ...message, body_html: '<table width="1200"><tr><td>Wide</td></tr></table>' }
    let closed = 0
    const view = render(
      <MessageContextMenu state={{ x: 0, y: 0, message: html }} isRSS={false} onClose={() => (closed += 1)} />,
    )
    fireEvent.click(view.getByText('Fit to window'))
    expect(closed).toBe(1)
    expect(isFitWidth('m-1')).toBe(true)
    cleanup()
    const plain = render(<MessageContextMenu state={{ x: 0, y: 0, message }} isRSS={false} onClose={() => undefined} />)
    expect(plain.queryByText('Fit to window')).toBeNull()
    expect(plain.queryByText('Show at original size')).toBeNull()
  })
})

describe('reading settings', () => {
  it('toggles the three reader preferences', () => {
    const view = render(<ReaderFoldingRows />)
    const quotes = view.getByRole('switch', { name: 'Fold quoted text' })
    const signatures = view.getByRole('switch', { name: 'Fold signatures' })
    const fit = view.getByRole('switch', { name: 'Fit wide messages to the window' })
    expect(quotes.getAttribute('aria-checked')).toBe('true')
    expect(signatures.getAttribute('aria-checked')).toBe('false')
    expect(fit.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(quotes)
    fireEvent.click(signatures)
    fireEvent.click(fit)
    expect(settings$.readerFoldQuotes.peek()).toBe(false)
    expect(settings$.readerFoldSignatures.peek()).toBe(true)
    expect(settings$.readerFitWidth.peek()).toBe(true)
  })
})
