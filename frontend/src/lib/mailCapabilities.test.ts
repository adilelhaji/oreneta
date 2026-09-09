import { expect, test } from 'bun:test'
import { isReadOnlyMail, readOnlyTarget } from './mailCapabilities'
import type { Account } from '../types'

test('Graph read-only capability is explicit, never guessed from Microsoft provider', () => {
  const graph = { id: 'a@example.test', auth_type: 'graph_oauth' } as Account
  expect(isReadOnlyMail(graph)).toBe(true)
  for (const auth_type of ['password', 'outlook_oauth', 'gmail_oauth', 'rss'] as const)
    expect(isReadOnlyMail({ auth_type })).toBe(false)
  expect(readOnlyTarget([graph], 'a@example.test#INBOX#opaque')).toBe(true)
  expect(readOnlyTarget([graph], 'a@example.test.evil#INBOX#opaque')).toBe(false)
  expect(readOnlyTarget([graph], 'another@example.test')).toBe(false)
})
