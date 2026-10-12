import { expect, test } from 'bun:test'
import { isAnswerableInvitation } from './calendarInvitation'

const me = { email: 'me@example.org', aliases: [{ email: 'boss@example.org' }] }

test('an invitation from someone else can be answered', () => {
  expect(
    isAnswerableInvitation({ my_response: 'NoResponseReceived', organizer: { addr: 'them@x' } }, 2, me, false),
  ).toBe(true)
})

test('the organizer is never asked to answer their own meeting', () => {
  // Exchange: the organizer's own response.
  expect(
    isAnswerableInvitation({ my_response: 'Organizer', organizer: { addr: 'me@example.org' } }, 3, me, false),
  ).toBe(false)
  // Google: an organizer's own event reads "accepted".
  expect(isAnswerableInvitation({ my_response: 'accepted', organizer: { addr: 'ME@example.org' } }, 3, me, false)).toBe(
    false,
  )
  // Convened from an alias of this account.
  expect(
    isAnswerableInvitation({ my_response: 'accepted', organizer: { addr: 'boss@example.org' } }, 3, me, false),
  ).toBe(false)
})

test('nothing to answer without attendees, a response field, or a writable calendar', () => {
  const invite = { my_response: 'needsAction', organizer: { addr: 'them@x' } }
  expect(isAnswerableInvitation(invite, 0, me, false)).toBe(false)
  expect(isAnswerableInvitation({ ...invite, my_response: '' }, 2, me, false)).toBe(false)
  expect(isAnswerableInvitation(invite, 2, me, true)).toBe(false)
})
