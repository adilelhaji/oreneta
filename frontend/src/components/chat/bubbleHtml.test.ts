import { describe, expect, it } from 'bun:test'
import { prepareBubbleHtml } from './bubbleHtml'

// A newsletter's own reset is `html, body { height: 100% !important }`, so the
// override only wins as an inline declaration — those outrank every stylesheet
// rule of the same importance, wherever the sender's `<style>` happens to sit.
const sizing = (prepared: string) => {
  const doc = new DOMParser().parseFromString(prepared, 'text/html')
  return [doc.documentElement, doc.body].map((el) => el.getAttribute('style') ?? '')
}

describe('prepareBubbleHtml', () => {
  it('lets newsletter documents grow beyond the placeholder frame', () => {
    const html = `
      <html>
        <head>
          <style>html, body { height: 100% !important; }</style>
        </head>
        <body><p>Visible message</p></body>
      </html>
    `

    const prepared = prepareBubbleHtml(html)

    for (const style of sizing(prepared)) {
      expect(style).toContain('height: auto !important')
      expect(style).toContain('min-height: 0 !important')
    }
    expect(prepared).toContain('Visible message')
  })

  it('outranks a reset that the sender put inside the body', () => {
    // ESP templates commonly emit their reset/media-query block after <body>
    // starts; the parser leaves it there, so a head-only override would lose.
    const html = `
      <html>
        <body>
          <style>html, body { height: 100% !important; }</style>
          <p>Visible message</p>
        </body>
      </html>
    `

    const prepared = prepareBubbleHtml(html)

    for (const style of sizing(prepared)) {
      expect(style).toContain('height: auto !important')
    }
    expect(prepared).toContain('Visible message')
  })

  it('leaves the body structure untouched', () => {
    const html = '<html><body><p>First</p><table><tr><td>Last</td></tr></table></body></html>'

    const doc = new DOMParser().parseFromString(prepareBubbleHtml(html), 'text/html')

    expect(doc.body.lastElementChild?.tagName).toBe('TABLE')
    expect(doc.querySelector('body > table:last-child')).not.toBeNull()
  })
})

describe('simplifying a message', () => {
  const sender =
    '<html><body><table width="600" style="width:600px"><tr><td style="font-family:Comic Sans;font-size:9px">' +
    '<p style="color:#c00">Careful</p></td></tr></table></body></html>'

  it('leaves the sender in charge unless asked', () => {
    const prepared = prepareBubbleHtml(sender)
    // A newsletter or an invoice is laid out on purpose; flattening it by
    // default would be destroying the thing the sender wrote.
    expect(prepared).not.toContain('font-family: inherit')
  })

  it('gives the message the reader font and width when asked', () => {
    const prepared = prepareBubbleHtml(sender, { family: null, zoom: 1, simplify: true })
    expect(prepared).toContain('font-family: inherit !important')
    expect(prepared).toContain('font-size: inherit !important')
    // A message laid out for a 600px column reflows to the pane it is in.
    expect(prepared).toContain('width: auto !important')
    expect(prepared).toContain('table-layout: auto !important')
  })

  it('keeps code monospaced, which is not decoration', () => {
    const prepared = prepareBubbleHtml('<pre>a = 1</pre>', { family: null, zoom: 1, simplify: true })
    expect(prepared).toMatch(/pre, pre \*, code[^}]*monospace !important/)
  })

  it('does not repaint the sender colours', () => {
    const prepared = prepareBubbleHtml(sender, { family: null, zoom: 1, simplify: true })
    // Someone who wrote in a colour usually meant something by it, and a rule
    // that repainted everything would turn a highlighted warning into prose.
    expect(prepared).not.toMatch(/body \*[^}]*color: inherit !important/)
    expect(prepared).toContain('#c00')
  })

  it('leaves the message itself untouched either way', () => {
    const simplified = prepareBubbleHtml(sender, { family: null, zoom: 1, simplify: true })
    // The sender's own markup survives: this restyles, it does not rewrite.
    expect(simplified).toContain('Careful')
    expect(simplified).toContain('width="600"')
  })
})
