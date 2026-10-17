import { afterEach, describe, expect, it } from 'bun:test'
import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { isMac, matchShortcut } from '../../lib/shortcuts'
import { htmlToText } from '../../lib/html'
import { composedPayload } from '../../states/compose'
import { inlineRichStyles } from './composerHelpers'
import {
  BACKGROUND_COLORS,
  clampSpan,
  FONT_FAMILIES,
  MAX_TABLE_SPAN,
  formattingCommandFor,
  richTextExtensions,
  safeCssColor,
  safeFontFamily,
  safeFontSize,
  TEXT_COLORS,
} from './richText'
import { MAX_INDENT, parseIndent } from './indentExtension'

// #274, ADR-0067: the composer's font, size, colours, alignment, indent and
// tables, what they let through from pasted or quoted mail, and what is sent.

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.view.dom.parentElement?.remove()
    editor.destroy()
  }
})

function editorWith(content: string): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: [StarterKit, ...richTextExtensions()], content })
  editors.push(editor)
  return editor
}

// The chord as this platform presses it: Mod is ⌘ on macOS, Ctrl elsewhere.
function chord(key: string, shift = false): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    shiftKey: shift,
    ctrlKey: !isMac,
    metaKey: isMac,
    bubbles: true,
    cancelable: true,
  })
}

// The document as HTML, without the empty paragraph the starter kit keeps at
// the end of a document that ends in a list, a heading or a table.
const html = (editor: Editor) => editor.getHTML().replace(/<p><\/p>$/, '')

const rowCount = (editor: Editor) => editor.view.dom.querySelectorAll('tr').length
const columnCount = (editor: Editor) => editor.view.dom.querySelector('tr')!.children.length

describe('the style values the editor accepts', () => {
  it('takes colours as hex, rgb() or rgba() with numbers, or a name', () => {
    for (const ok of ['#abc', '#AABBCC', '#aabbccdd', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'rgb(10%, 20%, 30%)', 'red']) {
      expect(safeCssColor(ok)).toBe(ok)
    }
    expect(safeCssColor('  #abc  ')).toBe('#abc')
  })

  it('refuses a colour that fetches, runs, indirects, escapes or adds a declaration', () => {
    for (const bad of [
      'url(https://t.example/p.gif)',
      'red;background:url(x)',
      'expression(alert(1))',
      'var(--x)',
      '#fff\\9',
      'red}',
      'red /* x */',
      '<b>',
      'hsl(0, 0%, 0%)',
      '#ab',
      'rgb(1, 2)',
      '',
      'x'.repeat(65),
      12,
      null,
    ]) {
      expect(safeCssColor(bad)).toBeNull()
    }
  })

  it('takes sizes in pt, px, em and % within their range', () => {
    expect(safeFontSize('12pt')).toBe('12pt')
    expect(safeFontSize('11.0pt')).toBe('11.0pt')
    expect(safeFontSize('14PX')).toBe('14px')
    expect(safeFontSize('1.5em')).toBe('1.5em')
    expect(safeFontSize('120%')).toBe('120%')
    expect(safeFontSize('144pt')).toBe('144pt')
  })

  it('refuses sizes out of range, keywords and anything that is not a plain size', () => {
    for (const bad of ['0pt', '145pt', '500px', '0.05em', '5%', 'large', '12', '12pt;', 'calc(1px + 2px)', 'var(--s)', '1e2px', '-2pt']) {
      expect(safeFontSize(bad)).toBeNull()
    }
  })

  it('takes a font list and writes it with single quotes', () => {
    expect(safeFontFamily('Arial, Helvetica, sans-serif')).toBe('Arial, Helvetica, sans-serif')
    expect(safeFontFamily('"Times New Roman", serif')).toBe("'Times New Roman', serif")
    expect(safeFontFamily('Times New Roman')).toBe("'Times New Roman'")
    expect(safeFontFamily("'Noto Sans JP', sans-serif")).toBe("'Noto Sans JP', sans-serif")
    for (const family of FONT_FAMILIES) expect(safeFontFamily(family.value)).toBe(family.value)
  })

  it('refuses a font list with escapes, functions, stray quotes or too many names', () => {
    for (const bad of [
      'a\\62 c',
      'x;y',
      'url(x)',
      "'unbalanced",
      '"mixed\'',
      'expression(1)',
      'var(--f)',
      'Arial,',
      Array.from({ length: 11 }, (_, i) => `F${i}`).join(', '),
      'x'.repeat(201),
    ]) {
      expect(safeFontFamily(bad)).toBeNull()
    }
  })
})

