import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import i18n from '../lib/i18n'
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
// English interface. The element holding it is isolated (dir="auto" or <bdi>),
// so the browser orders it by its own letters and it cannot reorder the
// interface text around it.
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

/** The nearest element that isolates the text and lets it pick its direction. */
function isolatingHolder(container: HTMLElement, text: string): Element | null {
  const holder = [...container.querySelectorAll('*')].find(
    (element) => [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.includes(text)),
  )
  return holder?.closest('[dir="auto"], bdi') ?? null
}

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

for (const [language, subject, from] of [
  ['ar', LATIN, 'Ana Ruiz'],
  ['en', ARABIC, ARABIC_NAME],
] as const) {
  describe(`${language === 'ar' ? 'a Latin' : 'an Arabic'} subject in the ${language === 'ar' ? 'Arabic' : 'English'} interface`, () => {
    it('keeps its own direction in a list card', async () => {
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
      expect(isolatingHolder(view.container, subject)).not.toBeNull()
      expect(isolatingHolder(view.container, from)).not.toBeNull()
      expect(isolatingHolder(view.container, 'See the attached figures')).not.toBeNull()
      expect(view.container.textContent).toContain(subject)
    })

    it('keeps its own direction in a table row', async () => {
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
      expect(isolatingHolder(view.container, subject)).not.toBeNull()
      expect(isolatingHolder(view.container, from)).not.toBeNull()
    })

    it('keeps its own direction in the reader heading and its tooltip', async () => {
      await interfaceIn(language)
      const view = render(<ConversationSubject subject={subject} copyLabel="Copy" onCopy={() => undefined} />)
      const holders = [...view.container.querySelectorAll('bdi, [dir="auto"]')].filter(
        (element) => element.textContent === subject,
      )
      expect(holders).toHaveLength(2)
    })
  })
}

describe('names and labels from people', () => {
  it('isolates each name in the line under the subject, so commas stay put', () => {
    const view = render(
      <ReadingHeaderSummary
        summary={{
          participants: [
            { name: ARABIC_NAME, address: 'layla@example.com', self: false },
            { name: 'Marc', address: 'marc@example.com', self: false },
          ],
          partial: false,
          messageCount: 2,
          unreadCount: 0,
          lastDate: null,
        }}
        onOpenDetails={() => undefined}
        onSenderMenu={() => undefined}
        detailsOpen={false}
      />,
    )
    const names = [...view.container.querySelectorAll('bdi')].map((element) => element.textContent)
    expect(names).toEqual([ARABIC_NAME, 'Marc'])
    expect(view.container.textContent).toContain(`${ARABIC_NAME}, Marc`)
  })

  it('lets a chip (a recipient, a label) take the direction of its own text', () => {
    const view = render(<Chip>{ARABIC_NAME}</Chip>)
    expect(isolatingHolder(view.container, ARABIC_NAME)).not.toBeNull()
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
    expect(view.container.querySelector('pre')?.getAttribute('dir')).toBe('ltr')
  })

  it('lets an HTML message that declares nothing take the direction of its text, and keeps a declared one', () => {
    const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')
    expect(parse(prepareBubbleHtml(`<p>${ARABIC}</p>`)).body.getAttribute('dir')).toBe('auto')
    expect(parse(prepareBubbleHtml(`<html dir="ltr"><body><p>${LATIN}</p></body></html>`)).body.hasAttribute('dir')).toBe(
      false,
    )
  })
})
