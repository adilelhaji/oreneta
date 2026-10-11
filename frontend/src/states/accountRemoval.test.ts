import { expect, test } from 'bun:test'
import { keptAfterRemovalNotice } from './accounts'

test('removing an account says which of the person’s own writing stayed', () => {
  expect(keptAfterRemovalNotice(undefined)).toBeNull()
  expect(keptAfterRemovalNotice({ drafts: 0, scheduled: 0, attempts: 3 })).toBeNull()
  expect(keptAfterRemovalNotice({ drafts: 1, scheduled: 0 })).toBe('Account removed. Kept on this computer: 1 draft.')
  expect(keptAfterRemovalNotice({ drafts: 0, scheduled: 2 })).toBe(
    'Account removed. Kept on this computer: 2 scheduled messages, not sent.',
  )
  expect(keptAfterRemovalNotice({ drafts: 3, scheduled: 1 })).toBe(
    'Account removed. Kept on this computer: 3 drafts, 1 scheduled message, not sent.',
  )
})
