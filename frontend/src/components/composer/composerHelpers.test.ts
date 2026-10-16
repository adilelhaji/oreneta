import { describe, expect, it } from 'bun:test'
import { inlineRichStyles } from './composerHelpers'

// Outgoing mail declares the direction of its right-to-left blocks (#226,
// ADR-0061); mail written left to right leaves exactly as before.
describe('the direction of outgoing mail', () => {
  const quoteLtr = 'border-left: 3px solid #d1d5db; padding-left: 0.9em; margin: 0.6em 0; color: #6b7280;'
  const quoteRtl = 'border-right: 3px solid #d1d5db; padding-right: 0.9em; margin: 0.6em 0; color: #6b7280;'
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html').body

  it('leaves left-to-right mail byte for byte as it was', () => {
    const html =
      '<p>Hello Ana,</p><ul><li><p>one</p></li></ul><h2>Plan</h2>' +
      '<p>On Mon, Ana wrote:</p><blockquote><p>Quoted <a href="https://x.test">link</a> and <code>code</code></p></blockquote>'
    const expected =
      '<p>Hello Ana,</p><ul><li><p>one</p></li></ul><h2>Plan</h2>' +
      `<p>On Mon, Ana wrote:</p><blockquote style="${quoteLtr}"><p>Quoted <a href="https://x.test" style="color: #2563eb; text-decoration: underline;">link</a> and <code style="background: rgba(127, 127, 127, 0.16); border-radius: 4px; padding: 0.1em 0.3em; font-size: 0.9em;">code</code></p></blockquote>`
    expect(inlineRichStyles(html)).toBe(expected)
  })

  it('marks right-to-left paragraphs, headings and lists, and only those', () => {
    const body = parse(
      inlineRichStyles('<p>مرحبا يا آنا</p><p>Thanks, Ana</p><h2>الخطة</h2><ul><li><p>واحد</p></li><li><p>two</p></li></ul>'),
    )
    const [arabic, latin] = body.querySelectorAll(':scope > p')
    expect(arabic.getAttribute('dir')).toBe('rtl')
    expect(latin.hasAttribute('dir')).toBe(false)
    expect(body.querySelector('h2')!.getAttribute('dir')).toBe('rtl')
    expect(body.querySelector('ul')!.getAttribute('dir')).toBe('rtl')
    // A left-to-right item inside a right-to-left list says so.
    expect(body.querySelectorAll('li')[1].getAttribute('dir')).toBe('ltr')
  })

  it('puts the bar of a right-to-left quote on the right', () => {
    const body = parse(inlineRichStyles('<blockquote><p>نص مقتبس</p></blockquote><blockquote><p>Quoted</p></blockquote>'))
    const [rtl, ltr] = body.querySelectorAll('blockquote')
    expect(rtl.getAttribute('dir')).toBe('rtl')
    expect(rtl.getAttribute('style')).toBe(quoteRtl)
    expect(ltr.getAttribute('style')).toBe(quoteLtr)
  })

  it('leaves a quoted original that declares its own direction alone', () => {
    const html = '<blockquote><div dir="ltr"><p>مرحبا</p></div></blockquote>'
    const body = parse(inlineRichStyles(html))
    expect(body.querySelector('p')!.hasAttribute('dir')).toBe(false)
  })
})
