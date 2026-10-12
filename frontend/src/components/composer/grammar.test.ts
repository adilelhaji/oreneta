import { describe, expect, it } from 'bun:test'
import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import {
  applyToText,
  engineFrom,
  GrammarChecker,
  MAX_CHECK_CHARS,
  type GrammarEngine,
  type GrammarIssue,
} from '../../lib/grammar'
import { applySuggestion, docText, grammarKey, GrammarExtension, issueAt, placeIssues } from './grammarExtension'

// The real Harper, from the WebAssembly the package ships (inlined here,
// since tests have no worker): the same rules the app runs. The test DOM
// replaces `Response`, which streaming compilation refuses, so the glue's
// own non-streaming path is taken instead; the module is the same.
;(WebAssembly as { instantiateStreaming?: unknown }).instantiateStreaming = undefined
const realEngine: Promise<GrammarEngine> = (async () => {
  const [{ LocalLinter, Dialect }, { binaryInlined }] = await Promise.all([
    import('harper.js'),
    import('harper.js/binaryInlined'),
  ])
  return engineFrom(new LocalLinter({ binary: binaryInlined }), {
    american: Dialect.American,
    british: Dialect.British,
    canadian: Dialect.Canadian,
    australian: Dialect.Australian,
  })
})()

describe('Harper, on this computer', () => {
  it('loads from the packaged WebAssembly and finds what is wrong, at the right place', async () => {
    const checker = new GrammarChecker(() => realEngine)
    const text = '😀 Thanks for the notes. I has a apple for you.'
    const result = await checker.check(text, 'british')
    expect(result.state).toBe('checked')
    if (result.state !== 'checked') return
    const has = result.issues.find((i) => i.problem === 'has')
    expect(has?.suggestions).toContain('have')
    // Offsets are string offsets, emoji and all.
    expect(text.slice(has!.start, has!.end)).toBe('has')
    expect(applyToText(text, has!, 'have').text).toBe('😀 Thanks for the notes. I have a apple for you.')
  }, 30_000)

  it('does not check text that is not English, and says so', async () => {
    const checker = new GrammarChecker(() => realEngine)
    const result = await checker.check(
      'Hola Marta, te mando el presupuesto revisado para la cocina esta tarde.',
      'american',
    )
    expect(result).toEqual({ state: 'notEnglish' })
  }, 30_000)
})

describe('the checker', () => {
  const fake = (issues: Omit<GrammarIssue, 'key'>[], delay = 0): GrammarEngine => ({
    lint: async () => {
      await new Promise((r) => setTimeout(r, delay))
      return issues
    },
    isEnglish: async () => true,
  })
  const issue = { start: 2, end: 5, problem: 'has', message: 'Agreement', kind: 'Agreement', suggestions: ['have'] }

  it('declines a text too long to check as a whole', async () => {
    const checker = new GrammarChecker(async () => fake([issue]))
    expect(await checker.check('a'.repeat(MAX_CHECK_CHARS + 1), 'american')).toEqual({
      state: 'tooLong',
      limit: MAX_CHECK_CHARS,
    })
  })

  it('answers stale for a check overtaken by a newer one', async () => {
    const checker = new GrammarChecker(async () => fake([issue], 30))
    const first = checker.check('I has it', 'american')
    const second = checker.check('I has it now', 'american')
    expect(await first).toEqual({ state: 'stale' })
    expect((await second).state).toBe('checked')
  })

  it('does not show again what the person ignored', async () => {
    const checker = new GrammarChecker(async () => fake([issue]))
    const first = await checker.check('I has it', 'american')
    if (first.state !== 'checked') throw new Error(first.state)
    checker.ignore(first.issues[0])
    expect(await checker.check('I has it', 'american')).toEqual({ state: 'checked', issues: [] })
  })

  it('a checker that cannot load says so instead of hanging', async () => {
    const checker = new GrammarChecker(() => Promise.reject(new Error('WebAssembly failed to load')))
    await expect(checker.check('I has it', 'american')).rejects.toThrow('WebAssembly failed to load')
  })
})

describe('in the rich editor', () => {
  const editor = () =>
    new Editor({
      extensions: [StarterKit, GrammarExtension.configure({ checker: null, dialect: () => null })],
      content: '<p>Hello, <strong>I has</strong> a apple.</p><p>Second line</p>',
    })

  it('reads the document as text with positions back into it', () => {
    const e = editor()
    const mapped = docText(e.state.doc)
    expect(mapped.text).toBe('Hello, I has a apple.\nSecond line')
    const at = mapped.text.indexOf('has')
    expect(e.state.doc.textBetween(mapped.toPos(at)!, mapped.toPos(at + 3)!)).toBe('has')
    expect(mapped.toPos(mapped.text.indexOf('\n'))).not.toBeNull()
    e.destroy()
  })

  it('applies a suggestion as one undoable edit that keeps the formatting', () => {
    const e = editor()
    const text = docText(e.state.doc).text
    const has: GrammarIssue = {
      start: text.indexOf('has'),
      end: text.indexOf('has') + 3,
      problem: 'has',
      message: 'Agreement',
      kind: 'Agreement',
      suggestions: ['have'],
      key: 'k',
    }
    const placed = placeIssues(e.state.doc, [has])
    expect(placed).toHaveLength(1)
    e.view.dispatch(e.state.tr.setMeta(grammarKey, { placed }))
    expect(issueAt(e.state, placed[0].from + 1)?.issue.problem).toBe('has')
    // Underlines are not part of the message: the draft saved is the same.
    expect(e.getHTML()).toBe('<p>Hello, <strong>I has</strong> a apple.</p><p>Second line</p>')

    applySuggestion(e.view, placed[0], 'have')
    expect(e.getHTML()).toContain('<strong>I have</strong>')
    expect(issueAt(e.state, placed[0].from + 1)).toBeNull()
    e.commands.undo()
    expect(e.getHTML()).toContain('<strong>I has</strong>')
    e.destroy()
  })

  it('drops an underline when its own text is edited, and keeps it when text before it moves', () => {
    const e = editor()
    const text = docText(e.state.doc).text
    const a: GrammarIssue = {
      start: text.indexOf(' a ') + 1,
      end: text.indexOf(' a ') + 2,
      problem: 'a',
      message: 'Article',
      kind: 'Miscellaneous',
      suggestions: ['an'],
      key: 'a',
    }
    const placed = placeIssues(e.state.doc, [a])
    e.view.dispatch(e.state.tr.setMeta(grammarKey, { placed }))
    e.view.dispatch(e.state.tr.insertText('Well, ', 1))
    const moved = grammarKey.getState(e.state)!.placed
    expect(moved).toHaveLength(1)
    expect(e.state.doc.textBetween(moved[0].from, moved[0].to)).toBe('a')
    e.view.dispatch(e.state.tr.insertText('the', moved[0].from, moved[0].to))
    expect(grammarKey.getState(e.state)!.placed).toHaveLength(0)
    e.destroy()
  })
})
