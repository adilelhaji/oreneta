import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_REPLY_FORWARD_PREFS,
  buildReplyQuote,
  forwardSubject,
  formatQuoteDate,
  isolate,
  joinReplyBody,
  prefixQuote,
  quoteIsRich,
  replySubject,
  sanitizeReplyForwardPrefs,
  type QuotedMessage,
  type ReplyForwardPrefs,
} from './replyForward'

// 2026-03-01 23:30 UTC: 1 March 18:30 in New York and already 2 March 08:30 in
// Tokyo, so a date formatted in the wrong zone shows up as the wrong day.
const DATE = Math.floor(Date.UTC(2026, 2, 1, 23, 30) / 1000)
const NY = { locale: 'en-US', timeZone: 'America/New_York' }

const original = (overrides: Partial<QuotedMessage> = {}): QuotedMessage => ({
  from_name: 'Ana Ruiz',
  from_addr: 'ana@example.test',
  to: 'me@example.test',
  cc: '',
  subject: 'Plan',
  date: DATE,
  body: 'First line\nSecond line',
  ...overrides,
})

const prefs = (overrides: Partial<ReplyForwardPrefs> = {}): ReplyForwardPrefs => ({
  ...DEFAULT_REPLY_FORWARD_PREFS,
  ...overrides,
})

describe('reply and forward preferences', () => {
  it('keeps every valid field and defaults the rest one by one', () => {
    expect(sanitizeReplyForwardPrefs(null)).toBeNull()
    expect(sanitizeReplyForwardPrefs([])).toBeNull()
    expect(
      sanitizeReplyForwardPrefs({ replyPosition: 'below', quoteStyle: 'sideways', forwardMode: 'attachment', extra: 1 }),
    ).toEqual({ ...DEFAULT_REPLY_FORWARD_PREFS, replyPosition: 'below', forwardMode: 'attachment' })
  })
})

describe('subjects', () => {
  it('collapses stacked reply prefixes in any case or language', () => {
    expect(replySubject('Re: Re: RE: Plan', true)).toBe('Re: Plan')
    expect(replySubject('AW: Re[2]: Plan', true)).toBe('Re: Plan')
    expect(replySubject('Plan', true)).toBe('Re: Plan')
    // Not every word ending in a colon is a prefix.
    expect(replySubject('Rest: Plan', true)).toBe('Re: Rest: Plan')
  })

  it('keeps the original prefixes when collapsing is off, and never doubles a leading Re:', () => {
    expect(replySubject('Re: Re: Plan', false)).toBe('Re: Re: Plan')
    expect(replySubject('re: Plan', false)).toBe('re: Plan')
    expect(replySubject('AW: Plan', false)).toBe('Re: AW: Plan')
  })

  it('collapses stacked forward prefixes but keeps a reply inside a forward', () => {
    expect(forwardSubject('Fwd: FW: Plan', true)).toBe('Fwd: Plan')
    expect(forwardSubject('Re: Plan', true)).toBe('Fwd: Re: Plan')
    expect(forwardSubject('Fwd: FW: Plan', false)).toBe('Fwd: FW: Plan')
    expect(forwardSubject('', true)).toBe('Fwd: (no subject)')
  })
})

describe('dates', () => {
  it('formats the original date in the given zone and language', () => {
    expect(formatQuoteDate(DATE, NY)).toContain('Mar 1, 2026')
    expect(formatQuoteDate(DATE, { locale: 'en-US', timeZone: 'Asia/Tokyo' })).toContain('Mar 2, 2026')
    expect(formatQuoteDate(DATE, { locale: 'es', timeZone: 'Europe/Madrid' })).toContain('2 mar 2026')
    expect(formatQuoteDate(0, NY)).toBe('')
  })
})