describe('the formatting commands', () => {
  it('sets and removes the font and the size', () => {
    const editor = editorWith('<p>Hello</p>')
    editor.chain().selectAll().setFontFamily(FONT_FAMILIES[0].value).setFontSize('14pt').run()
    expect(html(editor)).toBe(
      '<p><span style="font-family: Arial, Helvetica, sans-serif; font-size: 14pt">Hello</span></p>',
    )
    editor.chain().selectAll().unsetFontFamily().unsetFontSize().run()
    expect(html(editor)).toBe('<p>Hello</p>')
  })

  it('sets and removes the text and background colours', () => {
    const editor = editorWith('<p>Hello</p>')
    editor.chain().selectAll().setColor(TEXT_COLORS.red).setBackgroundColor(BACKGROUND_COLORS.yellow).run()
    expect(html(editor)).toBe('<p><span style="color: #dc2626; background-color: #fef08a">Hello</span></p>')
    editor.chain().selectAll().unsetColor().unsetBackgroundColor().run()
    expect(html(editor)).toBe('<p>Hello</p>')
  })

  it('never writes a value that does not pass, even one set by a command', () => {
    const editor = editorWith('<p>Hello</p>')
    editor.chain().selectAll().setColor('red;background:url(x)').setFontSize('var(--s)').run()
    expect(editor.getHTML()).not.toContain('url(')
    expect(editor.getHTML()).not.toContain('var(')
  })

  it('aligns paragraphs and headings', () => {
    const editor = editorWith('<p>One</p><h2>Two</h2>')
    editor.chain().selectAll().setTextAlign('center').run()
    expect(html(editor)).toBe('<p style="text-align: center">One</p><h2 style="text-align: center">Two</h2>')
    editor.chain().selectAll().setTextAlign('justify').run()
    expect(editor.getHTML()).toContain('<p style="text-align: justify">')
    editor.chain().selectAll().unsetTextAlign().run()
    expect(html(editor)).toBe('<p>One</p><h2>Two</h2>')
  })

  it('indents and outdents paragraphs within 0 and the maximum', () => {
    const editor = editorWith('<p>One</p>')
    expect(editor.commands.decreaseIndent()).toBe(false)
    editor.commands.increaseIndent()
    editor.commands.increaseIndent()
    expect(html(editor)).toBe('<p data-indent="2">One</p>')
    editor.commands.decreaseIndent()
    expect(html(editor)).toBe('<p data-indent="1">One</p>')
    for (let i = 0; i < MAX_INDENT + 3; i++) editor.commands.increaseIndent()
    expect(html(editor)).toBe(`<p data-indent="${MAX_INDENT}">One</p>`)
    expect(editor.commands.increaseIndent()).toBe(false)
  })

  it('indents a list item by nesting it, and outdents it back', () => {
    const editor = editorWith('<ul><li><p>a</p></li><li><p>b</p></li></ul>')
    editor.commands.setTextSelection(editor.state.doc.content.size - 3)
    editor.commands.increaseIndent()
    expect(html(editor)).toBe('<ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>')
    expect(editor.getHTML()).not.toContain('data-indent')
    editor.commands.decreaseIndent()
    expect(html(editor)).toBe('<ul><li><p>a</p></li><li><p>b</p></li></ul>')
  })

  it('reads the indent back from data-indent, or from the margin that was sent', () => {
    const el = (html: string) => {
      const div = document.createElement('div')
      div.innerHTML = html
      return div.firstElementChild as HTMLElement
    }
    expect(parseIndent(el('<p data-indent="3">x</p>'))).toBe(3)
    expect(parseIndent(el('<p data-indent="99">x</p>'))).toBe(MAX_INDENT)
    expect(parseIndent(el('<p style="margin-left: 80px;">x</p>'))).toBe(2)
    expect(parseIndent(el('<p style="margin-right: 40px;">x</p>'))).toBe(1)
    expect(parseIndent(el('<p style="margin-left: 0.5in;">x</p>'))).toBe(0)
    expect(parseIndent(el('<p data-indent="x">x</p>'))).toBe(0)
    const editor = editorWith('<p style="margin-left: 120px;">x</p>')
    expect(html(editor)).toBe('<p data-indent="3">x</p>')
  })

  it('inserts a table, adds and deletes rows and columns, and deletes it', () => {
    const editor = editorWith('<p>Before</p>')
    editor.commands.focus('end')
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })
    expect(editor.getHTML()).toContain('<table class="oreneta-table"')
    // The editor draws it with the same grid it is sent with.
    expect(editor.view.dom.querySelector('table.oreneta-table')).not.toBeNull()
    expect(editor.view.dom.querySelectorAll('th').length).toBe(2)
    expect(rowCount(editor)).toBe(2)

    editor.commands.addRowAfter()
    expect(rowCount(editor)).toBe(3)
    editor.commands.addRowBefore()
    expect(rowCount(editor)).toBe(4)
    editor.commands.deleteRow()
    expect(rowCount(editor)).toBe(3)

    editor.commands.addColumnAfter()
    expect(columnCount(editor)).toBe(3)
    editor.commands.addColumnBefore()
    expect(columnCount(editor)).toBe(4)
    editor.commands.deleteColumn()
    expect(columnCount(editor)).toBe(3)

    editor.commands.deleteTable()
    expect(editor.getHTML()).not.toContain('<table')
    expect(editor.getHTML()).toContain('Before')
  })

  it('keeps a table that came with quoted mail without the grid of one made here', () => {
    const editor = editorWith('<table><tbody><tr><td>layout</td></tr></tbody></table>')
    expect(editor.getHTML()).toContain('<table style=')
    expect(editor.getHTML()).not.toContain('oreneta-table')
    expect(editor.view.dom.querySelector('table')).not.toBeNull()
    expect(editor.view.dom.querySelector('table.oreneta-table')).toBeNull()
  })

  // Quoted mail is untrusted, and a cell's span is walked column by column.
  it('bounds the span of a cell that came in with mail', () => {
    const editor = editorWith(
      '<table><tbody><tr><td colspan="2000000000" rowspan="abc">a</td></tr><tr><th colspan="-3" rowspan="1000">b</th></tr></tbody></table>',
    )
    const [td, th] = Array.from(editor.view.dom.querySelectorAll('td, th'))
    expect(td.getAttribute('colspan')).toBe(String(MAX_TABLE_SPAN))
    expect(td.getAttribute('rowspan')).toBe('1')
    expect(th.getAttribute('colspan')).toBe('1')
    expect(Number(th.getAttribute('rowspan'))).toBeLessThanOrEqual(MAX_TABLE_SPAN)
    expect(clampSpan('3')).toBe(3)
    expect(clampSpan(2.7)).toBe(2)
    expect(clampSpan('x')).toBe(1)
    expect(clampSpan(null)).toBe(1)
  })
})

