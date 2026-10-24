import { expect, test } from 'bun:test'
import { answerLabel, answerOf, isAnswerableInvitation, meetingAnswer } from './calendarInvitation'

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

// The state the Dia panel says beside an event (ADR-0069 §3, #362), in the
// event sheet's own words.
test("reads each server's answer as one of three, or none yet, and nothing for nothing to answer", () => {
  for (const response of ['accept', 'accepted', 'Accept']) expect(answerOf(response)).toBe('accepted')
  for (const response of ['decline', 'declined']) expect(answerOf(response)).toBe('declined')
  expect(answerOf('tentative')).toBe('tentative')
  // Exchange's NoResponseReceived is `none`; Google's is needsAction.
  for (const response of ['none', 'needsAction', 'NoResponseReceived']) expect(answerOf(response)).toBe('unanswered')
  for (const response of ['', '  ', 'organizer', 'Organizer', 'unknown']) expect(answerOf(response)).toBeNull()
  expect(answerLabel('tentative')).toBe('Tentative')
  expect(answerLabel('unanswered')).toBe('No answer yet')
  expect(answerLabel(null)).toBe('No answer yet')
})

test("says no answer beside a meeting the account convened, Google's «accepted» included", () => {
  expect(meetingAnswer({ my_response: 'accepted', organizer: { addr: 'ME@example.org' } }, me)).toBeNull()
  expect(meetingAnswer({ my_response: 'accepted', organizer: { addr: 'boss@example.org' } }, me)).toBeNull()
  expect(meetingAnswer({ my_response: 'accepted', organizer: { addr: 'them@x' } }, me)).toBe('accepted')
  expect(meetingAnswer({ my_response: 'none', organizer: { addr: 'them@x' } }, me)).toBe('unanswered')
  expect(meetingAnswer({ my_response: '' }, me)).toBeNull()
})
