import { expect, it } from 'bun:test'
import { MAX_SUGGESTIONS, applyMention, mentionCandidates, mentionQuery, mentionsKept } from './chatMentions'

it('finds the @ being completed, and not one inside an address or after a space', () => {
  expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' })
  expect(mentionQuery('hola @Pa', 8)).toEqual({ start: 5, query: 'Pa' })
  expect(mentionQuery('(@án', 4)).toEqual({ start: 1, query: 'án' })
  // The caret decides: what follows it does not count.
  expect(mentionQuery('hola @Pau y más', 8)).toEqual({ start: 5, query: 'Pa' })
  expect(mentionQuery('escribe a ana@chat.test', 23)).toBeNull()
  expect(mentionQuery('@Pau ya', 7)).toBeNull()
  expect(mentionQuery('sin arroba', 10)).toBeNull()
  expect(mentionQuery(`@${'x'.repeat(65)}`, 66)).toBeNull()
})

it('offers the people in the room that start with what was typed, never the person', () => {
  const nicks = ['Pau', 'pablo', 'Ana', 'Álvaro', 'Pau', ' ']
  expect(mentionCandidates(nicks, 'pa', 'Ana')).toEqual(['pablo', 'Pau'])
  expect(mentionCandidates(nicks, '', 'Ana')).toEqual(['Álvaro', 'pablo', 'Pau'])
  expect(mentionCandidates(nicks, 'ál', 'Ana')).toEqual(['Álvaro'])
  expect(mentionCandidates(nicks, 'zz', 'Ana')).toEqual([])
  const many = Array.from({ length: 20 }, (_, n) => `p${String(n).padStart(2, '0')}`)
  expect(mentionCandidates(many, 'p')).toHaveLength(MAX_SUGGESTIONS)
})

it('writes the picked nickname in place and keeps only those still written', () => {
  expect(applyMention('hola @pa, ¿vienes?', 5, 8, 'Pau R')).toEqual({ text: 'hola @Pau R , ¿vienes?', caret: 12 })
  expect(applyMention('@', 0, 1, 'Ana')).toEqual({ text: '@Ana ', caret: 5 })
  expect(mentionsKept(['Pau R', 'Eva', 'Pau R'], '@Pau R y tú')).toEqual(['Pau R'])
  expect(mentionsKept([], 'hola')).toEqual([])
})
