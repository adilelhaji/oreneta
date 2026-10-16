import { describe, expect, it } from 'bun:test'
import i18n from './i18n'
import { buildPrintDocument, escapeHtml, printableBody, printedMessages } from './printDocument'
import { DEFAULT_PRINT_OPTIONS, type PrintOptions } from './printOptions'
import type { Message } from '../types'

const message = (over: Partial<Message> = {}): Message =>
  ({
    id: 'm-1',
    account_id: 'acct',
    folder_id: 'INBOX',
    thread_id: 't-1',
    from_name: 'Ann Example',
    from_addr: 'ann@example.com',
    to: 'me@example.com',
    subject: 'Lunch',
    preview: '',
    body: 'See you at one.',
    date: 1_700_000_000,
    unread: false,
    starred: false,
    has_attachments: false,
    ...over,
  }) as Message

const ONE_MESSAGE = 'Only this message of the conversation is printed.'
const ONE_MAYBE = 'Only this message is printed; other messages of the conversation, if any, are not.'

const build = (messages: Message[], subject = 'Lunch') =>
  buildPrintDocument({
    subject,
    messages,
    printedLabel: 'Printed',
    printedAt: new Date(1_700_000_000_000),
    toLabel: 'To',
    ccLabel: 'Cc',
    bccLabel: 'Bcc',
    attachmentsLabel: 'Attachments:',
    oneMessageNotice: ONE_MESSAGE,
    oneMessageUnknownNotice: ONE_MAYBE,
  })

