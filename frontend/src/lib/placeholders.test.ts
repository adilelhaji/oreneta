import { expect, it } from 'bun:test'
import { fillPlaceholders, firstName, takeCursor } from './placeholders'

const context = {
  to: '"Rivera, Morgan" <morgan@example.com>, ann@example.com',
  me: { name: 'Sam Example', email: 'sam@example.com' },
  subject: 'Roof',
  now: new Date(2026, 9, 12),
}

it('fills from the message being written, the first recipient named', () => {
  const filled = fillPlaceholders(
    'Hi {{to.firstName}} ({{ to.email }}), re {{subject}}. — {{me.firstName}}',
    context,
    false,
  )
  expect(filled).toEqual({
    text: 'Hi Morgan (morgan@example.com), re Roof. — Sam',
    missing: [],
    unknown: [],
  })
})

it('leaves what it cannot fill or does not know, and says so', () => {
  const filled = fillPlaceholders('Hi {{to.firstName}}, {{to.nickname}}', { ...context, to: '' }, false)
  expect(filled.text).toBe('Hi {{to.firstName}}, {{to.nickname}}')
  expect(filled.missing).toEqual(['to.firstName'])
  expect(filled.unknown).toEqual(['to.nickname'])
  // An address without a name has no first name to offer.
  expect(fillPlaceholders('{{to.firstName}}', { ...context, to: 'ann@example.com' }, false).missing).toEqual([
    'to.firstName',
  ])
})

it('escapes what goes into markup', () => {
  const filled = fillPlaceholders('<p>Hi {{to.name}}</p>', { ...context, to: '"A <b>" <a@example.com>' }, true)
  expect(filled.text).toBe('<p>Hi A &lt;b&gt;</p>')
})

it('turns the first cursor mark into the caret', () => {
  expect(takeCursor('Dear X,\n\n{{cursor}}\n\nBest')).toEqual({ text: 'Dear X,\n\n\n\nBest', cursor: 9 })
  expect(takeCursor('No mark')).toEqual({ text: 'No mark', cursor: 7 })
  expect(takeCursor('{{cursor}}a{{cursor}}')).toEqual({ text: 'a', cursor: 0 })
})

it('reads first names the way people write them', () => {
  expect(firstName('Rivera, Morgan Lee')).toBe('Morgan')
  expect(firstName('Ann Smith')).toBe('Ann')
  expect(firstName('  ')).toBe('')
})