describe('the formatting shortcuts', () => {
  it('maps the chords to their commands and nothing else', () => {
    for (const key of ['l', 'e', 'r', 'j', 'L', 'R']) expect(formattingCommandFor(chord(key, true))).not.toBeNull()
    expect(formattingCommandFor(chord(']'))).not.toBeNull()
    expect(formattingCommandFor(chord('['))).not.toBeNull()
    expect(formattingCommandFor(chord('r'))).toBeNull()
    expect(formattingCommandFor(chord('x', true))).toBeNull()
    expect(formattingCommandFor(new KeyboardEvent('keydown', { key: 'R', shiftKey: true }))).toBeNull()
    expect(formattingCommandFor(new KeyboardEvent('keydown', { key: 'R', shiftKey: true, altKey: true, ctrlKey: !isMac, metaKey: isMac }))).toBeNull()
    // Catalan, Spanish, French and German keyboards type the brackets with
    // AltGr, which arrives as Ctrl+Alt.
    expect(formattingCommandFor(new KeyboardEvent('keydown', { key: ']', altKey: true, ctrlKey: !isMac, metaKey: isMac }))).not.toBeNull()
    expect(formattingCommandFor(new KeyboardEvent('keydown', { key: '[', altKey: true, ctrlKey: !isMac, metaKey: isMac }))).not.toBeNull()
  })

  it('aligns with Mod+Shift+L, E, R and J', () => {
    const editor = editorWith('<p>Hello</p>')
    const expected: Record<string, string> = { L: 'left', E: 'center', R: 'right', J: 'justify' }
    for (const [key, align] of Object.entries(expected)) {
      editor.view.dom.dispatchEvent(chord(key, true))
      expect(html(editor)).toBe(`<p style="text-align: ${align}">Hello</p>`)
    }
  })

  it('indents with Mod+] and outdents with Mod+[', () => {
    const editor = editorWith('<p>Hello</p>')
    editor.view.dom.dispatchEvent(chord(']'))
    expect(html(editor)).toBe('<p data-indent="1">Hello</p>')
    editor.view.dom.dispatchEvent(chord('['))
    expect(html(editor)).toBe('<p>Hello</p>')
  })

  // Owner, 2026-10-17: inside the editor Mod+Shift+R aligns right; outside it
  // it is still "Sync mailbox".
  it('keeps Mod+Shift+R inside the editor, and leaves it to Sync mailbox outside', () => {
    const editor = editorWith('<p>Hello</p>')
    const reached: string[] = []
    const onWindow = (event: KeyboardEvent) => reached.push(String(matchShortcut(event)))
    window.addEventListener('keydown', onWindow)
    try {
      const inEditor = chord('R', true)
      editor.view.dom.dispatchEvent(inEditor)
      expect(html(editor)).toBe('<p style="text-align: right">Hello</p>')
      expect(inEditor.defaultPrevented).toBe(true)
      expect(reached).toEqual([])

      const field = document.createElement('input')
      document.body.appendChild(field)
      field.dispatchEvent(chord('R', true))
      field.remove()
      expect(reached).toEqual(['mail.sync'])
    } finally {
      window.removeEventListener('keydown', onWindow)
    }
  })

  it('moves through the cells with Tab and adds a row at the end of the table', () => {
    const editor = editorWith('<p></p>')
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false })
    const cellText = () => editor.state.selection.$from.parent.textContent
    const tab = () => editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    editor.commands.insertContent('1')
    for (const next of ['2', '3', '4']) {
      tab()
      editor.commands.insertContent(next)
      expect(cellText()).toBe(next)
    }
    // Three cells crossed without a new row; Tab in the last one adds it.
    expect(rowCount(editor)).toBe(2)
    tab()
    expect(rowCount(editor)).toBe(3)
  })
})

