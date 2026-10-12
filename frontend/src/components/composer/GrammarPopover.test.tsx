import { afterEach, expect, it } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { GrammarChecker, type GrammarIssue } from '../../lib/grammar'
import { GrammarExtension, grammarKey, placeIssues } from './grammarExtension'
import { GrammarPopover, GrammarStatus } from './GrammarPopover'

afterEach(cleanup)

const setup = () => {
  const editor = new Editor({
    extensions: [StarterKit, GrammarExtension.configure({ checker: null, dialect: () => null })],
    content: '<p>I has a apple.</p>',
  })
  const issue: GrammarIssue = {
    start: 2,
    end: 5,
    problem: 'has',
    message: 'The verb must agree with the pronoun.',
    kind: 'Agreement',
    suggestions: ['have'],
    key: 'Agreement|has|x',
  }
  const placed = placeIssues(editor.state.doc, [issue])
  editor.view.dispatch(editor.state.tr.setMeta(grammarKey, { placed }))
  const checker = new GrammarChecker(async () => ({ lint: async () => [], isEnglish: async () => true }))
  return { editor, placed: placed[0], checker }
}

it('shows what is wrong and applies the chosen suggestion', () => {
  const { editor, placed, checker } = setup()
  let closed = false
  const view = render(
    <GrammarPopover
      editor={editor}
      checker={checker}
      pick={{ placed, at: { left: 10, top: 10 } }}
      onClose={() => (closed = true)}
    />,
  )
  expect(view.getByText('The verb must agree with the pronoun.')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'have' }))
  expect(editor.getHTML()).toBe('<p>I have a apple.</p>')
  expect(closed).toBe(true)
  editor.destroy()
})

it('ignoring removes the underline and leaves the text', () => {
  const { editor, placed, checker } = setup()
  const view = render(
    <GrammarPopover
      editor={editor}
      checker={checker}
      pick={{ placed, at: { left: 10, top: 10 } }}
      onClose={() => {}}
    />,
  )
  fireEvent.click(view.getByRole('button', { name: 'Ignore' }))
  expect(grammarKey.getState(editor.state)?.placed).toEqual([])
  expect(editor.getHTML()).toBe('<p>I has a apple.</p>')
  editor.destroy()
})

it('says why text was not checked', () => {
  const view = render(<GrammarStatus result={{ state: 'notEnglish' }} error="" />)
  expect(view.getByText(/English only/)).toBeTruthy()
  cleanup()
  const failed = render(<GrammarStatus result={null} error="WebAssembly failed to load" />)
  expect(failed.getByText('Grammar suggestions could not start: WebAssembly failed to load')).toBeTruthy()
})
