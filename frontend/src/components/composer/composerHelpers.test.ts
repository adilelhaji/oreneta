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

  it('leaves paragraphs in left-to-right scripts outside Latin unmarked', () => {
    const html = `<p>नमस्ते दोस्त</p><p>வணக்கம்</p><p>สวัสดี</p><p>${String.fromCodePoint(0xfeff)}Hello</p>`
    expect(inlineRichStyles(html)).toBe(html)
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

  it('indents on the side the paragraph starts from (#274)', () => {
    const body = parse(
      inlineRichStyles(
        '<p data-indent="2" style="text-align: center">Two levels</p><p data-indent="1">مرحبا</p><p data-indent="0">none</p>',
      ),
    )
    const [ltr, rtl, none] = body.querySelectorAll('p')
    expect(ltr.getAttribute('style')).toBe('margin-left: 80px; text-align: center')
    expect(rtl.getAttribute('style')).toBe('margin-right: 40px;')
    expect(none.hasAttribute('style')).toBe(false)
  })

  it('sends the indent as a margin only, without the editor’s own attribute', () => {
    const body = parse(inlineRichStyles('<p data-indent="1">one</p><p data-indent="0">two</p>'))
    expect(body.querySelectorAll('[data-indent]').length).toBe(0)
    expect(body.querySelector('p')!.getAttribute('style')).toBe('margin-left: 40px;')
  })

  it('keeps text on a background colour dark, unless it has a colour of its own', () => {
    const body = parse(
      inlineRichStyles(
        '<p><span style="background-color: #fef08a">a</span><span style="color: #dc2626; background-color: #fef08a">b</span><span style="color: #2563eb">c</span></p>',
      ),
    )
    const [onBackground, ownColour, noBackground] = body.querySelectorAll('span')
    expect(onBackground.getAttribute('style')).toBe('color: #111827; background-color: #fef08a')
    expect(ownColour.getAttribute('style')).toBe('color: #dc2626; background-color: #fef08a')
    expect(noBackground.getAttribute('style')).toBe('color: #2563eb')
  })

  it('caps an indent level that came in too high', () => {
    const body = parse(inlineRichStyles('<p data-indent="40">deep</p>'))
    expect(body.querySelector('p')!.getAttribute('style')).toBe('margin-left: 320px;')
  })

  it('draws the grid of a table made here and leaves a quoted layout table bare (#274)', () => {
    const body = parse(
      inlineRichStyles(
        '<table class="oreneta-table" style="min-width: 50px"><colgroup><col><col></colgroup><tbody>' +
          '<tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>' +
          '<blockquote><table><tbody><tr><td><p>layout</p></td></tr></tbody></table></blockquote>',
      ),
    )
    const [made, quoted] = body.querySelectorAll('table')
    expect(made.getAttribute('style')).toBe('border-collapse: collapse; min-width: 50px')
    expect(made.querySelector('th')!.getAttribute('style')).toContain('border: 1px solid #d1d5db;')
    expect(made.querySelector('td')!.getAttribute('style')).toBe(
      'border: 1px solid #d1d5db; padding: 4px 8px; vertical-align: top;',
    )
    // Cell paragraphs flush, as in the editor, not with a client's 1em margin.
    expect(made.querySelector('td > p')!.getAttribute('style')).toBe('margin: 0;')
    expect(made.querySelector('th > p')!.getAttribute('style')).toBe('margin: 0;')
    expect(quoted.querySelector('p')!.hasAttribute('style')).toBe(false)
    expect(quoted.hasAttribute('style')).toBe(false)
    expect(quoted.querySelector('td')!.hasAttribute('style')).toBe(false)
  })

  it('leaves a quoted original that declares its own direction alone', () => {
    const html = '<blockquote><div dir="ltr"><p>مرحبا</p></div></blockquote>'
    const body = parse(inlineRichStyles(html))
    expect(body.querySelector('p')!.hasAttribute('dir')).toBe(false)
  })
})
