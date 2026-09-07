import { describe, expect, it } from 'bun:test'
import { buildPrintDocument, escapeHtml, printableBody } from './printDocument'
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

const build = (messages: Message[], subject = 'Lunch') =>
  buildPrintDocument({
    subject,
    messages,
    printedLabel: 'Printed',
    printedAt: new Date(1_700_000_000_000),
    toLabel: 'To',
    ccLabel: 'Cc',
    attachmentsLabel: 'Attachments:',
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
    const page = build([
      message({ id: 'm-1', body: 'First thing' }),
      message({ id: 'm-2', body: 'Second thing' }),
    ])
    expect(page.indexOf('First thing')).toBeLessThan(page.indexOf('Second thing'))
    expect(page.match(/<article class="message">/g)).toHaveLength(2)
  })

  it('names the page after the subject, so a printed sheet can be filed', () => {
    expect(build([message()], 'Quarterly report')).toContain('<title>Quarterly report</title>')
    expect(build([message()], '   ')).toContain('<title>(no subject)</title>')
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
