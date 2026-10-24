import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { ComposerToolbar } from './ComposerToolbar'
import { focusInMenu } from '../../lib/menuKeyboard'
import { BACKGROUND_COLORS, FONT_FAMILIES, richTextExtensions, TEXT_COLORS } from './richText'

// The toolbar's formatting controls (#274, ADR-0067), each against the editor.

// Style attributes as written here: ProseMirror writes them through the DOM,
// which ends each one with a semicolon.
const html = (editor: Editor) => editor.getHTML().replace(/;"/g, '"')

const editors: Editor[] = []
afterEach(() => {
  cleanup()
  for (const editor of editors.splice(0)) editor.destroy()
})

function setup(content = '<p>Hello</p>') {
  const editor = new Editor({ extensions: [StarterKit, ...richTextExtensions()], content })
  editors.push(editor)
  editor.commands.selectAll()
  const view = render(<ComposerToolbar editor={editor} onSetLink={() => {}} />)
  return { editor, view }
}

describe('the composer toolbar', () => {
  it('sets the font and the size, and back to the default', () => {
    const { editor, view } = setup()
    const font = view.getByLabelText('Font') as HTMLSelectElement
    const size = view.getByLabelText('Font size') as HTMLSelectElement
    act(() => {
      fireEvent.change(font, { target: { value: FONT_FAMILIES[2].value } })
    })
    act(() => {
      fireEvent.change(size, { target: { value: '18pt' } })
    })
    expect(html(editor)).toBe('<p><span style="font-family: Georgia, serif; font-size: 18pt">Hello</span></p>')
    expect(font.value).toBe(FONT_FAMILIES[2].value)
    expect(size.value).toBe('18pt')
    act(() => {
      fireEvent.change(font, { target: { value: '' } })
    })
    act(() => {
      fireEvent.change(size, { target: { value: '' } })
    })
    expect(html(editor)).toBe('<p>Hello</p>')
  })

  it('shows a font that came with pasted text as its own choice', () => {
    const { view } = setup('<p><span style="font-family: Calibri, sans-serif">Hello</span></p>')
    const font = view.getByLabelText('Font') as HTMLSelectElement
    expect(font.value).toBe('Calibri, sans-serif')
    expect(font.options[font.selectedIndex].textContent).toBe('Calibri')
  })

  it('colours the text and its background from the swatches, and takes it off', () => {
    const { editor, view } = setup()
    act(() => {
      fireEvent.click(view.getByLabelText('Text color'))
    })
    act(() => {
      fireEvent.click(view.getByLabelText('Red'))
    })
    act(() => {
      fireEvent.click(view.getByLabelText('Highlight color'))
    })
    act(() => {
      fireEvent.click(view.getByLabelText('Yellow'))
    })
    expect(html(editor)).toBe(
      `<p><span style="color: ${TEXT_COLORS.red}; background-color: ${BACKGROUND_COLORS.yellow}">Hello</span></p>`,
    )
    act(() => {
      fireEvent.click(view.getByLabelText('Text color'))
    })
    act(() => {
      fireEvent.click(view.getByLabelText('Remove color'))
    })
    expect(html(editor)).toBe(`<p><span style="background-color: ${BACKGROUND_COLORS.yellow}">Hello</span></p>`)
  })

  it('aligns and indents', () => {
    const { editor, view } = setup()
    act(() => {
      fireEvent.click(view.getByTitle('Align right'))
    })
    expect(html(editor)).toBe('<p style="text-align: right">Hello</p>')
    act(() => {
      fireEvent.click(view.getByTitle('Center'))
    })
    act(() => {
      fireEvent.click(view.getByTitle('Increase indent'))
    })
    act(() => {
      fireEvent.click(view.getByTitle('Increase indent'))
    })
    act(() => {
      fireEvent.click(view.getByTitle('Decrease indent'))
    })
    expect(html(editor)).toBe('<p style="text-align: center" data-indent="1">Hello</p>')
  })

  it('offers the row and column commands only inside a table', () => {
    const { editor, view } = setup('<p></p>')
    expect(view.queryByTitle('Insert row below')).toBeNull()
    act(() => {
      fireEvent.click(view.getByTitle('Insert table'))
    })
    expect(editor.getHTML()).toContain('<table class="oreneta-table"')
    const rows = () => editor.view.dom.querySelectorAll('tr').length
    const columns = () => editor.view.dom.querySelector('tr')!.children.length
    expect(rows()).toBe(3)
    expect(columns()).toBe(3)

    act(() => {
      fireEvent.click(view.getByTitle('Insert row below'))
    })
    act(() => {
      fireEvent.click(view.getByTitle('Insert row above'))
    })
    expect(rows()).toBe(5)
    act(() => {
      fireEvent.click(view.getByTitle('Delete row'))
    })
    expect(rows()).toBe(4)
    act(() => {
      fireEvent.click(view.getByTitle('Insert column after'))
    })
    act(() => {
      fireEvent.click(view.getByTitle('Insert column before'))
    })
    expect(columns()).toBe(5)
    act(() => {
      fireEvent.click(view.getByTitle('Delete column'))
    })
    expect(columns()).toBe(4)
    act(() => {
      fireEvent.click(view.getByTitle('Delete table'))
    })
    expect(editor.getHTML()).not.toContain('<table')
    expect(view.queryByTitle('Insert row below')).toBeNull()
  })

  it('counts an open colour row as a menu, so a bare Delete there stays in it (#348)', () => {
    const { view } = setup()
    const trigger = view.getByLabelText('Text color')
    expect(focusInMenu(trigger)).toBe(false)
    act(() => {
      fireEvent.click(trigger)
    })
    expect(focusInMenu(trigger)).toBe(true)
    expect(focusInMenu(view.getByLabelText('Red'))).toBe(true)
    act(() => {
      fireEvent.click(trigger)
    })
    expect(focusInMenu(trigger)).toBe(false)
  })
})