describe('a conversation on paper', () => {
  it('says who wrote each message, in words', () => {
    const page = build([message()])
    // On paper there is no colour, no left and right, and nothing to hover:
    // the sender has to be spelled out.
    expect(page).toContain('Ann Example')
    expect(page).toContain('ann@example.com')
    expect(page).toContain('me@example.com')
  })

  it('falls back to the address when there is no name', () => {
    const page = build([message({ from_name: '' })])
    expect(page).toContain('ann@example.com')
    expect(page).not.toContain('&lt;&gt;')
  })

  it('prints every message of the conversation, in order', () => {
    const page = build([message({ id: 'm-1', body: 'First thing' }), message({ id: 'm-2', body: 'Second thing' })])
    expect(page.indexOf('First thing')).toBeLessThan(page.indexOf('Second thing'))
    expect(page.match(/<article class="message">/g)).toHaveLength(2)
  })

  it('names the page after the subject, so a printed sheet can be filed', () => {
    expect(build([message()], 'Quarterly report')).toContain('<title>Quarterly report</title>')
    expect(build([message()], '   ')).toContain('<title>(no subject)</title>')
  })

  it('says "no subject" in the interface language (#231)', async () => {
    await i18n.changeLanguage('ca')
    try {
      expect(build([message()], '   ')).toContain('<title>(sense assumpte)</title>')
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('keeps the line breaks of a plain-text message', () => {
    const page = build([message({ body: 'One\nTwo' })])
    expect(page).toContain('<pre class="plain">One\nTwo</pre>')
  })

  it('escapes text that would otherwise be read as markup', () => {
    expect(escapeHtml('<b>&"</b>')).toBe('&lt;b&gt;&amp;&quot;&lt;/b&gt;')
    const page = build([message({ subject: '<script>x</script>', body: '5 < 6' })])
    expect(page).not.toContain('<script>')
    expect(page).toContain('5 &lt; 6')
  })

  it('strips the scripting out of an HTML message', () => {
    const body = printableBody(
      message({
        body_html: '<p onclick="steal()">Hi</p><script>steal()</script><a href="javascript:steal()">go</a>',
      }),
    )
    // The print document is same-origin, so an email's own JavaScript would be
    // running with the app's privileges if it were left in.
    expect(body).not.toContain('<script')
    expect(body).not.toContain('onclick')
    expect(body).not.toContain('javascript:')
    expect(body).toContain('Hi')
  })

  it('keeps the formatting of an HTML message that is not dangerous', () => {
    const body = printableBody(message({ body_html: '<p><strong>Bold</strong> and <em>italic</em></p>' }))
    expect(body).toContain('<strong>Bold</strong>')
    expect(body).toContain('<em>italic</em>')
  })

  it('lists attachments by name, since paper cannot carry the files', () => {
    const page = build([
      message({
        has_attachments: true,
        attachments: [
          { filename: 'report.pdf', mime: 'application/pdf', size: 10, key: 'k1' },
          { filename: 'notes.txt', mime: 'text/plain', size: 4, key: 'k2' },
        ] as Message['attachments'],
      }),
    ])
    expect(page).toContain('Attachments: report.pdf, notes.txt')
  })

  it('leaves out an address line there is nothing to put on', () => {
    const page = build([message({ to: '', cc: '' })])
    expect(page).not.toContain('>To<')
    expect(page).not.toContain('>Cc<')
  })

  it('spells out where a link goes, since a printed link cannot be followed', () => {
    expect(build([message()])).toContain('.body a::after')
  })
})

// #35: printing keeps the reader's privacy and says what it leaves out.
describe('what a printout loads and says', () => {
  const tracked = message({
    body_html:
      '<p>Hello</p><img width="1" height="1" src="https://t.example/x.gif"><img src="https://cdn.example/logo.png">',
  })
  const csp = (html: string) =>
    new DOMParser()
      .parseFromString(html, 'text/html')
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content') ?? ''

  it('drops tracking pixels, as the reader does', () => {
    expect(build([tracked])).not.toContain('t.example/x.gif')
  })

  it('loads remote images only where the account allows them', () => {
    const blocked = csp(buildPrintDocument({ ...args(), messages: [tracked], allowRemoteImages: false }))
    expect(blocked).toContain("default-src 'none'")
    expect(blocked).not.toMatch(/img-src[^;]*https?:/)
    const allowed = csp(buildPrintDocument({ ...args(), messages: [tracked], allowRemoteImages: true }))
    expect(allowed).toMatch(/img-src[^;]*https:/)
    // Never scripts, either way.
    expect(allowed).toContain("script-src 'none'")
  })

  it('says when older messages of the conversation were not loaded', () => {
    const notice = 'Older messages are not included.'
    expect(buildPrintDocument({ ...args(), messages: [tracked], incompleteNotice: notice })).toContain(notice)
    expect(build([tracked])).not.toContain(notice)
  })
})

function args() {
  return {
    subject: 'Lunch',
    messages: [] as Message[],
    printedLabel: 'Printed',
    printedAt: new Date(1_700_000_000_000),
    toLabel: 'To',
    ccLabel: 'Cc',
    bccLabel: 'Bcc',
    attachmentsLabel: 'Attachments',
    oneMessageNotice: ONE_MESSAGE,
    oneMessageUnknownNotice: ONE_MAYBE,
  }
}

// SET-05 (#213, ADR-0060): the printout carries exactly what General → Print
// asks for, and nothing it was told to leave off.
describe('print options', () => {
  const opts = (over: Partial<PrintOptions> = {}, headers: Partial<PrintOptions['headers']> = {}): PrintOptions => ({
    ...DEFAULT_PRINT_OPTIONS,
    ...over,
    headers: { ...DEFAULT_PRINT_OPTIONS.headers, ...headers },
  })
  const thread = [
    message({ id: 'm-2', subject: 'Re: Lunch', body: 'Second thing', date: 1_700_000_200 }),
    message({ id: 'm-1', body: 'First thing', date: 1_700_000_100 }),
    message({ id: 'm-3', subject: 'Re: Lunch', body: 'Third thing', date: 1_700_000_300 }),
  ]
  const page = (options: PrintOptions, messageId?: string) =>
    buildPrintDocument({ ...args(), messages: thread, options, messageId })
  const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html')
  const header = (html: string) => doc(html).querySelector('.message .header')?.textContent ?? ''
  const order = (html: string) =>
    [...doc(html).querySelectorAll('.message .body')].map((body) => body.textContent?.trim())
  const stamp = new Date(1_700_000_000 * 1000).toLocaleString()
  const sent = message({
    to: 'bea@example.com',
    cc: 'carl@example.com',
    bcc: 'dee@example.com',
    attachments: [{ filename: 'report.pdf', mime: 'application/pdf', size: 10, key: 'k1' }] as Message['attachments'],
    has_attachments: true,
  })
  const one = (options: PrintOptions) => buildPrintDocument({ ...args(), messages: [sent], options })
  const allHeaders = { subject: true, date: true, to: true, cc: true, bcc: true }

  it('uses the default options when none are given', () => {
    const before = buildPrintDocument({ ...args(), messages: thread })
    expect(page(DEFAULT_PRINT_OPTIONS)).toBe(before)
    expect(order(before)).toEqual(['First thing', 'Second thing', 'Third thing'])
    expect(one(DEFAULT_PRINT_OPTIONS)).toContain('Attachments report.pdf')
    // Bcc names people the others were not told about: off unless asked.
    expect(one(DEFAULT_PRINT_OPTIONS)).not.toContain('dee@example.com')
  })

  it('prints every header field that is on', () => {
    const all = one(opts({}, allHeaders))
    const text = header(all)
    expect(text).toContain('Ann Example')
    expect(text).toContain(stamp)
    expect(text).toContain('To bea@example.com')
    expect(text).toContain('Cc carl@example.com')
    expect(text).toContain('Bcc dee@example.com')
    expect(doc(all).querySelector('h1')?.textContent).toBe('Lunch')
  })

  it('leaves off every header field that is off, and only that one', () => {
    for (const field of ['date', 'to', 'cc', 'bcc'] as const) {
      const text = header(one(opts({}, { ...allHeaders, [field]: false })))
      const shown = {
        date: text.includes(stamp),
        to: text.includes('bea@example.com'),
        cc: text.includes('carl@example.com'),
        bcc: text.includes('dee@example.com'),
      }
      expect(shown).toEqual({ date: true, to: true, cc: true, bcc: true, [field]: false })
    }
  })

  it('leaves the subject heading off when asked, but still names the page', () => {
    const html = one(opts({}, { subject: false }))
    expect(doc(html).querySelector('h1')).toBeNull()
    expect(html).toContain('<title>Lunch</title>')
  })

  it('always says who wrote each message, whatever is off', () => {
    const bare = one(opts({ attachments: false }, { subject: false, date: false, to: false, cc: false, bcc: false }))
    expect(header(bare).trim()).toBe('Ann Example <ann@example.com>')
  })

  it('lists attachments only when asked', () => {
    expect(one(opts({ attachments: true }))).toContain('Attachments report.pdf')
    const without = one(opts({ attachments: false }))
    expect(without).not.toContain('report.pdf')
    expect(doc(without).querySelector('.attachments')).toBeNull()
  })

  it('prints the whole conversation oldest first, by date rather than load order', () => {
    expect(order(page(opts({ scope: 'conversation', order: 'oldest' })))).toEqual([
      'First thing',
      'Second thing',
      'Third thing',
    ])
  })

  it('prints the whole conversation newest first when asked', () => {
    expect(order(page(opts({ scope: 'conversation', order: 'newest' })))).toEqual([
      'Third thing',
      'Second thing',
      'First thing',
    ])
  })

  it('keeps messages sent in the same second in the order they came, and reverses it exactly', () => {
    const same = [message({ id: 'a', body: 'Alpha' }), message({ id: 'b', body: 'Beta' })]
    expect(printedMessages(same, opts({ order: 'oldest' })).map((item) => item.id)).toEqual(['a', 'b'])
    // Newest first is oldest first turned over, ties included.
    expect(printedMessages(same, opts({ order: 'newest' })).map((item) => item.id)).toEqual(['b', 'a'])
  })

  it('prints only the message asked about, under its own subject', () => {
    const html = page(opts({ scope: 'message' }), 'm-2')
    expect(order(html)).toEqual(['Second thing'])
    expect(doc(html).querySelector('h1')?.textContent).toBe('Re: Lunch')
  })

  it('prints the newest message when one message is asked for without naming it', () => {
    expect(order(page(opts({ scope: 'message' })))).toEqual(['Third thing'])
    expect(printedMessages([], opts({ scope: 'message' }))).toEqual([])
  })

  it('ignores the order for one message', () => {
    expect(order(page(opts({ scope: 'message', order: 'newest' }), 'm-1'))).toEqual(['First thing'])
  })
})

// #35 stays true under every option: remote content stays blocked and what is
// left out is said.
describe('the #35 guarantees under every print option', () => {
  const remote = message({
    id: 'm-r',
    body_html:
      '<p>Hello</p><img width="1" height="1" src="https://t.example/x.gif"><img src="https://cdn.example/logo.png">',
  })
  const older = message({ id: 'm-o', body: 'Older', date: 1_600_000_000 })
  const csp = (html: string) =>
    new DOMParser()
      .parseFromString(html, 'text/html')
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content') ?? ''
  const every: PrintOptions[] = []
  for (const scope of ['conversation', 'message'] as const)
    for (const order of ['oldest', 'newest'] as const)
      for (const attachments of [true, false])
        for (const on of [true, false])
          every.push({ scope, order, attachments, headers: { subject: on, date: on, to: on, cc: on, bcc: on } })

  it('keeps remote images blocked and tracking pixels out, whatever is chosen', () => {
    for (const options of every) {
      const html = buildPrintDocument({ ...args(), messages: [older, remote], options, messageId: 'm-r' })
      const policy = csp(html)
      expect(policy).toContain("default-src 'none'")
      expect(policy).toContain("script-src 'none'")
      expect(policy).not.toMatch(/img-src[^;]*https?:/)
      expect(html).not.toContain('t.example/x.gif')
    }
  })

  it('says older messages were not loaded, in either order', () => {
    const notice = 'Older messages are not included.'
    for (const order of ['oldest', 'newest'] as const) {
      const html = buildPrintDocument({
        ...args(),
        messages: [remote],
        incompleteNotice: notice,
        options: { ...DEFAULT_PRINT_OPTIONS, order },
      })
      expect(html).toContain(notice)
      // Said before the first message, where it is read first.
      expect(html.indexOf(notice)).toBeLessThan(html.indexOf('<article'))
    }
  })

  it('says when one message is printed out of a conversation that has others', () => {
    const single = { ...DEFAULT_PRINT_OPTIONS, scope: 'message' as const }
    expect(buildPrintDocument({ ...args(), messages: [older, remote], options: single, messageId: 'm-r' })).toContain(
      ONE_MESSAGE,
    )
    // Others on the server but not loaded count too.
    expect(
      buildPrintDocument({ ...args(), messages: [remote], options: single, incompleteNotice: 'Older not loaded.' }),
    ).toContain(ONE_MESSAGE)
    // Nothing is left out of a conversation of one.
    expect(buildPrintDocument({ ...args(), messages: [remote], options: single })).not.toContain(ONE_MESSAGE)
    // And the whole conversation never claims to be one message.
    expect(buildPrintDocument({ ...args(), messages: [older, remote] })).not.toContain(ONE_MESSAGE)
  })

  it('says other messages may not be printed when the conversation was not loaded, without claiming any', () => {
    const single = { ...DEFAULT_PRINT_OPTIONS, scope: 'message' as const }
    const html = buildPrintDocument({ ...args(), messages: [remote], options: single, conversationUnknown: true })
    expect(html).toContain(ONE_MAYBE)
    expect(html).not.toContain(ONE_MESSAGE)
    // Known others are stated as such, unknown or not.
    expect(
      buildPrintDocument({
        ...args(),
        messages: [older, remote],
        options: single,
        messageId: 'm-r',
        conversationUnknown: true,
      }),
    ).toContain(ONE_MESSAGE)
    // The whole conversation has its own notice for what did not load.
    expect(buildPrintDocument({ ...args(), messages: [remote], conversationUnknown: true })).not.toContain(ONE_MAYBE)
  })

  it('never claims "this message" when there is no message to print', () => {
    const single = { ...DEFAULT_PRINT_OPTIONS, scope: 'message' as const }
    for (const incompleteNotice of [undefined, 'Older not loaded.']) {
      const html = buildPrintDocument({
        ...args(),
        messages: [],
        options: single,
        conversationUnknown: true,
        incompleteNotice,
      })
      expect(html).not.toContain(ONE_MESSAGE)
      expect(html).not.toContain(ONE_MAYBE)
      expect(html).not.toContain('<article')
    }
  })
})

// Review of #213: a draft or an unsent copy is never passed off as mail that
// went out.
describe('drafts and unsent messages on paper', () => {
  const sent = message({ id: 'm-1', body: 'Sent reply', date: 1_700_000_100 })
  const draft = message({ id: 'd-1', body: 'My draft', date: 1_700_000_300 })
  const unsent = message({ id: 'sent-1', body: 'Still in undo', date: 1_700_000_200 })
  const marks = { 'd-1': 'Draft', 'sent-1': 'Not sent' }
  const single = { ...DEFAULT_PRINT_OPTIONS, scope: 'message' as const }
  const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html')
  const bodies = (html: string) =>
    [...doc(html).querySelectorAll('.message .body')].map((body) => body.textContent?.trim())
  const markOf = (html: string, body: string) =>
    [...doc(html).querySelectorAll('.message')]
      .find((article) => article.querySelector('.body')?.textContent?.trim() === body)
      ?.querySelector('.mark')?.textContent ?? null

  it('does not take a draft or an unsent copy for "this message" when another is there', () => {
    const html = buildPrintDocument({ ...args(), messages: [sent, draft, unsent], options: single, marks })
    expect(bodies(html)).toEqual(['Sent reply'])
    expect(doc(html).querySelector('.mark')).toBeNull()
  })

  it('falls back to the newest one, marked, when nothing else is there', () => {
    const html = buildPrintDocument({ ...args(), messages: [draft, unsent], options: single, marks })
    expect(bodies(html)).toEqual(['My draft'])
    expect(markOf(html, 'My draft')).toBe('Draft')
  })

  it('marks them in the whole conversation, and only them', () => {
    const html = buildPrintDocument({ ...args(), messages: [sent, draft, unsent], marks })
    expect(bodies(html)).toEqual(['Sent reply', 'Still in undo', 'My draft'])
    expect(markOf(html, 'My draft')).toBe('Draft')
    expect(markOf(html, 'Still in undo')).toBe('Not sent')
    expect(markOf(html, 'Sent reply')).toBeNull()
  })

  it('marks the one asked for by name', () => {
    const html = buildPrintDocument({ ...args(), messages: [sent, draft], options: single, messageId: 'd-1', marks })
    expect(bodies(html)).toEqual(['My draft'])
    expect(markOf(html, 'My draft')).toBe('Draft')
  })
})
