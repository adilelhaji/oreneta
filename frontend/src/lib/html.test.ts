import { describe, expect, it } from 'bun:test'
import { htmlToText, resolveInlineCids } from './html'

describe('resolveInlineCids', () => {
  it('rewrites cid refs to data URLs from the matching attachments', () => {
    const html =
      '<p>hi</p><img src="cid:oreneta-image-1-a@oreneta" alt="a.png"><p>mid</p><img src="cid:oreneta-image-2-b@oreneta" alt="b.png">'
    const out = resolveInlineCids(html, [
      { inlineId: 'oreneta-image-1-a@oreneta', mime: 'image/png', data: 'AAAA' },
      { inlineId: 'oreneta-image-2-b@oreneta', mime: 'image/jpeg', data: 'BBBB' },
    ])
    expect(out).toBe(
      '<p>hi</p><img src="data:image/png;base64,AAAA" alt="a.png"><p>mid</p><img src="data:image/jpeg;base64,BBBB" alt="b.png">',
    )
  })

  it('ignores attachments without an inlineId and leaves unmatched cids alone', () => {
    const html = '<img src="cid:known@oreneta"><img src="cid:unknown@oreneta">'
    const out = resolveInlineCids(html, [
      { mime: 'application/pdf', data: 'CCCC' },
      { inlineId: 'known@oreneta', mime: 'image/png', data: 'DDDD' },
    ])
    expect(out).toBe('<img src="data:image/png;base64,DDDD"><img src="cid:unknown@oreneta">')
  })
})

// The plain-text alternative of a message with a table (#274, ADR-0067): one
// line per row, cells joined by " | ", the table set apart like a paragraph.
describe('htmlToText with tables', () => {
  it('writes a table with a header row as one line per row', () => {
    const html =
      '<p>Prices:</p><table class="oreneta-table"><tbody>' +
      '<tr><th><p>Item</p></th><th><p>Cost</p></th></tr>' +
      '<tr><td><p>Tea</p></td><td><p>2 €</p></td></tr>' +
      '</tbody></table><p>Thanks</p>'
    expect(htmlToText(html)).toBe('Prices:\n\nItem | Cost\nTea | 2 €\n\nThanks')
  })

  it('keeps an empty cell empty between the separators', () => {
    const html = '<table><tbody><tr><td><p>a</p></td><td><p></p></td><td><p>c</p></td></tr></tbody></table>'
    expect(htmlToText(html)).toBe('a |  | c')
  })

  it('writes a spanning cell once', () => {
    const html =
      '<table><tbody><tr><td colspan="2"><p>Total</p></td></tr><tr><td><p>b</p></td><td><p>c</p></td></tr></tbody></table>'
    expect(htmlToText(html)).toBe('Total\nb | c')
  })

  it('keeps a cell of a table made in the composer on its row, whatever it holds', () => {
    const html =
      '<table class="oreneta-table"><tbody><tr><td><p>one</p><p>two</p></td><td><table><tbody><tr><td>x</td><td>y</td></tr></tbody></table></td></tr></tbody></table>'
    expect(htmlToText(html)).toBe('one two | x | y')
  })

  // A layout table in quoted mail (a newsletter, a signature) is passages of
  // text, not values: it keeps its paragraphs instead of becoming one line.
  it('reads a quoted layout table as the paragraphs it lays out', () => {
    const html =
      '<p>On Monday Ana wrote:</p><blockquote><table><tbody><tr><td>' +
      '<table><tbody><tr><td><p>Dear reader,</p><p>Our news this week.</p></td></tr></tbody></table>' +
      '</td><td><p>Sidebar</p></td></tr></tbody></table></blockquote>'
    expect(htmlToText(html)).toBe('On Monday Ana wrote:\n\nDear reader,\n\nOur news this week.\n\nSidebar')
  })

  it('reads a cell with several paragraphs as layout too', () => {
    const html = '<table><tbody><tr><td><p>First</p><p>Second</p></td></tr></tbody></table>'
    expect(htmlToText(html)).toBe('First\n\nSecond')
  })

  it('puts the caption above the rows and leaves out rows with no text', () => {
    const html =
      '<table><caption>Prices</caption><tbody><tr><td>Tea</td><td>2</td></tr><tr><td></td><td></td></tr></tbody></table>'
    expect(htmlToText(html)).toBe('Prices\nTea | 2')
    expect(htmlToText('<table class="oreneta-table"><tbody><tr><td><p></p></td></tr></tbody></table>')).toBe('')
  })

  it('writes a table inside a quote', () => {
    const html =
      '<p>On Monday Ana wrote:</p><blockquote><table><tbody><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table></blockquote>'
    expect(htmlToText(html)).toBe('On Monday Ana wrote:\n\na | b')
  })

  it('leaves the words of an indented paragraph as they are', () => {
    expect(htmlToText('<p data-indent="2" style="margin-left: 80px;">Indented</p><p>Next</p>')).toBe('Indented\n\nNext')
  })
})
