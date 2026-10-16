import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import i18n from '../lib/i18n'
import { firstStrongDirection, type TextDirection } from '../lib/direction'
import { applyDocumentLanguage } from '../states/settings'
import { ThreadListItem } from './threads/ThreadListItem'
import { ThreadTable } from './threads/ThreadTable'
import { ConversationSubject } from './chat/ConversationSubject'
import { ReadingHeaderSummary } from './chat/ReadingHeaderSummary'
import { MessageBubbleBody } from './chat/MessageBubbleBody'
import { prepareBubbleHtml } from './chat/bubbleHtml'
import { Chip } from './chip/Chip'
import type { Message } from '../types'

// Text people write keeps its own direction inside the interface's (#226,
// ADR-0061): a Latin subject in the Arabic interface, an Arabic one in the
// English interface. happy-dom does not resolve dir="auto", so the direction
// each piece of text ends up with is worked out here by the HTML rule the
// browser applies (the production-entry checks read the real computed
// `direction` in Chromium).
afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
  applyDocumentLanguage('en')
})

const LATIN = 'Quarterly budget review'
const ARABIC = 'مراجعة الميزانية الفصلية'
const ARABIC_NAME = 'ليلى حداد'

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    account_id: 'acc',
    folder_id: 'INBOX',
    thread_id: 't1',
    from_name: 'Ana Ruiz',
    from_addr: 'ana@example.com',
    to: '',
    subject: LATIN,
    preview: 'See the attached figures',
    body: '',
    date: 1_700_000_000,
    unread: true,
    starred: false,
    has_attachments: false,
    message_count: 1,
    ...over,
  } as Message
}

/** Text of an element as dir="auto" reads it: nested elements with their own direction are skipped. */
function autoText(element: Element): string {
  let text = ''
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3) text += node.textContent ?? ''
    else if (node instanceof Element && !node.hasAttribute('dir') && node.tagName !== 'BDI') text += autoText(node)
  }
  return text
}

/** The direction an element resolves to under the HTML rules for `dir`. */
function resolvedDirection(element: Element | null): TextDirection {
  if (!element) return 'ltr'
  const dir = element.getAttribute('dir')
  if (dir === 'ltr' || dir === 'rtl') return dir
  if (dir === 'auto' || element.tagName === 'BDI') {
    return firstStrongDirection(autoText(element)) ?? resolvedDirection(element.parentElement)
  }
  return resolvedDirection(element.parentElement)
}

/** The element that holds the text itself. */
function holderOf(container: HTMLElement, text: string): Element {
  const holder = [...container.querySelectorAll('*')].find((element) =>
    [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.includes(text)),
  )
  if (!holder) throw new Error(`no element holds ${text}`)
  return holder
}

/** True when the text is isolated from what surrounds it (dir="auto" or <bdi> on the way up). */
const isolated = (holder: Element) => !!holder.closest('[dir="auto"], [dir="ltr"], [dir="rtl"]:not(html), bdi')

async function interfaceIn(language: 'en' | 'ar') {
  await i18n.changeLanguage(language)
  applyDocumentLanguage(language)
}

describe('the interface direction follows its language', () => {
  it('turns the document right to left for Arabic and back without a reload', async () => {
    await interfaceIn('ar')
    expect(document.documentElement.dir).toBe('rtl')
    expect(document.documentElement.lang).toBe('ar')
    await interfaceIn('en')
    expect(document.documentElement.dir).toBe('ltr')
    expect(document.documentElement.lang).toBe('en')
  })
})