describe('what is sent', () => {
  // Pasted or quoted HTML that tries to carry more than the toolbar can make.
  const hostile =
    '<p onclick="steal()">' +
    '<span style="color: red; background-image: url(https://t.example/p.gif)">a</span>' +
    '<span style="font-family: x\\;y; font-size: expression(alert(1))">b</span>' +
    '<span style="background-color: var(--x)">c</span>' +
    '<span style="font-size: 12pt">d</span>' +
    '</p><script>alert(1)</script><img src="x" onerror="alert(1)">'

  it('keeps only the styles that pass, and nothing that runs or fetches', () => {
    const editor = editorWith(hostile)
    const sent = inlineRichStyles(editor.getHTML())
    for (const bad of ['onclick', 'onerror', '<script', 'url(', 'expression', 'var(', '\\', 'background-image']) {
      expect(sent).not.toContain(bad)
    }
    expect(sent).toContain('<span style="color: red">a</span>')
    expect(sent).toContain('<span style="font-size: 12pt">d</span>')
  })

  it('sends the formatting in the HTML and a readable plain-text alternative', () => {
    const editor = editorWith('<p>Hi Ana,</p>')
    editor.commands.focus('end')
    editor.chain().selectAll().setFontFamily(FONT_FAMILIES[2].value).setColor(TEXT_COLORS.blue).run()
    editor.commands.focus('end')
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })
    editor.commands.insertContent('Item')
    editor.commands.goToNextCell()
    editor.commands.insertContent('Cost')
    editor.commands.goToNextCell()
    editor.commands.insertContent('Tea')
    editor.commands.goToNextCell()
    editor.commands.insertContent('2')

    const payload = composedPayload({
      accountId: 'a',
      to: 'ana@example.com',
      subject: 'Prices',
      rich: true,
      content: inlineRichStyles(editor.getHTML()),
      attachments: [],
    })
    expect(payload.html).toContain('<span style="font-family: Georgia, serif; color: #2563eb">Hi Ana,</span>')
    expect(payload.html).toContain('<table class="oreneta-table" style="border-collapse: collapse;')
    const sent = new DOMParser().parseFromString(payload.html, 'text/html').body
    expect(sent.querySelector('td')!.getAttribute('style')).toBe(
      'border: 1px solid #d1d5db; padding: 4px 8px; vertical-align: top;',
    )
    expect(sent.querySelectorAll('th').length).toBe(2)
    expect(payload.body).toBe('Hi Ana,\n\nItem | Cost\nTea | 2')
    expect(htmlToText(payload.html)).toBe(payload.body)
  })
})