describe('reply quote', () => {
  it('plain text, short header: an attribution line and every line prefixed', () => {
    const quote = buildReplyQuote(original(), prefs(), false, NY)
    expect(quote.html).toBe('')
    expect(quote.text).toBe(`On ${formatQuoteDate(DATE, NY)}, Ana Ruiz wrote:\n> First line\n> Second line`)
  })

  it('plain text deepens an existing quote level instead of spacing it', () => {
    expect(prefixQuote('mine\n> theirs\n\nend\n')).toBe('> mine\n>> theirs\n>\n> end')
  })

  it('plain text, Outlook header: the header block stays unquoted, empty rows are left out', () => {
    const quote = buildReplyQuote(original({ cc: '' }), prefs({ headerStyle: 'outlook' }), false, NY)
    expect(quote.text).toBe(
      [
        '-----',
        'From: Ana Ruiz <ana@example.test>',
        `Sent: ${formatQuoteDate(DATE, NY)}`,
        'To: me@example.test',
        'Subject: Plan',
        '> First line',
        '> Second line',
      ].join('\n'),
    )
  })

  it('HTML, short header: the attribution and a blockquote around the original HTML', () => {
    const quote = buildReplyQuote(original({ body_html: '<p>Hi <b>there</b></p>' }), prefs(), true, NY)
    expect(quote.text).toBe('')
    expect(quote.html).toBe(
      `<p>On ${formatQuoteDate(DATE, NY)}, Ana Ruiz wrote:</p><blockquote><p>Hi <b>there</b></p></blockquote>`,
    )
  })

  it('HTML escapes names and subjects with special characters', () => {
    const message = original({
      from_name: 'Tom & "Jerry" <Ops>',
      subject: '<script>alert(1)</script> & co',
      body_html: '',
      body: 'a < b',
    })
    const short = buildReplyQuote(message, prefs(), true, NY).html
    expect(short).toContain('Tom &amp; &quot;Jerry&quot; &lt;Ops&gt; wrote:')
    expect(short).toContain('<blockquote><p>a &lt; b</p></blockquote>')
    const outlook = buildReplyQuote(message, prefs({ headerStyle: 'outlook' }), true, NY).html
    expect(outlook).toStartWith('<hr><p><strong>From:</strong> Tom &amp; &quot;Jerry&quot; &lt;Ops&gt; &lt;ana@example.test&gt;')
    expect(outlook).toContain('<strong>Subject:</strong> &lt;script&gt;alert(1)&lt;/script&gt; &amp; co</p>')
    expect(outlook).not.toContain('<script>')
  })

  it('isolates right-to-left names so the line keeps its order, and leaves others untouched', () => {
    expect(isolate('Ana')).toBe('Ana')
    expect(isolate('דנה כהן')).toBe('⁨דנה כהן⁩')
    const quote = buildReplyQuote(original({ from_name: 'محمد' }), prefs(), false, NY)
    expect(quote.text.split('\n')[0]).toBe(`On ${formatQuoteDate(DATE, NY)}, ⁨محمد⁩ wrote:`)
    const outlook = buildReplyQuote(
      original({ from_name: 'דנה', subject: 'שלום' }),
      prefs({ headerStyle: 'outlook' }),
      true,
      NY,
    ).html
    expect(outlook).toContain('⁨דנה &lt;ana@example.test&gt;⁩')
    expect(outlook).toContain('⁨שלום⁩')
  })

  it('quotes an HTML-only original as text when the reply is plain', () => {
    const quote = buildReplyQuote(original({ body: '', body_html: '<p>One</p><p>Two<br>Three</p>' }), prefs(), false, NY)
    expect(quote.text.split('\n').slice(1)).toEqual(['> One', '> Two', '> Three'])
  })

  it('writes rich only when the style allows it and the original or the account is HTML', () => {
    expect(quoteIsRich(original({ body_html: '<p>x</p>' }), prefs(), false)).toBe(true)
    expect(quoteIsRich(original(), prefs(), true)).toBe(true)
    expect(quoteIsRich(original(), prefs(), false)).toBe(false)
    expect(quoteIsRich(original({ body_html: '<p>x</p>' }), prefs({ quoteStyle: 'plain' }), true)).toBe(false)
  })
})

describe('reply body order', () => {
  const quote = { html: '<blockquote><p>q</p></blockquote>', text: '> q' }

  it('puts the user part above or below the quote, in both forms', () => {
    expect(joinReplyBody({ rich: false, html: '', text: 'Hi\n\n-- sig' }, quote, 'above').text).toBe(
      'Hi\n\n-- sig\n\n> q',
    )
    expect(joinReplyBody({ rich: false, html: '', text: 'Hi\n\n-- sig' }, quote, 'below').text).toBe(
      '> q\n\nHi\n\n-- sig',
    )
    expect(joinReplyBody({ rich: false, html: '', text: '' }, quote, 'above').text).toBe('\n\n> q')
    expect(joinReplyBody({ rich: true, html: '<p>Hi</p>', text: '' }, quote, 'above').html).toBe(
      '<p>Hi</p><p></p><blockquote><p>q</p></blockquote>',
    )
    expect(joinReplyBody({ rich: true, html: '', text: '' }, quote, 'below').html).toBe(
      '<blockquote><p>q</p></blockquote><p></p><p></p>',
    )
  })
})