for (const [language, subject, from, own] of [
  ['ar', LATIN, 'Ana Ruiz', 'ltr'],
  ['en', ARABIC, ARABIC_NAME, 'rtl'],
] as const) {
  const ui = language === 'ar' ? 'rtl' : 'ltr'
  describe(`${language === 'ar' ? 'a Latin' : 'an Arabic'} subject in the ${language === 'ar' ? 'Arabic' : 'English'} interface`, () => {
    it('reads in its own direction in a list card, inside a row in the interface direction', async () => {
      await interfaceIn(language)
      const view = render(
        <ThreadListItem
          thread={message({ subject, from_name: from })}
          accounts={[]}
          selectedAccount=""
          selectedThread=""
          onSelect={() => undefined}
        />,
      )
      for (const text of [subject, from]) {
        const holder = holderOf(view.container, text)
        expect(isolated(holder)).toBe(true)
        expect(resolvedDirection(holder)).toBe(own)
      }
      expect(isolated(holderOf(view.container, 'See the attached figures'))).toBe(true)
      expect(resolvedDirection(view.container.firstElementChild)).toBe(ui)
    })

    it('reads in its own direction in a table row', async () => {
      await interfaceIn(language)
      const view = render(
        <ThreadTable
          threads={[message({ subject, from_name: from })]}
          accounts={[]}
          selectedThread=""
          showAccount={false}
          onSelect={() => undefined}
          onContextMenu={() => undefined}
        />,
      )
      for (const text of [subject, from]) expect(resolvedDirection(holderOf(view.container, text))).toBe(own)
      expect(resolvedDirection(view.container.querySelector('table'))).toBe(ui)
    })

    it('reads in its own direction in the reader heading and its tooltip', async () => {
      await interfaceIn(language)
      const view = render(<ConversationSubject subject={subject} copyLabel="Copy" onCopy={() => undefined} />)
      const holders = [...view.container.querySelectorAll('*')].filter(
        (element) =>
          element.childNodes.length === 1 && element.firstChild?.nodeType === 3 && element.textContent === subject,
      )
      expect(holders).toHaveLength(2)
      for (const holder of holders) expect(resolvedDirection(holder)).toBe(own)
    })
  })
}

describe('names and labels from people', () => {
  it('isolates each name in the line under the subject, so separators stay put', async () => {
    const summary = {
      participants: [
        { name: ARABIC_NAME, address: 'layla@example.com', self: false },
        { name: 'Marc', address: 'marc@example.com', self: false },
      ],
      partial: false,
      messageCount: 2,
      unreadCount: 0,
      lastDate: null,
    }
    const show = () =>
      render(
        <ReadingHeaderSummary
          summary={summary}
          onOpenDetails={() => undefined}
          onSenderMenu={() => undefined}
          detailsOpen={false}
        />,
      )
    let view = show()
    const names = [...view.container.querySelectorAll('bdi')]
    expect(names.map((element) => element.textContent)).toEqual([ARABIC_NAME, 'Marc'])
    expect(names.map(resolvedDirection)).toEqual(['rtl', 'ltr'])
    expect(view.container.textContent).toContain(`${ARABIC_NAME}, Marc`)
    cleanup()
    // In Arabic the names are separated with the Arabic comma.
    await interfaceIn('ar')
    view = show()
    expect(view.container.textContent).toContain(`${ARABIC_NAME}، Marc`)
  })

  it('lets a chip (a recipient, a label) take the direction of its own text', () => {
    const view = render(<Chip>{ARABIC_NAME}</Chip>)
    expect(resolvedDirection(holderOf(view.container, ARABIC_NAME))).toBe('rtl')
  })
})

describe('message bodies', () => {
  it('gives each paragraph of a plain-text body its own direction, and code a left-to-right one', async () => {
    await interfaceIn('ar')
    const view = render(
      <MessageBubbleBody
        message={message({ body: `${ARABIC}\nThanks, see below.\n\`\`\`\nconst a = 1\n\`\`\`` })}
        useHtmlBody={false}
        normalizedSearchQuery=""
        activeSearchMatch={false}
      />,
    )
    expect(view.container.querySelector('.bidi-plaintext')?.textContent).toContain(ARABIC)
    expect(resolvedDirection(view.container.querySelector('pre code'))).toBe('ltr')
  })

  it('lets each paragraph of an HTML message that declares nothing take its own direction, and keeps a declared one', () => {
    const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')
    const mixed = parse(prepareBubbleHtml(`<p>${ARABIC}</p><p>${LATIN}</p>`))
    expect([...mixed.body.querySelectorAll('p')].map(resolvedDirection)).toEqual(['rtl', 'ltr'])
    expect(mixed.body.hasAttribute('dir')).toBe(false)
    const declared = parse(prepareBubbleHtml(`<html dir="ltr"><body><p>${ARABIC}</p></body></html>`))
    expect(declared.querySelector('p')!.hasAttribute('dir')).toBe(false)
    expect(resolvedDirection(declared.querySelector('p'))).toBe('ltr')
  })
})
